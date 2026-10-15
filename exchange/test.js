// EXCHANGE engine tests: node exchange/test.js
const { Exchange, ExchangeError, isTick, nearestTick, tickUp, tickDown, pence } = require('./engine.js');
let pass = 0, fail = 0; const eq = (a, b, msg) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL', msg, '\n   got', JSON.stringify(a), '\n   want', JSON.stringify(b)); } };
const throws = (fn, code, msg) => { try { fn(); fail++; console.log('FAIL (no throw)', msg); } catch (e) { if (e.code === code) pass++; else { fail++; console.log('FAIL', msg, 'threw', e.code || e.message); } } };

// ladder
eq(isTick(1.99), true, 'tick 1.99'); eq(isTick(2.01), false, '2.01 not a tick'); eq(isTick(3.05), true, '3.05'); eq(isTick(5.1), true, '5.1'); eq(isTick(7.2), true, '7.2'); eq(isTick(15.5), true, '15.5'); eq(isTick(45), false, '45 not a tick'); eq(isTick(46), true, '46');
eq(nearestTick(2.03), 2.02, 'nearest 2.03'); eq(nearestTick(4.47), 4.5, 'nearest 4.47'); eq(tickUp(1.99), 2, 'up from 1.99'); eq(tickUp(2), 2.02, 'up from 2'); eq(tickDown(3), 2.98, 'down from 3'); eq(tickUp(1000), 1000, 'top');

// setup
const x = new Exchange({ commission: 0.05, minStake: 200 });
x.openAccount('ann'); x.openAccount('bob'); x.openAccount('cat'); x.deposit('ann', pence(100)); x.deposit('bob', pence(100)); x.deposit('cat', pence(50));
const m = x.createMarket({ name: '2:30 Ayr', runners: [{ id: 'r1', name: 'Alpha' }, { id: 'r2', name: 'Beta' }, { id: 'r3', name: 'Gamma' }] });

// 1. a lay rests, a back takes it at the lay's price
const lay1 = x.place({ account: 'bob', marketId: m.id, runnerId: 'r1', side: 'L', price: 3, stake: pence(10) });
eq(lay1.status, 'open', 'lay rests'); eq(x.exposure('bob'), pence(20), 'layer liability 10 x (3-1)'); eq(x.available('bob'), pence(80), 'bob available');
eq(x.view(m.id).runners[0].backs, [{ price: 3, stake: pence(10) }], 'ladder shows 10 to back at 3');
const back1 = x.place({ account: 'ann', marketId: m.id, runnerId: 'r1', side: 'B', price: 2.9, stake: pence(4) });
eq(back1.status, 'matched', 'back fully matched'); eq(back1.matched[0].price, 3, 'backer gets the resting price 3 (better than asked 2.9)'); eq(lay1.remaining, pence(6), 'lay partly filled');
eq(x.exposure('ann'), pence(4), 'ann risks her stake'); eq(m.pnlIfWins('ann').r1, pence(8), 'ann +8 if Alpha wins'); eq(m.pnlIfWins('ann').r2, -pence(4), 'ann -4 if Beta wins');
eq(m.pnlIfWins('bob').r1, -pence(8) , 'bob -8 if Alpha wins'); eq(m.pnlIfWins('bob').r2, pence(4), 'bob +4 otherwise');

// 2. a back that asks more than any lay offers rests on the back ladder; a later lay at or below takes it
const back2 = x.place({ account: 'ann', marketId: m.id, runnerId: 'r1', side: 'B', price: 3.5, stake: pence(5) });
eq(back2.status, 'open', 'back rests above market'); eq(x.view(m.id).runners[0].lays, [{ price: 3.5, stake: pence(5) }], 'lay side shows 5 at 3.5');
const lay2 = x.place({ account: 'cat', marketId: m.id, runnerId: 'r1', side: 'L', price: 3.6, stake: pence(5) });
eq(lay2.status, 'matched', 'lay at 3.6 matched the back asking 3.5'); eq(lay2.matched[0].price, 3.5, 'layer gets the resting 3.5'); eq(back2.status, 'matched', 'resting back filled');

// 3. price-time priority: two lays at same price, earlier fills first
const lA = x.place({ account: 'bob', marketId: m.id, runnerId: 'r2', side: 'L', price: 5, stake: pence(3) });
const lB = x.place({ account: 'cat', marketId: m.id, runnerId: 'r2', side: 'L', price: 5, stake: pence(3) });
x.place({ account: 'ann', marketId: m.id, runnerId: 'r2', side: 'B', price: 5, stake: pence(4) });
eq([lA.remaining, lB.remaining], [0, pence(2)], 'earlier lay filled first, second part-filled');

// 4. best price first: lays at 4.5 and 4, a back asking 4 takes the 4.5 first
x.place({ account: 'bob', marketId: m.id, runnerId: 'r3', side: 'L', price: 4.5, stake: pence(2) });
x.place({ account: 'bob', marketId: m.id, runnerId: 'r3', side: 'L', price: 4, stake: pence(2) });
const b3 = x.place({ account: 'ann', marketId: m.id, runnerId: 'r3', side: 'B', price: 4, stake: pence(3) });
eq(b3.matched.map(f => [f.price, f.stake]), [[4.5, pence(2)], [4, pence(1)]], 'sweeps best price first then next');

