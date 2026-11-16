import fs from 'fs';
const [day, horse] = (process.env.ARG || '').split('|');
const base = 'https://raceside.vercel.app';
const st = await (await fetch(`${base}/api/yearstate?k=rpspot:day:${day}&t=${Date.now()}`)).json();
const out = [];
for (const [k, r] of Object.entries((st.state || {}).races || {})) {
  const txt = JSON.stringify(r);
  if (!horse || txt.toLowerCase().includes(horse.toLowerCase())) out.push({ k, sum: r.sum, winner: r.winner, a: r.a.slice(0, 6000), b: (r.b || '').slice(0, 3000) });
}
fs.writeFileSync('out.json', JSON.stringify(out, null, 1));
