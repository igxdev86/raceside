// RACINGPREDICT — a horse's career line: official rating and finishing position, run by run.
// Tries the horse-results endpoint in a few shapes; tolerant normalizer; reports its source.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME, pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const hid = String(req.query.hid || '').replace(/[^a-z0-9_-]/gi, '');
  if (!hid) return res.status(400).json({ ok: false, error: 'hid required' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const get = async (path) => {
    const r = await fetch('https://api.theracingapi.com' + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  };
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const norm = (r, horse) => {
    // results rows come race-shaped (runners inside) or already horse-shaped
    let mine = r;
    if (Array.isArray(r.runners)) {
      mine = r.runners.find(x => String(x.horse_id || '') === hid || String(x.horse || '').toLowerCase() === String(horse || '').toLowerCase());
      if (!mine) return null;
    }
    const date = String(r.date || r.race_date || r.off_dt || '').slice(0, 10);
    if (!date) return null;
    return {
      date,
      course: String(r.course || '').replace(/\s*\([^)]*\)/g, ''),
      ofr: num(mine.ofr != null ? mine.ofr : (mine.or != null ? mine.or : mine.official_rating)),
      pos: (() => { const p = parseInt(mine.position != null ? mine.position : mine.pos, 10); return Number.isFinite(p) && p > 0 ? p : null; })(),
      ran: num(r.ran || r.field_size || (Array.isArray(r.runners) ? r.runners.length : null)),
      sp: (() => { const s = parseFloat(mine.sp_dec != null ? mine.sp_dec : mine.sp); return Number.isFinite(s) && s > 1 ? Math.round(s * 100) / 100 : null; })(),
    };
  };
  const attempts = [];
  for (const p of [`/v1/horses/${hid}/results`, `/v1/results?horse_id=${hid}&limit=50`]) {
    try {
      const j = await get(p);
      const raw = j.results || j.data || (Array.isArray(j) ? j : null);
      if (raw && raw.length) {
        const runs = raw.map(r => norm(r, req.query.h)).filter(Boolean)
          .sort((a, b) => a.date < b.date ? -1 : 1).slice(-24);
        if (runs.length) {
          res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
          return res.status(200).json({ ok: true, source: p.split('?')[0], runs });
        }
      }
      attempts.push(p + ' -> empty');
    } catch (e) { attempts.push(String(e.message || e)); }
  }
  return res.status(200).json({ ok: false, error: 'no-history-endpoint', attempts });
}
