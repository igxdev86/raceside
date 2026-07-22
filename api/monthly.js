// RACESIDE — monthly icon performance grader (v3)
// Two-pass: fetches period + 14-day lookback, replays chronologically reconstructing each
// trainer's rolling 14-day strike rate as it stood BEFORE each race day (no hindsight leak).
// Basis per race: rpr_ts (RPR 22 + TS 13 + T14 5) → ofr (OFR 35 + T14 5) → skip.
// C&D flags are NOT reconstructible from one month of results and are excluded by design.

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
  const d = Number(run.sp_dec);
  if (!isNaN(d) && d > 1) return d;
  const s = String(run.sp || '').replace(/[^\d/.]/g, '');
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (a > 0 && b > 0) return a / b + 1;
  }
  const n = Number(s);
  return !isNaN(n) && n > 1 ? n : null;
}

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });

  const which = req.query.month === 'last' ? 'last' : 'this';
  const now = new Date();
  let start, end;
  if (which === 'this') {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    end = now;
  } else {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  }
  const lookbackStart = new Date(start.getTime() - 14 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const periodStart = fmt(start);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // ---- pass 1: fetch everything (lookback + period), keep minimal fields ----
  const all = [];
  const diag = [];
  let skip = 0, total = Infinity, pages = 0, upstreamTotal = null;
  let source = 'api';
  const wh = await fetchResultsRange(fmt(lookbackStart), fmt(end));
  if (wh) {
    source = 'warehouse';
    upstreamTotal = wh.length;
    total = 0; // warehouse hit: skip the legacy loop entirely
    for (const race of wh) {
      if (diag.length < 3 && (race.runners || [])[0]) {
        const f = race.runners[0];
        diag.push({ date: race.date, rpr: f.rpr ?? null, tsr: f.tsr ?? null, or: f.or ?? null, sp_dec: f.sp_dec ?? null, src: 'warehouse' });
      }
      all.push({ date: race.date || '', course: race.course || 'Unknown', type: race.type || '', runners: race.runners || [] });
    }
  }
  try {
    while (skip < total && pages < 36) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire` +
        `&start_date=${fmt(lookbackStart)}&end_date=${fmt(end)}&limit=50&skip=${skip}`;
      let r, attempts = 0;
      for (;;) {
        r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
        if (r.status !== 429 || attempts >= 4) break;
        attempts++;
        await new Promise((ok) => setTimeout(ok, 2000 * attempts));
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status, detail: body.slice(0, 300) });
      }
      const page = await r.json();
      total = Number(page.total) || 0;
      upstreamTotal = total;
      for (const race of page.results || []) {
        if (diag.length < 3 && (race.runners || [])[0]) {
          const f = race.runners[0];
          diag.push({ date: race.date, rpr: f.rpr ?? null, tsr: f.tsr ?? null, or: f.or ?? null, sp_dec: f.sp_dec ?? null });
        }
        all.push({
          date: race.date || '', course: race.course || 'Unknown', type: race.type || '',
          runners: (race.runners || []).map((x) => ({
            horse_id: x.horse_id, trainer_id: x.trainer_id, position: x.position,
            draw: x.draw, rpr: x.rpr, tsr: x.tsr, or: x.or, sp: x.sp, sp_dec: x.sp_dec,
          })),
        });
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 650));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  // ---- pass 2: chronological replay ----
  all.sort((a, b) => a.date.localeCompare(b.date));
  const trainerLog = {}; // trainer_id → [{d: 'YYYY-MM-DD', win: bool}]
  const t14At = (tid, raceDate) => {
    const log = trainerLog[tid];
    if (!log || !log.length) return { runs: 0, wins: 0 };
    const from = fmt(new Date(Date.parse(raceDate) - 14 * 86400000));
    let runs = 0, wins = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.d >= raceDate) continue;         // strictly before race day — no leak
      if (e.d < from) break;                  // outside the fortnight
      runs++; if (e.win) wins++;
    }
    return { runs, wins };
  };

  const days = {}, courses = {}, drawCourses = {};
  const iconDraw = { low: { runs: 0, wins: 0, pl: 0 }, mid: { runs: 0, wins: 0, pl: 0 }, high: { runs: 0, wins: 0, pl: 0 } };
  const basis = { rpr_ts: 0, ofr: 0 };
  let races = 0, skipped = 0;

  for (const race of all) {
    const runners = race.runners;
    const inPeriod = race.date >= periodStart;
    const win = runners.find((x) => String(x.position) === '1');

    if (inPeriod && runners.length >= 2 && win && win.horse_id) {
      // draw signal — flat only
      if (String(race.type).trim().toLowerCase() === 'flat') {
        const drawn = runners.map((x) => parseInt(x.draw, 10)).filter((n) => n >= 1);
        const wd = parseInt(win.draw, 10);
        if (drawn.length >= 6 && wd >= 1) {
          const sorted = [...drawn].sort((a, b) => a - b);
          const idx = sorted.indexOf(wd);
          if (idx >= 0) {
            const frac = sorted.length > 1 ? idx / (sorted.length - 1) : 0.5;
            const band = frac < 1 / 3 ? 'low' : frac <= 2 / 3 ? 'mid' : 'high';
            const dc = (drawCourses[race.course] ||= { races: 0, low: 0, mid: 0, high: 0 });
            dc.races++; dc[band]++;
          }
        }
      }

      // score map with reconstructed T14
      const t14u = runners.map((x) => {
        if (!x.trainer_id) return 0.4;
        const s = t14At(x.trainer_id, race.date);
        return t14UnitFrom(s.runs, s.wins);
      });
      const buildMap = (mode) => {
        const map = {};
        if (mode === 'rpr_ts') {
          const rprs = runners.map((x) => numRt(x.rpr));
          const tss = runners.map((x) => numRt(x.tsr));
          runners.forEach((x, i) => {
            if (!x.horse_id) return;
            map[x.horse_id] = Math.round((relUnit(rprs[i], rprs) * 22 + relUnit(tss[i], tss) * 13 + t14u[i] * 5) * 100) / 100;
          });
        } else {
          const ors = runners.map((x) => numRt(x.or));
          runners.forEach((x, i) => {
            if (!x.horse_id) return;
            map[x.horse_id] = Math.round((relUnit(ors[i], ors) * 35 + t14u[i] * 5) * 100) / 100;
          });
        }
        return map;
      };
      let map = buildMap('rpr_ts');
      let vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
      let usedBasis = 'rpr_ts';
      if (vals.length < 2) { map = buildMap('ofr'); vals = [...new Set(Object.values(map))].sort((a, b) => b - a); usedBasis = 'ofr'; }
      if (vals.length < 2) { skipped++; }
      else {
        basis[usedBasis]++;
        const rankOf = (id) => (map[id] == null ? -1 : vals.filter((v) => v > map[id]).length);
        const topSet = Object.keys(map).filter((id) => map[id] === vals[0]);
        const cut3 = vals[Math.min(2, vals.length - 1)];
        const top3Set = Object.keys(map).filter((id) => map[id] >= cut3);
        const wr = rankOf(win.horse_id);
        const d = spDec(win);
        const key = race.date || 'unknown';
        const day = (days[key] ||= { races: 0, cups: 0, gem2: 0, gem3: 0, top3: 0, pl: 0, pl3: 0, staked: 0, staked3: 0, nSel: 0, winSPs: [] });
        const crs = (courses[race.course] ||= { races: 0, cups: 0, top3: 0, pl: 0, staked: 0, pl3: 0, staked3: 0 });
        races++; day.races++; crs.races++;
        if (wr === 0) { day.cups++; crs.cups++; }
        if (wr === 1) day.gem2++;
        if (wr === 2) day.gem3++;
        if (wr >= 0 && wr <= 2) { day.top3++; crs.top3++; }
        day.staked += topSet.length; crs.staked += topSet.length;
        const plDelta = wr === 0 ? (d ? d - 1 : 0) - (topSet.length - 1) : -topSet.length;
        day.pl += plDelta; crs.pl += plDelta;
        day.staked3 += top3Set.length; crs.staked3 += top3Set.length;
        const pl3Delta = wr >= 0 && wr <= 2 ? (d ? d - 1 : 0) - (top3Set.length - 1) : -top3Set.length;
        day.pl3 += pl3Delta; crs.pl3 += pl3Delta;
        if (topSet.length === 1) {
          day.nSel++;
          if (wr === 0 && d) day.winSPs.push(d);
          if (String(race.type).trim().toLowerCase() === 'flat') {
            const drawnAll = runners.map((x) => parseInt(x.draw, 10)).filter((n) => n >= 1).sort((a, b) => a - b);
            const topRunner = runners.find((x) => x.horse_id === topSet[0]);
            const td = topRunner ? parseInt(topRunner.draw, 10) : NaN;
            if (drawnAll.length >= 6 && td >= 1) {
              const ti = drawnAll.indexOf(td);
              if (ti >= 0) {
                const tf = drawnAll.length > 1 ? ti / (drawnAll.length - 1) : 0.5;
                const tband = tf < 1 / 3 ? 'low' : tf <= 2 / 3 ? 'mid' : 'high';
                iconDraw[tband].runs++;
                if (wr === 0) { iconDraw[tband].wins++; iconDraw[tband].pl += d ? d - 1 : 0; }
                else iconDraw[tband].pl -= 1;
              }
            }
          }
        }
      }
    }

    // append outcomes to trainer log AFTER any grading (lookback races land here too)
    for (const x of runners) {
      if (!x.trainer_id) continue;
      (trainerLog[x.trainer_id] ||= []).push({ d: race.date, win: String(x.position) === '1' });
    }
  }

  // ---- build response ----
  const comb = (n, k) => { if (k > n) return 0; let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return Math.round(r); };
  const esyms = (ws) => { const e = [1, 0, 0, 0, 0]; for (const w of ws) for (let k = 4; k >= 1; k--) e[k] += e[k - 1] * w; return e; };
  const daily = Object.entries(days)
    .map(([date, v]) => {
      const e = esyms(v.winSPs);
      const mk = (k) => ({ pl: Math.round((e[k] - comb(v.nSel, k)) * 100) / 100, stake: comb(v.nSel, k) });
      const d2 = mk(2), d3 = mk(3), d4 = mk(4);
      const { winSPs, ...rest } = v;
      return { date, ...rest, pl: Math.round(v.pl * 100) / 100, pl3: Math.round(v.pl3 * 100) / 100,
        dbl: d2.pl, dblStake: d2.stake, trb: d3.pl, trbStake: d3.stake, acc4: d4.pl, acc4Stake: d4.stake };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  const sum = (k) => daily.reduce((a, x) => a + (x[k] || 0), 0);

  res.setHeader('Cache-Control', which === 'last'
    ? 's-maxage=604800, stale-while-revalidate=1209600'
    : 's-maxage=3600, stale-while-revalidate=21600');
  return res.status(200).json({
    ok: true, month: which, from: periodStart, to: fmt(end), lookbackFrom: fmt(lookbackStart),
    races, skipped, basis, upstreamTotal, truncated: skip < total, source, diag,
    iconDraw: Object.fromEntries(Object.entries(iconDraw).map(([band, v]) => [band, {
      runs: v.runs, wins: v.wins,
      'win_%': v.runs ? Math.round((v.wins / v.runs) * 1000) / 10 : 0,
      pl: Math.round(v.pl * 100) / 100 }])),
    byDraw: Object.entries(drawCourses)
      .map(([course, v]) => {
        const p = (n) => (v.races ? Math.round((n / v.races) * 1000) / 10 : 0);
        const bands = [['LOW', p(v.low)], ['MID', p(v.mid)], ['HIGH', p(v.high)]];
        bands.sort((a, b) => b[1] - a[1]);
        return { course, races: v.races, 'low_%': p(v.low), 'mid_%': p(v.mid), 'high_%': p(v.high),
          bias: bands[0][0] + ' +' + Math.round(bands[0][1] - 33.3),
          biasMag: Math.round((bands[0][1] - 33.3) * 10) / 10 };
      })
      .sort((a, b) => b.biasMag - a.biasMag),
    byCourse: Object.entries(courses)
      .map(([course, v]) => ({ course, ...v,
        pl: Math.round(v.pl * 100) / 100, pl3: Math.round(v.pl3 * 100) / 100,
        'cup_%': v.races ? Math.round((v.cups / v.races) * 1000) / 10 : 0,
        'top3_%': v.races ? Math.round((v.top3 / v.races) * 1000) / 10 : 0 }))
      .sort((a, b) => b.cups - a.cups),
    totals: {
      cups: sum('cups'), gem2: sum('gem2'), gem3: sum('gem3'), top3: sum('top3'),
      pl: Math.round(sum('pl') * 100) / 100, pl3: Math.round(sum('pl3') * 100) / 100,
      staked: sum('staked'), staked3: sum('staked3'),
      dbl: Math.round(sum('dbl') * 100) / 100, dblStake: sum('dblStake'),
      trb: Math.round(sum('trb') * 100) / 100, trbStake: sum('trbStake'),
      acc4: Math.round(sum('acc4') * 100) / 100, acc4Stake: sum('acc4Stake'),
    },
    daily,
  });
}
