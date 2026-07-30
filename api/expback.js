// RACESIDE — EXP backtest engine
// Replays the EXP composite's backtestable core over one month (?month=YYYY-MM):
//   pick = argmax of SP-market probability × icon boosts (top score ×1.15, icons ×1.08)
//          × parity boost (×1.06 when score sits 4+ above the score its SP rank implies)
// Icons come from the leak-free engine ruler: RPR·22 + TS·13 + rolling trainer-14 ·5.
// No draw factor (distance isn't stored) and no form/freshness/C&D — disclosed on the page.
// Settled at SP, £1 level stakes. Also tallies backing the SP favourite in the SAME races.
// Warehouse-first; complete months cache at the CDN.

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
  const windowFloor = new Date(now.getTime() - 363 * 86400000);
  if (lookbackStart < windowFloor) lookbackStart = windowFloor;
  const periodStart = fmt(analysisStart);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const all = [];
  let skip = 0, total = Infinity, pages = 0;
  let source = 'api';
  const wh = await fetchResultsRange(fmt(lookbackStart), fmt(analysisEnd));
  const mapRace = (race) => ({
    course: race.course || '?', date: race.date || '', off: offMin(race.off),
    runners: (race.runners || []).map((x) => ({
      horse_id: x.horse_id, horse: x.horse, trainer_id: x.trainer_id, position: x.position,
      rpr: x.rpr, tsr: x.tsr, sp: x.sp, sp_dec: x.sp_dec,
    })),
    offRaw: race.off || '',
  });
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

  // chronological replay with rolling trainer form
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

  const courses = {}; // course -> { n, w, pl, favW, favPl }
  const meets = {};   // course -> { date: { n, w, pl } }
  const days = {};    // date -> { n, wins: [sp_dec of winning picks] }
  const cdays = {};   // course -> date -> { n, wins: [sp_dec of winning picks] }
  const totalT = { n: 0, w: 0, pl: 0, favW: 0, favPl: 0 };

  for (const race of all) {
    const runners = (race.runners || []).filter((x) => x.horse_id);
    const inMonth = race.date >= periodStart;
    if (inMonth && runners.length >= 4) {
      const win = runners.find((x) => String(x.position) === '1');
      const priced = runners.filter((x) => spDec2(x));
      if (win && spDec2(win) && priced.length >= 4) {
        // score with rolling trainer form (leak-free: log only holds earlier days)
        const rprs = runners.map((x) => parseRt(x.rpr));
        const tss = runners.map((x) => parseRt(x.tsr));
        const map = {};
        runners.forEach((x, i) => {
          const t14 = x.trainer_id ? t14At(x.trainer_id, race.date) : 0.4;
          map[x.horse_id] = Math.round((relUnit(rprs[i], rprs) * 22 + relUnit(tss[i], tss) * 13 + t14 * 5) * 100) / 100;
        });
        const vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
        if (vals.length >= 2) {
          let bookT = 0;
          priced.forEach((x) => { bookT += 1 / spDec2(x); });
          const byPrice = priced.slice().sort((a, b) => spDec2(a) - spDec2(b));
          const scoresDesc = Object.values(map).sort((a, b) => b - a);
          const mR = {};
          byPrice.forEach((x, i) => { mR[x.horse_id] = i; });
          let pick = null;
          priced.forEach((x) => {
            let v = (1 / spDec2(x)) / bookT;
            const sc = map[x.horse_id];
            const rk = sc != null ? vals.filter((q) => q > sc).length : 99;
            if (rk === 0) v *= 1.15;
            else if (rk <= 2) v *= 1.08;
            const par = scoresDesc[Math.min(mR[x.horse_id], scoresDesc.length - 1)];
            if (par != null && sc != null && sc - par >= 4) v *= 1.06;
            if (!pick || v > pick.v) pick = { x, v };
          });
          if (pick) {
            const c = (courses[race.course] ||= { n: 0, w: 0, pl: 0, favW: 0, favPl: 0 });
            const md = ((meets[race.course] ||= {})[race.date] ||= { n: 0, w: 0, pl: 0 });
            const dd = (days[race.date] ||= { n: 0, wins: [] });
            dd.n++;
            const cd = ((cdays[race.course] ||= {})[race.date] ||= { n: 0, wins: [], picks: [] });
            cd.n++;
            const won = pick.x.horse_id === win.horse_id;
            const d = spDec2(pick.x);
            c.n++; totalT.n++; md.n++;
            const rd2 = Math.round(d * 100) / 100;
            if (won) { c.w++; totalT.w++; c.pl += d - 1; totalT.pl += d - 1; md.w++; md.pl += d - 1; dd.wins.push(rd2); cd.wins.push(rd2); }
            else { c.pl -= 1; totalT.pl -= 1; md.pl -= 1; }
            cd.picks.push({
              t: race.offRaw, h: pick.x.horse || '', sp: rd2, won: won ? 1 : 0,
              ...(won ? {} : { wh: win.horse || '', wsp: Math.round((spDec2(win) || 0) * 100) / 100 }),
            });
            const favWon = byPrice[0].horse_id === win.horse_id;
            const fd = spDec2(byPrice[0]);
            if (favWon) { c.favW++; totalT.favW++; c.favPl += fd - 1; totalT.favPl += fd - 1; }
            else { c.favPl -= 1; totalT.favPl -= 1; }
          }
        }
      }
    }
    // update trainer log (after grading, so a race never sees itself)
    for (const x of runners) {
      if (!x.trainer_id) continue;
      (trainerLog[x.trainer_id] ||= []).push({ d: race.date, win: String(x.position) === '1' });
    }
  }

  for (const c of Object.values(courses)) { c.pl = Math.round(c.pl * 100) / 100; c.favPl = Math.round(c.favPl * 100) / 100; }
  for (const cm of Object.values(meets)) for (const md of Object.values(cm)) md.pl = Math.round(md.pl * 100) / 100;
  totalT.pl = Math.round(totalT.pl * 100) / 100;
  totalT.favPl = Math.round(totalT.favPl * 100) / 100;

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, month: m, source, total: totalT, courses, meets, days, cdays });
}
