// RACESIDE shared nav — one horizontally scrolling strip, current page highlighted.
// Pages include: <script src="/nav.js?v=1" defer></script>
(function () {
  'use strict';
  var pages = [
    ['/theview.html', 'VIEW'],
    ['/jockeys.html', 'J&T'],
    ['/groups.html', 'GROUPS'],
    ['/results.html', 'RESULTS'],
    ['/ourodds.html', 'PRICE'],
    ['/priceday.html', 'DATED'],
    ['/daychart.html', 'DAY'],
    ['/freqyear.html', 'YEAR'],
    ['/martingale.html', 'MGALE'],
    ['/thepounce.html', 'POUNCE'],
    ['/market.html', 'MARKET'],
    ['/yesterday.html', 'YDAY'],
    ['/sires.html', 'SIRES'],
    ['/trebles.html', 'TREBLES'],
  ];
  function mount() {
    var wrap = document.querySelector('.wrap') || document.body;
    if (!wrap || document.getElementById('rsnav')) return;
    var here = location.pathname.replace(/\/$/, '') || '/theview.html';
    var nav = document.createElement('nav');
    nav.id = 'rsnav';
    nav.setAttribute('aria-label', 'site');
    nav.style.cssText = 'display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:2px 0 12px;margin:0 0 4px;';
    pages.forEach(function (p) {
      var a = document.createElement('a');
      var on = here === p[0] || (here === '' || here === '/' || here === '/index.html') && p[0] === '/theview.html';
      a.href = p[0];
      a.textContent = p[1];
      a.style.cssText = 'flex:none;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10.5px;letter-spacing:.06em;text-decoration:none;padding:6px 11px;border-radius:999px;border:1px solid ' +
        (on ? '#2456E6;background:#2456E6;color:#fff;font-weight:600' : '#3A5490;color:#8FA3C8');
      if (on) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    });
    wrap.insertBefore(nav, wrap.firstChild);
    // keep the active chip in view on small screens
    var act = nav.querySelector('[aria-current]');
    if (act && act.scrollIntoView) { try { act.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
