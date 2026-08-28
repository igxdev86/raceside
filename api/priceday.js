// RACESIDE — one day's results with full runner detail, for the dated price page
// ?date=YYYY-MM-DD (defaults to yesterday). Every GB/IRE race with each runner's
// horse, people, official rating, weight carried and SP — enough to re-price the
// day with the site's model and grade it against what actually happened.

export const config = { maxDuration: 60 };

function spDec(x) {
  const d = Number(x.sp_dec);
  if (!isNaN(d) && d > 1) return d;
  const m = String(x.sp || '').match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]) + 1;
  if (/^evens?$/i.test(String(x.sp || ''))) return 2;
  return null;
}
function lbsOf(x) {
  const v = parseInt(x.lbs, 10);
  if (v >= 80 && v <= 200) return v;
  const m = String(x.weight || '').match(/^(\d{1,2})-(\d{1,2})$/);
  return m ? Number(m[1]) * 14 + Number(m[2]) : null;
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
  const out = races.map((race) => ({
    t: race.off || '',
    dist: (() => {
      const f = parseFloat(race.dist_f);
      if (f > 0) return f;
      const m = String(race.dist || '').match(/(?:(\d+)m)?\s*(\d+(?:\.\d+)?)?f?/);
      if (!m) return null;
      const fur = (m[1] ? Number(m[1]) * 8 : 0) + (m[2] ? Number(m[2]) : 0);
      return fur > 0 ? fur : null;
    })(),
    course: race.course || '?',
    name: race.race_name || '',
    csf: (() => { const v = parseFloat(String(race.tote_csf || '').replace(/[\u00a3,]/g, '')); return v > 0 ? v : null; })(),
    trc: (() => { const v = parseFloat(String(race.tote_tricast || '').replace(/[\u00a3,]/g, '')); return v > 0 ? v : null; })(),
    runners: (race.runners || []).map((x) => ({
      h: x.horse || '?',
      jockey: x.jockey || '',
      jid: x.jockey_id || null,
      tid: x.trainer_id || null,
      ofr: (() => { const v = parseInt(x.or != null ? x.or : x.ofr, 10); return v >= 1 && v <= 200 ? v : null; })(),
      lbs: lbsOf(x),
      d: spDec(x),
      won: String(x.position) === '1' ? 1 : 0,
      pos: x.position != null && String(x.position) !== '' ? String(x.position) : null,
    })),
  }));
  res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, date: d, races: out });
}
