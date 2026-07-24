/* ============================================================
   Ink Tool v3 — ปากกา Apple Pencil / เมาส์ / นิ้ว สำหรับหน้าติวหนังสือ
   ใช้ร่วมกันทุกหน้าใน books/law-legal และ books/utcc
   สเปก: docs/superpowers/specs/2026-07-13-ink-tool-design.md
   ============================================================
   v3 (แก้อาการบน iPad: "เขียนไม่ติด / ไม่ตรง / เส้นลอยตอนเลื่อน"):
   - canvas เป็น position:absolute สูงเท่าเอกสาร → เส้น "ติดกับเนื้อหา"
     เลื่อน/ซูมตามหน้าเองโดยไม่ต้องวาดใหม่ (หมดอาการเส้นลอย/ตามไม่ทัน/ไม่ตรง)
   - เก็บทุกเส้นแม้จุดเดียว (แตะจุด/ขีดสั้น ๆ ก็ติด) — เดิมทิ้งเส้นที่ <3 จุด
   - setPointerCapture ระหว่างลาก → iOS ไม่แย่งเป็นสกรอลล์ เส้นไม่หลุด
   - กันฝ่ามือ: เริ่มโหมด "นิ้วเขียนได้"; พบ Apple Pencil ครั้งแรกสลับเป็น
     "Pencil เท่านั้น" อัตโนมัติ (เฉพาะเซสชัน — โหลดหน้าใหม่นิ้วเขียนได้อีก)
   - วาดสดแบบเพิ่มทีละช่วง (ลื่น) + วาดใหม่ทั้งหมดตอนจบเส้น/ลบ/ย้อน
   - แถบเครื่องมือหุบ-กางได้ · เลื่อนได้เมื่อจอเตี้ย (ปุ่มไม่ล้นจอ)
   - บันทึกภาพ PNG เฉพาะจอ/ทั้งเอกสาร (html2canvas โหลด lazy)
*/
(function () {
  'use strict';
  if (window.__inkToolLoaded) return;
  window.__inkToolLoaded = true;

  var LS_KEY = 'ink:' + location.pathname;
  var MAX_DOC_H = 24000;              // เพดานความสูงเอกสารที่จับภาพ "ทั้งหน้า"
  var MAX_SHOT_AREA = 14e6;           // เพดานพิกเซลภาพจับหน้าจอ (กัน iOS canvas ว่างเปล่า)
  var MAX_SIDE = 8192, MAX_AREA = 16e6; // ลิมิต canvas ของ iOS (ด้าน/พื้นที่)
  var HL_COLOR = '#ffe066';
  var PENS = [
    { c: '#c9a227', name: 'ทอง' },
    { c: '#e0433f', name: 'แดง' },
    { c: '#2563eb', name: 'น้ำเงิน' }
  ];

  /* ---------- state ---------- */
  var strokes = [];                  // {tool,color,bw,pts:[[x,y,p],...],bb}
  var undoStack = [];
  var tool = null;                   // 'pen' | 'hl' | 'eraser' | null(ปิด)
  var penColor = localStorage.getItem('ink:color') || PENS[0].c;
  var palmMode = 'any';              // 'any' = นิ้ว/เมาส์เขียนได้ · 'pen' = Pencil เท่านั้น (เซสชัน)
  var drawing = null;                // stroke ระหว่างเขียน
  var activeId = null, activeType = null;
  var saveTimer = null, sizeTimer = null;
  var _W = 0, _K = 1;                // ความกว้างเอกสาร + สเกลพิกเซล backing ปัจจุบัน

  function docW() { return document.documentElement.clientWidth || window.innerWidth || 1; }
  function contentH() {              // ความสูงเนื้อหา โดยยุบ canvas ก่อนวัด (กันวัดพองตัวเอง)
    var prev = canvas.style.height;
    canvas.style.height = '0px';
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      window.innerHeight || 0
    );
    canvas.style.height = prev;
    return h;
  }

  /* ---------- persistence (รูปแบบ v1 — โน้ตเก่าอ่านต่อได้) ---------- */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var slim = strokes.map(function (s) {
          return { t: s.tool, c: s.color, w: s.bw, p: s.pts.map(function (q) { return [Math.round(q[0]), Math.round(q[1]), Math.round(q[2] * 100) / 100]; }) };
        });
        localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, s: slim }));
      } catch (e) {
        if (!persist.warned) { persist.warned = true; toast('พื้นที่บันทึกเส้นเต็ม — เส้นใหม่จะไม่ถูกจำ'); }
      }
    }, 400);
  }
  function restore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      (JSON.parse(raw).s || []).forEach(function (s) {
        if (!s.p || !s.p.length) return;
        strokes.push(finishStroke({ tool: s.t, color: s.c, bw: s.w || docW(), pts: s.p }));
      });
    } catch (e) { /* ข้อมูลเสีย — เริ่มใหม่ */ }
  }
  function finishStroke(s) {
    var x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    s.pts.forEach(function (q) {
      if (q[0] < x1) x1 = q[0]; if (q[0] > x2) x2 = q[0];
      if (q[1] < y1) y1 = q[1]; if (q[1] > y2) y2 = q[1];
    });
    s.bb = [x1 - 30, y1 - 30, x2 + 30, y2 + 30];
    return s;
  }

  /* ---------- canvas (absolute, สูงเท่าเอกสาร — เลื่อน/ซูมตามหน้าเอง) ---------- */
  var canvas = document.createElement('canvas');
  canvas.id = 'inkToolCanvas';
  var ctx = canvas.getContext('2d');

  function sizeCanvas() {
    var W = docW(), H = contentH();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var K = Math.min(dpr, MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_AREA / (W * H)));
    if (!isFinite(K) || K <= 0) K = 1;
    K = Math.max(0.5, K);
    _W = W; _K = K;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    canvas.width = Math.max(1, Math.floor(W * K));   // floor → คง backing อยู่ใต้เพดานพื้นที่เสมอ
    canvas.height = Math.max(1, Math.floor(H * K));
    repaintAll();
  }
  function scheduleSize() { clearTimeout(sizeTimer); sizeTimer = setTimeout(sizeCanvas, 120); }

  // วาดหนึ่งเส้นลงบริบท c2: kk = พิกเซลปลายทางต่อ 1 CSS px เอกสาร, (x0,y0) = ออฟเซ็ตเอกสาร
  function paintStroke(c2, s, kk, x0, y0, curDocW) {
    var g = (curDocW || _W || docW()) / s.bw;
    var pts = s.pts;
    var X = function (i) { return (pts[i][0] * g - x0) * kk; };
    var Y = function (i) { return (pts[i][1] * g - y0) * kk; };
    c2.lineCap = 'round'; c2.lineJoin = 'round';
    if (pts.length < 2) {                              // จุดเดียว → วาดเป็นจุดกลม
      c2.fillStyle = s.color;
      if (s.tool === 'hl') { c2.globalAlpha = 0.4; c2.beginPath(); c2.arc(X(0), Y(0), 9 * g * kk, 0, 7); c2.fill(); c2.globalAlpha = 1; }
      else { c2.beginPath(); c2.arc(X(0), Y(0), Math.max(1.2, 1.6 * g * kk), 0, 7); c2.fill(); }
      return;
    }
    if (s.tool === 'hl') {
      c2.globalAlpha = 0.4;
      c2.strokeStyle = s.color;
      c2.lineWidth = 18 * g * kk;
      c2.beginPath();
      c2.moveTo(X(0), Y(0));
      for (var i = 1; i < pts.length - 1; i++) c2.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
      c2.lineTo(X(pts.length - 1), Y(pts.length - 1));
      c2.stroke();
      c2.globalAlpha = 1;
    } else {
      c2.strokeStyle = s.color;
      var mx = X(0), my = Y(0);
      for (var j = 1; j < pts.length; j++) {
        var nx = j < pts.length - 1 ? (X(j) + X(j + 1)) / 2 : X(j);
        var ny = j < pts.length - 1 ? (Y(j) + Y(j + 1)) / 2 : Y(j);
        var p = Math.max(0.15, (pts[j - 1][2] + pts[j][2]) / 2 || 0.5);
        c2.lineWidth = Math.max(1, 2.6 * (0.4 + p * 1.2)) * g * kk;
        c2.beginPath();
        c2.moveTo(mx, my);
        c2.quadraticCurveTo(X(j), Y(j), nx, ny);
        c2.stroke();
        mx = nx; my = ny;
      }
    }
  }

  function repaintAll() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var W = _W || docW();
    strokes.forEach(function (s) { paintStroke(ctx, s, _K, 0, 0, W); });
    if (drawing) paintStroke(ctx, finishStroke(drawing), _K, 0, 0, W);
  }

  // วาดสดเฉพาะช่วงใหม่ของเส้นที่กำลังลาก (ลื่น ไม่ต้องล้างทั้ง canvas)
  function drawLive() {
    var s = drawing; if (!s) return;
    var pts = s.pts, n = pts.length, K = _K;
    var X = function (i) { return pts[i][0] * K; }, Y = function (i) { return pts[i][1] * K; };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (n === 1) {
      ctx.fillStyle = s.color;
      if (s.tool === 'hl') { ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.arc(X(0), Y(0), 9 * K, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
      else { ctx.beginPath(); ctx.arc(X(0), Y(0), Math.max(1.2, 1.6 * K), 0, 7); ctx.fill(); }
      s._i = 0; s._mx = X(0); s._my = Y(0);
      return;
    }
    if (s._mx == null) { s._mx = X(0); s._my = Y(0); s._i = 0; }
    var start = Math.max(1, s._i);
    if (s.tool === 'hl') { ctx.globalAlpha = 0.4; ctx.strokeStyle = s.color; ctx.lineWidth = 18 * K; }
    else ctx.strokeStyle = s.color;
    for (var j = start; j < n; j++) {
      var nx = j < n - 1 ? (X(j) + X(j + 1)) / 2 : X(j);
      var ny = j < n - 1 ? (Y(j) + Y(j + 1)) / 2 : Y(j);
      if (s.tool !== 'hl') {
        var p = Math.max(0.15, (pts[j - 1][2] + pts[j][2]) / 2 || 0.5);
        ctx.lineWidth = Math.max(1, 2.6 * (0.4 + p * 1.2)) * K;
      }
      ctx.beginPath();
      ctx.moveTo(s._mx, s._my);
      ctx.quadraticCurveTo(X(j), Y(j), nx, ny);
      ctx.stroke();
      s._mx = nx; s._my = ny;
    }
    if (s.tool === 'hl') ctx.globalAlpha = 1;
    s._i = n - 1;
  }

  /* ---------- input — ฟังที่ document, canvas ไม่บังหน้า ---------- */
  function accepts(e) {
    if (!tool) return false;
    if (e.pointerType === 'touch' && palmMode === 'pen') return false;  // นิ้ว = เลื่อน/กดหน้า
    return true;
  }
  var suppressClickUntil = 0;
  function armClickSuppress() { suppressClickUntil = performance.now() + 350; }
  document.addEventListener('click', function (e) {
    if (performance.now() < suppressClickUntil && !e.target.closest('#inkToolbar')) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('pointerdown', function (e) {
    if (!tool) return;
    if (e.target && e.target.closest && e.target.closest('#inkToolbar,#inkBusy')) return;  // ปุ่มเครื่องมือทำงานปกติ
    if (!accepts(e)) return;
    // ฝ่ามือแตะค้างอยู่ แล้ว Pencil ตามมา → ทิ้งเส้นฝ่ามือ ใช้ Pencil แทน
    if (drawing && activeType === 'touch' && e.pointerType === 'pen') { drawing = null; repaintAll(); }
    else if (drawing) return;                                  // นิ้วอีกนิ้วระหว่างเขียน — ไม่สน
    if (e.pointerType === 'pen' && palmMode !== 'pen') setPalm('pen');  // พบ Pencil → กันฝ่ามือ (เซสชัน)
    activeId = e.pointerId; activeType = e.pointerType;
    try { document.documentElement.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();                                        // กัน select/callout ระหว่างเขียน
    if (tool === 'eraser') { eraseAt(e.pageX, e.pageY); return; }
    drawing = { tool: tool, color: tool === 'hl' ? HL_COLOR : penColor, bw: docW(), pts: [[e.pageX, e.pageY, e.pressure || 0.5]] };
    drawLive();
  }, true);

  document.addEventListener('pointermove', function (e) {
    if (!tool || e.pointerId !== activeId) return;
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    if (tool === 'eraser') { if (e.buttons) evs.forEach(function (ev) { eraseAt(ev.pageX, ev.pageY); }); return; }
    if (!drawing) return;
    evs.forEach(function (ev) { drawing.pts.push([ev.pageX, ev.pageY, ev.pressure || 0.5]); });
    e.preventDefault();
    drawLive();
  }, true);

  function endStroke(e) {
    if (e && e.pointerId !== activeId) return;
    try { document.documentElement.releasePointerCapture(activeId); } catch (_) {}
    activeId = null; activeType = null;
    if (!drawing) return;
    strokes.push(finishStroke(drawing));                       // เก็บทุกเส้น แม้จุดเดียว
    undoStack.push({ type: 'add' });
    persist();
    if (drawing.pts.length > 2) armClickSuppress();            // กันเส้นยาวที่โดนลิงก์แล้วเด้ง
    drawing = null;
    repaintAll();                                              // เก็บกวาดให้เนียน (โดยเฉพาะไฮไลต์)
  }
  document.addEventListener('pointerup', endStroke, true);
  document.addEventListener('pointercancel', function (e) {
    if (e.pointerId === activeId) {
      // เส้นที่เขียนไปแล้วยังเก็บไว้ (ไม่ให้ "เขียนไม่ติด")
      if (drawing) { strokes.push(finishStroke(drawing)); undoStack.push({ type: 'add' }); persist(); drawing = null; }
      activeId = null; activeType = null; repaintAll();
    }
  }, true);

  // กันหน้าจอเลื่อนเฉพาะตอน "กำลังเขียน" (นิ้ว/Pencil ที่รับเป็นเส้นอยู่)
  document.addEventListener('touchmove', function (e) {
    if (tool && drawing) e.preventDefault();
  }, { passive: false, capture: true });

  function eraseAt(x, y) {
    var w = _W || docW();
    for (var i = strokes.length - 1; i >= 0; i--) {
      var s = strokes[i], g = w / s.bw;
      if (x < s.bb[0] * g || x > s.bb[2] * g || y < s.bb[1] * g || y > s.bb[3] * g) continue;
      for (var j = 0; j < s.pts.length; j++) {
        var dx = s.pts[j][0] * g - x, dy = s.pts[j][1] * g - y;
        if (dx * dx + dy * dy < 22 * 22) {
          undoStack.push({ type: 'del', stroke: s, index: i });
          strokes.splice(i, 1);
          persist(); repaintAll();
          return;
        }
      }
    }
  }
  function undo() {
    var op = undoStack.pop();
    if (!op) return;
    if (op.type === 'add') strokes.pop();
    else strokes.splice(op.index, 0, op.stroke);
    persist(); repaintAll();
  }
  function clearAll() {
    strokes = []; undoStack = []; drawing = null;
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    repaintAll();
  }

  /* ---------- save as image ---------- */
  function loadH2C() {
    return new Promise(function (res, rej) {
      if (window.html2canvas) return res(window.html2canvas);
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = function () { res(window.html2canvas); };
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function download(cv, tag) {
    var base = decodeURIComponent(location.pathname.split('/').pop() || 'page').replace(/\.html?$/i, '');
    var d = new Date(), z = function (n) { return String(n).padStart(2, '0'); };
    var name = base + '-notes-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + (tag ? '-' + tag : '') + '.png';
    cv.toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }, 'image/png');
  }
  function shotScale(w, h) {                                   // จำกัดพื้นที่พิกเซล กัน canvas iOS ว่างเปล่า
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    return Math.max(0.5, Math.min(dpr, Math.sqrt(MAX_SHOT_AREA / (w * h))));
  }
  function inkOnlyCanvas(y0, h, scl) {
    var w = docW(), cv = document.createElement('canvas');
    cv.width = Math.round(w * scl); cv.height = Math.round(h * scl);
    var c2 = cv.getContext('2d');
    c2.fillStyle = '#fff'; c2.fillRect(0, 0, cv.width, cv.height);
    strokes.forEach(function (s) { paintStroke(c2, s, scl, 0, y0, w); });
    return cv;
  }
  function saveImage(mode) {                                   // 'view' | 'full'
    var y0 = mode === 'view' ? (window.scrollY || 0) : 0;
    var h = mode === 'view' ? (window.innerHeight || 0) : Math.min(contentH(), MAX_DOC_H);
    if (mode === 'full' && contentH() > MAX_DOC_H) toast('เอกสารยาวมาก — จับภาพช่วง ' + MAX_DOC_H + 'px แรก');
    var scl = shotScale(docW(), h);
    setBusy(true);
    loadH2C().then(function (h2c) {
      return h2c(document.body, {
        backgroundColor: '#ffffff',
        y: y0, height: h,
        width: docW(), windowWidth: document.documentElement.clientWidth,
        scale: scl, useCORS: true, logging: false,
        ignoreElements: function (el) { return el.id === 'inkToolbar' || el.id === 'inkToolCanvas' || el.id === 'inkBusy'; }
      });
    }).then(function (shot) {
      var kk = shot.width / docW();
      var c2 = shot.getContext('2d');
      strokes.forEach(function (s) { paintStroke(c2, s, kk, 0, y0, docW()); });
      download(shot, mode === 'view' ? 'screen' : 'full');
    }).catch(function () {
      download(inkOnlyCanvas(y0, h, scl), 'ink-only');
      toast('จับภาพเนื้อหาไม่ได้ (อาจออฟไลน์) — บันทึกเฉพาะลายเส้นแทน');
    }).finally(function () { setBusy(false); });
  }

  /* ---------- print: ทุกแท็บ/ทุกส่วน · พอดี A4 (เอาเข้าห้องสอบได้) ---------- */
  var printCss = document.createElement('style');
  printCss.id = 'inkPrintCss';
  printCss.textContent =
    '@page{size:A4;margin:11mm}' +
    '@media print{' +
      'html,body{background:#fff !important}' +
      '#inkToolbar,#inkBusy,#inkToolCanvas{display:none !important}' +
      '*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}' +
      // กางทุกแท็บให้เห็นพร้อมกัน (ตอนกด 🖨️ จะ mount แท็บครบก่อน)
      'body.ink-print-all .ant-tabs-nav{display:none !important}' +
      'body.ink-print-all .ant-tabs-content,body.ink-print-all .ant-tabs-content-holder{display:block !important;height:auto !important;overflow:visible !important;transform:none !important}' +
      'body.ink-print-all .ant-tabs-tabpane,body.ink-print-all .ant-tabs-tabpane-hidden{display:block !important;visibility:visible !important;opacity:1 !important;height:auto !important;overflow:visible !important}' +
      'body.ink-print-all .ant-tabs-tabpane[data-ink-label]::before{content:attr(data-ink-label);display:block;font-weight:700;font-size:13pt;margin:16px 0 8px;padding:6px 10px;background:#efe9df;border-left:5px solid #A8906C;border-radius:3px;break-after:avoid;break-before:auto}' +
      // กาง Collapse/accordion ที่กางไว้
      'body.ink-print-all .ant-collapse-content,body.ink-print-all .ant-collapse-content-hidden{display:block !important;height:auto !important;overflow:visible !important}' +
      'body.ink-print-all .ant-collapse-item{break-inside:avoid}' +
      // ให้พอดีความกว้าง A4 + กันตัดกลางบล็อก
      '#root,.ant-layout,.ant-layout-content,.ant-tabs,main,section,.container{width:auto !important;max-width:100% !important}' +
      'img{max-width:100% !important;height:auto !important}' +
      'table{width:100% !important;font-size:10pt}' +
      '.ant-card,.chcard,table,tr,img,.ant-alert,.ant-statistic,.flashcard,.ant-collapse-item,li{break-inside:avoid;page-break-inside:avoid}' +
      'h1,h2,h3,h4{break-after:avoid}' +
    '}';
  document.head.appendChild(printCss);

  function expandAllCollapse() {
    document.querySelectorAll('.ant-collapse-header').forEach(function (h) {
      if (h.getAttribute('aria-expanded') === 'false') { try { h.click(); } catch (_) {} }
    });
  }
  function labelPanes() {                                       // ใส่หัวข้อชื่อแท็บก่อนแต่ละส่วน
    document.querySelectorAll('.ant-tabs-tab').forEach(function (t) {
      var btn = t.querySelector('.ant-tabs-tab-btn') || t;
      var paneId = btn.getAttribute('aria-controls') || t.getAttribute('aria-controls');
      var label = (btn.textContent || '').trim();
      if (paneId) { var p = document.getElementById(paneId); if (p && label) p.setAttribute('data-ink-label', label); }
    });
  }
  function visitAllTabs(done) {                                 // คลิกวนทุกแท็บให้ React mount pane (รวมแท็บซ้อน)
    var rounds = 0;
    (function pass() {
      var fresh = Array.prototype.slice.call(document.querySelectorAll('.ant-tabs-tab'))
        .filter(function (t) { return !t.__inkVisited; });
      if (!fresh.length || rounds > 4) return done();
      rounds++;
      var i = 0;
      (function next() {
        if (i >= fresh.length) { setTimeout(pass, 70); return; }  // สแกนซ้ำเผื่อแท็บซ้อนที่เพิ่งโผล่
        var t = fresh[i++]; t.__inkVisited = 1;
        try { t.click(); } catch (_) {}
        setTimeout(next, 45);
      })();
    })();
  }
  function printAll() {
    if (tool) closeBar();
    var actives = Array.prototype.slice.call(document.querySelectorAll('.ant-tabs')).map(function (g) {
      return g.querySelector(':scope > .ant-tabs-nav .ant-tabs-tab-active');
    });
    expandAllCollapse();
    visitAllTabs(function () {
      expandAllCollapse();                                      // เผื่อ Collapse ในแท็บที่เพิ่ง mount
      labelPanes();
      setTimeout(function () {
        document.body.classList.add('ink-print-all');
        var restored = false;
        function restore() {
          if (restored) return; restored = true;
          window.removeEventListener('afterprint', restore);
          document.body.classList.remove('ink-print-all');
          actives.forEach(function (a) { if (a && document.contains(a)) { try { a.click(); } catch (_) {} } });
        }
        window.addEventListener('afterprint', restore);
        window.print();
        setTimeout(restore, 4000);                              // สำรอง เผื่อ afterprint ไม่ยิงบางเบราว์เซอร์
      }, 250);
    });
  }

  /* ---------- UI ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#inkToolCanvas{position:absolute;left:0;top:0;z-index:999990;pointer-events:none}' +
    'body[data-ink]{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
    '#inkToolbar{position:fixed;right:max(10px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);z-index:999999;' +
      'display:flex;flex-direction:column;align-items:center;gap:9px;max-height:96vh;' +
      'font-family:-apple-system,"IBM Plex Sans Thai",Sarabun,sans-serif}' +
    '#inkToolbar .ink-tray{display:none;flex-direction:column;align-items:center;gap:9px;' +
      'max-height:82vh;overflow-y:auto;overflow-x:hidden;padding:2px;scrollbar-width:none}' +
    '#inkToolbar .ink-tray::-webkit-scrollbar{display:none}' +
    '#inkToolbar.open .ink-tray{display:flex}' +
    '.ink-b{width:46px;height:46px;min-height:46px;border-radius:50%;border:1.5px solid rgba(255,255,255,.4);background:rgba(17,24,39,.94);color:#fff;' +
      'font-size:1.15rem;display:grid;place-items:center;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.5);' +
      '-webkit-tap-highlight-color:transparent;padding:0;touch-action:manipulation;transition:transform .12s ease}' +
    '.ink-b:active{transform:scale(.9)}' +
    '.ink-b.on{outline:3px solid #fbbf24;outline-offset:1px}' +
    '.ink-b.armed{background:#dc2626;border-color:#fecaca}' +
    '.ink-b .sw{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.9);display:block}' +
    '.ink-fab{width:54px;height:54px;min-height:54px;font-size:1.4rem;background:rgba(17,24,39,.97);flex:0 0 auto}' +
    '#inkToolbar.open [data-act="fab"]{background:#fbbf24;color:#1f2937;border-color:#fbbf24}' +
    '.ink-print-fab{background:#2563eb;border-color:#93c5fd}' +          // ปุ่มปริ้นถาวร สีน้ำเงิน เห็นชัด
    '.ink-print-fab:active{transform:scale(.9)}' +
    '@media (max-height:560px){.ink-b{width:40px;height:40px;min-height:40px;font-size:1rem}.ink-fab{width:46px;height:46px;min-height:46px}#inkToolbar{gap:7px}#inkToolbar .ink-tray{gap:7px}}' +
    '#inkBusy{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:999999;' +
      'background:rgba(17,24,39,.95);color:#fde68a;border-radius:999px;padding:9px 20px;font-size:.9rem;display:none}' +
    '@media print{#inkToolbar,#inkToolCanvas,#inkBusy{display:none!important}}';
  document.head.appendChild(css);

  var bar = document.createElement('div');
  bar.id = 'inkToolbar';
  var trayBtns =
    PENS.map(function (p) {
      return '<button class="ink-b" data-act="pen" data-color="' + p.c + '" title="ปากกาสี' + p.name + '" aria-label="ปากกาสี' + p.name + '"><span class="sw" style="background:' + p.c + '"></span></button>';
    }).join('') +
    '<button class="ink-b" data-act="hl" title="ปากกาไฮไลต์" aria-label="ปากกาไฮไลต์">🖍️</button>' +
    '<button class="ink-b" data-act="eraser" title="ยางลบ (ลบทีละเส้น)" aria-label="ยางลบ">🧽</button>' +
    '<button class="ink-b" data-act="undo" title="ย้อนกลับทีละเส้น" aria-label="ย้อนกลับ">↩️</button>' +
    '<button class="ink-b" data-act="clear" title="ล้างทั้งหน้า (แตะซ้ำเพื่อยืนยัน)" aria-label="ล้างทั้งหน้า">🗑️</button>' +
    '<button class="ink-b" data-act="palm" title="โหมดกันฝ่ามือ: Pencil เขียน / นิ้วเลื่อน-กดหน้าได้" aria-label="โหมดกันฝ่ามือ">✋</button>' +
    '<button class="ink-b" data-act="save-view" title="บันทึกภาพเฉพาะที่เห็นบนจอ" aria-label="บันทึกภาพหน้าจอ">📸</button>' +
    '<button class="ink-b" data-act="save-full" title="บันทึกภาพทั้งเอกสาร" aria-label="บันทึกภาพทั้งเอกสาร">📰</button>';
  // ปุ่มปริ้นเป็นปุ่มลอยถาวร (เห็นบนหน้าอ่านเลย ไม่ต้องเปิดปากกา) + ปุ่มปากกา
  bar.innerHTML = '<div class="ink-tray">' + trayBtns + '</div>' +
    '<button class="ink-b ink-fab ink-print-fab" data-act="print" title="ปริ้นครบทุกแท็บ · พอดี A4 (สำหรับอ่าน/เข้าห้องสอบ)" aria-label="ปริ้นหน้านี้ พอดี A4">🖨️</button>' +
    '<button class="ink-b ink-fab" data-act="fab" title="ปากกาเขียนหน้า (เปิด/หุบ)" aria-label="เปิดหรือหุบเครื่องมือปากกา">✎</button>';
  document.body.appendChild(bar);
  document.body.appendChild(canvas);

  var busy = document.createElement('div');
  busy.id = 'inkBusy';
  document.body.appendChild(busy);
  var busyTimer = null;
  function toast(msg) {
    busy.textContent = msg; busy.style.display = 'block';
    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () { busy.style.display = 'none'; }, 3500);
  }
  function setBusy(on) {
    clearTimeout(busyTimer);
    busy.textContent = '📸 กำลังสร้างภาพ…';
    busy.style.display = on ? 'block' : 'none';
  }

  var clearArmTimer = null;
  function refreshUI() {
    bar.querySelectorAll('.ink-b').forEach(function (b) {
      var act = b.dataset.act;
      if (act === 'pen') b.classList.toggle('on', tool === 'pen' && penColor === b.dataset.color);
      else if (act === 'hl' || act === 'eraser') b.classList.toggle('on', tool === act);
      else if (act === 'palm') { b.textContent = palmMode === 'pen' ? '✍️' : '✋'; b.classList.toggle('on', palmMode === 'pen'); }
    });
    if (tool) document.body.setAttribute('data-ink', '1'); else document.body.removeAttribute('data-ink');
  }
  function setPalm(m) { palmMode = m; refreshUI(); }          // เซสชันเท่านั้น — ไม่บันทึกลง localStorage
  function openBar() { bar.classList.add('open'); if (!tool) tool = 'pen'; refreshUI(); }
  function closeBar() {
    bar.classList.remove('open'); tool = null; drawing = null; activeId = null;
    disarmClear(); refreshUI(); repaintAll();
  }
  function disarmClear() {
    clearTimeout(clearArmTimer);
    var b = bar.querySelector('[data-act="clear"]');
    if (b) { b.classList.remove('armed'); b.textContent = '🗑️'; }
  }

  bar.addEventListener('click', function (e) {
    var b = e.target.closest('.ink-b'); if (!b) return;
    var act = b.dataset.act;
    if (act !== 'clear') disarmClear();
    if (act === 'fab') { bar.classList.contains('open') ? closeBar() : openBar(); return; }
    if (act === 'pen') {
      tool = 'pen'; penColor = b.dataset.color;
      try { localStorage.setItem('ink:color', penColor); } catch (_) {}
    }
    else if (act === 'hl' || act === 'eraser') tool = act;
    else if (act === 'undo') undo();
    else if (act === 'palm') setPalm(palmMode === 'pen' ? 'any' : 'pen');
    else if (act === 'save-view') saveImage('view');
    else if (act === 'save-full') saveImage('full');
    else if (act === 'print') { printAll(); return; }
    else if (act === 'clear') {                                 // แตะยืนยัน 2 ครั้ง — ไม่บล็อกจอ
      if (b.classList.contains('armed')) { clearAll(); disarmClear(); }
      else {
        b.classList.add('armed'); b.textContent = '❗';
        clearArmTimer = setTimeout(disarmClear, 2600);
      }
    }
    refreshUI();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && bar.classList.contains('open')) closeBar();
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && tool) { e.preventDefault(); undo(); }
  });

  /* ---------- lifecycle ---------- */
  addEventListener('resize', scheduleSize);
  if (window.visualViewport) visualViewport.addEventListener('resize', scheduleSize);
  if (window.ResizeObserver) new ResizeObserver(scheduleSize).observe(document.body);
  window.addEventListener('load', scheduleSize);
  restore();
  sizeCanvas();
  refreshUI();

  // debug hook สำหรับทดสอบอัตโนมัติ
  window.__inkDebug = {
    strokes: function () { return strokes.length; },
    tool: function () { return tool; },
    palm: function () { return palmMode; },
    drawing: function () { return !!drawing; },
    shotScale: shotScale,
    open: openBar,
    close: closeBar,
    printAll: printAll,
    setTool: function (t) { if (!bar.classList.contains('open')) openBar(); tool = t; refreshUI(); },
    setPalm: setPalm,
    clearAll: clearAll,
    lastBBox: function () { return strokes.length ? strokes[strokes.length - 1].bb.slice() : null; },
    canvasInfo: function () { return { w: canvas.width, h: canvas.height, cssW: canvas.style.width, cssH: canvas.style.height, pos: getComputedStyle(canvas).position, K: _K, W: _W }; },
    contentH: contentH,
    saveImage: saveImage,
    composeInkCanvas: function (mode) {                         // เส้นวางลงภาพ (ไม่ดาวน์โหลด) — ใช้ทดสอบ path บันทึกภาพ
      var y0 = mode === 'view' ? (window.scrollY || 0) : 0;
      var h = mode === 'view' ? (window.innerHeight || 0) : Math.min(contentH(), MAX_DOC_H);
      return inkOnlyCanvas(y0, h, shotScale(docW(), h));
    },
    pixelAt: function (bx, by) { try { var d = ctx.getImageData(bx, by, 1, 1).data; return [d[0], d[1], d[2], d[3]]; } catch (e) { return null; } },
    hasInkNear: function (docX, docY, rad) {                    // มีหมึกใกล้พิกัดเอกสาร (px) ไหม
      var K = _K, cx = Math.round(docX * K), cy = Math.round(docY * K), r = Math.round((rad || 12) * K);
      try {
        var img = ctx.getImageData(Math.max(0, cx - r), Math.max(0, cy - r), r * 2, r * 2).data;
        for (var i = 3; i < img.length; i += 4) if (img[i] > 0) return true;
      } catch (e) {}
      return false;
    }
  };
})();
