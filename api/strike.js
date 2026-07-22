// RACESIDE — strike engine
// From ~2 months of GB+IRE results, replayed chronologically per day:
// how often is a race icon-won (winner in top-3 ratings-core ranks, tie-aware),
// conditioned on the current drought — the number of consecutive non-icon results
// immediately before it? Returns the empirical hazard table + base rate.

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
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, now.getUTCDate()));
  const fmt = (d) => d.toISOString().slice(0, 10);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const byDay = {}; // date → [{off, iconWin}]
  let races = 0, skip = 0, total = Infinity, pages = 0;

  try {
    while (skip < total && pages < 36) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire` +
        `&start_date=${fmt(start)}&end_date=${fmt(now)}&limit=50&skip=${skip}`;
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
        const runners = race.runners || [];
        if (runners.length < 2) continue;
        const win = runners.find((x) => String(x.position) === '1');
        if (!win || !win.horse_id) continue;
        // ratings-core map (rpr+tsr, ofr fallback), tie-aware dense ranks
        const build = (mode) => {
          const map = {};
          if (mode === 'rpr_ts') {
            const rprs = runners.map((x) => numRt(x.rpr));
            const tss = runners.map((x) => numRt(x.tsr));
            runners.forEach((x, i) => { if (x.horse_id) map[x.horse_id] = Math.round((relUnit(rprs[i], rprs) * 22 + relUnit(tss[i], tss) * 13) * 100) / 100; });
          } else {
            const ors = runners.map((x) => numRt(x.or));
            runners.forEach((x, i) => { if (x.horse_id) map[x.horse_id] = Math.round(relUnit(ors[i], ors) * 35 * 100) / 100; });
          }
          return map;
        };
        let map = build('rpr_ts');
        let vals = [...new Set(Object.values(map))].sort((a, b) => b - a);
        if (vals.length < 2) { map = build('ofr'); vals = [...new Set(Object.values(map))].sort((a, b) => b - a); }
        if (vals.length < 2) continue;
        const cut3 = vals[Math.min(2, vals.length - 1)];
        const iconWin = map[win.horse_id] != null && map[win.horse_id] >= cut3;
        races++;
        (byDay[race.date || '?'] ||= []).push({ off: offMin(race.off), iconWin });
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 650));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  // hazard by drought length, streaks reset daily
  const hazard = {}; // gap → {cases, iconWins}
  let iconTotal = 0, caseTotal = 0;
  for (const day of Object.keys(byDay)) {
    const seq = byDay[day].sort((a, b) => a.off - b.off);
    let gap = 0;
    for (const r of seq) {
      const g = Math.min(gap, 10); // pool 10+
      const h = (hazard[g] ||= { cases: 0, iconWins: 0 });
      h.cases++; caseTotal++;
      if (r.iconWin) { h.iconWins++; iconTotal++; gap = 0; }
      else gap++;
    }
  }

  res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, from: fmt(start), to: fmt(now), races,
    base: caseTotal ? Math.round((iconTotal / caseTotal) * 1000) / 10 : 0,
    hazard: Object.entries(hazard)
      .map(([gap, v]) => ({ gap: Number(gap), cases: v.cases, iconWins: v.iconWins,
        pct: v.cases ? Math.round((v.iconWins / v.cases) * 1000) / 10 : 0 }))
      .sort((a, b) => a.gap - b.gap),
  });
}
