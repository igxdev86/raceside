// RACESIDE — ratings integrity check
// Question: are rpr/tsr in the RESULTS feed the same pre-race figures printed on the
// racecard, or post-race performance ratings assigned after the run (which would leak
// the result into every backtest that scores from them)?
// Method: today's racecards are pre-race by construction. Join settled races' card
// figures against the results feed's figures per horse and measure agreement.
// If they match ~exactly → results carry pre-race figures → backtests are clean.
// If winners' results figures systematically exceed their card figures → leakage.

export const config = { maxDuration: 60 };

const num = (v) => {
  const n = Number(String(v ?? '').trim());
  return n > 0 ? n : null;
};

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
    const results = await get('/v1/results/today');
    if (!cards) return res.status(502).json({ ok: false, error: 'no-racecards' });

    // card figures by race/horse
    const card = {};
    (cards.racecards || []).forEach((rc) => {
      if (!['gb', 'ire'].includes(String(rc.region || '').toLowerCase())) return;
      const m = (card[rc.race_id] ||= {});
      (rc.runners || []).forEach((x) => {
        if (x.horse_id) m[x.horse_id] = { rpr: num(x.rpr), ts: num(x.ts), or: num(x.ofr ?? x.or), horse: x.horse };
      });
    });

    const stats = {
      races: 0, horses: 0,
      rpr: { both: 0, match: 0, resHigher: 0, cardHigher: 0, cardOnly: 0, resOnly: 0, sumDiff: 0 },
      ts: { both: 0, match: 0, resHigher: 0, cardHigher: 0, cardOnly: 0, resOnly: 0, sumDiff: 0 },
      byPos: {}, // finishing pos band -> { n, rprDiffSum } — post-race figures would show winners' diffs positive
    };
    const samples = [];

    (results.results || []).forEach((race) => {
      const cm = card[race.race_id];
      if (!cm) return;
      stats.races++;
      (race.runners || []).forEach((x) => {
        if (!x.horse_id || !cm[x.horse_id]) return;
        const c = cm[x.horse_id];
        const rRpr = num(x.rpr), rTs = num(x.tsr);
        stats.horses++;
        const tally = (key, cv, rv) => {
          const s = stats[key];
          if (cv != null && rv != null) {
            s.both++;
            if (cv === rv) s.match++;
            else if (rv > cv) s.resHigher++;
            else s.cardHigher++;
            s.sumDiff += rv - cv;
          } else if (cv != null) s.cardOnly++;
          else if (rv != null) s.resOnly++;
        };
        tally('rpr', c.rpr, rRpr);
        tally('ts', c.ts, rTs);
        const pos = String(x.position || '');
        const band = pos === '1' ? 'won' : /^[23]$/.test(pos) ? 'placed' : 'other';
        if (c.rpr != null && rRpr != null) {
          const b = (stats.byPos[band] ||= { n: 0, rprDiffSum: 0 });
          b.n++;
          b.rprDiffSum += rRpr - c.rpr;
        }
        if (samples.length < 12 && c.rpr != null && rRpr != null) {
          samples.push({ horse: c.horse, pos, cardRpr: c.rpr, resultRpr: rRpr, cardTs: c.ts, resultTsr: rTs });
        }
      });
    });

    const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
    const verdict = (() => {
      const r = stats.rpr;
      if (r.both < 30) return 'not enough settled races yet — check after a few races have run';
      const matchPct = pct(r.match, r.both);
      const wonBand = stats.byPos.won;
      const wonDrift = wonBand && wonBand.n ? wonBand.rprDiffSum / wonBand.n : 0;
      if (matchPct >= 97) return 'CLEAN: results carry the pre-race card figures (' + matchPct + '% exact match) — backtests are not leaking';
      if (matchPct >= 85 && Math.abs(wonDrift) < 1) return 'MOSTLY CLEAN: ' + matchPct + '% exact match, small symmetric noise (late card updates), no winner-correlated drift';
      if (wonDrift > 2) return 'LEAKAGE: winners\u2019 results figures average +' + wonDrift.toFixed(1) + ' over their card figures — results rpr/tsr look post-race. Backtests scoring from them are inflated.';
      return 'INCONCLUSIVE: ' + matchPct + '% match, winner drift ' + wonDrift.toFixed(1) + ' — inspect samples';
    })();

    res.setHeader('Cache-Control', 's-maxage=600');
    return res.status(200).json({
      ok: true,
      note: 'Card figures are pre-race by construction; this compares them to the results feed for today\u2019s settled races. OR (official rating) is pre-race by definition in both feeds.',
      verdict,
      stats: {
        races: stats.races, horsesJoined: stats.horses,
        rpr: { ...stats.rpr, matchPct: pct(stats.rpr.match, stats.rpr.both), meanDiff: stats.rpr.both ? Math.round(stats.rpr.sumDiff / stats.rpr.both * 100) / 100 : null },
        ts: { ...stats.ts, matchPct: pct(stats.ts.match, stats.ts.both), meanDiff: stats.ts.both ? Math.round(stats.ts.sumDiff / stats.ts.both * 100) / 100 : null },
        rprDriftByFinish: Object.fromEntries(Object.entries(stats.byPos).map(([k, v]) => [k, { n: v.n, meanDiff: Math.round(v.rprDiffSum / v.n * 100) / 100 }])),
      },
      samples,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
}
