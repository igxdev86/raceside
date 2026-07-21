// RACESIDE — course quirks aggregator
// Pages through /v1/results for one course (last 12 months on Standard plan)
// and tallies wins by horse-name first letter, cloth number and draw.
// Heavily edge-cached: one real computation per course per day.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });

  const courseId = String(req.query.course_id || '');
  if (!/^crs_[\w-]+$/.test(courseId)) {
    return res.status(400).json({ ok: false, error: 'bad-course-id' });
  }

  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 12);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const letters = {}; // A: {runs, wins}
  const numbers = {}; // 1: {runs, wins}
  const draws = {};   // 1: {runs, wins}
  let races = 0, runnersTotal = 0, courseName = '', skip = 0, total = Infinity, pages = 0;

  try {
    while (skip < total && pages < 24) {
      const url = `https://api.theracingapi.com/v1/results?course=${courseId}` +
        `&start_date=${fmt(start)}&end_date=${fmt(end)}&limit=50&skip=${skip}`;
      const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) {
        return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status });
      }
      const page = await r.json();
      total = Number(page.total) || 0;
      const results = page.results || [];
      for (const race of results) {
        races++;
        courseName = race.course || courseName;
        for (const run of race.runners || []) {
          const pos = String(run.position || '');
          const win = pos === '1';
          runnersTotal++;
          const L = (run.horse || '').replace(/^(The |A |An )/i, '').trim().charAt(0).toUpperCase();
          if (/[A-Z]/.test(L)) {
            (letters[L] ||= { runs: 0, wins: 0 });
            letters[L].runs++; if (win) letters[L].wins++;
          }
          const num = parseInt(run.number, 10);
          if (num >= 1 && num <= 40) {
            (numbers[num] ||= { runs: 0, wins: 0 });
            numbers[num].runs++; if (win) numbers[num].wins++;
          }
          const dr = parseInt(run.draw, 10);
          if (dr >= 1 && dr <= 40) {
            (draws[dr] ||= { runs: 0, wins: 0 });
            draws[dr].runs++; if (win) draws[dr].wins++;
          }
        }
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 150)); // stay polite on rate limit
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  const pack = (obj, key) =>
    Object.entries(obj)
      .map(([k, v]) => ({ [key]: isNaN(Number(k)) ? k : Number(k), runs: v.runs, wins: v.wins, 'win_%': v.runs ? v.wins / v.runs : 0 }))
      .sort((a, b) => b.wins - a.wins || b['win_%'] - a['win_%']);

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
  return res.status(200).json({
    ok: true,
    course: courseName,
    course_id: courseId,
    from: fmt(start),
    to: fmt(end),
    races,
    runners: runnersTotal,
    truncated: skip < total,
    letters: pack(letters, 'letter'),
    numbers: pack(numbers, 'number'),
    draws: pack(draws, 'draw'),
  });
}
