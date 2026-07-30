// RACESIDE — The Diff engine
// For every course and month, replays ten simple alternative selection rules
// alongside the EXP baseline, settled at SP, £1 level stakes:
//   exp    — the EXP core (baseline)
//   fav    — back the SP favourite
//   sec    — back the second favourite
//   cup    — back the top core score (RPR·22 + TS·13 + rolling T14·5)
//   rpr    — back the top RPR
//   ts     — back the top Topspeed
//   par    — back the biggest positive parity gap (score 2+ above its SP rank's implied score)
//   drawlo — flat only: lowest stall among the 3 shortest prices
//   expnf  — the EXP pick, but only when it is NOT the favourite
//   sum    — flat only: lowest cloth-number+draw sum among the 4 shortest prices
//   t14    — best rolling trainer-14 form among the 3 shortest prices
// The client splits months into train/test and only trusts what survives out of sample.

import { fetchResultsRange } from '../lib/db.js';

export const config = { maxDuration: 60 };

const parseRt = (v) => {
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
function spDec2(run) {
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
  // Pro plan: results reach far beyond 12 months — no window clamp needed
  const periodStart = fmt(analysisStart);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const all = [];
  let skip = 0, total = Infinity, pages = 0;
  let source = 'api';
  const mapRace = (race) => ({
    course: race.course || '?', rtype: race.type || '', date: race.date || '', off: offMin(race.off),
    runners: (race.runners || []).map((x) => ({
      horse_id: x.horse_id, trainer_id: x.trainer_id, position: x.position,
      rpr: x.rpr, tsr: x.tsr, sp: x.sp, sp_dec: x.sp_dec, draw: x.draw, number: x.number,
    })),
  });
  const wh = await fetchResultsRange(fmt(lookbackStart), fmt(analysisEnd));
  if (wh) {
    source = 'warehouse';
    total = 0;
    for (const race of wh) all.push(mapRace(race));
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
      for (const race of page.results || []) all.push(mapRace(race));
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 620));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

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

  const STRATS = ['exp','fav','sec','cup','rpr','ts','par','drawlo','expnf','sum','t14'];
  const courses = {}; // course -> strat -> {n,w,pl}
  const meets = {};   // course -> strat -> date -> {n,w,pl}

  let settleDate = '';
  const settle = (course, strat, x, win) => {
    if (!x) return;
    const d = spDec2(x);
    if (!d) return;
    const cell = (((courses[course] ||= {})[strat] ||= { n: 0, w: 0, pl: 0 }));
    const md = ((((meets[course] ||= {})[strat] ||= {})[settleDate] ||= { n: 0, w: 0, pl: 0 }));
    cell.n++; md.n++;
    if (x.horse_id === win.horse_id) { cell.w++; cell.pl += d - 1; md.w++; md.pl += d - 1; }
    else { cell.pl -= 1; md.pl -= 1; }
  };

  for (const race of all) {
    const runners = (race.runners || []).filter((x) => x.horse_id);
    const inMonth = race.date >= periodStart;
    if (inMonth && runners.length >= 4) {
      const win = runners.find((x) => String(x.position) === '1');
      const priced = runners.filter((x) => spDec2(x));
      if (win && spDec2(win) && priced.length >= 4) {
        const rprs = runners.map((x) => parseRt(x.rpr));
        const tss = runners.map((x) => parseRt(x.tsr));
        const t14s = {};
        const map = {};
        runners.forEach((x, i) => {
          t14s[x.horse_id] = x.trainer_id ? t14At(x.trainer_id, race.date) : 0.4;
          map[x.horse_id] = Math.round((relUnit(rprs[i], rprs) * 22 + relUnit(tss[i], tss) * 13 + t14s[x.horse_id] * 5) * 100) / 100;
        });
        const vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
        if (vals.length >= 2) {
          const byPrice = priced.slice().sort((a, b) => spDec2(a) - spDec2(b));
          const scoresDesc = Object.values(map).sort((a, b) => b - a);
          const mR = {};
          byPrice.forEach((x, i) => { mR[x.horse_id] = i; });
          const isFlat = String(race.rtype || '').toLowerCase() === 'flat';
          let bookT = 0;
          priced.forEach((x) => { bookT += 1 / spDec2(x); });

          // exp pick (core)
          let expPk = null;
          priced.forEach((x) => {
            let v = (1 / spDec2(x)) / bookT;
            const sc = map[x.horse_id];
            const rk = sc != null ? vals.filter((q) => q > sc).length : 99;
            if (rk === 0) v *= 1.15;
            else if (rk <= 2) v *= 1.08;
            const par = scoresDesc[Math.min(mR[x.horse_id], scoresDesc.length - 1)];
            if (par != null && sc != null && sc - par >= 4) v *= 1.06;
            if (!expPk || v > expPk.v) expPk = { x, v };
          });
          const bestBy = (fn, pool = priced) => {
            let best = null, bv = -Infinity;
            pool.forEach((x) => { const v = fn(x); if (v != null && v > bv) { bv = v; best = x; } });
            return best;
          };
          const c = race.course;
          settleDate = race.date;
          settle(c, 'exp', expPk && expPk.x, win);
          settle(c, 'fav', byPrice[0], win);
          settle(c, 'sec', byPrice[1], win);
          settle(c, 'cup', bestBy((x) => map[x.horse_id]), win);
          settle(c, 'rpr', bestBy((x) => { const v = parseRt(x.rpr); return isNaN(v) ? null : v; }), win);
          settle(c, 'ts', bestBy((x) => { const v = parseRt(x.tsr); return isNaN(v) ? null : v; }), win);
          // par: biggest positive gap of 2+
          const parPick = bestBy((x) => {
            const sc = map[x.horse_id];
            const par = scoresDesc[Math.min(mR[x.horse_id], scoresDesc.length - 1)];
            if (sc == null || par == null) return null;
            const g = sc - par;
            return g >= 2 ? g : null;
          });
          settle(c, 'par', parPick, win);
          if (isFlat) {
            settle(c, 'drawlo', bestBy((x) => { const d2 = Number(x.draw); return d2 >= 1 ? -d2 : null; }, byPrice.slice(0, 3)), win);
            settle(c, 'sum', bestBy((x) => {
              const n2 = parseInt(x.number, 10), d2 = parseInt(x.draw, 10);
              return (n2 >= 1 && d2 >= 1) ? -(n2 + d2) : null;
            }, byPrice.slice(0, 4)), win);
          }
          if (expPk && expPk.x.horse_id !== byPrice[0].horse_id) settle(c, 'expnf', expPk.x, win);
          settle(c, 't14', bestBy((x) => t14s[x.horse_id] > 0.4 ? t14s[x.horse_id] : null, byPrice.slice(0, 3)), win);
        }
      }
    }
    for (const x of runners) {
      if (!x.trainer_id) continue;
      (trainerLog[x.trainer_id] ||= []).push({ d: race.date, win: String(x.position) === '1' });
    }
  }

  for (const cm of Object.values(courses)) for (const s of Object.values(cm)) s.pl = Math.round(s.pl * 100) / 100;
  for (const cm of Object.values(meets)) for (const sm of Object.values(cm)) for (const md of Object.values(sm)) md.pl = Math.round(md.pl * 100) / 100;

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, month: m, source, strats: STRATS, courses, meets });
}
