// Signal study over logged Spotlight races: ARG = days back (default 14)
import fs from 'fs';
const BASE = process.env.RS_BASE || 'https://raceside.vercel.app'; const DAYS = parseInt(process.env.ARG) || 14;
const html = fs.readFileSync(new URL('../rpspot.html', import.meta.url), 'utf8'); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const core = js.slice(js.indexOf('const esc ='), js.indexOf('// ---------- RENDER')); const lib = new Function(core + '\nreturn { parseAnyCard, parseStats, analyse, oddsNum, wr };')();
const ukd = off => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(Date.now() - off * 86400000));
const races = []; for (let i = 0; i <= DAYS; i++) { const d = ukd(i); try { const j = await (await fetch(BASE + '/api/yearstate?k=rpspot:day:' + d + '&t=' + Date.now())).json(); Object.entries((j.state && j.state.races) || {}).forEach(([k, r]) => { if (r.winner) races.push({ d, k, r }); }); } catch {} }
const T = {}; let n = 0, top1 = 0, top3 = 0, favWon = 0, lowX1 = 0, hiX1 = 0, lowAvg = 0, hiAvg = 0, hiComb = 0, lowComb = 0, fields = 0; const winRank = [];
for (const { d, k, r } of races) { const txt = (r.a || '') + '\n' + (r.b || ''); const race = lib.parseAnyCard(txt); if (!race.runnersList.length) continue; const A = lib.analyse(race, lib.parseStats(txt));
  const norm = s => String(s).toLowerCase().replace(/\s*\(.*?\)/g, '').replace(/[^a-z]/g, ''); const ix = A.out.findIndex(x => norm(x.r.name) === norm(r.winner.name)); if (ix < 0) continue; const w = A.out[ix]; n++; fields += A.out.length; winRank.push(ix + 1); if (ix === 0) top1++; if (ix < 3) top3++;
  const pcOf = s => { const [a, b] = lib.wr(s); return b ? a / b * 100 : null; };
  const rows = A.out.map(x => { const avg = x.seq.length ? x.seq.reduce((a, b) => a + b, 0) / x.seq.length : null; const o = lib.oddsNum(x.r.odds); return { x, avg, o, x1: avg != null && o != null ? avg + o : null, comb: avg != null && o != null ? avg + o + (pcOf(x.jk.c5) || 0) + (pcOf(x.tr.c5) || 0) : null }; });
  const wr_ = rows[ix]; const withX1 = rows.filter(q => q.x1 != null); if (withX1.length >= 3 && wr_.x1 != null) { if (wr_.x1 === Math.min(...withX1.map(q => q.x1))) lowX1++; if (wr_.x1 === Math.max(...withX1.map(q => q.x1))) hiX1++; }
  const withAvg = rows.filter(q => q.avg != null); if (withAvg.length >= 3 && wr_.avg != null) { if (wr_.avg === Math.max(...withAvg.map(q => q.avg))) hiAvg++; if (wr_.avg === Math.min(...withAvg.map(q => q.avg))) lowAvg++; }
  const withC = rows.filter(q => q.comb != null); if (withC.length >= 3 && wr_.comb != null) { if (wr_.comb === Math.max(...withC.map(q => q.comb))) hiComb++; if (wr_.comb === Math.min(...withC.map(q => q.comb))) lowComb++; }
  const withO = rows.filter(q => q.o != null); if (withO.length >= 3 && wr_.o != null && wr_.o === Math.min(...withO.map(q => q.o))) favWon++;
  const clean = t => t.replace(/ ·.*$| \d+LB$| \d+-\d+$| \d+%$| \+[\d.]+ HERE$/, ''); A.out.forEach((x, i) => { new Set(x.tags.map(t => clean(t[0]))).forEach(t => { const g = T[t] = T[t] || { n: 0, w: 0 }; g.n++; if (i === ix) g.w++; }); }); }
const tags = Object.entries(T).filter(([, g]) => g.n >= 5).map(([t, g]) => ({ tag: t, carried: g.n, won: g.w, strike: +(g.w / g.n * 100).toFixed(1) })).sort((a, b) => b.strike - a.strike);
console.log(JSON.stringify({ races: n, avgField: +(fields / n).toFixed(1), randomStrike: +(n / fields * 100).toFixed(1), topPickWon: top1, top3: top3, favWon, winnerLowestX1: lowX1, winnerHighestX1: hiX1, winnerHighestAvg: hiAvg, winnerLowestAvg: lowAvg, winnerHighestComb: hiComb, winnerLowestComb: lowComb, winRanks: winRank, tags }));
