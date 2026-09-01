// RACESIDE — shared year-state store
// GET  → the saved rolling state for the day chart's year analytics (or null)
// POST → save it (whole JSON body = the state object)
// Backed by the rs_kv table in Supabase; degrades to null if the table or env is missing,
// in which case devices fall back to building locally exactly as before.

function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

const KEYS = ['yearstate:v1', 'mgstate:v1', 'mgstate:v2', 'yearstate:v2', 'mgstate:v3', 'hourstate:v1', 'pairstate:v1', 'wrstate:v1', 'horseform:v1', 'tipstate:v1', 'fitstate:v1', 'gapstate:v1', 'sigstate:v1', 'optstate:v1'];

export default async function handler(req, res) {
  const K = KEYS.includes(String(req.query.k)) ? String(req.query.k) : KEYS[0];
  const s = supa();
  if (!s) return res.status(200).json({ ok: true, state: null });
  const headers = { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'POST') {
      const state = req.body && typeof req.body === 'object' ? req.body : null;
      if (!state || !state.lastDate) return res.status(400).json({ ok: false, error: 'no-state' });
      // last-write-wins, but never overwrite a newer state with an older one
      const cur = await fetch(`${s.url}/rest/v1/rs_kv?k=eq.${encodeURIComponent(K)}&select=v`, { headers });
      if (cur.ok) {
        const rows = await cur.json();
        const prev = rows && rows[0] && rows[0].v;
        if (prev && prev.lastDate && String(prev.lastDate) > String(state.lastDate)) {
          return res.status(200).json({ ok: true, kept: 'newer-exists' });
        }
      }
      const up = await fetch(`${s.url}/rest/v1/rs_kv`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{ k: K, v: state, updated_at: new Date().toISOString() }]),
      });
      return res.status(200).json({ ok: up.ok });
    }

    const r = await fetch(`${s.url}/rest/v1/rs_kv?k=eq.${encodeURIComponent(K)}&select=v`, { headers });
    if (!r.ok) return res.status(200).json({ ok: true, state: null });
    const rows = await r.json();
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, state: (rows && rows[0] && rows[0].v) || null });
  } catch {
    return res.status(200).json({ ok: true, state: null });
  }
}
