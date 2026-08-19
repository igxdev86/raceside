// RACESIDE — market snapshot
// Every GB/IRE runner on today's cards with current best available odds, market position,
// settled flag and winner. The page diffs successive snapshots to show movement; the
// first snapshot of the day a device sees becomes its baseline.

export const config = { maxDuration: 30 };

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
    (results.results || []).forEach((race) => {
      const w = (race.runners || []).find((r) => String(r.position) === '1');
      if (race.race_id && w && w.horse_id) winners[race.race_id] = { id: w.horse_id, name: w.horse || '' };
    });

    const runners = [];
    (cards.racecards || []).forEach((rc) => {
      if (!['gb', 'ire'].includes(String(rc.region || '').toLowerCase())) return;
      const priced = (rc.runners || []).map((x) => ({ x, o: bestOdds(x) })).filter((p) => p.o && p.x.horse_id);
      priced.sort((a, b) => a.o.d - b.o.d);
      const win = winners[rc.race_id] || null;
      priced.forEach((p, i) => {
        runners.push({
          id: p.x.horse_id, h: p.x.horse || '', t: rc.off_time || rc.off || '', course: rc.course || '?',
          race: rc.race_id, d: Math.round(p.o.d * 100) / 100, frac: p.o.frac, rank: i + 1, n: priced.length,
          j: p.x.jockey || '', tr: p.x.trainer || '',
          won: win ? (win.id === p.x.horse_id ? 1 : 0) : null,
        });
      });
    });
    res.setHeader('Cache-Control', 's-maxage=90, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, at: new Date().toISOString(), runners });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
}
