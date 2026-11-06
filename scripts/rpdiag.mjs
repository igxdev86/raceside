// why are analysed races unsettled? list each with the nearest results-feed races for that day
const BASE = 'https://raceside.vercel.app'; const DAYS = parseInt(process.env.ARG) || 10;
const ukd = off => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(Date.now() - off * 86400000));
const t2k = t => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); if (!m) return ''; let h = +m[1]; if (h >= 13) h -= 12; return h + ':' + m[2]; }; const normC = s => String(s || '').toLowerCase().replace(/\s*\((aw|ire)\)/g, '').replace(/[^a-z]/g, '');
const out = [];
for (let i = 0; i <= DAYS; i++) { const d = ukd(i); const j = await (await fetch(BASE + '/api/yearstate?k=rpspot:day:' + d + '&t=' + Date.now())).json(); const races = (j.state && j.state.races) || {}; const open = Object.entries(races).filter(([, r]) => !r.winner); if (!open.length) continue;
  let feed = []; try { const p = await (await fetch(BASE + '/api/priceday?v=5&date=' + d)).json(); feed = (p.races || []).map(rc => ({ t: rc.t, course: rc.course, w: ((rc.runners || []).find(x => x.pos === '1') || {}).h })); } catch {}
  open.forEach(([k, r]) => { const sm = r.sum || {}; const same = feed.filter(f => normC(f.course) === normC(sm.course)).map(f => f.t + ' ' + f.w); out.push({ d, key: k, time: sm.time, course: sm.course, feedRaces: feed.length, sameCourse: same.slice(0, 12) }); }); }
console.log(JSON.stringify(out));
