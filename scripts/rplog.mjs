// Log a winner against an analysed race in SPOTLIGHT ANY RACE: ARG="YYYY-MM-DD HH:MM Winner Name"
import fs from 'fs';
const BASE = process.env.RS_BASE || 'https://raceside.vercel.app';
const ARG = String(process.env.ARG || '').trim(); const m = ARG.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
if (!m) { console.log(JSON.stringify({ err: 'ARG must be "YYYY-MM-DD HH:MM Winner Name"' })); process.exit(1); }
const [, day, time, winName] = m;
const html = fs.readFileSync(new URL('../rpspot.html', import.meta.url), 'utf8'); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const core = js.slice(js.indexOf('const esc ='), js.indexOf('// ---------- RENDER')); const lib = new Function(core + '\nreturn { parseAnyCard, parseStats, analyse };')();
const r = await (await fetch(BASE + '/api/yearstate?k=rpspot:day:' + day + '&t=' + Date.now())).json(); const DAY = r && r.state; if (!DAY || !DAY.races) { console.log(JSON.stringify({ err: 'no day row', day })); process.exit(1); }
const key = Object.keys(DAY.races).find(k => (DAY.races[k].sum || {}).time === time || k.includes(' ' + time + ' ')); if (!key) { console.log(JSON.stringify({ err: 'no race at ' + time, have: Object.keys(DAY.races) })); process.exit(1); }
const rec = DAY.races[key]; const txt = (rec.a || '') + '\n' + (rec.b || ''); const race = lib.parseAnyCard(txt); const A = lib.analyse(race, lib.parseStats(txt));
const norm = s => String(s).toLowerCase().replace(/\s*\(.*?\)/, '').replace(/[^a-z]/g, ''); const ix = A.out.findIndex(x => norm(x.r.name) === norm(winName) || norm(x.r.name).startsWith(norm(winName)));
if (ix < 0) { console.log(JSON.stringify({ err: 'winner not in field', field: A.out.map(x => x.r.name) })); process.exit(1); }
const x = A.out[ix]; const clean = t => t.replace(/ ·.*$| \d+LB$| \d+-\d+$| \d+%$/, '');
rec.winner = { name: x.r.name, rank: ix + 1, n: A.out.length, odds: x.r.odds || '', tags: x.tags.map(t => clean(t[0])), score: x.score, allTags: A.out.map(y => y.tags.map(t => clean(t[0]))) };
DAY.ts = Date.now(); const up = await fetch(BASE + '/api/yearstate?k=rpspot:day:' + day, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(DAY) });
console.log(JSON.stringify({ ok: up.ok, race: key, winner: rec.winner, top3: A.out.slice(0, 3).map(y => y.r.name + ' ' + y.score) }));
