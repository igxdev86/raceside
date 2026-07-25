// RACESIDE — draw engine
// For FLAT races only: how often the winner comes from each draw third
// (LOW / MID / HIGH stalls), conditioned on course, distance band and field size.
// Per month (?month=YYYY-MM). API-sourced (distance isn't in the warehouse);
// complete months cache at the CDN for 30 days so the cost is one-time.

export const config = { maxDuration: 60 };

function furlongs(dist) {
  const s = String(dist || '').toLowerCase().replace(/\s/g, '');
  const m = s.match(/^(?:(\d+)m)?(?:(\d+)f)?/);
  if (!m) return null;
  const f = (Number(m[1]) || 0) * 8 + (Number(m[2]) || 0);
  return f > 0 ? f : null;
}
const distBand = (f) => f == null ? null : f <= 6 ? 'sprint' : f <= 8 ? 'mile' : f <= 12 ? 'middle' : 'staying';
const fieldBand = (n) => n <= 8 ? 'S' : n <= 12 ? 'M' : 'L';
const normCourse = (c) => String(c || '').toLowerCase().replace(/\(.*?\)/g, '').trim();

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });

  const now = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const m = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ ok: false, error: 'month-required' });
  const [yy, mm] = m.split('-').map(Number);
  const start = new Date(Date.UTC(yy, mm - 1, 1));
  const monthEnd = new Date(Date.UTC(yy, mm, 0));
  const end = monthEnd < now ? monthEnd : now;
  const isCompleteMonth = monthEnd < now;
  if (start > now) return res.status(400).json({ ok: false, error: 'future-month' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const tally = {}; // course|distBand|fieldBand -> {races, low, mid, high}
  let skip = 0, total = Infinity, pages = 0, flatRaces = 0;
  try {
    while (skip < total && pages < 40) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire` +
        `&start_date=${fmt(start)}&end_date=${fmt(end)}&limit=50&skip=${skip}`;
      let r, attempts = 0;
      for (;;) {
        r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
        if (r.status !== 429 || attempts >= 4) break;
        attempts++;
        await new Promise((ok) => setTimeout(ok, 2000 * attempts));
      }
      if (!r.ok) return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status });
      const page = await r.json();
      total = Number(page.total) || 0;
      for (const race of page.results || []) {
        if (String(race.type || '').toLowerCase() !== 'flat') continue;
        const db = distBand(furlongs(race.dist));
        if (!db) continue;
        const drawn = (race.runners || []).filter((x) => Number(x.draw) >= 1);
        if (drawn.length < 5) continue;
        const win = drawn.find((x) => String(x.position) === '1');
        if (!win) continue;
        const maxD = Math.max(...drawn.map((x) => Number(x.draw)));
        if (!(maxD > 1)) continue;
        const rel = (Number(win.draw) - 1) / (maxD - 1);
        const third = rel < 1 / 3 ? 'low' : rel < 2 / 3 ? 'mid' : 'high';
        const key = normCourse(race.course) + '|' + db + '|' + fieldBand(drawn.length);
        const cell = (tally[key] ||= { races: 0, low: 0, mid: 0, high: 0 });
        cell.races++;
        cell[third]++;
        flatRaces++;
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 620));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, month: m, flatRaces, tally });
}
