// RACINGPREDICT — a demo book. Accounts, balance, bets at live odds, settlement. Server-side truth.
// POST { op:'new' }                          → create account { id, token, bal:1000 }
// POST { op:'login', code }                  → code = "id.token" → account state
// POST { op:'state', id, token }             → settle matured positions, return state
// POST { op:'buy', id, token, k, h, stake }  → server prices the horse from the live feed and executes
// Accounts live in rs_kv as rpacct:<id>. The server computes the implied % — the client's number is never trusted.
// Demo balance: 50,000. Every bet is recorded with race, price and outcome; totals ride along.

export const config = { maxDuration: 30 };

function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}
const BASE = 'https://raceside.vercel.app';
const rk = (t, c) => String(t).replace(/\s.*/, '') + '|' + String(c).replace(/\s*\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ukDate = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(Date.now() + (offsetDays || 0) * 86400000));
const hk = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const raceMin = (t) => { const m = String(t || '').match(/(\d{1,2})[:. ](\d{2})/); if (!m) return -1; let hh = Number(m[1]); if (hh < 10) hh += 12; return hh * 60 + Number(m[2]); };
const ukHM = (now) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now || new Date()); const g = (t) => Number(p.find(x => x.type === t).value); return g('hour') * 60 + g('minute'); };
// standard UK each-way terms from field size + handicap status; null = win only
const ewTerms = (n, hcp) => n < 5 ? null : n <= 7 ? { pl: 2, fr: 0.25 } : hcp ? (n >= 16 ? { pl: 4, fr: 0.25 } : n >= 12 ? { pl: 3, fr: 0.25 } : { pl: 3, fr: 0.2 }) : { pl: 3, fr: 0.2 };
const rand = (n) => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };

async function kvGet(s, k) {
  const r = await fetch(`${s.url}/rest/v1/rs_kv?k=eq.${encodeURIComponent(k)}&select=v`, { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows[0] ? rows[0].v : null;
}
async function kvSet(s, k, v) {
  const r = await fetch(`${s.url}/rest/v1/rs_kv?on_conflict=k`, {
    method: 'POST',
    headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ k, v }]),
  });
  return r.ok;
}

async function settle(acct) {
  const open = (acct.pos || []).filter(p => !p.settled);
  if (!open.length) return false;
  let changed = false;

  // SP-era bets: settle from the results feed — winner AND official SP per runner, per bet date
  const spOpen = open.filter(p => p.sp === null);
  const dates = [...new Set(spOpen.map(p => String(p.k).slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))];
  for (const dt of dates) {
    let j = null;
    try { const r = await fetch(BASE + '/api/priceday?v=5&date=' + dt); j = await r.json(); } catch {}
    if (!(j && j.ok)) continue;
    const byRace = {};
    (j.races || []).forEach(rc => { byRace[dt + '|' + rk(rc.t, rc.course)] = rc; });
    spOpen.filter(p => String(p.k).slice(0, 10) === dt).forEach(p => {
      const rc = byRace[p.k];
      if (!rc || !(rc.runners || []).some(r => r.pos === '1' || r.won === 1)) return;   // result not in yet
      const mine = (rc.runners || []).find(r => hk(r.h) === hk(p.h));
      changed = true;
      const cost = p.ew ? p.stake * 2 : p.stake;
      if (!mine) { p.settled = 1; p.won = 0; p.voided = 1; p.pay = cost; acct.bal += cost; return; }   // non-runner: full stake back
      p.sp = Number(mine.d) > 1 ? Number(mine.d) : null;
      p.settled = 1;
      const sp = p.sp || p.g || 0;
      const posN = Number(mine.pos) || (mine.won === 1 ? 1 : 99);
      let pay = 0;
      if (posN === 1) pay += p.stake * sp;                                        // win part
      if (p.ew && p.pl && posN <= p.pl) pay += p.stake * (1 + (sp - 1) * p.fr);   // place part at fractional odds
      p.won = pay > 0 ? 1 : 0;
      p.placed = p.ew && posN <= (p.pl || 0) ? posN : undefined;
      if (pay > 0) { p.pay = Math.round(pay); acct.bal += p.pay; }
    });
  }

  // legacy market-era and odds-era bets: winner feed as before
  const legacy = open.filter(p => p.sp !== null && p.sp === undefined || (p.o || p.p) && !p.settled);
  if (legacy.length) {
    let w = null;
    try { const r = await fetch(BASE + '/api/todaywinners'); w = await r.json(); } catch {}
    if (w && w.ok) {
      const winMap = {};
      const td = ukDate(0);
      (w.winners || []).forEach(x => { const base = rk(x.t, x.course); winMap[td + '|' + base] = hk(x.h); winMap[base] = hk(x.h); });
      legacy.forEach(p => {
        const wn = winMap[p.k];
        if (wn === undefined) return;
        p.settled = 1;
        const hit = wn === hk(p.h);
        p.won = (p.side === 'no' ? !hit : hit) ? 1 : 0;
        changed = true;
        if (p.won) { p.pay = Math.round(p.o ? p.stake * p.o : p.stake / p.p); acct.bal += p.pay; }
      });
    }
  }
  return changed;
}

