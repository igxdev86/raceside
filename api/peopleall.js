// RACESIDE — people, all months in one call
// Reads the stored monthly people blobs (page_months, key people:v3), merges the last
// 12 months server-side — totals, placed, odds bands, and the busy-month/winning-month
// counts the steady badge needs — and returns one payload. Months not yet in the store
// are listed in `missing`; the page fetches those via /api/people (which stores them)
// and calls back.

import { monthGetAll } from '../lib/db.js';

export const config = { maxDuration: 30 };

const STORE_KEY = 'people:v5';

export default async function handler(req, res) {
  const now = new Date();
  const months = [];
  const cur = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1));
  while (cur <= now) { months.push(cur.toISOString().slice(0, 7)); cur.setUTCMonth(cur.getUTCMonth() + 1); }

  const rows = await monthGetAll(STORE_KEY, months);
  if (rows === null) return res.status(500).json({ ok: false, error: 'no-store', hint: 'create the page_months table in Supabase' });
  const have = {};
  rows.forEach((r) => { have[r.month] = r; });
  const curMonth = months[months.length - 1];
  const missing = months.filter((m) => {
    const r = have[m];
    if (!r) return true;
    // current month counts as missing when stale so the page refreshes it
    return m === curMonth && Date.now() - Date.parse(r.updated_at) > 21600000;
  });

  const merged = { jockeys: {}, trainers: {} };
  const pairs = {};
  const monthIdx = {};
  months.forEach((m, i) => { monthIdx[m] = i; });
  const baseline = { runs: 0, wins: 0, exp: 0 };
  const baselineC = {};
  for (const m of months) {
    const r = have[m];
    if (!r || !r.data || !r.data.ok) continue;
    const d = r.data;
    ['runs', 'wins', 'exp'].forEach((k) => { baseline[k] += (d.baseline || {})[k] || 0; });
    for (const [ck, cb] of Object.entries(d.baselineC || {})) {
      const t = (baselineC[ck] ||= { runs: 0, wins: 0, exp: 0 });
      t.runs += cb.runs; t.wins += cb.wins; t.exp += cb.exp;
    }
    for (const [pk, pr] of Object.entries(d.pairs || {})) {
      const t = (pairs[pk] ||= { j: pr.j, t: pr.t, r: 0, w: 0, e: 0, pl: 0 });
      t.r += pr.r; t.w += pr.w; t.e += pr.e; t.pl += pr.pl;
    }
    for (const bk of ['jockeys', 'trainers']) {
      for (const [id, s] of Object.entries(d[bk] || {})) {
        const t = (merged[bk][id] ||= { name: s.name, runs: 0, wins: 0, plc: 0, pl: 0, exp: 0,
          flat: { runs: 0, wins: 0 }, jumps: { runs: 0, wins: 0 }, ob: {}, mm: 0, mw: 0 });
        t.runs += s.runs; t.wins += s.wins; t.plc += (s.plc || 0); t.pl += s.pl; t.exp += s.exp;
        t.mo = t.mo || months.map(() => [0, 0]);
        const mi = monthIdx[m];
        if (mi != null) { t.mo[mi][0] += s.runs; t.mo[mi][1] += s.wins; }
        ['flat', 'jumps'].forEach((k) => { t[k].runs += s[k].runs; t[k].wins += s[k].wins; });
        for (const [bk2, ob] of Object.entries(s.ob || {})) {
          const tb = (t.ob[bk2] ||= { r: 0, w: 0, e: 0 });
          tb.r += ob.r; tb.w += ob.w; tb.e += ob.e;
        }
        t.cs = t.cs || {};
        for (const [ck, cb] of Object.entries(s.cs || {})) {
          const tc = (t.cs[ck] ||= { r: 0, w: 0, p: 0, e: 0, pl: 0 });
          tc.r += cb.r; tc.w += cb.w; tc.p += cb.p; tc.e += cb.e; tc.pl += cb.pl;
        }
        if (s.runs >= 10) { t.mm++; if (s.wins > 0) t.mw++; }
      }
    }
  }
  for (const bk of ['jockeys', 'trainers']) {
    for (const t of Object.values(merged[bk])) {
      t.pl = Math.round(t.pl * 100) / 100; t.exp = Math.round(t.exp * 100) / 100;
      if (t.runs < 50) delete t.mo;   // keep the payload sane: charts for 50+ run people only
    }
  }
  baseline.exp = Math.round(baseline.exp * 100) / 100;

  res.setHeader('Cache-Control', missing.length ? 'no-store' : 's-maxage=3600, stale-while-revalidate=21600');
  baselineC && Object.values(baselineC).forEach((cb) => { cb.exp = Math.round(cb.exp * 100) / 100; });
  for (const pr of Object.values(pairs)) { pr.e = Math.round(pr.e * 100) / 100; pr.pl = Math.round(pr.pl * 100) / 100; }
  return res.status(200).json({ ok: true, months, missing, monthsStored: months.length - missing.length, baseline, baselineC, jockeys: merged.jockeys, trainers: merged.trainers, pairs });
}
