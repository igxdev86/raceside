// RACESIDE — fixtures calendar
// GB/IRE fixture dates and courses, as far ahead as the upstream plan allows.
// Tries the fixtures endpoint first, falls back to near-term racecards so the page is never empty.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const get = async (path) => {
    const r = await fetch('https://api.theracingapi.com' + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  };
  const today = new Date().toISOString().slice(0, 10);
  const from = String(req.query.from || today).slice(0, 10);
  const to = String(req.query.to || (today.slice(0, 4) + '-12-31')).slice(0, 10);
  const gbire = (v) => ['gb', 'ire', 'gbr', 'irl'].includes(String(v || '').toLowerCase());
  const norm = (f) => {
    const date = String(f.date || f.start_date || f.fixture_date || f.fixture_start || '').slice(0, 10);
    const course = f.course || f.course_name || f.venue || f.name || '';
    const region = f.region || f.region_code || f.country || '';
    return date && course ? { date, course: String(course), region: String(region).toLowerCase() } : null;
  };
  const tryPaths = [
    `/v1/fixtures?start_date=${from}&end_date=${to}`,
    `/v1/fixtures?from=${from}&to=${to}`,
    `/v1/fixtures`,
  ];
  const attempts = [];
  for (const p of tryPaths) {
    try {
      const j = await get(p);
      const raw = j.fixtures || j.data || (Array.isArray(j) ? j : null);
      if (raw && raw.length) {
        const fixtures = raw.map(norm).filter(Boolean)
          .filter((f) => f.date >= from && f.date <= to)
          .filter((f) => !f.region || gbire(f.region));
        if (fixtures.length) {
          fixtures.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.course.localeCompare(b.course));
          res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
          return res.status(200).json({ ok: true, source: p.split('?')[0], from, to, fixtures });
        }
      }
      attempts.push(p + ' -> empty');
    } catch (e) { attempts.push(String(e.message || e)); }
  }
  const fixtures = [];
  for (const day of ['today', 'tomorrow']) {
    let cards = null;
    for (const tier of ['standard', 'basic', 'free']) {
      try { cards = await get('/v1/racecards/' + tier + '?day=' + day); break; } catch {}
    }
    if (!cards) continue;
    const seen = {};
    (cards.racecards || []).forEach((rc) => {
      if (!gbire(rc.region)) return;
      const date = String(rc.date || rc.off_dt || '').slice(0, 10) || (day === 'today' ? today : new Date(Date.now() + 86400000).toISOString().slice(0, 10));
      const k = date + '|' + rc.course;
      if (seen[k]) return;
      seen[k] = 1;
      fixtures.push({ date, course: rc.course, region: String(rc.region || '').toLowerCase() });
    });
  }
  fixtures.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.course.localeCompare(b.course));
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
  return res.status(200).json({ ok: true, source: 'racecards-fallback', from, to, fixtures, note: 'no fixtures endpoint on this plan', attempts });
}