const pub = (acct) => {
  const pos = acct.pos || [];
  const tot = { bets: pos.length, staked: 0, returned: 0 };
  pos.forEach(p => { tot.staked += p.stake; if (p.settled && p.won) tot.returned += p.pay || 0; });
  tot.pl = Math.round(tot.returned - pos.filter(p => p.settled).reduce((a, p) => a + p.stake, 0));
  return { ok: true, id: acct.id, bal: Math.round(acct.bal), pos: pos.slice(-60), tot };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const s = supa();
  if (!s) return res.status(200).json({ ok: false, error: 'store unavailable' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const op = String(b.op || '');

  if (op === 'new') {
    const id = 'rp' + rand(6), token = rand(24);
    const acct = { id, token, bal: 50000, mv2: 1, pos: [], created: new Date().toISOString() };
    if (!await kvSet(s, 'rpacct:' + id, acct)) return res.status(200).json({ ok: false, error: 'store write failed' });
    return res.status(200).json({ ...pub(acct), token });
  }

  const migrate = (a) => { if (a && !a.mv2) { a.bal += 49000; a.mv2 = 1; return true; } return false; };

  if (op === 'login') {
    const [id, token] = String(b.code || '').trim().split('.');
    const acct = id ? await kvGet(s, 'rpacct:' + id) : null;
    if (!acct || acct.token !== token) return res.status(200).json({ ok: false, error: 'bad code' });
    if (migrate(acct)) await kvSet(s, 'rpacct:' + acct.id, acct);
    if (await settle(acct)) await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json({ ...pub(acct), token: acct.token });
  }

  const acct = b.id ? await kvGet(s, 'rpacct:' + String(b.id)) : null;
  if (!acct || acct.token !== b.token) return res.status(200).json({ ok: false, error: 'bad account' });
  if (migrate(acct)) await kvSet(s, 'rpacct:' + acct.id, acct);

  if (op === 'state') {
    if (await settle(acct)) await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json(pub(acct));
  }

  if (op === 'deposit') {
    const amt = Math.floor(Number(b.amt || 10000));
    if (!(amt >= 100 && amt <= 100000)) return res.status(200).json({ ok: false, error: 'deposit 100–100,000' });
    if (acct.bal + amt > 10000000) return res.status(200).json({ ok: false, error: 'balance cap reached' });
    acct.bal += amt;
    await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json(pub(acct));
  }

  if (op === 'withdraw') {
    const amt = Math.min(Math.floor(Number(b.amt || 10000)), acct.bal);
    if (!(amt > 0)) return res.status(200).json({ ok: false, error: 'nothing to withdraw' });
    acct.bal -= amt;
    await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json({ ...pub(acct), withdrew: amt });
  }

  if (op === 'reset') {
    if ((acct.pos || []).some(p => !p.settled)) return res.status(200).json({ ok: false, error: 'open positions' });
    if (acct.bal >= 100) return res.status(200).json({ ok: false, error: 'not bust' });
    acct.bal = 50000; acct.pos = [];
    await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json(pub(acct));
  }

  if (op === 'buy') {
    const stake = Math.floor(Number(b.stake));
    if (!(stake >= 10 && stake <= 5000)) return res.status(200).json({ ok: false, error: 'stake 10–5,000' });
    if (acct.bal < stake) return res.status(200).json({ ok: false, error: 'not enough points' });
    let up = null;
    try { const r = await fetch(BASE + '/api/upcoming?v=4'); up = await r.json(); } catch {}
    if (!(up && up.ok)) return res.status(200).json({ ok: false, error: 'feed unavailable' });
    // markets are keyed by UK date so today and tomorrow never collide: YYYY-MM-DD|time|course
    const rides = (up.rides || []).filter(r => (r.day === 'today' || r.day === 'tomorrow') && Number(r.d) > 1 && (ukDate(r.day === 'tomorrow' ? 1 : 0) + '|' + rk(r.t, r.course)) === String(b.k));
    if (rides.length < 3) return res.status(200).json({ ok: false, error: 'market not found' });
    const now = req.query && req.query.now ? new Date(String(req.query.now)) : new Date();
    if (rides[0].day === 'today' && raceMin(rides[0].t) <= ukHM(now)) return res.status(200).json({ ok: false, error: 'market closed — race is off' });
    const pick = rides.find(r => hk(r.h) === hk(String(b.h || '')));
    if (!pick) return res.status(200).json({ ok: false, error: 'horse not found' });
    // SP bet: no price locked at strike — settles at the official starting price from the results feed
    const g = Number(pick.d);                          // current price, recorded as a guide only
    const n = Number(rides[0].n) || rides.length;
    const hcp = /handicap/i.test(String(rides[0].rtype || '') + ' ' + String(rides[0].rname || ''));
    let ew = 0, terms = null, cost = stake;
    if (b.ew) {
      terms = ewTerms(n, hcp);
      if (!terms) return res.status(200).json({ ok: false, error: 'win only — fewer than 5 runners' });
      ew = 1; cost = stake * 2;                         // an E/W bet is a win stake AND a place stake
      if (acct.bal < cost) return res.status(200).json({ ok: false, error: 'not enough for E/W (2× stake)' });
    }
    acct.bal -= cost;
    acct.pos = (acct.pos || []).concat([{ k: b.k, t: rides[0].t, course: String(rides[0].course).replace(/\s*\([^)]*\)/g, ''), h: pick.h, sp: null, g, stake, ew, ...(terms ? { pl: terms.pl, fr: terms.fr } : {}), at: new Date().toISOString() }]);
    if (!await kvSet(s, 'rpacct:' + acct.id, acct)) return res.status(200).json({ ok: false, error: 'store write failed' });
    return res.status(200).json({ ...pub(acct), bought: { h: pick.h, g, stake } });
  }

  return res.status(200).json({ ok: false, error: 'unknown op' });
}
