// RACESIDE — debug mailbox. Reads a store key (or a health summary) and commits it to the
// repo at debug/latest.json, where the assistant can read it via raw.githubusercontent.
// Gate: ?key=TWEET_KEY (or CRON_SECRET). Needs env RS_GH_TOKEN (GitHub PAT, contents write).
// Usage:
//   /api/debugpush?key=K                     -> health: today's snapshot race count + store key list
//   /api/debugpush?key=K&k=minussnap:2026-10-01  -> push that store value
function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}
export default async function handler(req, res) {
  const env = process.env;
  const gate = req.query.key && (req.query.key === env.TWEET_KEY || req.query.key === env.CRON_SECRET);
  if (!gate) return res.status(401).json({ ok: false, error: 'unauthorised' });
  if (!env.RS_GH_TOKEN) return res.status(200).json({ ok: false, error: 'no RS_GH_TOKEN env - add it in Vercel' });
  const s = supa();
  if (!s) return res.status(200).json({ ok: false, error: 'no-store' });
  const headers = { apikey: s.key, Authorization: `Bearer ${s.key}` };
  const ukd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  let payload;
  try {
    if (req.query.k) {
      const r = await fetch(`${s.url}/rest/v1/rs_kv?k=eq.${encodeURIComponent(String(req.query.k))}&select=k,v,updated_at`, { headers });
      payload = { mode: 'key', k: String(req.query.k), row: (await r.json())[0] || null };
    } else {
      const r1 = await fetch(`${s.url}/rest/v1/rs_kv?k=eq.${encodeURIComponent('minussnap:' + ukd)}&select=v,updated_at`, { headers });
      const snap = (await r1.json())[0] || null;
      const r2 = await fetch(`${s.url}/rest/v1/rs_kv?select=k,updated_at&order=updated_at.desc&limit=40`, { headers });
      payload = { mode: 'health', date: ukd,
        snapshotRaces: snap && snap.v && snap.v.races ? Object.keys(snap.v.races).length : 0,
        snapshotUpdated: snap ? snap.updated_at : null,
        keys: await r2.json() };
    }
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
  payload.at = new Date().toISOString();
  try {
    const gh = 'https://api.github.com/repos/igxdev86/raceside/contents/debug/latest.json';
    const ghHeaders = { Authorization: `Bearer ${env.RS_GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'raceside-debug' };
    const cur = await fetch(gh, { headers: ghHeaders });
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const w = await fetch(gh, { method: 'PUT', headers: ghHeaders,
      body: JSON.stringify({ message: 'debug: ' + (payload.mode === 'key' ? payload.k : 'health'),
        content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'), sha }) });
    return res.status(200).json({ ok: w.ok, pushed: payload.mode, snapshotRaces: payload.snapshotRaces });
  } catch (e) { return res.status(500).json({ ok: false, error: 'gh: ' + String(e) }); }
}
