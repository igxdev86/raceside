// RACESIDE — recent form (jockeys & trainers)
// Walks the last 21 days of results in time order and, for every jockey and trainer,
// reports rides/runs in the window, wins, rides since their last win (capped at the
// window edge), and the date of that last win. Feeds the J&T "win expectancy" line.

import { monthGet, monthPut } from '../lib/db.js';

export const config = { maxDuration: 60 };

function offMin(off) {
  const m = String(off || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  let hh = Number(m[1]);
  if (hh < 10) hh += 12;
  return hh * 60 + Number(m[2]);
}

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  // stored answer first: recomputed at most every 3 hours, shared by everyone
  const stored = await monthGet('recentform', 'latest');
  if (stored && Date.now() - Date.parse(stored.updated_at) < 10800000) {
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=10800');
    return res.status(200).json({ ...stored.data, source: 'store' });
  }
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const races = [];
  let skip = 0, total = Infinity, pages = 0;
  try {
    while (skip < total && pages < 20) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire&start_date=${fmt(start)}&end_date=${fmt(end)}&limit=50&skip=${skip}`;
      let r, attempts = 0;
      for (;;) {
        r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
        if (r.status !== 429 || attempts >= 4) break;
        attempts++;
        await new Promise((ok) => setTimeout(ok, 1500 * attempts));
      }
      if (!r.ok) return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status });
      const page = await r.json();
      total = Number(page.total) || 0;
      for (const race of page.results || []) races.push(race);
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 300));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
  races.sort((a, b) => String(a.date).localeCompare(String(b.date)) || offMin(a.off) - offMin(b.off));
  const J = {}, T = {};
  const yd = new Date(end.getTime() - 86400000).toISOString().slice(0, 10);
  const touch = (bucket, id, won, date, course) => {
    const s = (bucket[id] ||= { r: 0, w: 0, since: 0, lastWin: null, ydCourse: null });
    s.r++;
    if (won) { s.w++; s.since = 0; s.lastWin = date; }
    else s.since++;
    if (date === yd) s.ydCourse = course;   // races walk in time order, so this ends as yesterday's LAST course
  };
  for (const race of races) {
    for (const x of race.runners || []) {
      const won = String(x.position) === '1';
      if (x.jockey_id) touch(J, x.jockey_id, won, race.date, race.course || null);
      if (x.trainer_id) touch(T, x.trainer_id, won, race.date, race.course || null);
    }
  }
  const body = { ok: true, window: 14, from: fmt(start), to: fmt(end), yesterday: yd, jockeys: J, trainers: T };
  await monthPut('recentform', 'latest', body);
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=10800');
  return res.status(200).json(body);
}
