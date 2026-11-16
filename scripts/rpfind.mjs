import fs from 'fs';
const [day, horse] = (process.env.ARG || '').split('|');
const base = 'https://raceside.vercel.app';
const out = [];
for (const d of day.split(',')) {
  const st = await (await fetch(`${base}/api/yearstate?k=rpspot:day:${d}&t=${Date.now()}`)).json();
  for (const [k, r] of Object.entries((st.state || {}).races || {})) {
    const txt = JSON.stringify(r);
    if (!horse || txt.toLowerCase().includes(horse.toLowerCase())) out.push({ d, k, sum: r.sum, winner: r.winner, a: r.a.slice(0, 6000), b: (r.b || '').slice(0, 3000) });
    else out.push({ d, k, sum: r.sum, winner: r.winner });
  }
}
console.log(JSON.stringify(out, null, 1));
