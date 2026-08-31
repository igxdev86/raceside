// RACESIDE — pre-off snapshot store for MINUS CARDS. The record, set in stone.
// Cron (every 5 min) captures the live card; each race is overwritten only while its off time
// is still in the future, so the stored copy is the LAST capture before the off. After the off
// nothing can touch it. GET ?date=YYYY-MM-DD serves the day's snapshots to the page.
// Auth for capture: Vercel cron bearer CRON_SECRET, or ?key=TWEET_KEY manually.

function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}
const ukParts = (d) => {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = {}; f.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
};
export const raceMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); if (!m) return 9999; let hh = Number(m[1]); if (hh < 10) hh += 12; return hh * 60 + Number(m[2]); };
const rkey = (t, course) => String(t || '').replace(/\s.*/, '') + '|' + String(course || '').replace(/\s*\(aw\)\s*/i, '').trim().toLowerCase();

// pure: fold a live feed into the day's snapshot. Only future races are (re)written.
export function foldSnapshot(day, rides, nowMin, capturedAt) {
  const out = day && day.races ? day : { races: {} };
  const byRace = {};
  (rides || []).forEach(r => { if (r.day !== 'today') return; (byRace[rkey(r.t, r.course)] = byRace[rkey(r.t, r.course)] || []).push(r); });
  let written = 0, held = 0;
  Object.entries(byRace).forEach(([k, rs]) => {
    if (raceMin(rs[0].t) <= nowMin) { held++; return; }   // off time passed: stone
    out.races[k] = { t: rs[0].t, course: rs[0].course, capturedAt, rides: rs };
    written++;
  });
  return { day: out, written, held };
}

export default async function handler(req, res) {
  const s = supa();
  const env = process.env;
  const headers = s ? { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' } : null;
  const read = async (K) => {
    if (!s) return null;
    const r = await fetch(`${s.url}/rest/v1/rs_kv?k=eq.${encodeURIComponent(K)}&select=v`, { headers });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0] && rows[0].v) || null;
  };

  if (req.query.date) {
    const dt = String(req.query.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return res.status(400).json({ ok: false, error: 'bad-date' });
    const day = await read('minussnap:' + dt);
    const isToday = ukParts(new Date()).date === dt;
    res.setHeader('Cache-Control', isToday ? 's-maxage=60, stale-while-revalidate=120' : 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ ok: true, date: dt, races: (day && day.races) || {} });
  }

  const auth = req.headers.authorization || '';
  const isCron = env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`;
  const isManual = env.TWEET_KEY && req.query.key === env.TWEET_KEY;
  if (!isCron && !isManual) return res.status(401).json({ ok: false, error: 'unauthorised' });
  if (!s) return res.status(200).json({ ok: false, error: 'no-store' });
  try {
    const now = new Date();
    const uk = ukParts(now);
    const base = `https://${req.headers.host}`;
    const r = await fetch(`${base}/api/upcoming?v=4&r=${Math.floor(Date.now() / 300000)}`);
    const up = await r.json();
    if (!up.ok) return res.status(502).json({ ok: false, error: 'feed' });
    const K = 'minussnap:' + uk.date;
    const cur = await read(K);
    const { day, written, held } = foldSnapshot(cur, up.rides, uk.min, now.toISOString());
    const w = await fetch(`${s.url}/rest/v1/rs_kv`, {
      method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ k: K, v: day, updated_at: now.toISOString() }]),
    });
    return res.status(200).json({ ok: w.ok, date: uk.date, written, held, total: Object.keys(day.races).length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
