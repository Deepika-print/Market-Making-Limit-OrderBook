'use strict';

/**
 * Limit Order Book — Core Matching Engine
 * Runs entirely on the server. Browser clients never see this code directly,
 * they only receive snapshots/events over WebSocket.
 *
 * Algorithm: Price-Time Priority (FIFO) — the same discipline used by
 * real exchanges (NASDAQ, NSE, etc.)
 */

class Order {
  constructor({ id, side, type, price, quantity, trader, clientId }) {
    this.id = id;
    this.side = side;                 // 'buy' | 'sell'
    this.type = type;                 // 'limit' | 'market' | 'ioc'
    this.price = price;
    this.quantity = quantity;
    this.remainingQty = quantity;
    this.trader = trader || 'Anon';
    this.clientId = clientId || null; // which WebSocket connection owns this order
    this.timestamp = Date.now();
    this.status = 'open';             // 'open' | 'filled' | 'partial' | 'cancelled'
  }
}

class PriceLevel {
  constructor(price) {
    this.price = price;
    this.orders = [];
    this.totalQuantity = 0;
  }
  add(order) {
    this.orders.push(order);
    this.totalQuantity += order.remainingQty;
  }
  remove(orderId) {
    const idx = this.orders.findIndex(o => o.id === orderId);
    if (idx !== -1) {
      this.totalQuantity -= this.orders[idx].remainingQty;
      this.orders.splice(idx, 1);
    }
  }
  isEmpty() { return this.orders.length === 0; }
}

class OrderBook {
  constructor(symbol, initialPrice = 100) {
    this.symbol = symbol;
    this.bids = new Map();      // price -> PriceLevel
    this.asks = new Map();      // price -> PriceLevel
    this.trades = [];
    this.orderMap = new Map();  // id -> order
    this.nextOrderId = 1;
    this.lastPrice = initialPrice;
    this.lastTradeSize = 0;
    this.stats = { buyVolume: 0, sellVolume: 0, tradeCount: 0, high: initialPrice, low: initialPrice };
    this._seed(initialPrice);
  }

  _seed(mid) {
    const spreads = [0.01, 0.02, 0.03, 0.05, 0.08, 0.13, 0.21, 0.34, 0.55, 0.89, 1.34, 2.17];
    spreads.forEach((s, i) => {
      const bq = Math.floor(60 + Math.random() * 180 + (12 - i) * 18);
      const aq = Math.floor(60 + Math.random() * 180 + (12 - i) * 18);
      this._addToBook(new Order({ id: `seed-b-${i}`, side: 'buy', type: 'limit', price: parseFloat((mid - s).toFixed(2)), quantity: bq, trader: 'MM' }));
      this._addToBook(new Order({ id: `seed-a-${i}`, side: 'sell', type: 'limit', price: parseFloat((mid + s).toFixed(2)), quantity: aq, trader: 'MM' }));
    });
  }

  submitOrder(params) {
    const order = new Order({ id: `O${this.nextOrderId++}`, ...params });
    this.orderMap.set(order.id, order);

    const trades = this._match(order);

    if (order.type === 'ioc' && order.remainingQty > 0) {
      order.status = 'cancelled';
    } else if (order.remainingQty > 0 && order.type === 'limit') {
      this._addToBook(order);
    }

    return { order, trades };
  }

  cancelOrder(orderId, clientId) {
    const order = this.orderMap.get(orderId);
    if (!order) return { ok: false, reason: 'not_found' };
    if (clientId && order.clientId !== clientId) return { ok: false, reason: 'not_owner' };
    if (order.status === 'filled' || order.status === 'cancelled') return { ok: false, reason: 'already_closed' };

    const book = order.side === 'buy' ? this.bids : this.asks;
    const level = book.get(order.price);
    if (level) {
      level.remove(orderId);
      if (level.isEmpty()) book.delete(order.price);
    }
    order.status = 'cancelled';
    this.orderMap.delete(orderId);
    return { ok: true, order };
  }

