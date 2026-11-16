// RACESIDE — PLOT alert: emailed the moment Spotlight finds the Sony Bill shape in a pasted card.
// Deliberately ignores ALERTS_PAUSED - Ryan asked for these specifically.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const key = process.env.RESEND_API_KEY, to = process.env.EMAIL_TO;
  if (!key || !to) return res.status(200).json({ ok: false, error: 'no mail env' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || !b.race || !Array.isArray(b.horses) || !b.horses.length || b.horses.length > 6) return res.status(400).json({ ok: false });
  const esc = s => String(s == null ? '' : s).slice(0, 120).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r = b.race;
  const html = `<div style="font:15px/1.5 -apple-system,system-ui,sans-serif;color:#111"><p style="font-size:11px;letter-spacing:.18em;color:#c2410c;font-weight:900">PLOT · SPOTLIGHT</p><h2 style="margin:0 0 4px">${esc(r.time)} ${esc(r.course)}</h2><p style="margin:0 0 14px;color:#666">${esc(r.date)} · ${esc(r.name)}</p>` +
    b.horses.map(h => `<div style="border:1px solid #fdba74;background:#fff7ed;border-radius:12px;padding:12px 14px;margin-bottom:10px"><b style="font-size:17px">${esc(h.name)}</b> <span style="color:#666">${esc(h.odds)}</span><br>best RPR ${esc(h.best)} v OR ${esc(h.or)} — <b>${esc(h.headroom)}lb in hand</b>, mark down ${esc(h.orDrop)}lb<br>${esc(h.jockey)} for ${esc(h.trainer)}<br><span style="font-size:12px;color:#9a3412">${(h.tags || []).slice(0, 8).map(esc).join(' · ')}</span></div>`).join('') +
    `<p style="margin-top:14px"><a href="https://raceside.vercel.app/rpspot.html?day=${encodeURIComponent(r.date || '')}">Open Spotlight</a></p></div>`;
  const subject = `PLOT ${r.time} ${r.course}: ${b.horses.map(h => h.name + ' ' + (h.odds || '')).join(', ')}`;
  try { const x = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'RACESIDE <onboarding@resend.dev>', to: [to], subject, html }) }); return res.status(200).json({ ok: x.ok }); }
  catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
}
