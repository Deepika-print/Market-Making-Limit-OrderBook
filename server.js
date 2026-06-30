'use strict';

/**
 * LOB Backend Server
 * -------------------
 * Express serves the static client. The WebSocket server (ws) broadcasts
 * order book state to every connected client in real time and accepts
 * order placement / cancellation messages from clients.
 *
 * Protocol (JSON messages over WebSocket):
 *
 *  Client -> Server:
 *    { type: 'place_order', side, orderType, price, quantity }
 *    { type: 'cancel_order', orderId }
 *    { type: 'get_my_orders' }
 *
 *  Server -> Client:
 *    { type: 'snapshot', data: <book snapshot> }          (broadcast to all, on every book change)
 *    { type: 'order_ack', data: { order, trades } }       (sent only to the submitting client)
 *    { type: 'cancel_ack', data: { ok, reason? } }        (sent only to the cancelling client)
 *    { type: 'my_orders', data: [...] }                   (sent only to requester)
 *    { type: 'error', message }
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { OrderBook } = require('./src/OrderBook');
const { MarketMaker, NoiseTrader } = require('./src/Bots');

const PORT = process.env.PORT || 3000;
const SYMBOL = 'AAPL';
const STARTING_PRICE = 100;

// ---- App + server setup ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- Shared order book (single instance, single source of truth) ----
const book = new OrderBook(SYMBOL, STARTING_PRICE);

// ---- Client registry ----
let nextClientId = 1;
const clients = new Map(); // ws -> { id, name }

function broadcastSnapshot() {
  const payload = JSON.stringify({ type: 'snapshot', data: book.getSnapshot() });
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---- Bots (run server-side, always on, shared by everyone) ----
const bots = [
  new MarketMaker(book, { name: 'MM-Alpha', spread: 0.04, quoteSize: 60, intervalMs: 1100, onTrade: broadcastSnapshot }),
  new MarketMaker(book, { name: 'MM-Beta', spread: 0.06, quoteSize: 40, intervalMs: 1500, onTrade: broadcastSnapshot }),
  new MarketMaker(book, { name: 'MM-Gamma', spread: 0.03, quoteSize: 80, intervalMs: 900, onTrade: broadcastSnapshot }),
  new NoiseTrader(book, { name: 'Noise-1', intervalMs: 700, onTrade: broadcastSnapshot }),
  new NoiseTrader(book, { name: 'Noise-2', intervalMs: 1100, onTrade: broadcastSnapshot }),
  new NoiseTrader(book, { name: 'Noise-3', intervalMs: 500, onTrade: broadcastSnapshot }),
  new NoiseTrader(book, { name: 'Whale', intervalMs: 3000, onTrade: broadcastSnapshot }),
];

let simRunning = true;
function startBots() { bots.forEach(b => b.start()); }
function stopBots() { bots.forEach(b => b.stop()); }
startBots();

// Even quiet ticks should refresh clients periodically (e.g. clock-based UI bits)
setInterval(() => { if (simRunning) broadcastSnapshot(); }, 4000);

// ---- WebSocket connection handling ----
wss.on('connection', (ws) => {
  const clientId = `C${nextClientId++}`;
  const traderName = `You-${clientId}`;
  clients.set(ws, { id: clientId, name: traderName });

  console.log(`[connect] ${clientId} (${clients.size} clients online)`);

  // Send initial state immediately on connect
  send(ws, { type: 'welcome', data: { clientId, traderName, simRunning } });
  send(ws, { type: 'snapshot', data: book.getSnapshot() });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', message: 'invalid_json' });
    }

    const client = clients.get(ws);

    switch (msg.type) {
      case 'place_order': {
        const { side, orderType, price, quantity } = msg;
        if (!['buy', 'sell'].includes(side)) return send(ws, { type: 'error', message: 'invalid_side' });
        if (!['limit', 'market', 'ioc'].includes(orderType)) return send(ws, { type: 'error', message: 'invalid_type' });
        const qty = parseInt(quantity, 10);
        if (!qty || qty <= 0) return send(ws, { type: 'error', message: 'invalid_quantity' });

        let orderPrice = parseFloat(price);
        if (orderType === 'market') {
          const mid = book.getMidPrice();
          orderPrice = side === 'buy' ? mid * 1.5 : mid * 0.5; // sweep-safe bound
        } else if (!orderPrice || orderPrice <= 0) {
          return send(ws, { type: 'error', message: 'invalid_price' });
        }

        const result = book.submitOrder({
          side, type: orderType, price: orderPrice, quantity: qty,
          trader: client.name, clientId: client.id,
        });

        send(ws, { type: 'order_ack', data: result });
        broadcastSnapshot();
        break;
      }

      case 'cancel_order': {
        const result = book.cancelOrder(msg.orderId, client.id);
        send(ws, { type: 'cancel_ack', data: result });
        if (result.ok) broadcastSnapshot();
        break;
      }

      case 'get_my_orders': {
        send(ws, { type: 'my_orders', data: book.getClientOrders(client.id) });
        break;
      }

      case 'toggle_sim': {
        simRunning = !simRunning;
        if (simRunning) startBots(); else stopBots();
        for (const c of clients.keys()) send(c, { type: 'sim_state', data: { simRunning } });
        break;
      }

      default:
        send(ws, { type: 'error', message: 'unknown_message_type' });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[disconnect] ${clientId} (${clients.size} clients online)`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LOB backend listening on port ${PORT}`);
  console.log(`WebSocket endpoint shares the same port (same HTTP server)`);
});
