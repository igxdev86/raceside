// EXCHANGE — horse racing betting exchange core. Pure JS, no dependencies, runs in Node or the browser.
// One Exchange holds accounts and markets. A market is one race; each runner has a back ladder and a lay ladder.
// Money is held in integer pennies. Prices are decimal odds on the standard tick ladder. Matching is price-time priority.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Exchange = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- price ladder (Betfair-style increments) ----
  const BANDS = [[1.01, 2, 0.01], [2, 3, 0.02], [3, 4, 0.05], [4, 6, 0.1], [6, 10, 0.2], [10, 20, 0.5], [20, 30, 1], [30, 50, 2], [50, 100, 5], [100, 1000, 10]];
  const TICKS = (() => { const t = []; BANDS.forEach(([lo, hi, st]) => { for (let p = lo; p < hi - 1e-9; p = +(p + st).toFixed(2)) t.push(+p.toFixed(2)); }); t.push(1000); return t; })();
  const tickIndex = (p) => { let lo = 0, hi = TICKS.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (TICKS[mid] < p - 1e-9) lo = mid + 1; else hi = mid; } return lo; };
  const isTick = (p) => Math.abs(TICKS[tickIndex(p)] - p) < 1e-9;
  const nearestTick = (p) => { if (p <= 1.01) return 1.01; if (p >= 1000) return 1000; const i = tickIndex(p); const a = TICKS[i], b = TICKS[Math.max(0, i - 1)]; return Math.abs(a - p) <= Math.abs(b - p) ? a : b; };
  const tickUp = (p, n = 1) => TICKS[Math.min(TICKS.length - 1, tickIndex(p) + n)];
  const tickDown = (p, n = 1) => TICKS[Math.max(0, tickIndex(p) - n)];

  const pence = (gbp) => Math.round(Number(gbp) * 100);
  const gbp = (p) => p / 100;
  let seq = 0; const nextId = (pfx) => pfx + '_' + (++seq).toString(36) + '_' + Date.now().toString(36);

  class ExchangeError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

  // ---- accounts: balance, exposure, ledger ----
  class Account {
    constructor(id, opts = {}) { this.id = id; this.name = opts.name || id; this.balance = 0; this.ledger = []; this.commission = opts.commission != null ? opts.commission : null; this.createdAt = Date.now(); }
    post(type, amount, ref, note) { this.balance += amount; this.ledger.push({ id: nextId('L'), t: Date.now(), type, amount, balance: this.balance, ref: ref || null, note: note || '' }); return this.balance; }
  }

  // ---- orders ----
  // side: 'B' back (bets the runner wins) or 'L' lay (bets it does not). stake is the backer's stake in pence for both sides;
  // a lay's liability is stake * (price - 1). matched[] holds fills {price, stake, t, against}.
  class Order {
    constructor(o) { Object.assign(this, { id: nextId('O'), status: 'open', remaining: o.stake, matched: [], t: Date.now(), persistence: 'lapse' }, o); }
    get matchedStake() { return this.matched.reduce((a, m) => a + m.stake, 0); }
    get avgPrice() { const s = this.matchedStake; return s ? this.matched.reduce((a, m) => a + m.price * m.stake, 0) / s : null; }
    liabilityOf(stake, price) { return this.side === 'B' ? stake : Math.round(stake * (price - 1)); }
    get restingLiability() { return this.remaining > 0 ? this.liabilityOf(this.remaining, this.price) : 0; }
  }

  // ---- a runner's two ladders ----
  class Book {
    constructor(runnerId) { this.runnerId = runnerId; this.backs = []; this.lays = []; }   // backs: offers to back = money wanting to BACK, waiting for layers; lays: money wanting to LAY, waiting for backers
    // resting backs sorted best-for-a-layer first (highest price = the backer is asking the most), lays sorted lowest price first (the layer is offering the shortest)
    ladder(side, depth = 3) { const arr = side === 'B' ? this.backs : this.lays; const agg = new Map(); arr.forEach(o => { if (o.remaining > 0) agg.set(o.price, (agg.get(o.price) || 0) + o.remaining); });
      // resting LAYS are what a backer can take: best = highest price first. resting BACKS are what a layer can take: best = lowest first.
      const rows = [...agg.entries()].map(([price, stake]) => ({ price, stake })); rows.sort((a, b) => side === 'L' ? b.price - a.price : a.price - b.price); return rows.slice(0, depth); }
    bestBack() { const r = this.ladder('L', 1)[0]; return r ? r.price : null; }   // best price a BACKER can take = highest resting lay
    bestLay() { const r = this.ladder('B', 1)[0]; return r ? r.price : null; }    // best price a LAYER can take = lowest resting back
    lastTraded() { return this._last || null; }
  }

  // ---- market = one race ----
  class Market {
    constructor(x, m) { this.x = x; this.id = m.id || nextId('M'); this.name = m.name || ''; this.venue = m.venue || ''; this.start = m.start || null; this.status = 'open'; this.inPlay = false; this.inPlayAllowed = !!m.inPlayAllowed;
      this.runners = new Map(); (m.runners || []).forEach(r => this.addRunner(r)); this.orders = new Map(); this.trades = []; this.result = null; this.settledAt = null; }
    addRunner(r) { const id = r.id || nextId('R'); this.runners.set(id, { id, name: r.name, status: 'active', sp: r.sp || null, reductionFactor: r.reductionFactor || 0, book: new Book(id) }); return id; }
    runner(id) { const r = this.runners.get(id); if (!r) throw new ExchangeError('NO_RUNNER'); return r; }
    suspend(reason) { this.status = 'suspended'; this.suspendReason = reason || ''; }
    reopen() { if (this.status === 'closed') throw new ExchangeError('CLOSED'); this.status = 'open'; }
    goInPlay() { this.inPlay = true; this.lapseUnmatched('in-play'); if (!this.inPlayAllowed) this.suspend('in-play'); else this.status = 'open'; }   // unmatched money lapses at the off unless it was placed with persistence 'persist'
    lapseUnmatched(reason) { this.orders.forEach(o => { if (o.remaining > 0 && o.persistence === 'lapse') this.x._cancel(this, o, reason || 'lapsed'); }); }

    // exposure for an account in this market = the worst outcome across runners (what it could lose), counting matched bets and resting orders' liability
    exposure(accountId) { let worst = 0; const base = {}; const ids = [...this.runners.keys()];
      this.orders.forEach(o => { if (o.account !== accountId) return;
        o.matched.forEach(f => { ids.forEach(rid => { const win = rid === o.runnerId; const pl = o.side === 'B' ? (win ? Math.round(f.stake * (f.price - 1)) : -f.stake) : (win ? -Math.round(f.stake * (f.price - 1)) : f.stake); base[rid] = (base[rid] || 0) + pl; }); });
        if (o.remaining > 0) { ids.forEach(rid => { const win = rid === o.runnerId; const pl = o.side === 'B' ? (win ? 0 : -o.remaining) : (win ? -Math.round(o.remaining * (o.price - 1)) : 0); base[rid] = (base[rid] || 0) + pl; }); } });
      ids.forEach(rid => { if ((base[rid] || 0) < worst) worst = base[rid]; }); return -worst; }
    // profit/loss per runner if that runner wins, matched bets only
    pnlIfWins(accountId) { const out = {}; const ids = [...this.runners.keys()]; ids.forEach(r => out[r] = 0);
      this.orders.forEach(o => { if (o.account !== accountId) return; o.matched.forEach(f => { ids.forEach(rid => { const win = rid === o.runnerId; out[rid] += o.side === 'B' ? (win ? Math.round(f.stake * (f.price - 1)) : -f.stake) : (win ? -Math.round(f.stake * (f.price - 1)) : f.stake); }); }); }); return out; }
  }

  // ---- the exchange ----
  class Exchange {
    constructor(opts = {}) { this.accounts = new Map(); this.markets = new Map(); this.commission = opts.commission != null ? opts.commission : 0.05; this.minStake = opts.minStake != null ? opts.minStake : 200; this.events = []; this.onEvent = opts.onEvent || null; }
    emit(type, data) { const e = { t: Date.now(), type, ...data }; this.events.push(e); if (this.onEvent) this.onEvent(e); return e; }

    openAccount(id, opts) { if (this.accounts.has(id)) throw new ExchangeError('ACCOUNT_EXISTS'); const a = new Account(id, opts); this.accounts.set(id, a); return a; }
    account(id) { const a = this.accounts.get(id); if (!a) throw new ExchangeError('NO_ACCOUNT'); return a; }
    deposit(id, amount, note) { return this.account(id).post('deposit', amount, null, note); }
    withdraw(id, amount) { const a = this.account(id); if (this.available(id) < amount) throw new ExchangeError('INSUFFICIENT_FUNDS'); return a.post('withdraw', -amount); }
    exposure(id) { let e = 0; this.markets.forEach(m => { if (m.status !== 'closed') e += m.exposure(id); }); return e; }
    available(id) { return this.account(id).balance - this.exposure(id); }

    createMarket(m) { const mk = new Market(this, m); this.markets.set(mk.id, mk); this.emit('market', { marketId: mk.id, status: 'open' }); return mk; }
    market(id) { const m = this.markets.get(id); if (!m) throw new ExchangeError('NO_MARKET'); return m; }

    // place a back or lay. Matches immediately against the opposite ladder at the order's price or better; any remainder rests on the book.
    place({ account, marketId, runnerId, side, price, stake, persistence }) {
      const m = this.market(marketId); const r = m.runner(runnerId); this.account(account);
      if (m.status !== 'open') throw new ExchangeError('MARKET_' + m.status.toUpperCase());
      if (r.status !== 'active') throw new ExchangeError('RUNNER_' + r.status.toUpperCase());
      if (side !== 'B' && side !== 'L') throw new ExchangeError('BAD_SIDE');
      if (!isTick(price)) throw new ExchangeError('BAD_PRICE', 'price is not on the ladder');
      stake = Math.round(stake); if (!(stake >= this.minStake)) throw new ExchangeError('MIN_STAKE');
      const o = new Order({ account, marketId, runnerId, side, price, stake, persistence: persistence || 'lapse' });
      // funds check: the order's own worst-case liability must be covered by what is free right now
      const need = o.liabilityOf(stake, price); if (this.available(account) < need) throw new ExchangeError('INSUFFICIENT_FUNDS');
      m.orders.set(o.id, o); this._match(m, r, o); if (o.remaining > 0) (side === 'B' ? r.book.backs : r.book.lays).push(o);
      o.status = o.remaining === 0 ? 'matched' : (o.matched.length ? 'part' : 'open');
      this.emit('order', { orderId: o.id, account, marketId, runnerId, side, price, stake, matched: o.matchedStake, status: o.status }); return o;
    }

    _match(m, r, o) {
      // a BACK at price p wants p or more: it takes resting LAYS priced >= p, highest first. a LAY at p will give p or less: it takes resting BACKS priced <= p, lowest first.
      const opp = o.side === 'B' ? r.book.lays : r.book.backs;
      opp.sort((a, b) => (o.side === 'B' ? b.price - a.price : a.price - b.price) || a.t - b.t);
      for (const c of opp) { if (o.remaining <= 0) break; if (c.remaining <= 0 || c.account === o.account && this.noSelfMatch) continue;
        const ok = o.side === 'B' ? c.price >= o.price : c.price <= o.price; if (!ok) break;
        const fill = Math.min(o.remaining, c.remaining); const price = c.price;   // the resting order sets the price (price improvement goes to the taker)
        o.remaining -= fill; c.remaining -= fill; const t = Date.now();
        o.matched.push({ price, stake: fill, t, against: c.id }); c.matched.push({ price, stake: fill, t, against: o.id });
        c.status = c.remaining === 0 ? 'matched' : 'part'; r.book._last = price;
        m.trades.push({ id: nextId('T'), marketId: m.id, runnerId: r.id, price, stake: fill, t, back: o.side === 'B' ? o.id : c.id, lay: o.side === 'L' ? o.id : c.id });
        this.emit('trade', { marketId: m.id, runnerId: r.id, price, stake: fill }); }
      for (const arr of [r.book.backs, r.book.lays]) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].remaining === 0) arr.splice(i, 1); }
    }

    cancel(orderId, account) { for (const m of this.markets.values()) { const o = m.orders.get(orderId); if (o) { if (account && o.account !== account) throw new ExchangeError('NOT_YOURS'); if (o.remaining === 0) throw new ExchangeError('NOTHING_TO_CANCEL'); return this._cancel(m, o, 'cancelled'); } } throw new ExchangeError('NO_ORDER'); }
    _cancel(m, o, reason) { const r = m.runner(o.runnerId); const arr = o.side === 'B' ? r.book.backs : r.book.lays; const i = arr.indexOf(o); if (i >= 0) arr.splice(i, 1); const was = o.remaining; o.remaining = 0; o.status = o.matched.length ? 'matched' : reason; o.cancelled = was; this.emit('cancel', { orderId: o.id, marketId: m.id, remaining: was, reason }); return o; }

    // non-runner: void every bet on it, apply the reduction factor to matched prices on the other runners (Tattersalls Rule 4 style)
    removeRunner(marketId, runnerId, reductionFactor) {
      const m = this.market(marketId); const r = m.runner(runnerId); r.status = 'removed'; r.reductionFactor = reductionFactor || 0;
      m.orders.forEach(o => { if (o.runnerId === runnerId) { if (o.remaining > 0) this._cancel(m, o, 'voided'); o.matched.forEach(f => { f.void = true; }); o.status = 'voided'; } });
      if (reductionFactor > 0) m.orders.forEach(o => { if (o.runnerId === runnerId) return; o.matched.forEach(f => { if (f.void) return; f.priceBefore = f.priceBefore || f.price; f.price = Math.max(1.01, +(1 + (f.price - 1) * (1 - reductionFactor)).toFixed(2)); }); });
      this.emit('runner', { marketId, runnerId, status: 'removed', reductionFactor });
    }

    // settle: pay every matched bet, then commission on each account's net profit in the market
    settle(marketId, winnerId, opts = {}) {
      const m = this.market(marketId); if (m.status === 'closed') throw new ExchangeError('ALREADY_SETTLED'); if (winnerId !== null && !m.runners.has(winnerId)) throw new ExchangeError('NO_RUNNER');
      m.suspend('settling'); m.lapseUnmatched('settled'); const net = {};
      m.orders.forEach(o => { o.matched.forEach(f => { if (f.void) return; let pl;
        if (winnerId === null) pl = 0;   // void market: stakes returned, nothing won or lost
        else { const win = o.runnerId === winnerId; pl = o.side === 'B' ? (win ? Math.round(f.stake * (f.price - 1)) : -f.stake) : (win ? -Math.round(f.stake * (f.price - 1)) : f.stake); }
        net[o.account] = (net[o.account] || 0) + pl; f.settledPl = pl; }); o.status = o.matched.length ? 'settled' : o.status; });
      Object.entries(net).forEach(([acc, pl]) => { const a = this.account(acc); if (pl) a.post(pl > 0 ? 'win' : 'loss', pl, m.id, m.name);
        const rate = a.commission != null ? a.commission : this.commission; const comm = pl > 0 ? Math.round(pl * rate) : 0; if (comm) a.post('commission', -comm, m.id, (rate * 100) + '%'); net[acc] = { pl, commission: comm, net: pl - comm }; });
      m.result = winnerId; m.status = 'closed'; m.settledAt = Date.now(); this.emit('settled', { marketId, winnerId, net }); return net;
    }
    void(marketId) { return this.settle(marketId, null); }

    // snapshot for a UI: ladders, last traded, totals
    view(marketId, accountId) { const m = this.market(marketId); const runners = [...m.runners.values()].map(r => ({ id: r.id, name: r.name, status: r.status, backs: r.book.ladder('L', 3), lays: r.book.ladder('B', 3), last: r.book.lastTraded(), traded: m.trades.filter(t => t.runnerId === r.id).reduce((a, t) => a + t.stake, 0) }));
      const mine = accountId ? [...m.orders.values()].filter(o => o.account === accountId).map(o => ({ id: o.id, runnerId: o.runnerId, side: o.side, price: o.price, stake: o.stake, remaining: o.remaining, matched: o.matchedStake, avg: o.avgPrice, status: o.status })) : [];
      return { id: m.id, name: m.name, venue: m.venue, start: m.start, status: m.status, inPlay: m.inPlay, runners, traded: m.trades.reduce((a, t) => a + t.stake, 0), mine, pnl: accountId ? m.pnlIfWins(accountId) : null, exposure: accountId ? m.exposure(accountId) : null }; }

    // persistence: plain JSON in, plain JSON out
    toJSON() { return { commission: this.commission, minStake: this.minStake, accounts: [...this.accounts.values()], markets: [...this.markets.values()].map(m => ({ id: m.id, name: m.name, venue: m.venue, start: m.start, status: m.status, inPlay: m.inPlay, inPlayAllowed: m.inPlayAllowed, result: m.result, settledAt: m.settledAt, runners: [...m.runners.values()].map(r => ({ id: r.id, name: r.name, status: r.status, sp: r.sp || null, reductionFactor: r.reductionFactor, last: r.book._last || null })), orders: [...m.orders.values()], trades: m.trades })) }; }
    static fromJSON(j, opts) { const x = new Exchange({ ...(opts || {}), commission: j.commission, minStake: j.minStake }); (j.accounts || []).forEach(a => { const acc = x.openAccount(a.id, { name: a.name, commission: a.commission }); acc.balance = a.balance; acc.ledger = a.ledger || []; });
      (j.markets || []).forEach(mj => { const m = new Market(x, { id: mj.id, name: mj.name, venue: mj.venue, start: mj.start, inPlayAllowed: mj.inPlayAllowed }); m.status = mj.status; m.inPlay = mj.inPlay; m.result = mj.result; m.settledAt = mj.settledAt;
        (mj.runners || []).forEach(r => { m.addRunner({ id: r.id, name: r.name, sp: r.sp, reductionFactor: r.reductionFactor }); const rr = m.runners.get(r.id); rr.status = r.status; rr.book._last = r.last; });
        (mj.orders || []).forEach(oj => { const o = new Order(oj); m.orders.set(o.id, o); if (o.remaining > 0 && o.status !== 'voided') { const rr = m.runners.get(o.runnerId); (o.side === 'B' ? rr.book.backs : rr.book.lays).push(o); } }); m.trades = mj.trades || []; x.markets.set(m.id, m); }); return x; }
  }

  return { Exchange, Market, Order, Account, ExchangeError, TICKS, isTick, nearestTick, tickUp, tickDown, pence, gbp };
});
