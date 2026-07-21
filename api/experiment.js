// RACESIDE — experiments engine
// Experiment 1: number-follows-number. After cloth #A wins, does cloth #B win the NEXT race
// at the same meeting more often than field-size-adjusted chance? Runs both directions.
// Window: 1st of last month → today, GB+IRE. Baseline = sum of 1/field over next-races
// where the target number actually ran — the honest expectation, not zero.

export const config = { maxDuration: 60 };

function spOff(off) {
  // racing off times are h:mm without am/pm; 1-9 → afternoon/evening
  const m = String(off || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  let h = Number(m[1]);
  if (h >= 1 && h <= 9) h += 12;
  return h * 60 + Number(m[2]);
}

export default async function handler(req, res) {
  const user = process.env.RACING_API_USERNAME;
  const pass = process.env.RACING_API_PASSWORD;
  if (!user || !pass) return res.status(500).json({ ok: false, error: 'no-credentials' });

  const a = parseInt(req.query.a, 10) || 4;
  const b = parseInt(req.query.b, 10) || 7;

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const fmt = (d) => d.toISOString().slice(0, 10);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const meetings = {}; // course|date → [{off, winNum, nums:Set-as-array, field}]
  const numbers = {};  // n → {ran, wins}
  let races = 0, skip = 0, total = Infinity, pages = 0;

  try {
    while (skip < total && pages < 40) {
      const url = `https://api.theracingapi.com/v1/results?region=gb&region=ire` +
        `&start_date=${fmt(start)}&end_date=${fmt(now)}&limit=50&skip=${skip}`;
      let r, attempts = 0;
      for (;;) {
        r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
        if (r.status !== 429 || attempts >= 4) break;
        attempts++;
        await new Promise((ok) => setTimeout(ok, 2000 * attempts));
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.status(r.status).json({ ok: false, error: 'upstream-' + r.status, detail: body.slice(0, 300) });
      }
      const page = await r.json();
      total = Number(page.total) || 0;
      for (const race of page.results || []) {
        const runners = race.runners || [];
        const win = runners.find((x) => String(x.position) === '1');
        const nums = runners.map((x) => parseInt(x.number, 10)).filter((n) => n >= 1 && n <= 40);
        const winNum = win ? parseInt(win.number, 10) : NaN;
        if (!nums.length || !(winNum >= 1)) continue;
        races++;
        const key = (race.course || '?') + '|' + (race.date || '?');
        (meetings[key] ||= []).push({ off: spOff(race.off), winNum, nums, field: nums.length });
        for (const n of new Set(nums)) {
          (numbers[n] ||= { ran: 0, wins: 0 });
          numbers[n].ran++;
        }
        (numbers[winNum] ||= { ran: 0, wins: 0 });
        numbers[winNum].wins++;
      }
      skip += 50; pages++;
      if (skip < total) await new Promise((ok) => setTimeout(ok, 650));
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream', detail: String(e) });
  }

  const test = (from, to) => {
    let trials = 0, targetRan = 0, hits = 0, expected = 0;
    for (const key of Object.keys(meetings)) {
      const rs = meetings[key].sort((x, y) => x.off - y.off);
      for (let i = 0; i < rs.length - 1; i++) {
        if (rs[i].winNum !== from) continue;
        trials++;
        const next = rs[i + 1];
        if (next.nums.includes(to)) {
          targetRan++;
          expected += 1 / next.field;
          if (next.winNum === to) hits++;
        }
      }
    }
    return {
      trials, targetRan, hits,
      'act_%': trials ? Math.round((hits / trials) * 1000) / 10 : 0,
      'exp_%': trials ? Math.round((expected / trials) * 1000) / 10 : 0,
    };
  };

  const numberTable = Object.entries(numbers)
    .map(([num, v]) => ({ num: Number(num), ran: v.ran, wins: v.wins,
      'win_%': v.ran ? Math.round((v.wins / v.ran) * 1000) / 10 : 0 }))
    .sort((x, y) => x.num - y.num);

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, from: fmt(start), to: fmt(now), races,
    meetings: Object.keys(meetings).length, truncated: skip < total,
    a, b,
    ab: test(a, b),
    ba: test(b, a),
    numbers: numberTable,
  });
}
