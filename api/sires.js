// RACESIDE — sires engine
// Per month (?month=YYYY-MM): every runner grouped by sire.
// Tallies: runs, wins, £1 level-stakes P/L at SP, market-expected wins (sum of 1/SP —
// note the overround lives in this, so break-even A/E sits below 1.0; the page shows
// the all-sires baseline to compare against), plus flat/jumps and distance-band splits.
// Warehouse-first when rows carry sire (newer ingests); API fallback otherwise.

import { fetchResultsRange } from '../lib/db.js';

export const config = { maxDuration: 60 };

function spDec2(run) {
  const d = Number(run && run.sp_dec);
  if (!isNaN(d) && d > 1) return d;
  const s = String((run && run.sp) || '').replace(/[^\d/.]/g, '');
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); if (a > 0 && b > 0) return a / b + 1; }
  const n = Number(s);
  return !isNaN(n) && n > 1 ? n : null;
}
function furlongs(dist) {
  const s = String(dist || '').toLowerCase().replace(/\s/g, '');
  const m = s.match(/^(?:(\d+)m)?(?:(\d+)f)?/);
  if (!m) return null;
  const f = (Number(m[1]) || 0) * 8 + (Number(m[2]) || 0);
  return f > 0 ? f : null;
}
const distBand = (f) => f == null ? null : f <= 6 ? 'sprint' : f <= 8 ? 'mile' : f <= 12 ? 'middle' : 'staying';

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

  const races = [];
  let source = 'api';
  const wh = await fetchResultsRange(fmt(start), fmt(end));
  if (wh && wh.length && wh.some((r) => (r.runners || []).some((x) => x.sire_id))) {
    source = 'warehouse';
    for (const r of wh) races.push(r);
  } else {
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
        if (!r.ok) return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status });
        const page = await r.json();
        total = Number(page.total) || 0;
        for (const race of page.results || []) races.push(race);
        skip += 50; pages++;
        if (skip < total) await new Promise((ok) => setTimeout(ok, 620));
      }
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
    }
  }

  const sires = {}; // sire_id -> tallies
  let allRuns = 0, allWins = 0, allExp = 0;
  for (const race of races) {
    const isFlat = String(race.type || '').toLowerCase() === 'flat';
    const db = distBand(furlongs(race.dist));
    for (const x of race.runners || []) {
      if (!x.sire_id || !x.horse_id) continue;
      const d = spDec2(x);
      if (!d) continue;
      const won = String(x.position) === '1';
      const s = (sires[x.sire_id] ||= {
        name: x.sire || '?', runs: 0, wins: 0, pl: 0, exp: 0,
        flat: { runs: 0, wins: 0 }, jumps: { runs: 0, wins: 0 },
        bands: { sprint: { runs: 0, wins: 0 }, mile: { runs: 0, wins: 0 }, middle: { runs: 0, wins: 0 }, staying: { runs: 0, wins: 0 } },
      });
      s.runs++; allRuns++;
      s.exp += 1 / d; allExp += 1 / d;
      if (won) { s.wins++; allWins++; s.pl += d - 1; } else s.pl -= 1;
      const leg = isFlat ? s.flat : s.jumps;
      leg.runs++;
      if (won) leg.wins++;
      if (db) { s.bands[db].runs++; if (won) s.bands[db].wins++; }
    }
  }
  for (const s of Object.values(sires)) { s.pl = Math.round(s.pl * 100) / 100; s.exp = Math.round(s.exp * 100) / 100; }

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, month: m, source,
    baseline: { runs: allRuns, wins: allWins, exp: Math.round(allExp * 100) / 100 },
    sires,
  });
}
