// RACINGPREDICT — accounts, balance, buys, settlement. Server-side truth.
// POST { op:'new' }                          → create account { id, token, bal:1000 }
// POST { op:'login', code }                  → code = "id.token" → account state
// POST { op:'state', id, token }             → settle matured positions, return state
// POST { op:'buy', id, token, k, h, stake }  → server prices the horse from the live feed and executes
// Accounts live in rs_kv as rpacct:<id>. The server computes the implied % — the client's number is never trusted.

export const config = { maxDuration: 30 };

function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}
const BASE = 'https://raceside.vercel.app';
const rk = (t, c) => String(t).replace(/\s.*/, '') + '|' + String(c).replace(/\s*\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hk = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const raceMin = (t) => { const m = String(t || '').match(/(\d{1,2})[:. ](\d{2})/); if (!m) return -1; let hh = Number(m[1]); if (hh < 10) hh += 12; return hh * 60 + Number(m[2]); };
const ukHM = (now) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now || new Date()); const g = (t) => Number(p.find(x => x.type === t).value); return g('hour') * 60 + g('minute'); };
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
  let w = null;
  try { const r = await fetch(BASE + '/api/todaywinners'); w = await r.json(); } catch {}
  if (!(w && w.ok)) return false;
  const winMap = {};
  (w.winners || []).forEach(x => { winMap[rk(x.t, x.course)] = hk(x.h); });
  let changed = false;
  open.forEach(p => {
    const wn = winMap[p.k];
    if (wn === undefined) return;
    p.settled = 1; p.won = wn === hk(p.h) ? 1 : 0; changed = true;
    if (p.won) { p.pay = Math.round(p.stake / p.p); acct.bal += p.pay; }
  });
  return changed;
}

const pub = (acct) => ({ ok: true, id: acct.id, bal: Math.round(acct.bal), pos: (acct.pos || []).slice(-40) });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const s = supa();
  if (!s) return res.status(200).json({ ok: false, error: 'store unavailable' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const op = String(b.op || '');

  if (op === 'new') {
    const id = 'rp' + rand(6), token = rand(24);
    const acct = { id, token, bal: 1000, pos: [], created: new Date().toISOString() };
    if (!await kvSet(s, 'rpacct:' + id, acct)) return res.status(200).json({ ok: false, error: 'store write failed' });
    return res.status(200).json({ ...pub(acct), token });
  }

  if (op === 'login') {
    const [id, token] = String(b.code || '').trim().split('.');
    const acct = id ? await kvGet(s, 'rpacct:' + id) : null;
    if (!acct || acct.token !== token) return res.status(200).json({ ok: false, error: 'bad code' });
    if (await settle(acct)) await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json({ ...pub(acct), token: acct.token });
  }

  const acct = b.id ? await kvGet(s, 'rpacct:' + String(b.id)) : null;
  if (!acct || acct.token !== b.token) return res.status(200).json({ ok: false, error: 'bad account' });

  if (op === 'state') {
    if (await settle(acct)) await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json(pub(acct));
  }

  if (op === 'reset') {
    if ((acct.pos || []).some(p => !p.settled)) return res.status(200).json({ ok: false, error: 'open positions' });
    if (acct.bal >= 10) return res.status(200).json({ ok: false, error: 'not bust' });
    acct.bal = 1000; acct.pos = [];
    await kvSet(s, 'rpacct:' + acct.id, acct);
    return res.status(200).json(pub(acct));
  }

  if (op === 'buy') {
    const stake = Math.floor(Number(b.stake));
    if (!(stake >= 5 && stake <= 200)) return res.status(200).json({ ok: false, error: 'stake 5–200' });
    if (acct.bal < stake) return res.status(200).json({ ok: false, error: 'not enough points' });
    let up = null;
    try { const r = await fetch(BASE + '/api/upcoming?v=4'); up = await r.json(); } catch {}
    if (!(up && up.ok)) return res.status(200).json({ ok: false, error: 'feed unavailable' });
    const rides = (up.rides || []).filter(r => r.day === 'today' && Number(r.d) > 1 && rk(r.t, r.course) === String(b.k));
    if (rides.length < 3) return res.status(200).json({ ok: false, error: 'market not found' });
    const now = req.query && req.query.now ? new Date(String(req.query.now)) : new Date();
    if (raceMin(rides[0].t) <= ukHM(now)) return res.status(200).json({ ok: false, error: 'market closed — race is off' });
    const pick = rides.find(r => hk(r.h) === hk(String(b.h || '')));
    if (!pick) return res.status(200).json({ ok: false, error: 'horse not found' });
    const Z = rides.reduce((a, r) => a + 1 / r.d, 0);
    const p = (1 / pick.d) / Z;                       // the server's price — client numbers ignored
    acct.bal -= stake;
    acct.pos = (acct.pos || []).concat([{ k: b.k, h: pick.h, p: Number(p.toFixed(4)), stake, at: new Date().toISOString() }]);
    if (!await kvSet(s, 'rpacct:' + acct.id, acct)) return res.status(200).json({ ok: false, error: 'store write failed' });
    return res.status(200).json({ ...pub(acct), bought: { h: pick.h, p: Number(p.toFixed(4)), stake } });
  }

  return res.status(200).json({ ok: false, error: 'unknown op' });
}
