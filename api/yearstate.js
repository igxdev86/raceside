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

const KEYS = ['yearstate:v1', 'mgstate:v1', 'mgstate:v2', 'yearstate:v2', 'mgstate:v3', 'hourstate:v1', 'pairstate:v1', 'wrstate:v1', 'horseform:v1', 'tipstate:v1', 'fitstate:v1', 'gapstate:v1', 'sigstate:v1', 'optstate:v1', 'trkstate:v1', 'trkstate:v2', 'alertstate:v1', 'printsarchive:v1', 'courseseq:v1', 'termdata:v1', 'termfreeze:v1', 'comboledger:v1'];

export default async function handler(req, res) {
  const qk = String(req.query.k || '');
  const K = KEYS.includes(qk) ? qk : /^minussnap:\d{4}-\d{2}-\d{2}$/.test(qk) ? qk : KEYS[0];
  const s = supa();
  if (!s) return res.status(200).json({ ok: true, state: null });
  const headers = { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'POST') {
      const state = req.body && typeof req.body === 'object' ? req.body : null;
      if (!state || (!state.lastDate && !state.ts)) return res.status(400).json({ ok: false, error: 'no-state' });
      // last-write-wins, but never overwrite a newer state with an older one
      const cur = await fetch(`${s.url}/rest/v1/rs_kv?k=eq.${encodeURIComponent(K)}&select=v`, { headers });
      if (cur.ok) {
        const rows = await cur.json();
        const prev = rows && rows[0] && rows[0].v;
        const nf = (v) => v && (v.lastDate != null ? String(v.lastDate) : v.ts != null ? String(v.ts).padStart(20, '0') : null);
        if (nf(prev) && nf(state) && nf(prev) > nf(state)) {
          return res.status(200).json({ ok: true, kept: 'newer-exists' });
        }
        // comboledger: finished days are append-only. A page may add or grow a day, never shrink or drop one,
        // and a past day can only be replaced by a richer version of itself.
        if (K === 'comboledger:v1' && prev && prev.days && typeof prev.days === 'object') {
          state.days = state.days && typeof state.days === 'object' ? state.days : {};
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
          const size = (v) => { try { return JSON.stringify(v || null).length; } catch { return 0; } };
          for (const d of Object.keys(prev.days)) {
            const was = prev.days[d], now = state.days[d];
            if (!now) { state.days[d] = was; continue; }
            if (d < today && size(now) < size(was)) state.days[d] = was;
          }
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
    const FAST = K === 'termdata:v1' || K === 'alertstate:v1' || K === 'termfreeze:v1';
    res.setHeader('Cache-Control', FAST ? 's-maxage=10, stale-while-revalidate=20' : 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, state: (rows && rows[0] && rows[0].v) || null });
  } catch {
    return res.status(200).json({ ok: true, state: null });
  }
}
