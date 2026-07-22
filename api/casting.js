// RACESIDE — casting engine
// For one calendar month: tallies which cloth-number combinations filled the
// forecast (1st→2nd in order) and tricast (1st→2nd→3rd in order), GB+IRE.
// Completed months are immutable → cached 30 days. Current month cached 6h.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });

  const m = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ ok: false, error: 'bad-month' });
  const [yy, mm] = m.split('-').map(Number);
  const start = new Date(Date.UTC(yy, mm - 1, 1));
  const monthEnd = new Date(Date.UTC(yy, mm, 0));
  const now = new Date();
  const end = monthEnd < now ? monthEnd : now;
  if (start > now) return res.status(400).json({ ok: false, error: 'future-month' });
  const isComplete = monthEnd < now;
  const fmt = (d) => d.toISOString().slice(0, 10);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const forecasts = {}; // "a-b" → {n, c, s1, s2, p}
  const tricasts = {};  // "a-b-c" → {n, c, s1, s2, s3, p}
  const spOf = (run) => {
    const d = Number(run && run.sp_dec);
    if (!isNaN(d) && d > 1) return d;
    const s = String((run && run.sp) || '').replace(/[^\d/.]/g, '');
    if (s.includes('/')) { const [a, b] = s.split('/').map(Number); if (a > 0 && b > 0) return a / b + 1; }
    const n2 = Number(s);
    return !isNaN(n2) && n2 > 1 ? n2 : null;
  };
  let races = 0, castable = 0, skip = 0, total = Infinity, pages = 0;

  try {
    while (skip < total && pages < 32) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire` +
        `&start_date=${fmt(start)}&end_date=${fmt(end)}&limit=50&skip=${skip}`;
      let r, attempts = 0;
      for (;;) {
        r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
        if (r.status !== 429 || attempts >= 4) break;
        attempts++;
        await new Promise((ok) => setTimeout(ok, 2000 * attempts));
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status, detail: body.slice(0, 300) });
      }
      const page = await r.json();
      total = Number(page.total) || 0;
      for (const race of page.results || []) {
        races++;
        const runners = race.runners || [];
        const at = (p) => runners.find((x) => String(x.position) === p);
        const n = (run) => { const v = parseInt(run && run.number, 10); return v >= 1 && v <= 40 ? v : null; };
        const n1 = n(at('1')), n2 = n(at('2')), n3 = n(at('3'));
        if (n1 == null || n2 == null) continue;
        castable++;
        const r1 = at('1'), r2 = at('2'), r3 = at('3');
        const sp1 = spOf(r1), sp2 = spOf(r2), sp3 = spOf(r3);
        const fKey = n1 + '-' + n2;
        const f = (forecasts[fKey] ||= { n: 0, c: 0, s1: 0, s2: 0, p: 0 });
        f.n++;
        if (sp1 && sp2) { f.c++; f.s1 += sp1; f.s2 += sp2; f.p += sp1 * sp2; }
        if (n3 != null) {
          const tKey = n1 + '-' + n2 + '-' + n3;
          const t = (tricasts[tKey] ||= { n: 0, c: 0, s1: 0, s2: 0, s3: 0, p: 0 });
          t.n++;
          if (sp1 && sp2 && sp3) { t.c++; t.s1 += sp1; t.s2 += sp2; t.s3 += sp3; t.p += sp1 * sp2 * sp3; }
        }
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 650));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  res.setHeader('Cache-Control', isComplete
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, month: m, from: fmt(start), to: fmt(end),
    races, castable, truncated: skip < total, complete: isComplete,
    forecasts, tricasts,
  });
}
