// RACESIDE shared chrome v2 — injects the design system + grouped sticky nav on every page.
// Pages include nav.js with defer; it injects rs.css and the grouped bar.
(function () {
  'use strict';
  var GROUPS = [
    ['TODAY', [
      ['/thepounce.html', 'POUNCE'],
      ['/theideas.html', 'IDEAS'],
      ['/minuscards.html', 'MINUS'],
      ['/theview.html', 'VIEW'],
      ['/jockeys.html', 'J&T'],
      ['/market.html', 'MARKET'],
    ]],
    ['RECORD', [
      ['/daychart.html', 'DAY'],
      ['/freqyear.html', 'YEAR'],
      ['/priceday.html', 'DATED'],
      ['/results.html', 'RESULTS'],
      ['/yesterday.html', 'YDAY'],
      ['/ourodds.html', 'PRICE'],
    ]],
    ['ANGLES', [
      ['/thewr.html', 'WR'],
      ['/firstpairs.html', 'PAIRS'],
      ['/thehour.html', 'HOUR'],
      ['/martingale.html', 'MGALE'],
      ['/groups.html', 'GROUPS'],
      ['/sires.html', 'SIRES'],
      ['/trebles.html', 'TREBLES'],
    ]],
  ];
  function mount() {
    if (document.getElementById('rsbar')) return;
    if (!document.querySelector('link[href^="/rs.css"]')) {
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/rs.css?v=1';
      document.head.appendChild(l);
    }
    var old = document.getElementById('rsnav');
    if (old) old.remove();
    var wrap = document.querySelector('.wrap') || document.body;
    var here = location.pathname.replace(/\/$/, '') || '/index.html';
    var bar = document.createElement('div');
    bar.id = 'rsbar';
    var brand = document.createElement('div');
    brand.className = 'brand';
    brand.innerHTML = '<span class="dot"></span><a href="/">RACE<b>SIDE</b></a>';
    bar.appendChild(brand);
    GROUPS.forEach(function (g) {
      var row = document.createElement('nav');
      row.className = 'rsgroup';
      row.setAttribute('aria-label', g[0]);
      var lb = document.createElement('span');
      lb.className = 'lbl';
      lb.textContent = g[0];
      row.appendChild(lb);
      g[1].forEach(function (p) {
        var a = document.createElement('a');
        var on = here === p[0];
        a.href = p[0];
        a.textContent = p[1];
        if (on) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
        row.appendChild(a);
        if (on) setTimeout(function () { a.scrollIntoView({ inline: 'center', block: 'nearest' }); }, 0);
      });
      bar.appendChild(row);
    });
    wrap.insertBefore(bar, wrap.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
