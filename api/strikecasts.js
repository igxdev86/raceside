// RACESIDE — strike casts engine
// Like the strike engine, but the tracked events are:
//   FC: 1st AND 2nd both in the race's icon set (top-3 tie-aware ranks, RPR22+TS13+T14 5)
//   TC: 1st, 2nd AND 3rd all in the icon set
// Per calendar month (?month=YYYY-MM). Warehouse-first, API fallback.
// FC droughts pooled at 12+, TC at 24+. Extremes carry break-by-hit resolution.

import { fetchResultsRange } from '../lib/db.js';

export const config = { maxDuration: 60 };

const numRt = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '\u2013') return NaN;
  const n = Number(s);
  return n > 0 ? n : NaN;
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function relUnit(v, arr) {
  const ns = arr.filter((x) => !isNaN(x));
  if (isNaN(v) || ns.length < 2) return 0.4;
  const mn = Math.min(...ns), mx = Math.max(...ns);
  return mx > mn ? (v - mn) / (mx - mn) : 0.6;
}
function t14UnitFrom(runs, wins) {
  if (!(runs > 0)) return 0.4;
  let v = 0.15 + clamp01((wins / runs) / 0.25) * 0.85;
  if (runs < 3) v = v * 0.5 + 0.2;
  return v;
}
function spDec(run) {
  const d = Number(run && run.sp_dec);
  if (!isNaN(d) && d > 1) return d;
  const s = String((run && run.sp) || '').replace(/[^\d/.]/g, '');
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); if (a > 0 && b > 0) return a / b + 1; }
  const n = Number(s);
  return !isNaN(n) && n > 1 ? n : null;
}
function offMin(off) {
  const m = String(off || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  let h = Number(m[1]);
  if (h >= 1 && h <= 9) h += 12;
  return h * 60 + Number(m[2]);
}

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });

  const now = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const m = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ ok: false, error: 'month-required' });
  const [yy, mm] = m.split('-').map(Number);
  const analysisStart = new Date(Date.UTC(yy, mm - 1, 1));
  const monthEnd = new Date(Date.UTC(yy, mm, 0));
  const analysisEnd = monthEnd < now ? monthEnd : now;
  const isCompleteMonth = monthEnd < now;
  if (analysisStart > now) return res.status(400).json({ ok: false, error: 'future-month' });
  let lookbackStart = new Date(analysisStart.getTime() - 14 * 86400000);
  const windowFloor = new Date(now.getTime() - 363 * 86400000);
  if (lookbackStart < windowFloor) lookbackStart = windowFloor;
  const periodStart = fmt(analysisStart);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // ---- fetch: warehouse first ----
  const all = [];
  let skip = 0, total = Infinity, pages = 0, source = 'api';
  const wh = await fetchResultsRange(fmt(lookbackStart), fmt(analysisEnd));
  if (wh) {
    source = 'warehouse';
    total = 0;
    for (const race of wh) {
      all.push({
        date: race.date || '', off: offMin(race.off),
        runners: (race.runners || []).map((x) => ({
          horse_id: x.horse_id, trainer_id: x.trainer_id, position: x.position,
          rpr: x.rpr, tsr: x.tsr, sp: x.sp, sp_dec: x.sp_dec,
        })),
      });
    }
  }
  try {
    while (skip < total && pages < 40) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire` +
        `&start_date=${fmt(lookbackStart)}&end_date=${fmt(analysisEnd)}&limit=50&skip=${skip}`;
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
        all.push({
          date: race.date || '', off: offMin(race.off),
          runners: (race.runners || []).map((x) => ({
            horse_id: x.horse_id, trainer_id: x.trainer_id, position: x.position,
            rpr: x.rpr, tsr: x.tsr, sp: x.sp, sp_dec: x.sp_dec,
          })),
        });
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 620));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  // ---- replay with rolling T14 ----
  all.sort((a, b) => a.date.localeCompare(b.date) || a.off - b.off);
  const trainerLog = {};
  const t14At = (tid, raceDate) => {
    const log = trainerLog[tid];
    if (!log || !log.length) return 0.4;
    const from = fmt(new Date(Date.parse(raceDate) - 14 * 86400000));
    let runs = 0, wins = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.d >= raceDate) continue;
      if (e.d < from) break;
      runs++; if (e.win) wins++;
    }
    return t14UnitFrom(runs, wins);
  };

  const byDay = {}; // date → [{off, fc, tc, hasThird}]
  const dayCF = {}, dayCT = {}; // date → £10-combination P&L at SP
  let races = 0, skipped = 0;
  for (const race of all) {
    const runners = race.runners;
    const inPeriod = race.date >= periodStart;
    const p1 = runners.find((x) => String(x.position) === '1');
    const p2 = runners.find((x) => String(x.position) === '2');
    const p3 = runners.find((x) => String(x.position) === '3');
    if (inPeriod && runners.length >= 3 && p1 && p1.horse_id && p2 && p2.horse_id) {
      const rprs = runners.map((x) => numRt(x.rpr));
      const tss = runners.map((x) => numRt(x.tsr));
      const map = {};
      runners.forEach((x, i) => {
        if (!x.horse_id) return;
        const t14 = x.trainer_id ? t14At(x.trainer_id, race.date) : 0.4;
        map[x.horse_id] = Math.round((relUnit(rprs[i], rprs) * 22 + relUnit(tss[i], tss) * 13 + t14 * 5) * 100) / 100;
      });
      const vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
      if (vals.length < 2) skipped++;
      else {
        const cut3 = vals[Math.min(2, vals.length - 1)];
        const inSet = (id) => map[id] != null && map[id] >= cut3;
        const fc = inSet(p1.horse_id) && inSet(p2.horse_id);
        const hasThird = !!(p3 && p3.horse_id);
        const tc = fc && hasThird && inSet(p3.horse_id);
        races++;
        (byDay[race.date] ||= []).push({ off: race.off, fc, tc, hasThird });
        // £10 combination CF/CT on the unique-rank picks, settled at SP
        const picks = [];
        for (let rank = 0; rank < 3 && rank < vals.length; rank++) {
          const ids = Object.keys(map).filter((id) => map[id] === vals[rank]);
          if (ids.length !== 1) continue;
          const r = runners.find((x) => x.horse_id === ids[0]);
          const d = r ? spDec(r) : null;
          if (d) picks.push({ id: ids[0], d });
        }
        const oddsOf = Object.fromEntries(picks.map((p) => [p.id, p.d]));
        if (picks.length >= 2) {
          const line = 10 / (picks.length * (picks.length - 1));
          const d1 = oddsOf[p1.horse_id], d2 = oddsOf[p2.horse_id];
          const pl = (d1 && d2) ? line * d1 * d2 - 10 : -10;
          dayCF[race.date] = (dayCF[race.date] || 0) + pl;
        }
        if (picks.length >= 3 && hasThird) {
          const line = 10 / (picks.length * (picks.length - 1) * (picks.length - 2));
          const d1 = oddsOf[p1.horse_id], d2 = oddsOf[p2.horse_id], d3 = oddsOf[p3.horse_id];
          const pl = (d1 && d2 && d3) ? line * d1 * d2 * d3 - 10 : -10;
          dayCT[race.date] = (dayCT[race.date] || 0) + pl;
        }
      }
    }
    for (const x of runners) {
      if (!x.trainer_id) continue;
      (trainerLog[x.trainer_id] ||= []).push({ d: race.date, win: String(x.position) === '1' });
    }
  }

  // ---- hazard + extremes per stream ----
  const buildStream = (pick, hasEvent, poolCap) => {
    const hazard = {};
    let hitTotal = 0, caseTotal = 0;
    const maxDrought = { len: 0, date: null, brokeByHit: false };
    const maxStreak = { len: 0, date: null };
    for (const day of Object.keys(byDay)) {
      const seq = byDay[day].sort((a, b) => a.off - b.off);
      let gap = 0, streak = 0, dayMax = 0, dayMaxBroke = false;
      for (const r of seq) {
        if (!hasEvent(r)) continue; // race can't produce this event (e.g. no 3rd finisher for TC)
        const g = Math.min(gap, poolCap);
        const h = (hazard[g] ||= { cases: 0, hits: 0 });
        h.cases++; caseTotal++;
        if (pick(r)) {
          h.hits++; hitTotal++;
          if (gap === dayMax && gap > 0) dayMaxBroke = true;
          gap = 0;
          streak++;
          if (streak > maxStreak.len) { maxStreak.len = streak; maxStreak.date = day; }
        } else {
          gap++; streak = 0;
          if (gap > dayMax) { dayMax = gap; dayMaxBroke = false; }
        }
      }
      if (dayMax > maxDrought.len) {
        maxDrought.len = dayMax; maxDrought.date = day; maxDrought.brokeByHit = dayMaxBroke;
      }
    }
    return {
      base: caseTotal ? Math.round((hitTotal / caseTotal) * 1000) / 10 : 0,
      hazard: Object.entries(hazard)
        .map(([gap, v]) => ({ gap: Number(gap), cases: v.cases, hits: v.hits,
          pct: v.cases ? Math.round((v.hits / v.cases) * 1000) / 10 : 0 }))
        .sort((a, b) => a.gap - b.gap),
      extremes: { drought: maxDrought, streak: maxStreak },
      poolCap,
    };
  };

  const dailySeries = () => {
    const dates = [...new Set([...Object.keys(dayCF), ...Object.keys(dayCT), ...Object.keys(byDay)])].sort();
    return dates.map((date) => ({
      date,
      races: (byDay[date] || []).length,
      cf: dayCF[date] != null ? Math.round(dayCF[date] * 100) / 100 : null,
      ct: dayCT[date] != null ? Math.round(dayCT[date] * 100) / 100 : null,
    }));
  };

  const dayExtremes = (days) => {
    let best = null, worst = null;
    for (const [date, pl] of Object.entries(days)) {
      const v = Math.round(pl * 100) / 100;
      if (!best || v > best.pl) best = { date, pl: v };
      if (!worst || v < worst.pl) worst = { date, pl: v };
    }
    return { best, worst };
  };

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, month: m, from: periodStart, to: fmt(analysisEnd),
    races, skipped, source,
    daily: dailySeries(),
    fc: { ...buildStream((r) => r.fc, () => true, 12), days: dayExtremes(dayCF) },
    tc: { ...buildStream((r) => r.tc, (r) => r.hasThird, 24), days: dayExtremes(dayCT) },
  });
}
