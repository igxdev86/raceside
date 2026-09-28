// RACESIDE — course number-sequence backfill.
// Walks /v1/results backwards in ~CHUNK-day chunks per invocation, folding each course's
// chronological winning-saddle-number sequence into a transition table stored in courseseq:v1.
// Call repeatedly (cron or by hand) with ?key=CRON_SECRET until done=true (18 months covered).
// State: { trans: { course: { A: { B: count } } }, tail: { course: lastNumOfOlderChunk }, cursor, oldest, races, done }
// Chunks run newest->oldest; within a chunk days are processed oldest->newest, and the chunk's
// OLDEST edge links to the previously-stored tail via pending head-links resolved next chunk.

export const config = { maxDuration: 60 };

const CHUNK = 7;
const MONTHS_BACK = 18;

export default async function handler(req, res) {
  if (String(req.query.key) !== String(process.env.CRON_SECRET)) return res.status(401).json({ ok: false });
  const user = process.env.RACING_API_USERNAME, pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const base = (process.env.ALERT_BASE || '').replace(/\/$/, '');
  const gj = async (p, opt) => { const r = await fetch(base + p, opt); return r.json(); };

  let st = null;
  try { const j = await gj('/api/yearstate?k=courseseq:v1'); st = j && j.state ? j.state : null; } catch {}
  if (!st) st = { trans: {}, heads: {}, cursor: null, oldest: null, races: 0, done: false };
  if (st.done) return res.status(200).json({ ok: true, done: true, races: st.races, oldest: st.oldest });

  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const limit = new Date(today.getTime()); limit.setMonth(limit.getMonth() - MONTHS_BACK);

  const cKey = (c) => String(c || '').replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
  const t2m = (t) => { const m = String(t || '').match(/(\d{1,2})[:.](\d{2})/); if (!m) return 0;
    let hh = +m[1]; const mm = +m[2]; if (hh < 10) hh += 12; return hh * 60 + mm; };

  const t0 = Date.now();
  let chunks = 0; let lastChunk = null;
  while (!st.done && Date.now() - t0 < 42000) {
    const end2 = st.cursor ? new Date(new Date(st.cursor + 'T12:00:00Z').getTime() - 86400000) : today;
    const start2 = new Date(Math.max(limit.getTime(), end2.getTime() - (CHUNK - 1) * 86400000));
    if (end2 < limit) { st.done = true; break; }
    const r2 = await doChunk(start2, end2);
    if (!r2.ok) return res.status(502).json({ ok: false, error: r2.error, at: iso(start2), racesTotal: st.races });
    st.races += r2.races; st.cursor = iso(start2); st.oldest = iso(start2); chunks++;
    lastChunk = [iso(start2), iso(end2)];
    if (start2.getTime() <= limit.getTime()) st.done = true;
    // persist progress each chunk so a timeout loses nothing
    try { await gj('/api/yearstate?k=courseseq:v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...st, lastDate: iso(today) }) }); } catch {}
  }

  async function doChunk(start, end) {
    let racesSeen = 0;
    {
    // page through results for the window
    let skip = 0; const all = [];
    for (let page = 0; page < 20; page++) {
      const u = `https://api.theracingapi.com/v1/results?start_date=${iso(start)}&end_date=${iso(end)}&limit=50&skip=${skip}`;
      const r = await fetch(u, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) { if (r.status === 404) break; return { ok: false, error: 'upstream-' + r.status }; }
      const d = await r.json();
      const rs = d.results || [];
      all.push(...rs);
      skip += rs.length;
      if (rs.length < 50 || skip >= (d.total || Infinity)) break;
    }
    const byC = {};
    all.forEach((race) => {
      const region = String(race.region || '').toLowerCase();
      if (region && !['gb', 'ire'].includes(region)) return;
      const w = (race.runners || []).find((x) => String(x.position) === '1');
      const num = w && Number(w.number || w.num);
      if (!num || !isFinite(num)) return;
      racesSeen++;
      (byC[cKey(race.course)] = byC[cKey(race.course)] || []).push({ d: String(race.date || '').slice(0, 10), tm: t2m(race.off || race.off_time), n: num });
    });
    Object.entries(byC).forEach(([c, arr]) => {
      arr.sort((a, b) => a.d.localeCompare(b.d) || a.tm - b.tm);
      const t = (st.trans[c] = st.trans[c] || {});
      for (let i = 1; i < arr.length; i++) { const a = arr[i - 1].n, b = arr[i].n; (t[a] = t[a] || {})[b] = (t[a][b] || 0) + 1; }
      // chunk runs newest->oldest overall: this chunk's LAST number precedes the previously stored HEAD
      const prevHead = st.heads[c];
      if (prevHead != null && arr.length) { const a = arr[arr.length - 1].n; (t[a] = t[a] || {})[prevHead] = (t[a][prevHead] || 0) + 1; }
      st.heads[c] = arr[0].n;   // oldest number of this chunk becomes head for the next (older) chunk
    });
    }
    return { ok: true, races: racesSeen };
  }

  try {
    const r = await gj('/api/yearstate?k=courseseq:v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...st, lastDate: iso(today) }) });
    if (!r || r.ok === false) return res.status(500).json({ ok: false, error: 'store-failed' });
  } catch (e) { return res.status(500).json({ ok: false, error: 'store-' + String(e) }); }
  return res.status(200).json({ ok: true, done: st.done, chunksThisCall: chunks, lastChunk, racesTotal: st.races, oldest: st.oldest });
}
