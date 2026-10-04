// RACESIDE — today's winners, minimal
// One call to results/today; returns just { t, course, h } per winner so pages can
// tick winners without dragging the full market-tick history.

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  try {
    const r = await fetch('https://api.theracingapi.com/v1/results/today', { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status });
    const d = await r.json();
    const winners = [];
    (d.results || []).forEach((race) => {
      const region = String(race.region || '').toLowerCase();
      if (region && !['gb', 'ire'].includes(region)) return;   // only filter when the field exists
      const w = (race.runners || []).find((x) => String(x.position) === '1');
      if (w) winners.push({ t: race.off || race.off_time || '', course: race.course || '?', h: w.horse || '', sp: w.sp || '' });
    });
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, winners });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
}
