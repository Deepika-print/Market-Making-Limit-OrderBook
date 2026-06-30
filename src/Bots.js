'use strict';

/**
 * Server-side simulated market participants.
 * These run continuously on the Node process and trade against the
 * shared OrderBook, exactly like real liquidity providers would.
 */

class MarketMaker {
  constructor(book, { name, spread = 0.04, quoteSize = 60, intervalMs = 1200, onTrade }) {
    this.book = book;
    this.name = name;
    this.spread = spread;
    this.quoteSize = quoteSize;
    this.intervalMs = intervalMs;
    this.onTrade = onTrade || (() => {});
    this.inventory = 0;
    this.maxInventory = 600;
    this.timer = null;
    this.active = false;
  }

  start() {
    this.active = true;
    this._loop();
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
  }

  _loop() {
    if (!this.active) return;
    this._quote();
    const jitter = this.intervalMs * (0.7 + Math.random() * 0.6);
    this.timer = setTimeout(() => this._loop(), jitter);
  }

  _quote() {
    const mid = this.book.getMidPrice();
    const skew = (this.inventory / this.maxInventory) * 0.015;
    const bidPrice = parseFloat((mid - this.spread / 2 - skew).toFixed(2));
    const askPrice = parseFloat((mid + this.spread / 2 - skew).toFixed(2));
    const qty = Math.floor(this.quoteSize * (0.6 + Math.random() * 0.8));

    const buyRes = this.book.submitOrder({ side: 'buy', type: 'limit', price: bidPrice, quantity: qty, trader: this.name });
    const sellRes = this.book.submitOrder({ side: 'sell', type: 'limit', price: askPrice, quantity: qty, trader: this.name });

    buyRes.trades.forEach(t => { this.inventory += t.quantity; });
    sellRes.trades.forEach(t => { this.inventory -= t.quantity; });

    if (buyRes.trades.length || sellRes.trades.length) this.onTrade([...buyRes.trades, ...sellRes.trades]);
  }
}

class NoiseTrader {
  constructor(book, { name, intervalMs = 800, onTrade }) {
    this.book = book;
    this.name = name;
    this.intervalMs = intervalMs;
    this.onTrade = onTrade || (() => {});
    this.timer = null;
    this.active = false;
  }

  start() {
    this.active = true;
    this._loop();
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
  }

  _loop() {
    if (!this.active) return;
    this._trade();
    const jitter = this.intervalMs * (0.4 + Math.random() * 1.8);
    this.timer = setTimeout(() => this._loop(), jitter);
  }

  _trade() {
    const mid = this.book.getMidPrice();
    const isBuy = Math.random() > 0.5;
    const isMarket = Math.random() < 0.25;
    const qty = Math.floor(3 + Math.random() * 35);
    let res;

    if (isMarket) {
      res = this.book.submitOrder({ side: isBuy ? 'buy' : 'sell', type: 'market', price: isBuy ? mid + 2 : mid - 2, quantity: qty, trader: this.name });
    } else {
      const off = parseFloat((Math.random() * 0.15).toFixed(2));
      const price = parseFloat((mid + (isBuy ? -off : off)).toFixed(2));
      res = this.book.submitOrder({ side: isBuy ? 'buy' : 'sell', type: 'limit', price, quantity: qty, trader: this.name });
    }

    if (res.trades.length) this.onTrade(res.trades);
  }
}

module.exports = { MarketMaker, NoiseTrader };
