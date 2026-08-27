// RACESIDE — yesterday's results, shaped for the day review
// One day of GB/IRE results: every race's winner (with SP) plus per-person ride/win
// tallies for the day. The page crosses these with the 12-month store to find who
// out-rode or under-rode their own numbers.

export const config = { maxDuration: 60 };

function spDec(x) {
  const d = Number(x.sp_dec);
  if (!isNaN(d) && d > 1) return d;
  const m = String(x.sp || '').match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]) + 1;
  if (/^evens?$/i.test(String(x.sp || ''))) return 2;
  return null;
}
function offMin(off) {
  const m = String(off || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  let hh = Number(m[1]);
  if (hh < 10) hh += 12;
  return hh * 60 + Number(m[2]);
}

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date)
    : new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const races = [];
  let skip = 0, total = Infinity, pages = 0;
  try {
    while (skip < total && pages < 10) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire&start_date=${d}&end_date=${d}&limit=50&skip=${skip}`;
      const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status });
      const page = await r.json();
      total = Number(page.total) || 0;
      for (const race of page.results || []) races.push(race);
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 400));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
  races.sort((a, b) => offMin(a.off) - offMin(b.off));
  const out = [];
  const J = {}, T = {};
  for (const race of races) {
    const rs = (race.runners || []).map((x) => ({ x, d: spDec(x) }));
    const priced = rs.filter((p) => p.d).sort((a, b) => a.d - b.d);
    const win = rs.find((p) => String(p.x.position) === '1');
    const favRank = win && win.d ? priced.findIndex((p) => p.x.horse_id === win.x.horse_id) + 1 : null;
    if (win) out.push({
      t: race.off || '', course: race.course || '?', horse: win.x.horse || '?',
      sp: win.x.sp || '', d: win.d, favRank, n: priced.length,
      jockey: win.x.jockey || '', jid: win.x.jockey_id || null,
      trainer: win.x.trainer || '', tid: win.x.trainer_id || null,
      field: rs.filter((p) => p.x.jockey_id || p.x.trainer_id).map((p) => ({
        jid: p.x.jockey_id || null, tid: p.x.trainer_id || null, d: p.d,
        won: String(p.x.position) === '1' ? 1 : 0,
      })),
    });
    for (const { x, d: dd } of rs) {
      const won = String(x.position) === '1';
      if (x.jockey_id) {
        const s = (J[x.jockey_id] ||= { name: x.jockey || '?', r: 0, w: 0, e: 0, winSps: [] });
        s.r++;
        if (dd) s.e += 1 / dd;
        if (won) { s.w++; if (x.sp) s.winSps.push(x.sp); }
      }
      if (x.trainer_id) {
        const s = (T[x.trainer_id] ||= { name: x.trainer || '?', r: 0, w: 0, e: 0, winSps: [] });
        s.r++;
        if (dd) s.e += 1 / dd;
        if (won) { s.w++; if (x.sp) s.winSps.push(x.sp); }
      }
    }
  }
  for (const b of [J, T]) for (const s of Object.values(b)) s.e = Math.round(s.e * 100) / 100;
  res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, date: d, races: out, jockeys: J, trainers: T });
}
