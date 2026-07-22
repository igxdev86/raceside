// RACESIDE — strike engine v3
// Empirical icon-win hazard by drought length. Callable two ways:
//   ?month=YYYY-MM  → hazard tallies for that calendar month (complete months cache 30d)
//   (no param)      → last 45 days (legacy behaviour, cache 12h)
// Monthly chunks merge cleanly client-side because streaks reset daily.
// Icon: winner in top-3 tie-aware ranks of RPR 22 + TS 13 + T14 5 (T14 reconstructed
// leak-free from a 14-day lookback before each race day). Unrankable races are skipped.

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
  let analysisStart, analysisEnd, isCompleteMonth = false;
  const m = String(req.query.month || '');
  if (/^\d{4}-\d{2}$/.test(m)) {
    const [yy, mm] = m.split('-').map(Number);
    analysisStart = new Date(Date.UTC(yy, mm - 1, 1));
    const monthEnd = new Date(Date.UTC(yy, mm, 0));
    analysisEnd = monthEnd < now ? monthEnd : now;
    isCompleteMonth = monthEnd < now;
    if (analysisStart > now) return res.status(400).json({ ok: false, error: 'future-month' });
  } else {
    analysisStart = new Date(now.getTime() - 45 * 86400000);
    analysisEnd = now;
  }
  let lookbackStart = new Date(analysisStart.getTime() - 14 * 86400000);
  // clamp inside the API's 12-month results window so edge months don't 400
  const windowFloor = new Date(now.getTime() - 363 * 86400000);
  if (lookbackStart < windowFloor) lookbackStart = windowFloor;
  const periodStart = fmt(analysisStart);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // pass 1: fetch lookback + period
  const all = [];
  let skip = 0, total = Infinity, pages = 0;
  let source = 'api';
  const wh = await fetchResultsRange(fmt(lookbackStart), fmt(analysisEnd));
  if (wh) {
    source = 'warehouse';
    total = 0;
    for (const race of wh) {
      all.push({
        date: race.date || '', off: offMin(race.off),
        runners: (race.runners || []).map((x) => ({
          horse_id: x.horse_id, trainer_id: x.trainer_id, position: x.position,
          rpr: x.rpr, tsr: x.tsr,
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
            rpr: x.rpr, tsr: x.tsr,
          })),
        });
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 620));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  // pass 2: chronological replay with rolling trainer form
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

  const byDay = {};
  let races = 0, skipped = 0;
  for (const race of all) {
    const runners = race.runners;
    const inPeriod = race.date >= periodStart;
    const win = runners.find((x) => String(x.position) === '1');
    if (inPeriod && runners.length >= 2 && win && win.horse_id) {
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
        const wv = map[win.horse_id];
        const wr = wv == null ? -1 : vals.filter((v) => v > wv).length;
        const iconWin = wv != null && wv >= cut3;
        races++;
        (byDay[race.date] ||= []).push({ off: race.off, iconWin, wr });
      }
    }
    for (const x of runners) {
      if (!x.trainer_id) continue;
      (trainerLog[x.trainer_id] ||= []).push({ d: race.date, win: String(x.position) === '1' });
    }
  }

  const iconStream = (hitRank, poolCap) => {
    const hz = {};
    let hits = 0, cases = 0;
    const rec = { len: 0, date: null, brokeByIcon: false };
    for (const day of Object.keys(byDay)) {
      const seq = byDay[day].sort((a, b) => a.off - b.off);
      let gap = 0, dayMax = 0, dayMaxBroke = false;
      for (const r of seq) {
        const g = Math.min(gap, poolCap);
        const h = (hz[g] ||= { cases: 0, iconWins: 0 });
        h.cases++; cases++;
        if (r.wr === hitRank) {
          h.iconWins++; hits++;
          if (gap === dayMax && gap > 0) dayMaxBroke = true;
          gap = 0;
        } else {
          gap++;
          if (gap > dayMax) { dayMax = gap; dayMaxBroke = false; }
        }
      }
      if (dayMax > rec.len) { rec.len = dayMax; rec.date = day; rec.brokeByIcon = dayMaxBroke; }
    }
    return {
      poolCap,
      base: cases ? Math.round((hits / cases) * 1000) / 10 : 0,
      hazard: Object.entries(hz)
        .map(([gap, v]) => ({ gap: Number(gap), cases: v.cases, iconWins: v.iconWins,
          pct: v.cases ? Math.round((v.iconWins / v.cases) * 1000) / 10 : 0 }))
        .sort((a, b) => a.gap - b.gap),
      extremes: { drought: rec },
    };
  };

  const hazard = {};
  let iconTotal = 0, caseTotal = 0;
  const maxDrought = { len: 0, date: null, brokeByIcon: false };
  const maxStreak = { len: 0, date: null };
  for (const day of Object.keys(byDay)) {
    const seq = byDay[day].sort((a, b) => a.off - b.off);
    let gap = 0, streak = 0, dayMax = 0, dayMaxBroke = false;
    for (const r of seq) {
      const g = Math.min(gap, 10);
      const h = (hazard[g] ||= { cases: 0, iconWins: 0 });
      h.cases++; caseTotal++;
      if (r.iconWin) {
        h.iconWins++; iconTotal++;
        if (gap === dayMax && gap > 0) dayMaxBroke = true; // the day's deepest drought just broke on an icon
        gap = 0;
        streak++;
        if (streak > maxStreak.len) { maxStreak.len = streak; maxStreak.date = day; }
      } else {
        gap++; streak = 0;
        if (gap > dayMax) { dayMax = gap; dayMaxBroke = false; }
      }
    }
    if (dayMax > maxDrought.len) {
      maxDrought.len = dayMax; maxDrought.date = day; maxDrought.brokeByIcon = dayMaxBroke;
    }
  }

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=43200, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, month: m || null, from: periodStart, to: fmt(analysisEnd),
    races, skipped, truncated: skip < total, source,
    extremes: { drought: maxDrought, streak: maxStreak },
    perIcon: { cup: iconStream(0, 12), red: iconStream(1, 18), blue: iconStream(2, 24) },
    base: caseTotal ? Math.round((iconTotal / caseTotal) * 1000) / 10 : 0,
    hazard: Object.entries(hazard)
      .map(([gap, v]) => ({ gap: Number(gap), cases: v.cases, iconWins: v.iconWins,
        pct: v.cases ? Math.round((v.iconWins / v.cases) * 1000) / 10 : 0 }))
      .sort((a, b) => a.gap - b.gap),
  });
}
