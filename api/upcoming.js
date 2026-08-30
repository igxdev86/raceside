// RACESIDE — upcoming rides
// Every GB/IRE runner on today's and tomorrow's cards with jockey/trainer ids, best odds,
// and the overround-stripped market win probability. The J&T page uses this to plot a
// person's coming rides with likelihoods.

export const config = { maxDuration: 30 };

function bestOdds(r) {
  let best = null;
  for (const o of r.odds || []) {
    const d = Number(o.decimal);
    if (!isNaN(d) && d > 1 && (!best || d > best)) best = d;
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
  const rides = [];
  for (const day of ['today', 'tomorrow']) {
    let cards = null;
    for (const tier of ['standard', 'basic', 'free']) {
      try { cards = await get('/v1/racecards/' + tier + '?day=' + day); break; } catch {}
    }
    if (!cards) continue;
    (cards.racecards || []).forEach((rc) => {
      if (!['gb', 'ire'].includes(String(rc.region || '').toLowerCase())) return;
      const isNR = (x) => x.non_runner === true || x.non_runner === 1 ||
        /^(true|1|yes|nr)$/i.test(String(x.non_runner == null ? '' : x.non_runner).trim()) ||
        String(x.number == null ? '' : x.number).trim().toUpperCase() === 'NR';
      const priced = (rc.runners || [])
        .filter((x) => !isNR(x))
        .map((x) => ({ x, d: bestOdds(x) })).filter((p) => p.d && p.x.horse_id);
      if (priced.length < 2) return;
      const over = priced.reduce((a, p) => a + 1 / p.d, 0);
      priced.sort((a, b) => a.d - b.d);
      priced.forEach((p, i) => {
        rides.push({
          day, date: rc.date || '', t: rc.off_time || rc.off || '', course: rc.course || '?',
          dist: rc.distance_f || rc.distance || '', going: rc.going || '',
          rtype: rc.race_name && /handicap/i.test(rc.race_name) ? 'Handicap' : (rc.type || rc.race_type || rc.race_class || ''),
          rname: String(rc.race_name || '').slice(0, 60),
          h: p.x.horse || '', d: Math.round(p.d * 100) / 100,
          mp: Math.round((1 / p.d / over) * 1000) / 10,   // stripped market win %, e.g. 21.4
          rank: i + 1, n: priced.length,
          jid: p.x.jockey_id || null, tid: p.x.trainer_id || null,
          jockey: p.x.jockey || '', trainer: p.x.trainer || '',
          form: String(p.x.form || '').slice(-6),
          ofr: (() => { const v = parseInt(p.x.ofr != null ? p.x.ofr : (p.x.or != null ? p.x.or : p.x.official_rating), 10); return v >= 1 ? v : null; })(),
          lbs: (() => {
            const v = parseInt(p.x.lbs, 10);
            if (v >= 80 && v <= 200) return v;
            const m = String(p.x.weight || '').match(/^(\d{1,2})-(\d{1,2})$/);
            return m ? Number(m[1]) * 14 + Number(m[2]) : null;
          })(),
        });
      });
    });
  }
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
  return res.status(200).json({ ok: true, at: new Date().toISOString(), rides });
}