// 5. validation
throws(() => x.place({ account: 'ann', marketId: m.id, runnerId: 'r1', side: 'B', price: 2.01, stake: pence(5) }), 'BAD_PRICE', 'off-ladder price rejected');
throws(() => x.place({ account: 'ann', marketId: m.id, runnerId: 'r1', side: 'B', price: 2, stake: 100 }), 'MIN_STAKE', 'below min stake');
throws(() => x.place({ account: 'cat', marketId: m.id, runnerId: 'r1', side: 'L', price: 20, stake: pence(10) }), 'INSUFFICIENT_FUNDS', 'lay liability beyond funds');
throws(() => x.place({ account: 'zed', marketId: m.id, runnerId: 'r1', side: 'B', price: 2, stake: pence(5) }), 'NO_ACCOUNT', 'unknown account');

// 6. cancel frees exposure
const mc = x.createMarket({ name: 'cancel test', runners: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }] });
const lc = x.place({ account: 'cat', marketId: mc.id, runnerId: 'c1', side: 'L', price: 9, stake: pence(2) }); eq(mc.exposure('cat'), pence(16), 'resting lay 2 x (9-1) = 16 exposure');
x.cancel(lc.id, 'cat'); eq(mc.exposure('cat'), 0, 'cancel releases it'); eq(x.view(mc.id).runners[0].backs, [], 'ladder empty after cancel'); x.void(mc.id);
throws(() => x.cancel(lay1.id, 'ann'), 'NOT_YOURS', 'cannot cancel another account\'s order');

// 7. suspension blocks placing; in-play without permission suspends and lapses unmatched
m.suspend('off'); throws(() => x.place({ account: 'ann', marketId: m.id, runnerId: 'r1', side: 'B', price: 2, stake: pence(5) }), 'MARKET_SUSPENDED', 'suspended market'); m.reopen();
m.goInPlay(); eq(m.status, 'suspended', 'no in-play => suspended'); eq(lay1.remaining, 0, 'unmatched lapsed at the off'); eq(lay1.status, 'matched', 'partly matched lay keeps its fills');

// 8. settlement with commission: Alpha wins
const net = x.settle(m.id, 'r1');
// ann: r1 backs 4@3 (+8) and 5@3.5 (+12.5); r2 back 4@5 lost (-4); r3 back 2@4.5 + 1@4 lost (-3) => +13.5 gross, 5% comm = 0.675 -> 68p
eq(net.ann.pl, pence(13.5), 'ann gross +13.50'); eq(net.ann.commission, 68, 'ann commission 68p'); eq(x.account('ann').balance, pence(100) + pence(13.5) - 68, 'ann balance');
// bob: laid r1 4@3 (-8); laid r2 3@5 matched 3 of ann's 4 (+3); laid r3 2@4.5 (+2) and 1@4 (+1) => -2 gross, no commission
eq(net.bob.pl, -pence(2), 'bob gross -2'); eq(net.bob.commission, 0, 'no commission on a loss');
// cat: laid r1 5@3.5 (-12.5), laid r2 1@5 matched (+1) => -11.5
eq(net.cat.pl, -pence(11.5), 'cat gross -11.5');
eq(m.status, 'closed', 'market closed'); eq(x.exposure('ann'), 0, 'no exposure after settlement');
throws(() => x.settle(m.id, 'r1'), 'ALREADY_SETTLED', 'double settle rejected');
const sumBal = ['ann', 'bob', 'cat'].reduce((a, id) => a + x.account(id).balance, 0); eq(sumBal, pence(250) - 68, 'money conserved bar commission');

// 9. non-runner with reduction factor, then void market
const m2 = x.createMarket({ name: '3:00 Ayr', runners: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
x.place({ account: 'bob', marketId: m2.id, runnerId: 'a', side: 'L', price: 4, stake: pence(10) }); const ba = x.place({ account: 'ann', marketId: m2.id, runnerId: 'a', side: 'B', price: 4, stake: pence(10) });
const bb = x.place({ account: 'ann', marketId: m2.id, runnerId: 'b', side: 'B', price: 2, stake: pence(5) }); x.place({ account: 'cat', marketId: m2.id, runnerId: 'b', side: 'L', price: 2, stake: pence(5) });
x.removeRunner(m2.id, 'b', 0.25);
eq(bb.status, 'voided', 'bets on the non-runner voided'); eq(ba.matched[0].price, 3.25, 'reduction factor 25%: 4 -> 3.25');
const net2 = x.void(m2.id); eq(net2.ann ? net2.ann.pl : 0, 0, 'void market pays nothing'); eq(x.exposure('ann'), 0, 'void clears exposure');

// 10. persistence round trip
const j = JSON.parse(JSON.stringify(x.toJSON())); const y = Exchange.fromJSON(j);
eq(y.account('ann').balance, x.account('ann').balance, 'balance survives'); eq(y.markets.size, 3, 'markets survive'); eq(y.market(m.id).status, 'closed', 'status survives');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
