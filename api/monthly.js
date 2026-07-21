// RACESIDE — monthly icon performance grader (v2)
// Grades the ratings core of SCORE over the period, tie-aware, same icon rules as the app.
// Basis per race: rpr_ts (RPR 25 + TS 15) → fallback ofr (official rating, 40) → skip.
// Always returns a small raw-data diagnostic so failures are visible, never silent.

export const config = { maxDuration: 60 };

const numRt = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '\u2013') return NaN;
  const n = Number(s);
  return n > 0 ? n : NaN;
};
function relUnit(v, arr) {
  const ns = arr.filter((x) => !isNaN(x));
  if (isNaN(v) || ns.length < 2) return 0.4;
  const mn = Math.min(...ns), mx = Math.max(...ns);
  return mx > mn ? (v - mn) / (mx - mn) : 0.6;
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
function buildMap(runners, mode) {
  const map = {};
  if (mode === 'rpr_ts') {
    const rprs = runners.map((x) => numRt(x.rpr));
    const tss = runners.map((x) => numRt(x.tsr));
    runners.forEach((x, i) => {
      if (!x.horse_id) return;
      map[x.horse_id] = Math.round((relUnit(rprs[i], rprs) * 25 + relUnit(tss[i], tss) * 15) * 100) / 100;
    });
  } else {
    const ors = runners.map((x) => numRt(x.or));
    runners.forEach((x, i) => {
      if (!x.horse_id) return;
      map[x.horse_id] = Math.round(relUnit(ors[i], ors) * 40 * 100) / 100;
    });
  }
  return map;
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
  const fmt = (d) => d.toISOString().slice(0, 10);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const days = {};
  const courses = {};
  const basis = { rpr_ts: 0, ofr: 0 };
  const diag = [];
  let races = 0, skipped = 0, skip = 0, total = Infinity, pages = 0, upstreamTotal = null;

  try {
    while (skip < total && pages < 30) {
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
        return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status, detail: body.slice(0, 300) });
      }
      const page = await r.json();
      total = Number(page.total) || 0;
      upstreamTotal = total;
      for (const race of page.results || []) {
        const runners = race.runners || [];
        if (diag.length < 3 && runners[0]) {
          const f = runners[0];
          diag.push({ date: race.date, rpr: f.rpr ?? null, tsr: f.tsr ?? null, or: f.or ?? null, sp_dec: f.sp_dec ?? null, pos: f.position ?? null });
        }
        if (runners.length < 2) { skipped++; continue; }
        const win = runners.find((x) => String(x.position) === '1');
        if (!win || !win.horse_id) { skipped++; continue; }

        let map = buildMap(runners, 'rpr_ts');
        let vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
        let usedBasis = 'rpr_ts';
        if (vals.length < 2) {
          map = buildMap(runners, 'ofr');
          vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
          usedBasis = 'ofr';
        }
        if (vals.length < 2) { skipped++; continue; }
        basis[usedBasis]++;

        const rankOf = (id) => (map[id] == null ? -1 : vals.filter((v) => v > map[id]).length);
        const topSet = Object.keys(map).filter((id) => map[id] === vals[0]);
        const cut3 = vals[Math.min(2, vals.length - 1)];
        const top3Set = Object.keys(map).filter((id) => map[id] >= cut3);
        const wr = rankOf(win.horse_id);
        const d = spDec(win);
        const key = race.date || 'unknown';
        const day = (days[key] ||= { races: 0, cups: 0, gem2: 0, gem3: 0, top3: 0, pl: 0, pl3: 0, staked: 0, staked3: 0, nSel: 0, winSPs: [] });
        // multiples slate: unique top pick only (ties can't be acca legs)
        if (topSet.length === 1) {
          day.nSel++;
          if (wr === 0) { const dd = spDec(win); if (dd) day.winSPs.push(dd); }
        }
        races++; day.races++;
        const cKey = race.course || 'Unknown';
        const crs = (courses[cKey] ||= { races: 0, cups: 0, top3: 0, pl: 0, staked: 0, pl3: 0, staked3: 0 });
        crs.races++;
        if (wr === 0) crs.cups++;
        if (wr >= 0 && wr <= 2) crs.top3++;
        crs.staked += topSet.length;
        crs.pl += wr === 0 ? ((d || 1) - 1) - (topSet.length - 1) : -topSet.length;
        crs.staked3 += top3Set.length;
        crs.pl3 += wr >= 0 && wr <= 2 ? ((d || 1) - 1) - (top3Set.length - 1) : -top3Set.length;
        if (wr === 0) day.cups++;
        if (wr === 1) day.gem2++;
        if (wr === 2) day.gem3++;
        if (wr >= 0 && wr <= 2) day.top3++;
        day.staked += topSet.length;
        day.pl += wr === 0 ? (d ? d - 1 : 0) - (topSet.length - 1) : -topSet.length;
        day.staked3 += top3Set.length;
        day.pl3 += wr >= 0 && wr <= 2 ? (d ? d - 1 : 0) - (top3Set.length - 1) : -top3Set.length;
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 700));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  const comb = (n, k) => {
    if (k > n) return 0;
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  };
  const esyms = (ws) => {
    const e = [1, 0, 0, 0, 0];
    for (const w of ws) for (let k = 4; k >= 1; k--) e[k] += e[k - 1] * w;
    return e;
  };
  const daily = Object.entries(days)
    .map(([date, v]) => {
      const e = esyms(v.winSPs);
      const mk = (k) => {
        const stake = comb(v.nSel, k);
        return { pl: Math.round((e[k] - stake) * 100) / 100, stake };
      };
      const d2 = mk(2), d3 = mk(3), d4 = mk(4);
      const { winSPs, ...rest } = v;
      return { date, ...rest,
        pl: Math.round(v.pl * 100) / 100, pl3: Math.round(v.pl3 * 100) / 100,
        dbl: d2.pl, dblStake: d2.stake, trb: d3.pl, trbStake: d3.stake, acc4: d4.pl, acc4Stake: d4.stake };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  const sum = (k) => daily.reduce((a, x) => a + (x[k] || 0), 0);

  res.setHeader('Cache-Control', which === 'last'
    ? 's-maxage=604800, stale-while-revalidate=1209600'
    : 's-maxage=3600, stale-while-revalidate=21600');
  return res.status(200).json({
    ok: true, month: which, from: fmt(start), to: fmt(end),
    races, skipped, basis, upstreamTotal, truncated: skip < total, diag,
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
