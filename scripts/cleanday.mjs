// One-off ledger hygiene for a day row: drops picks that break doctrine.
//  - live or settled picks at courses not on that day's card (a feed that still served yesterday's card)
//  - settled picks whose posted time is after the off (a post-race calculation is not a tip)
// usage: DAY=2026-10-15 node scripts/cleanday.mjs   (DRY=1 to report only)
const BASE = process.env.RS_BASE || 'https://raceside.vercel.app';
const ARG = String(process.env.ARG || '').trim().split(/\s+/); const DAY = process.env.DAY || ARG[0]; const DRY = process.env.DRY || ARG.includes('dry'); if (!DAY) { console.log(JSON.stringify({ err: 'DAY required' })); process.exit(1); }
const t2m = (t) => { const m = String(t).match(/(\d+):(\d+)/); if (!m) return 0; let h = +m[1]; const mi = +m[2]; if (h < 10) h += 12; return h * 60 + mi; };
const hm = (s) => { const m = String(s || '').match(/(\d+):(\d+)/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const row = await (await fetch(BASE + '/api/yearstate?k=comboledger:day:' + DAY + '&t=' + Date.now())).json();
if (!row || !row.ok || row.upstream || !row.state) { console.log(JSON.stringify({ err: 'row unreadable', row })); process.exit(1); }
const st = row.state; const tp = st.tp || {};
// the day's courses: from the day's own priceday results feed, falling back to the live card when it is that day
const courses = new Set();
try { const pd = await (await fetch(BASE + '/api/priceday?date=' + DAY + '&t=' + Date.now())).json(); Object.values((pd && (pd.races || pd.days && pd.days[DAY] || {})) || {}).forEach(r => { if (r && r.course) courses.add(String(r.course).toLowerCase()); });
  (pd && pd.rows || []).forEach(r => { if (r && r.course) courses.add(String(r.course).toLowerCase()); }); } catch {}
try { const up = await (await fetch(BASE + '/api/upcoming?t=' + Date.now())).json(); (up && up.rides || []).forEach(r => { if (r.date === DAY && r.course) courses.add(String(r.course).toLowerCase()); }); } catch {}
const drop = { offCard: 0, postOff: 0 }; const dropped = []; let kept = 0;
Object.keys(tp).forEach(nm => { tp[nm] = (tp[nm] || []).filter(e => { if (!e || !e.h) return false;
  const c = String(e.c || '').toLowerCase();
  if (courses.size && !courses.has(c)) { drop.offCard++; dropped.push(nm + ' ' + e.t + ' ' + e.c + ' ' + e.h); return false; }
  const posted = e.w === null ? hm(e.at) : hm(e.lk);
  if (posted != null && posted >= t2m(e.t)) { drop.postOff++; dropped.push(nm + ' ' + e.t + ' ' + e.c + ' ' + e.h + ' @' + (e.lk || e.at)); return false; }
  kept++; return true; }); });
const out = { day: DAY, courses: [...courses], drop, kept, sample: dropped.slice(0, 40) };
if (DRY) { console.log(JSON.stringify(out)); process.exit(0); }
const body = { ...st, tp, cleaned: (st.cleaned || 0) + 1, cleanedAt: new Date().toISOString(), savedTs: Date.now(), ts: Date.now() };
const rp = await fetch(BASE + '/api/yearstate?k=comboledger:day:' + DAY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
out.post = { status: rp.status, body: await rp.text().catch(() => '') };
console.log(JSON.stringify(out));
