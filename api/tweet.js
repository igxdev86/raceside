// Post the day's most-minus horses to X.
// Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>; manual calls use ?key=<TWEET_KEY>.
// ?dry=1 composes without posting. Env needed: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
// X_ACCESS_SECRET, TWEET_KEY, CRON_SECRET.
import crypto from 'crypto';

const pctB = (bucket) => {
  const list = Object.entries(bucket || {}).filter(([, s]) => s.runs >= 100 && s.exp > 0)
    .map(([id, s]) => ({ id, ae: s.wins / s.exp })).sort((a, b) => b.ae - a.ae);
  const map = {}; const n = list.length;
  list.forEach((x, i) => { map[x.id] = n > 1 ? (1 - i / (n - 1)) * 100 : 50; });
  return map;
};
const clm = (nm) => { const m = String(nm || '').match(/\((\d)\)/); return m ? Number(m[1]) : 0; };
const nameN = (s) => String(s || '').toLowerCase().replace(/\s*\([a-z]{2,3}\)\s*$/i, '').replace(/[^a-z0-9]/g, '');
const raceMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); if (!m) return 9999; let hh = Number(m[1]); if (hh < 10) hh += 12; return hh * 60 + Number(m[2]); };

export function composePicks(rides, store, maxPicks) {
  const pj = pctB(store.jockeys), pt = pctB(store.trainers);
  const today = (rides || []).filter(r => r.day === 'today');
  const byRace = {};
  today.forEach(r => { (byRace[r.t + '|' + r.course] = byRace[r.t + '|' + r.course] || []).push(r); });
  const picks = [];
  Object.values(byRace).forEach(fieldRaw => {
    const seen = {};
    const field = fieldRaw.filter(r => { r.d = Number(r.d); if (!(r.d > 1)) r.d = null; const k = nameN(r.h); if (seen[k]) return false; seen[k] = 1; return true; });
    const orVals = field.map(r => r.ofr).filter(v => v != null);
    if (orVals.length < 2) return;   // the model is people-only there — not tweetable
    const orMean = orVals.reduce((a, b) => a + b, 0) / orVals.length;
    const maxOr = Math.max(...orVals);
    const okF = field.filter(r => r.ofr != null && r.lbs != null);
    const advM = {};
    if (okF.length >= 2) {
      const top = okF.reduce((a, b) => b.ofr > a.ofr ? b : a, okF[0]);
      const car = (r) => r.lbs - clm(r.jockey);
      const topC = car(top);
      okF.forEach(r => { advM[r.h] = (r.ofr + (topC - car(r))) - top.ofr; });
    }
    const strengths = field.map(r => {
      const parts = [];
      if (r.jid && pj[r.jid] != null) parts.push(pj[r.jid]);
      if (r.tid && pt[r.tid] != null) parts.push(pt[r.tid]);
      const sc = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
      return 0.8 * (sc - 50) / 50 + 0.6 * (r.ofr != null ? r.ofr - orMean : 0) / 20 + 0.5 * (advM[r.h] || 0) / 10;
    });
    const exps = strengths.map(s => Math.exp(s));
    const tot = exps.reduce((a, b) => a + b, 0);
    let deep = null, deepEdge = 0;
    field.forEach((r, i) => {
      if (!(r.d > 1)) return;
      const e = ((exps[i] / tot) - 1 / r.d) / (1 / r.d);
      if (isFinite(e) && e < deepEdge) { deepEdge = e; deep = r; }
    });
    if (!deep) return;
    picks.push({ t: deep.t, course: deep.course, h: deep.h, d: deep.d, edge: deepEdge, topOr: deep.ofr === maxOr });
  });
  picks.sort((a, b) => a.edge - b.edge);
  return picks.slice(0, maxPicks || 5).sort((a, b) => raceMin(a.t) - raceMin(b.t));
}

export function composeText(picks, dateStr) {
  const lines = picks.map(p => `${p.t} ${p.course} \u2014 ${p.h} ${Math.round(p.edge * 100)}% @ ${p.d}${p.topOr ? ' \u00b7 top OR' : ''}`);
  let text = `THE MOST-BACKED \u00b7 ${dateStr}\nWhere the market leans hardest beyond our model \u2014 a fade study, not tips.\n\n` + lines.join('\n') +
    `\n\nRecord + every race: raceside.vercel.app/minuscards.html`;
  while (text.length > 275 && lines.length > 2) { lines.pop(); text = `THE MOST-BACKED \u00b7 ${dateStr}\nWhere the market leans hardest beyond our model \u2014 a fade study, not tips.\n\n` + lines.join('\n') + `\n\nRecord + every race: raceside.vercel.app/minuscards.html`; }
  return text;
}

function oauthHeader(method, url, env) {
  const p = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const base = [method, enc(url), enc(Object.keys(p).sort().map(k => `${enc(k)}=${enc(p[k])}`).join('&'))].join('&');
  const key = `${enc(env.X_API_SECRET)}&${enc(env.X_ACCESS_SECRET)}`;
  p.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).sort().map(k => `${enc(k)}="${enc(p[k])}"`).join(', ');
}

export default async function handler(req, res) {
  const env = process.env;
  const auth = req.headers.authorization || '';
  const isCron = env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`;
  const isManual = env.TWEET_KEY && req.query.key === env.TWEET_KEY;
  if (!isCron && !isManual) return res.status(401).json({ ok: false, error: 'unauthorised' });
  const base = `https://${req.headers.host}`;
  let store, up;
  try {
    const [r1, r2] = await Promise.all([fetch(base + '/api/peopleall?v=2'), fetch(base + '/api/upcoming?v=4')]);
    store = await r1.json(); up = await r2.json();
    if (!store.ok || !up.ok) throw new Error('feeds');
  } catch (e) { return res.status(502).json({ ok: false, error: 'feeds: ' + String(e) }); }
  const picks = composePicks(up.rides, store, 5);
  if (!picks.length) return res.status(200).json({ ok: true, skipped: 'no qualifying picks today' });
  const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const text = composeText(picks, dateStr);
  if (req.query.dry) return res.status(200).json({ ok: true, dry: true, chars: text.length, text, picks });
  if (!env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_SECRET)
    return res.status(500).json({ ok: false, error: 'X credentials not configured in Vercel env' });
  const url = 'https://api.twitter.com/2/tweets';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: oauthHeader('POST', url, env) },
    body: JSON.stringify({ text }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ ok: false, error: 'X rejected', status: r.status, body });
  return res.status(200).json({ ok: true, posted: true, id: body.data && body.data.id, chars: text.length });
}
