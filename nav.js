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
      ['/prints.html', 'PRINTS'],
      ['/printlist.html', 'PRINT LIST'],
      ['/archive.html', 'ARCHIVE'],
      ['/maxarchive.html', 'MAX ARCHIVE'],
      ['/maxprints.html', 'MAX PRINTS'],
      ['/ourodds.html', 'PRICE'],
    ]],
    ['ANGLES', [
      ['/thewr.html', 'WR'],
      ['/firstpairs.html', 'PAIRS'],
      ['/thehour.html', 'HOUR'],
      ['/tiptree.html', 'TIPTREE'],
      ['/fit.html', 'FIT'],
      ['/gap.html', 'GAP'],
      ['/signals.html', 'SIGNALS'],
      ['/optimal.html', 'OPTIMAL'],
      ['/tricast.html', 'FRAME'],
      ['/fixtures.html', 'FIXTURES'],
      ['/racingpredict.html', 'PREDICT'],
      ['/martingale.html', 'MGALE'],
      ['/groups.html', 'GROUPS'],
      ['/sires.html', 'SIRES'],
      ['/trebles.html', 'TREBLES'],
    ]],
    ['LISTEN', [
      ['https://betfair.mediaondemand.net/?sport=horses&theme=dark&playerbg=ffb80c&highlights=0&queuebuttoncolor=fff&showmenu', 'RACING RADIO', 1],
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
        if (p[2]) { a.target = '_blank'; a.rel = 'noopener'; }
        if (on) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
        row.appendChild(a);
        if (on) setTimeout(function () { a.scrollIntoView({ inline: 'center', block: 'nearest' }); }, 0);
      });
      bar.appendChild(row);
    });
    wrap.insertBefore(bar, wrap.firstChild);
  }
  // ---- results ticker: last 3 winners, site-wide ----
  function ticker() {
    fetch('/api/todaywinners').then(function (r) { return r.json(); }).then(function (j) {
      if (!(j && j.ok && j.winners && j.winners.length)) return;
      var t2m = function (t) { var m = String(t || '').match(/(\d{1,2})[:.](\d{2})/); if (!m) return 0; var hh = +m[1]; if (hh < 10) hh += 12; return hh * 60 + +m[2]; };
      var last3 = j.winners.slice().sort(function (a, b) { return t2m(a.t) - t2m(b.t); }).slice(-3).reverse();
      var txt = last3.map(function (w) {
        return '<span style="color:#5FBF77">\u2705</span> ' + String(w.t || '').replace('.', ':') + ' ' + String(w.course || '').replace(/\s*\([^)]*\)/g, '').toUpperCase() + ' \u2014 <b style="color:#FFFFFF">' + w.h + '</b>' + (w.sp ? ' <span style="color:#93A1AE">@ ' + w.sp + '</span>' : '');
      }).join(' <span style="color:#5C6B77">\u00b7</span> ');
      var bar = document.createElement('div');
      bar.setAttribute('style', 'overflow:hidden;background:#0B0F13;border-bottom:1px solid rgba(255,255,255,.08);font:11px/2.2 "SF Mono",ui-monospace,Menlo,monospace;color:#93A1AE;white-space:nowrap;position:relative');
      var inner = document.createElement('div');
      inner.setAttribute('style', 'display:inline-block;padding-left:100%;animation:rsTick 28s linear infinite');
      inner.innerHTML = '<span style="color:#E8B54C;letter-spacing:.1em">RESULTS</span> \u00b7 ' + txt + ' \u00b7\u00b7 ' + txt;
      var css = document.createElement('style');
      css.textContent = '@keyframes rsTick{0%{transform:translateX(0)}100%{transform:translateX(-100%)}}';
      document.head.appendChild(css);
      bar.appendChild(inner);
      document.body.insertBefore(bar, document.body.firstChild);
    }).catch(function () {});
  }
  function boot() { mount(); ticker(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
