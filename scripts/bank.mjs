// Cloud banker: keeps TERMINAL X open in headless Chromium so every pick is banked pre-off and locked at the result.
// Runs for RUN_MINUTES (default 57) then exits; the workflow schedules it hourly through racing hours, so coverage is continuous.
import { chromium } from 'playwright';
const BASE = process.env.RS_BASE || 'https://raceside.vercel.app';
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 57);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, userAgent: 'RACESIDE-cloud-banker/1' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => { log('PAGEERR', String(e).slice(0, 200)); errs.push(String(e).slice(0, 200)); });
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
await page.goto(BASE + '/maxterminalx.html?bg=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
log('terminal open');
// one pass of tomorrow's card per run so tomorrow's picks are on record early
const tm = await ctx.newPage();
tm.goto(BASE + '/maxterminalx.html?day=tomorrow', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
setTimeout(() => tm.close().catch(() => {}), 90000);
const end = Date.now() + RUN_MINUTES * 60000;
while (Date.now() < end) {
  await page.waitForTimeout(60000);
  const st = await page.evaluate(() => ({ banked: !!window.__lgSig, picks: window.__trackPicks ? Object.values(window.__trackPicks).reduce((a, b) => a + b.length, 0) : 0,
    live: window.__trackPicks ? Object.values(window.__trackPicks).reduce((a, b) => a + b.filter(p => p.w === null).length, 0) : 0 })).catch(() => null);
  log('alive', JSON.stringify(st));
  // heartbeat to the store so the banker can be checked from anywhere without GitHub logs
  try { const hb = await page.evaluate(() => ({ bankedAt: window.__bankedAt || null, err: window.__bankErr || null, sig: !!window.__lgSig, ukd: (document.body.textContent.match(/page updated \S+/) || [])[0] || null })).catch(() => null);
    await fetch(BASE + '/api/yearstate?k=bankerlog:v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ts: Date.now(), at: new Date().toISOString(), run: process.env.GITHUB_RUN_NUMBER || null, st, hb, errs: errs.slice(-10) }) }); } catch (e) { log('hb fail', String(e).slice(0, 100)); }
  // the page reloads itself at midnight; if it ever goes blank, reload it ourselves
  const ok = await page.evaluate(() => !!document.getElementById('appbody')).catch(() => false);
  if (!ok) { log('reloading'); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
}
log('run complete');
await browser.close();
