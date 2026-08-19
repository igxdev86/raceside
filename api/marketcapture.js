// RACESIDE — market capture (cron, every 5 minutes)
// Snapshots best-available odds for every GB/IRE runner on today's and tomorrow's cards
// into Supabase table `market_ticks`, keyed by (race_date, horse_id, snapped_at).
// The market page reads these to show full-day movement for everyone regardless of
// when they opened the page, plus the opening price per horse.
//
// One-time SQL (Supabase SQL editor):
//   create table if not exists market_ticks (
//     race_date date not null, race_id text not null, horse_id text not null,
//     snapped_at timestamptz not null, dec numeric not null, frac text,
//     horse text, course text, off text, jockey text, trainer text, rank int, n int,
//     primary key (race_date, horse_id, snapped_at)
//   );
//   create index if not exists market_ticks_date on market_ticks (race_date, horse_id);

export const config = { maxDuration: 60 };

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
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const s = supa();
  if (!s) return res.status(500).json({ ok: false, error: 'no-supabase' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const get = async (path) => {
    const r = await fetch('https://api.theracingapi.com' + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  };
  const snapped = new Date();
  const snappedIso = snapped.toISOString();
  const ticks = [];
  const perDay = {};
  for (const day of ['today', 'tomorrow']) {
    let cards = null;
    for (const tier of ['standard', 'basic', 'free']) {
      try { cards = await get('/v1/racecards/' + tier + '?day=' + day); break; } catch {}
    }
    if (!cards) { perDay[day] = 'no-cards'; continue; }
    let n = 0;
    (cards.racecards || []).forEach((rc) => {
      if (!['gb', 'ire'].includes(String(rc.region || '').toLowerCase())) return;
      const date = rc.date || '';
      if (!date) return;
      const priced = (rc.runners || []).map((x) => ({ x, o: bestOdds(x) })).filter((p) => p.o && p.x.horse_id);
      priced.sort((a, b) => a.o.d - b.o.d);
      priced.forEach((p, i) => {
        ticks.push({
          race_date: date, race_id: rc.race_id, horse_id: p.x.horse_id, snapped_at: snappedIso,
          dec: Math.round(p.o.d * 100) / 100, frac: p.o.frac,
          horse: p.x.horse || '', course: rc.course || '?', off: rc.off_time || rc.off || '',
          jockey: p.x.jockey || '', trainer: p.x.trainer || '', rank: i + 1, n: priced.length,
        });
        n++;
      });
    });
    perDay[day] = n;
  }
  // write in batches
  let written = 0;
  for (let i = 0; i < ticks.length; i += 500) {
    const batch = ticks.slice(i, i + 500);
    const r = await fetch(`${s.url}/rest/v1/market_ticks?on_conflict=race_date,horse_id,snapped_at`, {
      method: 'POST',
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(500).json({ ok: false, error: 'write-' + r.status, detail: detail.slice(0, 300), written, hint: 'run the market_ticks SQL in Supabase' });
    }
    written += batch.length;
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, at: snappedIso, perDay, written });
}
