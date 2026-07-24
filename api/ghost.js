// RACESIDE — ghost engine
// A "ghost" is a horse the market strongly fancies (SP rank <= 2) while the score
// system rates it poorly (score rank in the bottom half) or cannot rate it at all
// (missing RPR & TS — unexposed). Per month (?month=YYYY-MM), warehouse-first.
// Measures: ghost frequency, ghost wins vs market-expected wins (A/E),
// unexposed vs exposed split, and icon win rate in races WITH vs WITHOUT a ghost.

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

  const all = [];
  let skip = 0, total = Infinity, pages = 0, source = 'api';
  const wh = await fetchResultsRange(fmt(lookbackStart), fmt(analysisEnd));
  const mapRunner = (x) => ({
    horse_id: x.horse_id, trainer_id: x.trainer_id, position: x.position,
    rpr: x.rpr, tsr: x.tsr, sp: x.sp, sp_dec: x.sp_dec,
  });
  if (wh) {
    source = 'warehouse';
    total = 0;
    for (const race of wh) {
      all.push({ date: race.date || '', off: offMin(race.off), runners: (race.runners || []).map(mapRunner) });
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
        all.push({ date: race.date || '', off: offMin(race.off), runners: (race.runners || []).map(mapRunner) });
      }
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

  // aggregates
  const G = {
    races: 0, ghostRaces: 0,
    ghosts: 0, ghostWins: 0, ghostExp: 0,          // A/E vs normalised market
    unexposed: 0, unexposedWins: 0, unexposedExp: 0,
    exposed: 0, exposedWins: 0, exposedExp: 0,
    iconWithGhost: { races: 0, wins: 0 },           // icon (top-3 score) win rate split
    iconNoGhost: { races: 0, wins: 0 },
    ghostBands: {},                                  // ghost SP band → {n, wins, exp}
  };
  const band = (d) => d < 2 ? 'odds_on' : d < 3 ? 'ev_2' : d < 5 ? 'f2_4' : d < 9 ? 'f4_8' : 'f16p_rest';

  for (const race of all) {
    const runners = race.runners;
    const inPeriod = race.date >= periodStart;
    const win = runners.find((x) => String(x.position) === '1');
    if (inPeriod && runners.length >= 5 && win && win.horse_id) {
      // engine score (leak-free core)
      const rprs = runners.map((x) => numRt(x.rpr));
      const tss = runners.map((x) => numRt(x.tsr));
      const map = {}, noRt = {};
      runners.forEach((x, i) => {
        if (!x.horse_id) return;
        const t14 = x.trainer_id ? t14At(x.trainer_id, race.date) : 0.4;
        map[x.horse_id] = Math.round((relUnit(rprs[i], rprs) * 22 + relUnit(tss[i], tss) * 13 + t14 * 5) * 100) / 100;
        noRt[x.horse_id] = isNaN(rprs[i]) && isNaN(tss[i]);
      });
      const vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
      if (vals.length >= 2) {
        // market: normalised implied probabilities and SP ranks
        const priced = runners.filter((x) => x.horse_id && spDec(x));
        if (priced.length >= Math.min(5, runners.length)) {
          const bookTot = priced.reduce((a, x) => a + 1 / spDec(x), 0);
          const bySp = priced.slice().sort((a, b) => spDec(a) - spDec(b));
          const spRank = {};
          bySp.forEach((x, i) => { spRank[x.horse_id] = i; });
          // dense, tie-aware score ranks
          const scoreRank = {};
          Object.keys(map).forEach((id) => { scoreRank[id] = vals.filter((v) => v > map[id]).length; });
          const nRanks = vals.length;
          const half = Math.ceil(nRanks / 2);

          const ghosts = priced.filter((x) => {
            if (spRank[x.horse_id] > 2) return false;                 // top-3 of market
            if (noRt[x.horse_id]) return true;                        // unexposed: no RPR & no TS
            if (map[x.horse_id] != null && map[x.horse_id] < 12) return true;  // pathologically low score
            return scoreRank[x.horse_id] >= half;                     // rated but bottom-half by dense rank
          });

          G.races++;
          const cut3 = vals[Math.min(2, vals.length - 1)];
          const iconWon = map[win.horse_id] != null && map[win.horse_id] >= cut3;
          const bucket = ghosts.length ? G.iconWithGhost : G.iconNoGhost;
          bucket.races++;
          if (iconWon) bucket.wins++;
          if (ghosts.length) G.ghostRaces++;

          for (const g of ghosts) {
            const p = (1 / spDec(g)) / bookTot;
            const won = String(g.position) === '1';
            G.ghosts++; G.ghostExp += p;
            if (won) G.ghostWins++;
            const cell = (G.ghostBands[band(spDec(g))] ||= { n: 0, wins: 0, exp: 0 });
            cell.n++; cell.exp += p;
            if (won) cell.wins++;
            if (noRt[g.horse_id]) {
              G.unexposed++; G.unexposedExp += p;
              if (won) G.unexposedWins++;
            } else {
              G.exposed++; G.exposedExp += p;
              if (won) G.exposedWins++;
            }
          }
        }
      }
    }
    for (const x of runners) {
      if (!x.trainer_id) continue;
      (trainerLog[x.trainer_id] ||= []).push({ d: x === undefined ? '' : race.date, win: String(x.position) === '1' });
    }
  }

  const r2 = (v) => Math.round(v * 100) / 100;
  G.ghostExp = r2(G.ghostExp);
  G.unexposedExp = r2(G.unexposedExp);
  G.exposedExp = r2(G.exposedExp);
  for (const b of Object.values(G.ghostBands)) b.exp = r2(b.exp);

  res.setHeader('Cache-Control', isCompleteMonth
    ? 's-maxage=2592000, stale-while-revalidate=5184000'
    : 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, month: m, from: periodStart, to: fmt(analysisEnd), source, ...G });
}
