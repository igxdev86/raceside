// RACESIDE — jockeys & trainers engine
// Per month (?month=YYYY-MM): every runner grouped by jockey and by trainer.
// Tallies: runs, wins, £1 level-stakes P/L at SP, market-expected wins (sum of 1/SP —
// note the overround lives in this, so break-even A/E sits below 1.0; the page shows
// the all-sires baseline to compare against), plus flat/jumps and distance-band splits.
// Warehouse-first when rows carry sire (newer ingests); API fallback otherwise.

import { fetchResultsRange, monthGet, monthPut } from '../lib/db.js';

const STORE_KEY = 'people:v4';

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
  // stored answer first: complete months forever, current month if under 6h old
  const stored = await monthGet(STORE_KEY, m);
  if (stored && (isCompleteMonth || Date.now() - Date.parse(stored.updated_at) < 21600000)) {
    res.setHeader('Cache-Control', isCompleteMonth ? 's-maxage=2592000, stale-while-revalidate=5184000' : 's-maxage=3600');
    return res.status(200).json({ ...stored.data, source: 'store' });
  }
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const races = [];
  let source = 'api';
  const wh = await fetchResultsRange(fmt(start), fmt(end));
  if (wh && wh.length && wh.some((r) => (r.runners || []).some((x) => x.jockey_id))) {
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

  const jockeys = {}, trainers = {};
  let allRuns = 0, allWins = 0, allExp = 0;
  const spBandOf = (d) => d < 2 ? 'oddson' : d < 3 ? 'ev2' : d < 5 ? 'f2_4' : d < 9 ? 'f4_8' : d < 17 ? 'f8_16' : 'f16p';
  const crsKey = (c) => String(c || '').toLowerCase().replace(/\s*\(a\.?w\.?\)\s*/, '').replace(/\s+/g, ' ').trim();
  const tally = (bucket, id, name, isFlat, won, placed, d, ck) => {
    const s = (bucket[id] ||= { name: name || '?', runs: 0, wins: 0, plc: 0, pl: 0, exp: 0, flat: { runs: 0, wins: 0 }, jumps: { runs: 0, wins: 0 }, ob: {} });
    s.runs++;
    s.exp += 1 / d;
    const ob = (s.ob[spBandOf(d)] ||= { r: 0, w: 0, e: 0 });
    ob.r++;
    ob.e += 1 / d;
    if (won) ob.w++;
    if (ck) {
      s.cs = s.cs || {};
      const cb = (s.cs[ck] ||= { r: 0, w: 0, p: 0, e: 0, pl: 0 });
      cb.r++;
      cb.e += 1 / d;
      if (placed) cb.p++;
      if (won) { cb.w++; cb.pl += d - 1; } else cb.pl -= 1;
    }
    if (placed) s.plc++;
    if (won) { s.wins++; s.pl += d - 1; } else s.pl -= 1;
    const leg = isFlat ? s.flat : s.jumps;
    leg.runs++;
    if (won) leg.wins++;
  };
  const baseC = {};
  for (const race of races) {
    const isFlat = String(race.type || '').toLowerCase() === 'flat';
    const ck = crsKey(race.course);
    for (const x of race.runners || []) {
      if (!x.horse_id) continue;
      const d = spDec2(x);
      if (!d) continue;
      const pos = parseInt(x.position, 10);
      const won = pos === 1;
      const placed = pos >= 1 && pos <= 3;
      allRuns++; allWins += won ? 1 : 0; allExp += 1 / d;
      if (ck) {
        const cb = (baseC[ck] ||= { runs: 0, wins: 0, exp: 0 });
        cb.runs++; cb.exp += 1 / d;
        if (won) cb.wins++;
      }
      if (x.jockey_id) tally(jockeys, x.jockey_id, x.jockey, isFlat, won, placed, d, ck);
      if (x.trainer_id) tally(trainers, x.trainer_id, x.trainer, isFlat, won, placed, d, ck);
    }
  }
  for (const cb of Object.values(baseC)) cb.exp = Math.round(cb.exp * 100) / 100;
  for (const b of [jockeys, trainers]) for (const s of Object.values(b)) {
    s.pl = Math.round(s.pl * 100) / 100; s.exp = Math.round(s.exp * 100) / 100;
    for (const ob of Object.values(s.ob)) ob.e = Math.round(ob.e * 100) / 100;
    for (const cb of Object.values(s.cs || {})) { cb.e = Math.round(cb.e * 100) / 100; cb.pl = Math.round(cb.pl * 100) / 100; }
  }

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  const body = {
    ok: true, month: m, source,
    baseline: { runs: allRuns, wins: allWins, exp: Math.round(allExp * 100) / 100 },
    baselineC: baseC,
    jockeys, trainers,
  };
  await monthPut(STORE_KEY, m, body);   // store for everyone; best-effort
  return res.status(200).json(body);
}
