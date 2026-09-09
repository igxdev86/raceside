// RACINGPREDICT — an owner's recent record across all their horses.
// Pages /v1/owners/{id}/results (up to 3 x 50), tolerant to row shapes.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME, pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const oid = String(req.query.oid || '').replace(/[^a-z0-9_-]/gi, '');
  if (!oid) return res.status(400).json({ ok: false, error: 'oid required' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const get = async (path) => {
    const r = await fetch('https://api.theracingapi.com' + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  };
  const rows = [];
  const attempts = [];
  for (let page = 0; page < 3; page++) {
    try {
      const j = await get(`/v1/owners/${oid}/results?limit=50&skip=${page * 50}`);
      const raw = j.results || j.data || (Array.isArray(j) ? j : []);
      if (!raw.length) break;
      raw.forEach(r => {
        const date = String(r.date || r.race_date || '').slice(0, 10);
        if (!date) return;
        // rows may be race-shaped (find our owner's runner) or already runner-shaped
        let mine = r;
        if (Array.isArray(r.runners)) mine = r.runners.find(x => String(x.owner_id || '') === oid) || null;
        if (!mine) return;
        const p = parseInt(mine.position != null ? mine.position : mine.pos, 10);
        rows.push({ date, course: String(r.course || '').replace(/\s*\([^)]*\)/g, ''), pos: Number.isFinite(p) && p > 0 ? p : null });
      });
      if (raw.length < 50) break;
    } catch (e) { attempts.push(String(e.message || e)); break; }
  }
  if (!rows.length) return res.status(200).json({ ok: false, error: 'no-owner-results', attempts });
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json({ ok: true, runs: rows.slice(0, 150) });
}
