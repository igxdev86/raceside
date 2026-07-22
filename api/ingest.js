// RACESIDE — ingest
// Pours Racing API results into the Supabase warehouse.
//   ?month=YYYY-MM   → that calendar month (for backfill, run once per month)
//   ?recent=N        → last N days (daily top-up, default 3)
// Stores one row per race with a trimmed runners JSONB (only fields the engines use).

import { upsertResults } from '../lib/db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });

  const now = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  let start, end;
  const m = String(req.query.month || '');
  if (/^\d{4}-\d{2}$/.test(m)) {
    const [yy, mm] = m.split('-').map(Number);
    start = new Date(Date.UTC(yy, mm - 1, 1));
    const monthEnd = new Date(Date.UTC(yy, mm, 0));
    end = monthEnd < now ? monthEnd : now;
    if (start > now) return res.status(400).json({ ok: false, error: 'future-month' });
  } else {
    const n = Math.min(14, Math.max(1, parseInt(req.query.recent, 10) || 3));
    start = new Date(now.getTime() - n * 86400000);
    end = now;
  }
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const rows = [];
  let skip = 0, total = Infinity, pages = 0;
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
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status, detail: body.slice(0, 200), fetched: rows.length });
      }
      const page = await r.json();
      total = Number(page.total) || 0;
      for (const race of page.results || []) {
        if (!race.race_id || !race.date) continue;
        rows.push({
          race_id: race.race_id,
          date: race.date,
          course: race.course || null,
          region: race.region || null,
          type: race.type || null,
          off: race.off || null,
          runners: (race.runners || []).map((x) => ({
            horse_id: x.horse_id, horse: x.horse, trainer_id: x.trainer_id,
            position: x.position, draw: x.draw, number: x.number,
            rpr: x.rpr, tsr: x.tsr, or: x.or, sp: x.sp, sp_dec: x.sp_dec,
          })),
        });
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 620));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  const up = await upsertResults(rows);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(up.ok ? 200 : 500).json({
    ok: up.ok, from: fmt(start), to: fmt(end),
    fetched: rows.length, written: up.written || 0,
    truncated: skip < total, error: up.error, detail: up.detail,
  });
}
