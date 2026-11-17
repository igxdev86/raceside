// Builds fs47.json: one compact row per race where cloth numbers 4 and 7 both finished, over the last 1000 days.
// Incremental: keeps days already built, fetches missing ones, always refreshes the last 3 days (late results).
import fs from 'fs';
const base = 'https://raceside.vercel.app'; const FILE = 'fs47.json'; const DAYS = +(process.env.ARG || 1000);
const ukd = off => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(Date.now() - off * 86400000));
let data = { built: '', days: {} }; try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const want = []; for (let i = 1; i <= DAYS; i++) { const d = ukd(i); if (!data.days[d] || i <= 3) want.push(d); }
const get = async d => { for (let k = 0; k < 3; k++) { try { const r = await fetch(`${base}/api/priceday?v=6&date=${d}`, { signal: AbortSignal.timeout(25000) }); if (r.ok) return (await r.json()).races || []; } catch {} await new Promise(r => setTimeout(r, 1500)); } return null; };
const pack = rc => { const rs = (rc.runners || []).filter(x => x && x.num && x.pos); const h4 = rs.find(x => x.num === '4'), h7 = rs.find(x => x.num === '7'); if (!h4 || !h7) return null;
  const p = k => rs.find(x => x.pos === String(k)); const p1 = p(1), p2 = p(2), p3 = p(3); const book = rs.reduce((a, x) => a + (Number(x.d) > 1 ? 1 / Number(x.d) : 0), 0);
  const P = x => x ? [x.num, x.h, Number(x.d) > 1 ? +Number(x.d).toFixed(2) : 0] : null;
  return [rc.t, rc.course, rc.name, rs.length, +Number(h4.d || 0).toFixed(2), +Number(h7.d || 0).toFixed(2), P(p1), P(p2), p3 ? p3.num : null, rc.csf || 0, rc.rclass || '', rc.dist ?? null, rc.going || '', +book.toFixed(3)]; };
let done = 0, failed = 0; const q = want.slice();
const work = async () => { while (q.length) { const d = q.shift(); const rcs = await get(d); if (rcs == null) { failed++; continue; } data.days[d] = rcs.map(pack).filter(Boolean); done++; } };
await Promise.all([work(), work(), work(), work(), work(), work()]);
// drop anything older than the window
const keep = new Set(); for (let i = 1; i <= DAYS; i++) keep.add(ukd(i)); for (const d of Object.keys(data.days)) if (!keep.has(d)) delete data.days[d];
data.built = new Date().toISOString(); data.rows = Object.values(data.days).reduce((a, r) => a + r.length, 0);
fs.writeFileSync(FILE, JSON.stringify(data));
console.error(`fs47: fetched ${done} days (${failed} failed), ${Object.keys(data.days).length} days, ${data.rows} rows, ${(fs.statSync(FILE).size / 1e6).toFixed(2)} MB`);
