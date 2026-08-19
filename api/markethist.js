// RACESIDE — market history (reader)
// ?day=today|tomorrow (or ?date=YYYY-MM-DD). Returns per-horse open/now/path from
// market_ticks plus results for settled races. Falls back to a live one-shot
// snapshot (no history) if the table is empty for that date.

export const config = { maxDuration: 30 };

function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}
function bestOdds(r) {
  let best = null;
  for (const o of r.odds || []) {
    const d = Number(o.decimal);
    if (!isNaN(d) && d > 1 && (!best || d > best.d)) best = { d, frac: o.fractional || '' };
  }
  return best;
}

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  const auth = user && pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
  const get = async (path) => {
    const r = await fetch('https://api.theracingapi.com' + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  };
  const day = String(req.query.day || 'today');
  const base = new Date();
  if (day === 'tomorrow') base.setUTCDate(base.getUTCDate() + 1);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : base.toISOString().slice(0, 10);

  const s = supa();
  let rows = [];
  if (s) {
    let offset = 0;
    for (;;) {
      const r = await fetch(`${s.url}/rest/v1/market_ticks?race_date=eq.${date}&select=race_id,horse_id,snapped_at,dec,frac,horse,course,off,jockey,trainer,rank,n&order=snapped_at.asc&limit=1000&offset=${offset}`,
        { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
      if (!r.ok) break;
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
      if (offset > 200000) break;
    }
  }

  // results for settled races (today only makes sense, but harmless for a past date)
  const winners = {};
  if (auth && day === 'today') {
    try {
      const results = await get('/v1/results/today');
      (results.results || []).forEach((race) => {
        const w = (race.runners || []).find((r) => String(r.position) === '1');
        if (race.race_id && w && w.horse_id) winners[race.race_id] = { id: w.horse_id, name: w.horse || '' };
      });
    } catch {}
  }

  let runners = [];
  let source = 'history';
  if (rows.length) {
    const byHorse = {};
    rows.forEach((t) => {
      const h = (byHorse[t.horse_id] ||= { id: t.horse_id, race: t.race_id, h: t.horse, course: t.course, t: t.off, j: t.jockey, tr: t.trainer, path: [] });
      h.path.push([t.snapped_at, Number(t.dec)]);
      h.rank = t.rank; h.n = t.n; h.frac = t.frac;
    });
    runners = Object.values(byHorse).map((h) => {
      const open = h.path[0][1], now = h.path[h.path.length - 1][1];
      const hi = Math.max(...h.path.map((p) => p[1])), lo = Math.min(...h.path.map((p) => p[1]));
      const win = winners[h.race] || null;
      // sparse path for sparkline: up to 24 points
      const step = Math.max(1, Math.floor(h.path.length / 24));
      const sp = h.path.filter((_, i) => i % step === 0 || i === h.path.length - 1).map((p) => p[1]);
      return { id: h.id, h: h.h, t: h.t, course: h.course, race: h.race, j: h.j, tr: h.tr, rank: h.rank, n: h.n,
        b: open, d: now, hi, lo, ticks: h.path.length, first: h.path[0][0], last: h.path[h.path.length - 1][0], spark: sp,
        won: win ? (win.id === h.id ? 1 : 0) : null };
    });
  } else if (auth) {
    // no history yet for this date: one-shot live snapshot
    source = 'live';
    let cards = null;
    for (const tier of ['standard', 'basic', 'free']) {
      try { cards = await get('/v1/racecards/' + tier + '?day=' + (day === 'tomorrow' ? 'tomorrow' : 'today')); break; } catch {}
    }
    (cards && cards.racecards || []).forEach((rc) => {
      if (!['gb', 'ire'].includes(String(rc.region || '').toLowerCase())) return;
      const priced = (rc.runners || []).map((x) => ({ x, o: bestOdds(x) })).filter((p) => p.o && p.x.horse_id);
      priced.sort((a, b) => a.o.d - b.o.d);
      const win = winners[rc.race_id] || null;
      priced.forEach((p, i) => runners.push({
        id: p.x.horse_id, h: p.x.horse || '', t: rc.off_time || rc.off || '', course: rc.course || '?', race: rc.race_id,
        j: p.x.jockey || '', tr: p.x.trainer || '', rank: i + 1, n: priced.length,
        b: p.o.d, d: p.o.d, hi: p.o.d, lo: p.o.d, ticks: 1, spark: [p.o.d],
        won: win ? (win.id === p.x.horse_id ? 1 : 0) : null,
      }));
    });
  }
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  return res.status(200).json({ ok: true, date, day, source, at: new Date().toISOString(), runners });
}
