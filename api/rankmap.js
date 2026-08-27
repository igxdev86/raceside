// RACESIDE — rank map
// Percentile standing of every qualified jockey (100+ runs), trainer (100+) and
// jockey|trainer pair (20+) in the 12-month A/E tables, computed from the stored
// people months. Small payload for pages that only need the standings.

import { monthGetAll } from '../lib/db.js';

export const config = { maxDuration: 30 };

const STORE_KEY = 'people:v5';

export default async function handler(req, res) {
  const now = new Date();
  const months = [];
  const cur = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1));
  while (cur <= now) { months.push(cur.toISOString().slice(0, 7)); cur.setUTCMonth(cur.getUTCMonth() + 1); }
  const rows = await monthGetAll(STORE_KEY, months);
  if (rows === null) return res.status(500).json({ ok: false, error: 'no-store' });

  const J = {}, T = {}, P = {};
  for (const r of rows) {
    const d = r.data;
    if (!d || !d.ok) continue;
    for (const [bkName, acc] of [['jockeys', J], ['trainers', T]]) {
      for (const [id, s] of Object.entries(d[bkName] || {})) {
        const t = (acc[id] ||= { r: 0, w: 0, e: 0 });
        t.r += s.runs; t.w += s.wins; t.e += s.exp;
      }
    }
    for (const [pk, pr] of Object.entries(d.pairs || {})) {
      const t = (P[pk] ||= { r: 0, w: 0, e: 0 });
      t.r += pr.r; t.w += pr.w; t.e += pr.e;
    }
  }
  const pctMap = (acc, minR) => {
    const list = Object.entries(acc)
      .filter(([, s]) => s.r >= minR && s.e > 0)
      .map(([id, s]) => ({ id, ae: s.w / s.e }))
      .sort((a, b) => b.ae - a.ae);
    const map = {};
    const n = list.length;
    list.forEach((x, i) => { map[x.id] = n > 1 ? Math.round((1 - i / (n - 1)) * 100) : 50; });
    return map;
  };
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, months: rows.length, j: pctMap(J, 100), t: pctMap(T, 100), p: pctMap(P, 20) });
}
