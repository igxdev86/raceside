// RACESIDE — email alerts
// Every 5 minutes: email the SCORES picks for races going off in the next 5–10 minutes,
// then email each race's result when the winner lands. Deduped via alertstate in the shared store.
// Env: RESEND_API_KEY, EMAIL_TO (+ CRON_SECRET to gate the cron; TWEET_KEY works for manual ?key=).

export const config = { maxDuration: 60 };

const PTS = [5, 3, 1];
const clm = (nm) => { const m = String(nm || '').match(/\((\d)\)/); return m ? Number(m[1]) : 0; };
const pctB = (bucket) => { const list = Object.entries(bucket || {}).filter(([, s]) => s.runs >= 100 && s.exp > 0).map(([id, s]) => ({ id, ae: s.wins / s.exp })).sort((a, b) => b.ae - a.ae); const map = {}; const n = list.length; list.forEach((x, i) => { map[x.id] = n > 1 ? (1 - i / (n - 1)) * 100 : 50; }); return map; };

// graded 5/3/1 scores for one race — same design as the SCORES modal
function scoreRace(rs, store, pj, pt) {
  const sc = {}; const tag = (h, t, p) => { const s = (sc[h] = sc[h] || { pts: 0, tags: [] }); s.pts += p; s.tags.push(t); };
  const rank = (label, fn) => {
    const vals = rs.map((r, i) => ({ i, v: fn(r) })).filter(e => e.v != null).sort((a, b) => b.v - a.v);
    vals.slice(0, 3).forEach((e, k) => tag(rs[e.i].h, label + (k + 1), PTS[k]));
  };
  const strike = (b, id, min) => { const s = (b || {})[id]; return s && s.runs >= min ? s.wins / s.runs : null; };
  rank('J', (r) => strike(store.jockeys, r.jid, 50));
  rank('T', (r) => strike(store.trainers, r.tid, 50));
  rank('PAIR', (r) => { const p = (store.pairs || {})[r.jid + '|' + r.tid]; return p && p.r >= 10 && p.e > 0 ? p.w / p.e : null; });
  const orVals = rs.map(r => r.ofr).filter(v => v != null);
  const orMean = orVals.length >= 2 ? orVals.reduce((a, b) => a + b, 0) / orVals.length : null;
  const ok = rs.filter(r => r.ofr != null && r.lbs != null); const adv = {};
  if (ok.length >= 2) { const top = ok.reduce((a, b) => b.ofr > a.ofr ? b : a, ok[0]); const car = (r) => r.lbs - clm(r.jockey); const tc = car(top); ok.forEach(r => { adv[r.h] = (r.ofr + (tc - car(r))) - top.ofr; }); }
  rank('WR', (r) => adv[r.h] != null && adv[r.h] > 0 ? adv[r.h] : null);
  rank('OR', (r) => r.ofr != null ? r.ofr : null);
  let edges = null;
  if (orMean != null) {
    const s = rs.map(r => { const parts = []; if (r.jid && pj[r.jid] != null) parts.push(pj[r.jid]); if (r.tid && pt[r.tid] != null) parts.push(pt[r.tid]); const v = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
      return 0.8 * (v - 50) / 50 + 0.6 * (r.ofr != null ? r.ofr - orMean : 0) / 20 + 0.5 * (adv[r.h] || 0) / 10; });
    const ex = s.map(v => Math.exp(v)); const Z = ex.reduce((a, b) => a + b, 0);
    edges = rs.map((r, i) => r.d > 1 ? ((ex[i] / Z) - 1 / r.d) / (1 / r.d) : null);
    rank('M', (r) => { const i = rs.indexOf(r); const e2 = edges[i]; return e2 != null && isFinite(e2) && e2 < 0 ? -e2 : null; });
    rs.forEach((r, i) => { const e2 = edges[i]; if (e2 != null && isFinite(e2) && e2 > 0) tag(r.h, '+', 1); });
  }
  return sc;
}

