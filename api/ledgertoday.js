// RACESIDE — ledger today
// Today's races (settled and unrun) with the backtest skeleton's likely selection per race,
// rated-only icon labels, favourite flag, sire, and the View's U ghost — settled at SP as
// results land. Card best odds are the price basis for unrun races (SP doesn't exist yet).
// Note: the live approximation omits the rolling trainer-form component (needs history),
// so a small minority of borderline selections can differ from tonight's settled replay.

export const config = { maxDuration: 60 };

const parseRt = (v) => { const n = Number(String(v ?? '').trim()); return n > 0 ? n : NaN; };
function relUnit(v, arr) {
  const ns = arr.filter((x) => !isNaN(x));
  if (isNaN(v) || ns.length < 2) return 0.4;
  const mn = Math.min(...ns), mx = Math.max(...ns);
  return mx > mn ? (v - mn) / (mx - mn) : 0.6;
}
function bestOdds(r) {
  let best = null;
  for (const o of r.odds || []) {
    const d = Number(o.decimal);
    if (!isNaN(d) && d > 1 && (!best || d > best)) best = d;
  }
  return best;
}
function spDec2(run) {
  const d = Number(run && run.sp_dec);
  if (!isNaN(d) && d > 1) return d;
  const s = String((run && run.sp) || '').replace(/[^\d/.]/g, '');
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); if (a > 0 && b > 0) return a / b + 1; }
  const n = Number(s);
  return !isNaN(n) && n > 1 ? n : null;
}

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const get = async (path) => {
    const r = await fetch('https://api.theracingapi.com' + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  };
  try {
    let cards = null;
    for (const tier of ['standard', 'basic', 'free']) {
      try { cards = await get('/v1/racecards/' + tier + '?day=today'); break; } catch {}
    }
    if (!cards) return res.status(502).json({ ok: false, error: 'no-racecards' });
    let results = { results: [] };
    try { results = await get('/v1/results/today'); } catch {}

    const winners = {};
    const spOf = {};
    (results.results || []).forEach((race) => {
      const w = (race.runners || []).find((r) => String(r.position) === '1');
      if (race.race_id && w && w.horse_id) winners[race.race_id] = { id: w.horse_id, name: w.horse || '', sp: spDec2(w) };
      if (race.race_id) {
        const m2 = (spOf[race.race_id] ||= {});
        (race.runners || []).forEach((r) => { const d = spDec2(r); if (r.horse_id && d) m2[r.horse_id] = d; });
      }
    });

    const out = [];
    (cards.racecards || []).forEach((rc) => {
      if (!['gb', 'ire'].includes(String(rc.region || '').toLowerCase())) return;
      const runners = (rc.runners || []).filter((x) => x.horse_id);
      if (runners.length < 4) return;
      const priced = runners.map((x) => ({ x, d: bestOdds(x) })).filter((p) => p.d);
      if (priced.length < 4) return;
      priced.sort((a, b) => a.d - b.d);
      const over = priced.reduce((a, p) => a + 1 / p.d, 0);
      // rated-only score universe (rpr + ts card ruler)
      const rprs = runners.map((x) => parseRt(x.rpr));
      const tss = runners.map((x) => parseRt(x.ts ?? x.tsr));
      const sc = {};
      runners.forEach((x, i) => { sc[x.horse_id] = relUnit(rprs[i], rprs) * 22 + relUnit(tss[i], tss) * 13; });
      const noRtOf = (x) => isNaN(parseRt(x.rpr)) && isNaN(parseRt(x.ts ?? x.tsr));
      const ratedVals = [...new Set(runners.filter((x) => !noRtOf(x)).map((x) => sc[x.horse_id]))].sort((a, b) => b - a);
      const rankR = (x) => noRtOf(x) ? 99 : ratedVals.filter((q) => q > sc[x.horse_id]).length;
      // skeleton selection: overround-stripped market prob x icon rank boosts
      let pick = null;
      priced.forEach((p, i) => {
        const rk = rankR(p.x);
        const v = (1 / p.d / over) * (rk === 0 ? 1.15 : rk <= 2 ? 1.08 : 1);
        if (!pick || v > pick.v) pick = { ...p, v, rk, mkt: i };
      });
      if (!pick) return;
      // U ghost per the View rule (card odds basis)
      const iconSps = priced.filter((p) => rankR(p.x) <= 2).map((p) => p.d);
      const maxIconSp = iconSps.length ? Math.max(...iconSps) : null;
      const cut3 = ratedVals.length >= 3 ? ratedVals[2] : null;
      let u = null;
      if (maxIconSp != null && cut3 != null) {
        priced.forEach((p, i) => {
          if (i > 2 || !(p.d <= 9) || !(p.d <= maxIconSp * 1.1)) return;
          if (rankR(p.x) <= 2) return;
          const s2 = sc[p.x.horse_id];
          if (!(s2 == null || noRtOf(p.x) || s2 <= cut3 - 4)) return;
          if (!u || p.d < u.d) u = p;
        });
      }
      const win = winners[rc.race_id] || null;
      const settle = (horse) => {
        if (!win) return { won: null, sp: null };
        const sp2 = (spOf[rc.race_id] || {})[horse.horse_id] || null;
        return { won: win.id === horse.horse_id ? 1 : 0, sp: sp2 ? Math.round(sp2 * 100) / 100 : null };
      };
      const ps = settle(pick.x);
      const entry = {
        t: rc.off_time || rc.off || '', course: rc.course || '?',
        h: pick.x.horse || '', d: Math.round(pick.d * 100) / 100,
        ic: pick.rk <= 2 ? pick.rk : null, fv: pick.mkt === 0 ? 1 : 0,
        sid: pick.x.sire_id || null,
        won: ps.won, ssp: ps.sp,
        ...(win && ps.won === 0 ? { wh: win.name, wsp: win.sp ? Math.round(win.sp * 100) / 100 : null } : {}),
      };
      if (u) {
        const us = settle(u.x);
        entry.uh = u.x.horse || '';
        entry.ud = Math.round(u.d * 100) / 100;
        entry.usid = u.x.sire_id || null;
        entry.uwon = us.won;
        entry.ussp = us.sp;
        if (win && us.won === 0) { entry.uwh = win.name; entry.uwsp = win.sp ? Math.round(win.sp * 100) / 100 : null; }
      }
      out.push(entry);
    });
    out.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({ ok: true, gen: 4, races: out });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
}