  _match(aggressor) {
    const trades = [];
    const opposite = aggressor.side === 'buy' ? this.asks : this.bids;
    const prices = [...opposite.keys()];
    const sorted = aggressor.side === 'buy' ? prices.sort((a, b) => a - b) : prices.sort((a, b) => b - a);

    for (const price of sorted) {
      if (aggressor.remainingQty <= 0) break;
      if (aggressor.type === 'limit') {
        if (aggressor.side === 'buy' && price > aggressor.price) break;
        if (aggressor.side === 'sell' && price < aggressor.price) break;
      }

      const level = opposite.get(price);
      const queue = [...level.orders];

      for (const resting of queue) {
        if (aggressor.remainingQty <= 0) break;
        const fillQty = Math.min(aggressor.remainingQty, resting.remainingQty);

        aggressor.remainingQty -= fillQty;
        resting.remainingQty -= fillQty;
        level.totalQuantity -= fillQty;

        resting.status = resting.remainingQty === 0 ? 'filled' : 'partial';
        aggressor.status = aggressor.remainingQty === 0 ? 'filled' : 'partial';

        if (resting.remainingQty === 0) {
          level.orders.shift();
          this.orderMap.delete(resting.id);
        }

        const trade = {
          id: `T${this.trades.length + 1}`,
          price,
          quantity: fillQty,
          buyer: aggressor.side === 'buy' ? aggressor.trader : resting.trader,
          seller: aggressor.side === 'sell' ? aggressor.trader : resting.trader,
          timestamp: Date.now(),
          aggressor: aggressor.side,
        };

        this.trades.unshift(trade);
        if (this.trades.length > 500) this.trades.pop();
        trades.push(trade);

        this.lastPrice = price;
        this.lastTradeSize = fillQty;
        this.stats.tradeCount++;
        this.stats.high = Math.max(this.stats.high, price);
        this.stats.low = Math.min(this.stats.low, price);
        if (aggressor.side === 'buy') this.stats.buyVolume += fillQty;
        else this.stats.sellVolume += fillQty;
      }

      if (level.isEmpty()) opposite.delete(price);
    }

    return trades;
  }

  _addToBook(order) {
    const book = order.side === 'buy' ? this.bids : this.asks;
    if (!book.has(order.price)) book.set(order.price, new PriceLevel(order.price));
    book.get(order.price).add(order);
  }

  getBestBid() { return this.bids.size === 0 ? null : Math.max(...this.bids.keys()); }
  getBestAsk() { return this.asks.size === 0 ? null : Math.min(...this.asks.keys()); }
  getMidPrice() {
    const b = this.getBestBid(), a = this.getBestAsk();
    return (b && a) ? (b + a) / 2 : this.lastPrice;
  }
  getSpread() {
    const b = this.getBestBid(), a = this.getBestAsk();
    return (b && a) ? parseFloat((a - b).toFixed(4)) : null;
  }

  getDepth(levels = 12) {
    const sb = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, levels);
    const sa = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, levels);
    return {
      bids: sb.map(([price, l]) => ({ price, quantity: l.totalQuantity, orders: l.orders.length })),
      asks: sa.map(([price, l]) => ({ price, quantity: l.totalQuantity, orders: l.orders.length })),
    };
  }

  // Orders belonging to a specific client (for "my orders" panel)
  getClientOrders(clientId) {
    return [...this.orderMap.values()].filter(o => o.clientId === clientId);
  }

  getSnapshot() {
    return {
      symbol: this.symbol,
      bestBid: this.getBestBid(),
      bestAsk: this.getBestAsk(),
      spread: this.getSpread(),
      midPrice: this.getMidPrice(),
      lastPrice: this.lastPrice,
      lastTradeSize: this.lastTradeSize,
      depth: this.getDepth(12),
      trades: this.trades.slice(0, 40),
      stats: { ...this.stats },
      bidLevels: this.bids.size,
      askLevels: this.asks.size,
      timestamp: Date.now(),
    };
  }
}

module.exports = { Order, OrderBook, PriceLevel };