const ukHM = (now) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const g = (t) => Number(p.find(x => x.type === t).value);
  return g('hour') * 60 + g('minute');
};
const raceMin = (t) => { const m = String(t || '').match(/(\d{1,2})[:. ](\d{2})/); if (!m) return -1; let hh = Number(m[1]); if (hh < 10) hh += 12; return hh * 60 + Number(m[2]); };
const rkey = (t, course) => String(t).replace(/\s.*/, '') + '|' + String(course).replace(/\s*\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export default async function handler(req, res) {
  const key = process.env.RESEND_API_KEY, to = process.env.EMAIL_TO;
  const gate = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}` || (req.query.key && (req.query.key === process.env.TWEET_KEY || req.query.key === process.env.CRON_SECRET));
  if (!gate) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!key || !to) return res.status(200).json({ ok: false, error: 'set RESEND_API_KEY and EMAIL_TO' });
  const base = process.env.ALERT_BASE || 'https://raceside.vercel.app';
  const gj = async (p) => { const r = await fetch(base + p); return r.json(); };
  const now = req.query.now ? new Date(req.query.now) : new Date();
  const nm = ukHM(now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);

  let st = null;
  try { const j = await gj('/api/yearstate?k=alertstate:v1'); if (j && j.state && j.state.date === today) st = j.state; } catch {}
  if (!st) st = { date: today, sent: {}, resulted: {}, picks: {} };

  let up = null, store = null;
  try { up = await gj('/api/upcoming?v=4'); store = await gj('/api/peopleall?v=2'); } catch {}
  if (!(up && up.ok && store && store.ok)) return res.status(200).json({ ok: false, error: 'feeds unavailable', base, up: !!(up && up.ok), people: !!(store && store.ok) });
  const pj = pctB(store.jockeys), pt = pctB(store.trainers);
  const by = {};
  (up.rides || []).filter(r => r.day === 'today' && r.d > 1).forEach(r => { (by[rkey(r.t, r.course)] = by[rkey(r.t, r.course)] || { t: r.t, course: r.course, rs: [] }).rs.push(r); });

  const send = async (subject, html) => {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'RACESIDE <onboarding@resend.dev>', to: [to], subject, html }),
    });
    return r.ok;
  };
  const out = { ok: true, sentPicks: [], sentResults: [] };

  // 1) selections: races off in (4, 10] minutes, not yet sent
  for (const [k, rc] of Object.entries(by)) {
    const mins = raceMin(rc.t) - nm;
    if (st.sent[k] || mins <= 4 || mins > 10 || rc.rs.length < 3) continue;
    const sc = scoreRace(rc.rs, store, pj, pt);
    const xs1 = (r) => { const js = (store.jockeys || {})[r.jid], ts = (store.trainers || {})[r.tid];
      if (!(js && js.runs >= 50 && ts && ts.runs >= 50 && r.d > 1)) return null;
      return (js.wins / js.runs * 100 + ts.wins / ts.runs * 100) / r.d; };
    const xcell = (r) => { const v = xs1(r); return v == null ? '\u2014' : `<b style="color:${v >= 15 ? '#B8860B' : '#666'}">${v.toFixed(1)}</b>`; };
    const picks = rc.rs.map(r => ({ r, s: sc[r.h] })).filter(p => p.s && p.s.pts >= 2).sort((a, b) => b.s.pts - a.s.pts).slice(0, 4);   // same cut as the SCORES modal
    if (!picks.length) { st.sent[k] = 1; continue; }
    const rows = picks.map(p => `<tr><td style="padding:4px 8px;font-weight:700">${p.s.pts}</td><td style="padding:4px 8px">${p.r.h}</td><td style="padding:4px 8px;color:#666">${p.s.tags.join(' · ')}</td><td style="padding:4px 8px">@ ${p.r.d}</td><td style="padding:4px 8px">XS1 ${xcell(p.r)}</td></tr>`).join('');
    // full card below: every runner, deepest minus first
    const strike = (b, id) => { const s2 = (b || {})[id]; return s2 && s2.runs >= 50 ? Math.round(s2.wins / s2.runs * 100) : null; };
    const edges = (() => { const m = {}; rc.rs.forEach(r => { m[r.h] = null; });
      const orVals = rc.rs.map(r => r.ofr).filter(v => v != null);
      if (orVals.length < 2) return m;
      const orMean = orVals.reduce((a, b) => a + b, 0) / orVals.length;
      const ok2 = rc.rs.filter(r => r.ofr != null && r.lbs != null); const adv = {};
      if (ok2.length >= 2) { const top = ok2.reduce((a, b) => b.ofr > a.ofr ? b : a, ok2[0]); const car = (r) => r.lbs - clm(r.jockey); const tc = car(top); ok2.forEach(r => { adv[r.h] = (r.ofr + (tc - car(r))) - top.ofr; }); }
      const s3 = rc.rs.map(r => { const parts = []; if (r.jid && pj[r.jid] != null) parts.push(pj[r.jid]); if (r.tid && pt[r.tid] != null) parts.push(pt[r.tid]); const v = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
        return 0.8 * (v - 50) / 50 + 0.6 * (r.ofr != null ? r.ofr - orMean : 0) / 20 + 0.5 * (adv[r.h] || 0) / 10; });
      const ex = s3.map(v => Math.exp(v)); const Z = ex.reduce((a, b) => a + b, 0);
      rc.rs.forEach((r, i) => { const e2 = r.d > 1 ? ((ex[i] / Z) - 1 / r.d) / (1 / r.d) : null; m[r.h] = e2 != null && isFinite(e2) ? e2 : null; });
      return m; })();
    const cardRows = rc.rs.slice().sort((a, b) => { const ea = edges[a.h], eb = edges[b.h];
        return (ea == null) - (eb == null) || (ea || 0) - (eb || 0); })
      .map(r => { const e2 = edges[r.h]; const s4 = sc[r.h];
        return `<tr><td style="padding:3px 8px">${r.h}${s4 && s4.pts >= 9 ? ' <b>' + s4.pts + '</b>' : ''}</td>
          <td style="padding:3px 8px;color:#666">${strike(store.jockeys, r.jid) != null ? strike(store.jockeys, r.jid) : '\u2014'}/${strike(store.trainers, r.tid) != null ? strike(store.trainers, r.tid) : '\u2014'}</td>
          <td style="padding:3px 8px;color:${e2 != null && e2 < 0 ? '#B00020' : '#2A7A3B'}">${e2 == null ? '\u2014' : (e2 > 0 ? '+' : '') + Math.round(e2 * 100) + '%'}</td>
          <td style="padding:3px 8px">@ ${r.d}</td><td style="padding:3px 8px">${xcell(r)}</td></tr>`; }).join('');
    const okS = await send(`🏇 ${rc.t} ${rc.course} — off in ~${mins} min`,
      `<div style="font-family:monospace"><h3 style="margin:0 0 6px">${rc.t} ${String(rc.course).toUpperCase()} · SCORES picks</h3><table>${rows}</table>
      <h4 style="margin:12px 0 4px;color:#444">FULL CARD · deepest minus first</h4>
      <table style="font-size:12px"><tr style="color:#999;font-size:10px"><td style="padding:2px 8px">HORSE · SCORE</td><td style="padding:2px 8px">J/T%</td><td style="padding:2px 8px">EDGE</td><td style="padding:2px 8px">SP</td><td style="padding:2px 8px">XS1</td></tr>${cardRows}</table>
      <p style="color:#999;font-size:12px">score = each signal pays 5/3/1 for its top three · XS1 = (J% + T%) / SP · a design, not a finding · not advice</p></div>`);
    if (okS) { st.sent[k] = 1; st.picks[k] = picks.map(p => ({ h: p.r.h, pts: p.s.pts, d: p.r.d })); out.sentPicks.push(k);
      st.prints = st.prints || [];
      st.prints.push({ ts: Date.now(), k, t: rc.t, course: rc.course, mins,
        picks: picks.map(p => ({ h: p.r.h, pts: p.s.pts, tags: p.s.tags, d: p.r.d, xs1: (() => { const v = xs1(p.r); return v != null ? Math.round(v * 10) / 10 : null; })() })),
        card: rc.rs.slice().sort((a, b) => { const ea = edges[a.h], eb = edges[b.h]; return (ea == null) - (eb == null) || (ea || 0) - (eb || 0); })
          .map(r => ({ h: r.h, pts: (sc[r.h] || {}).pts || 0, j: strike(store.jockeys, r.jid), tr: strike(store.trainers, r.tid),
            e: edges[r.h] != null ? Math.round(edges[r.h] * 100) : null, d: r.d, xs1: (() => { const v = xs1(r); return v != null ? Math.round(v * 10) / 10 : null; })() })) });
      st.prints = st.prints.slice(-120); }
  }

  // 2) results for sent races
  let winners = null;
  try { winners = await gj('/api/todaywinners'); } catch {}
  out.winnersSeen = winners && winners.ok ? (winners.winners || []).length : -1;
  out.sentKeys = Object.keys(st.sent);
  out.unmatched = [];
  if (winners && winners.ok) {
    for (const w of winners.winners || []) {
      const k = rkey(w.t, w.course);
      if (!st.sent[k]) { out.unmatched.push(k); continue; }
      if (st.resulted[k]) continue;
      const picks = st.picks[k] || [];
      (st.prints || []).forEach(p => { if (p.k === k && !p.w) { p.w = w.h; p.hit = picks.some(x => String(x.h).toLowerCase() === String(w.h).toLowerCase()); } });
      const hit = picks.find(p => p.h === w.h);
      const list = picks.map(p => `${p.h === w.h ? '✅' : '❌'} ${p.h} (${p.pts}) @ ${p.d}`).join('<br>') || 'no scored picks';
      const okS = await send(`${hit ? '✅' : '❌'} ${w.t} ${w.course} — ${w.h} won`,
        `<div style="font-family:monospace"><h3 style="margin:0 0 6px">${w.t} ${String(w.course).toUpperCase()} · result</h3><p><b>Winner: ${w.h}</b></p><p>${list}</p></div>`);
      if (okS) { st.resulted[k] = 1; out.sentResults.push(k); }
    }
  }

  try { await fetch(base + '/api/yearstate?k=alertstate:v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) }); } catch {}
  return res.status(200).json(out);
}
