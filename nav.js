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
      ['/maxlists.html', 'MAX LISTS'],
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
      l.href = '/rs.css?v=2';
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
        return '<span style="color:#5FBF77">\u2705</span> ' + String(w.t || '').replace('.', ':') + ' ' + String(w.course || '').replace(/\s*\([^)]*\)/g, '').toUpperCase() + ' \u2014 <b style="color:#141414">' + w.h + '</b>' + (w.sp ? ' <span style="color:#93A1AE">@ ' + w.sp + '</span>' : '');
      }).join(' <span style="color:#5C6B77">\u00b7</span> ');
      var bar = document.createElement('div');
      bar.setAttribute('style', 'overflow:hidden;background:#FFFFFF;border-bottom:2px solid #141414;font:11px/2.2 "SF Mono",ui-monospace,Menlo,monospace;color:#555555;white-space:nowrap;position:relative');
      var inner = document.createElement('div');
      inner.setAttribute('style', 'display:inline-block;padding-left:100%;animation:rsTick 28s linear infinite');
      inner.innerHTML = '<span style="color:#C1121F;letter-spacing:.1em;font-weight:700">RESULTS</span> \u00b7 ' + txt + ' \u00b7\u00b7 ' + txt;
      var css = document.createElement('style');
      css.textContent = '@keyframes rsTick{0%{transform:translateX(0)}100%{transform:translateX(-100%)}}';
      document.head.appendChild(css);
      bar.appendChild(inner);
      document.body.insertBefore(bar, document.body.firstChild);
    }).catch(function () {});
  }
  function paper() {
    var s = document.createElement('style');
    s.id = 'rs-paper';
    s.textContent = [
      'html{color-scheme:light !important}',
      ':root{--bg:#FFFFFF !important;--tile:#F8F8F6 !important;--line:rgba(0,0,0,.14) !important;--ink:#141414 !important;--dim:#555555 !important;--faint:#8E8E8E !important;--gold:#C1121F !important;--red:#C1121F !important;--green:#1B7A3D !important;--blue:#C1121F !important}',
      'body{background:#FFFFFF !important;color:#141414 !important}',
      '.tile{background:#F8F8F6 !important;border-color:rgba(0,0,0,.16) !important}',
      '.hd b,.pick .nm,.right,.dayhd,.jump a,.pts{color:#141414 !important}',
      '.pick.np .nm{color:#777 !important}',
      '.num{background:rgba(0,0,0,.08) !important;color:#141414 !important}',
      '.pts{background:rgba(0,0,0,.08) !important}.pts.big{background:#C1121F !important;color:#FFFFFF !important}',
      '.star{color:#C1121F !important}',
      '.sig{background:rgba(193,18,31,.08) !important;color:#C1121F !important}',
      '.mx{background:rgba(0,0,0,.05) !important;color:#141414 !important;border-color:rgba(0,0,0,.25) !important}',
      '.lum{background:rgba(193,18,31,.06) !important;color:#8A1010 !important}',
      '.ml{background:#141414 !important;color:#FFFFFF !important}',
      '.chip{color:#555 !important;border-color:rgba(0,0,0,.2) !important}',
      '.tsort button{color:#666 !important;border-color:rgba(0,0,0,.2) !important}',
      '.tsort button.on{color:#C1121F !important;border-color:#C1121F !important}',
      'span[style*="8EC9FF"]{color:#C1121F !important}',
      'span[style*="FFFFFF"],b[style*="FFFFFF"],[style*="color:#FFFFFF"]{color:#141414 !important}',
      '.ml[style], .pts.big{color:#FFFFFF !important}',
      '[style*="EAFF00"]{color:#8A1010 !important}',
      '[style*="ff8fc7"]{color:#C1121F !important}',
      '[style*="3EE6B1"]{color:#141414 !important}',
      'a{color:#C1121F}',
    ].join('\n');
    document.head.appendChild(s);
  }
  function boot() { paper(); mount(); ticker(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
