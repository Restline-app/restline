(function () {
  'use strict';

  var doc = document;
  var win = window;
  var root = doc.documentElement;
  root.classList.add('js');

  function showAll() {
    var all = doc.querySelectorAll('.reveal');
    for (var i = 0; i < all.length; i++) all[i].classList.add('now', 'in');
  }
  win.addEventListener('error', showAll);
  try {
    main();
  } catch (e) {
    showAll();
  }

  function main() {

  var ENDPOINT = '/api/event';
  var COOKIE = 'rl_v';
  var NINETY_DAYS = 90 * 24 * 60 * 60;

  /* ---------- visitor id (one first-party cookie) ---------- */

  function randomId() {
    var bytes = null;
    try {
      if (win.crypto && win.crypto.getRandomValues) {
        bytes = new Uint8Array(16);
        win.crypto.getRandomValues(bytes);
      }
    } catch (e) { bytes = null; }
    var out = '';
    var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 24; i++) {
      var n = bytes ? bytes[i % 16] ^ (i * 31) : Math.floor(Math.random() * 256);
      out += alphabet[n % alphabet.length];
    }
    return out;
  }

  function readCookie(name) {
    var parts = (doc.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+/, '');
      if (p.indexOf(name + '=') === 0) return p.slice(name.length + 1);
    }
    return '';
  }

  var vid = readCookie(COOKIE);
  if (!/^[a-z0-9]{24}$/.test(vid)) {
    vid = randomId();
    try {
      doc.cookie = COOKIE + '=' + vid + '; Max-Age=' + NINETY_DAYS + '; Path=/; SameSite=Lax' +
        (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) {}
  }

  /* ---------- context ---------- */

  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { params = null; }
  function param(name) {
    var v = params ? params.get(name) : null;
    return v ? String(v).slice(0, 100) : '';
  }

  function refOrigin(v) {
    if (!v) return '';
    try { var o = new URL(v).origin; return o === 'null' ? '' : o; } catch (e) {}
    var m = /^[a-z]+:\/\/[^\/?#]+/i.exec(v);
    return m ? m[0] : '';
  }

  var ua = navigator.userAgent || '';
  var device = (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) ? 'ios'
    : /Android/.test(ua) ? 'android' : 'other';
  var inapp = /BytedanceWebview|musical_ly|TikTok/i.test(ua) ? 'tiktok'
    : /Instagram/i.test(ua) ? 'instagram'
    : /FBAN|FBAV|FB_IAB|FBIOS|FB4A/.test(ua) ? 'facebook' : 'none';

  var base = {
    vid: vid,
    utm_source: param('utm_source'),
    utm_medium: param('utm_medium'),
    utm_campaign: param('utm_campaign'),
    utm_content: param('utm_content'),
    device: device,
    inapp: inapp,
    ref: refOrigin(doc.referrer)
  };

  /* ---------- transport ---------- */

  function payload(event, extra) {
    var row = { event: event, ts: new Date().toISOString() };
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) row[k] = base[k];
    if (extra) for (var j in extra) if (Object.prototype.hasOwnProperty.call(extra, j)) row[j] = extra[j];
    return JSON.stringify(row);
  }

  function post(body, attempt) {
    attempt = attempt || 1;
    var retry = function () { if (attempt < 3) setTimeout(function () { post(body, attempt + 1); }, 600 * attempt); };
    try {
      if (!win.fetch) { xhr(body); return; }
      win.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'same-origin',
        cache: 'no-store'
      }).then(function (r) { if (!r.ok && r.status !== 400) retry(); }, retry);
    } catch (e) { xhr(body); }
  }

  function xhr(body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', ENDPOINT, true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(body);
    } catch (e) {}
  }

  function send(event, extra) { post(payload(event, extra)); }

  function beacon(event, extra) {
    var body = payload(event, extra);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, body)) return;
    } catch (e) {}
    post(body);
  }

  /* ---------- the tap: bound before anything else, counted before the sheet opens ---------- */

  var tapButtons = doc.querySelectorAll('[data-tap]');
  for (var b = 0; b < tapButtons.length; b++) {
    tapButtons[b].addEventListener('click', function (ev) {
      try { send('tap', { button: this.getAttribute('data-tap') || '' }); } catch (e) {}
      try { openSheet(); } catch (e) {}
    });
  }

  /* ---------- events ---------- */

  send('pageview');

  var t0 = Date.now();
  var left = false;
  function leave() {
    if (left) return;
    left = true;
    beacon('leave', { seconds: Math.max(0, Math.round((Date.now() - t0) / 1000)) });
  }
  win.addEventListener('pagehide', leave);
  win.addEventListener('pageshow', function () { left = false; });
  doc.addEventListener('visibilitychange', function () {
    if (doc.visibilityState === 'hidden') leave(); else left = false;
  });

  var video = doc.getElementById('clip');
  var videoReported = false;
  function reportVideo(state) {
    if (videoReported) return;
    videoReported = true;
    send('video', { video: state });
  }
  try { if (video) {
    video.addEventListener('playing', function () { reportVideo('playing'); });
    video.addEventListener('error', function () { reportVideo('blocked'); });
    try {
      video.defaultMuted = true;
      video.muted = true;
      var p = video.play();
      if (p && typeof p.then === 'function') p.then(null, function () { reportVideo('blocked'); });
    } catch (e) { reportVideo('blocked'); }
    setTimeout(function () { if (!videoReported && video.paused) reportVideo('blocked'); }, 15000);
    video.parentNode.addEventListener('click', function () {
      if (video.paused) { try { var q = video.play(); if (q && q.then) q.then(null, function () {}); } catch (e) {} }
    });
  } } catch (e) {}

  var price = doc.getElementById('price');
  try { if (price && 'IntersectionObserver' in win) {
    var seen = false;
    var seenObs = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting && !seen) {
          seen = true;
          seenObs.disconnect();
          send('seen');
        }
      }
    }, { threshold: 0.5 });
    seenObs.observe(price);
  } } catch (e) {}

  /* ---------- reveal ---------- */

  var reveals = doc.querySelectorAll('.reveal');
  var reduced = false;
  try { reduced = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  try { if (reduced || !('IntersectionObserver' in win)) {
    for (var r = 0; r < reveals.length; r++) reveals[r].classList.add('now', 'in');
  } else {
    var vh = win.innerHeight || root.clientHeight;
    var revealObs = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          entries[i].target.classList.add('in');
          revealObs.unobserve(entries[i].target);
        }
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    for (var k = 0; k < reveals.length; k++) {
      var el = reveals[k];
      if (el.getBoundingClientRect().top < vh) el.classList.add('now', 'in');
      else revealObs.observe(el);
    }
    // insurance: anything scrolled into view that the observer did not report
    var revealRaf = 0;
    win.addEventListener('scroll', function () {
      if (revealRaf) return;
      revealRaf = win.requestAnimationFrame(function () {
        revealRaf = 0;
        var h = win.innerHeight || root.clientHeight;
        for (var i = 0; i < reveals.length; i++) {
          if (!reveals[i].classList.contains('in') && reveals[i].getBoundingClientRect().top < h) reveals[i].classList.add('in');
        }
      });
    }, { passive: true });
  } } catch (e) { showAll(); }

  /* ---------- sheet ---------- */

  var sheetRoot = doc.getElementById('sheet');
  var panel = doc.getElementById('sheet-panel');
  var step1 = doc.getElementById('step-1');
  var step2 = doc.getElementById('step-2');
  var emailForm = doc.getElementById('email-form');
  var answerForm = doc.getElementById('answer-form');
  var emailInput = doc.getElementById('email');
  var answerInput = doc.getElementById('answer');
  var lastFocus = null;
  var scrollY = 0;
  var sheetOpen = false;
  var closeTimer = 0;

  function showStep(n) {
    step1.hidden = n !== 1;
    step2.hidden = n !== 2;
    panel.setAttribute('aria-labelledby', n === 1 ? 'sheet-title-1' : 'sheet-title-2');
    panel.scrollTop = 0;
  }

  function openSheet() {
    if (sheetOpen) return;
    sheetOpen = true;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
    lastFocus = doc.activeElement;
    scrollY = win.pageYOffset || root.scrollTop || 0;
    doc.body.style.top = -scrollY + 'px';
    showStep(1);
    emailInput.value = '';
    emailInput.removeAttribute('aria-invalid');
    answerInput.value = '';
    sheetRoot.hidden = false;
    root.classList.add('sheet-open');
    fitSheet();
    win.requestAnimationFrame(function () {
      win.requestAnimationFrame(function () {
        sheetRoot.classList.add('open');
        try { panel.focus({ preventScroll: true }); } catch (e) { panel.focus(); }
      });
    });
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    sheetRoot.classList.remove('open');
    try { doc.activeElement && doc.activeElement.blur(); } catch (e) {}
    root.classList.remove('sheet-open');
    doc.body.style.top = '';
    win.scrollTo(0, scrollY);
    var done = function () {
      closeTimer = 0;
      sheetRoot.hidden = true;
      panel.style.bottom = '';
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
    };
    if (reduced) done(); else closeTimer = setTimeout(done, 320);
  }

  function fitSheet() {
    var vv = win.visualViewport;
    if (!vv) return;
    root.style.setProperty('--vvh', Math.round(vv.height) + 'px');
    var offset = Math.max(0, Math.round((win.innerHeight || vv.height) - (vv.height + vv.offsetTop)));
    panel.style.bottom = sheetOpen ? offset + 'px' : '';
  }

  if (win.visualViewport) {
    var fitRaf = 0;
    var onViewport = function () {
      if (!sheetOpen || fitRaf) return;
      fitRaf = win.requestAnimationFrame(function () { fitRaf = 0; fitSheet(); });
    };
    win.visualViewport.addEventListener('resize', onViewport);
    win.visualViewport.addEventListener('scroll', onViewport);
  }

  sheetRoot.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== sheetRoot) {
      if (t.hasAttribute && t.hasAttribute('data-close')) { ev.preventDefault(); closeSheet(); return; }
      t = t.parentNode;
    }
  });

  doc.addEventListener('keydown', function (ev) {
    if (!sheetOpen) return;
    if (ev.key === 'Escape' || ev.key === 'Esc') { closeSheet(); return; }
    if (ev.key === 'Tab') {
      var focusables = panel.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
      var list = [];
      for (var i = 0; i < focusables.length; i++) {
        var f = focusables[i];
        if (f.offsetParent !== null) list.push(f);
      }
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (ev.shiftKey && (doc.activeElement === first || doc.activeElement === panel)) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && doc.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });

  function validEmail(v) {
    if (!v || v.length > 254) return false;
    if (emailInput.checkValidity && !emailInput.checkValidity()) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  emailForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = (emailInput.value || '').trim();
    if (!validEmail(v)) {
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
      return;
    }
    emailInput.removeAttribute('aria-invalid');
    send('email', { email: v });
    try { emailInput.blur(); } catch (e) {}
    showStep(2);
    win.requestAnimationFrame(function () {
      try { panel.focus({ preventScroll: true }); } catch (e) {}
      fitSheet();
    });
  });

  emailInput.addEventListener('input', function () { emailInput.removeAttribute('aria-invalid'); });

  answerForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = (answerInput.value || '').trim().slice(0, 500);
    if (!v) { answerInput.focus(); return; }
    send('answer', { answer: v });
    closeSheet();
  });
  }
})();
