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

const KEYS = ['yearstate:v1', 'mgstate:v1', 'mgstate:v2', 'yearstate:v2', 'mgstate:v3', 'hourstate:v1', 'pairstate:v1', 'wrstate:v1', 'horseform:v1', 'tipstate:v1', 'fitstate:v1', 'gapstate:v1', 'sigstate:v1', 'optstate:v1', 'trkstate:v1', 'trkstate:v2', 'alertstate:v1', 'printsarchive:v1', 'courseseq:v1', 'termdata:v1', 'termfreeze:v1', 'comboledger:v1', 'bankerlog:v1', 'tottset:v1'];

export default async function handler(req, res) {
  const size = (v) => { try { return JSON.stringify(v || null).length; } catch { return 0; } };
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
      // if the stored state cannot be read, nothing is written: a write that cannot be merged could only destroy history
      if (!cur.ok) return res.status(503).json({ ok: false, error: 'read-failed' });
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
          if (Object.keys(state.days).length < Object.keys(prev.days).length) return res.status(409).json({ ok: false, error: 'would-drop-days' });
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
    const FAST = K === 'termdata:v1' || K === 'alertstate:v1' || K === 'termfreeze:v1' || K === 'comboledger:v1' || K === 'bankerlog:v1' || K === 'tottset:v1';
    res.setHeader('Cache-Control', FAST ? 's-maxage=10, stale-while-revalidate=20' : 's-maxage=600, stale-while-revalidate=3600');
    let out = (rows && rows[0] && rows[0].v) || null;
    // ?day=YYYY-MM-DD returns just that day; &tp=A,B,C narrows its picks to those combos (small payloads for consumers and checks)
    // ?stats=1 returns per-combo lifetime hit rates from picks of record (pre-off, restored, or rebuilt days), from 10 Oct
    if (out && out.days && req.query.stats) { const st = {}; Object.entries(out.days).sort().forEach(([d, dv]) => { if (!dv || d < '2026-10-10') return;
      Object.entries(dv.tp || {}).forEach(([nm, arr]) => (arr || []).forEach(e => { if (!e || e.w === null || e.w === undefined) return; if (!(e.lk || (dv.restored && e.at) || dv.src === 'replay')) return;
        const g = st[nm] = st[nm] || { n: 0, w: 0, f: 0, pnl: 0, seq: '' }; g.n++; const d1 = Number(e.d) > 1 ? Number(e.d) : null;
        if (e.w) { g.w++; g.seq += 'W'; g.pnl += d1 ? d1 - 1 : 0; } else { g.seq += e.pl ? 'F' : 'L'; g.pnl -= 1; } })); });
      return res.status(200).json({ ok: true, ts: out.ts, stats: st }); }
    // ?index=1 returns a one-line-per-day summary instead of the data
    if (out && out.days && req.query.index) { const idx = {}; Object.entries(out.days).forEach(([d, dv]) => { if (!dv) { idx[d] = null; return; } let n = 0, settled = 0, locked = 0; Object.values(dv.tp || {}).forEach(arr => (arr || []).forEach(e => { if (!e) return; n++; if (e.w !== null && e.w !== undefined) { settled++; if (e.lk) locked++; } }));
      idx[d] = { v: dv.v, src: dv.src, preview: dv.preview || 0, restored: dv.restored || 0, combos: Object.keys(dv.tp || {}).length, picks: n, settled, settledWithTime: locked, tm: dv.tm ? Object.keys(dv.tm).length : 0, bytes: size(dv) }; });
      return res.status(200).json({ ok: true, ts: out.ts, days: idx, bytes: size(out) }); }
    const qd = String(req.query.day || ''); if (out && out.days && /^\d{4}-\d{2}-\d{2}$/.test(qd)) { const dv = out.days[qd] || null; let d2 = dv;
      if (dv && req.query.tp) { const want = String(req.query.tp).split(','); d2 = { ...dv, tp: Object.fromEntries(want.filter(k => dv.tp && dv.tp[k]).map(k => [k, dv.tp[k]])), tm: dv.tm ? Object.fromEntries(want.filter(k => dv.tm[k]).map(k => [k, dv.tm[k]])) : undefined, scan: undefined, nx: undefined, sq: undefined, ultra: undefined, tiles: undefined, tmScan: undefined }; }
      out = { days: { [qd]: d2 }, ts: out.ts }; }
    return res.status(200).json({ ok: true, state: out });
  } catch {
    return res.status(200).json({ ok: true, state: null });
  }
}
