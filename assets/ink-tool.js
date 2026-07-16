/* ============================================================
   Ink Tool v2 — ปากกา Apple Pencil / เมาส์ สำหรับหน้าติวหนังสือ
   ใช้ร่วมกันทุกหน้าใน books/law-legal และ books/utcc
   สเปก: docs/superpowers/specs/2026-07-13-ink-tool-design.md
   ============================================================
   v2 (แก้อาการใช้งานขัดบน iPad):
   - canvas โปร่งต่อ pointer เสมอ → นิ้วยังกดการ์ด/แท็บ/ลิงก์ในหน้าได้ระหว่างจด
   - ฟัง pointer ระดับ document · กันสกอลล์เฉพาะ Apple Pencil (touchType 'stylus')
   - กันฝ่ามือ: ฝ่ามือแตะก่อนแล้ว Pencil ตามมา → ทิ้งเส้นฝ่ามือ เขียนต่อด้วย Pencil
   - รองรับ pinch-zoom ผ่าน visualViewport + พิกัด pageX/pageY
   - เส้นโค้งลื่น (midpoint quadratic smoothing) + หนาบางตามแรงกด
   - ปุ่มย้ายมากึ่งกลางขวา (ไม่ชนแถบ Safari/antd FloatButton) + safe-area
   - ล้างหน้าแบบแตะยืนยัน 2 ครั้ง (ไม่ใช้ dialog บล็อกจอ)
   - จับภาพจำกัดพื้นที่พิกเซลตามลิมิต canvas ของ iOS
*/
(function () {
  'use strict';
  if (window.__inkToolLoaded) return;
  window.__inkToolLoaded = true;

  var LS_KEY = 'ink:' + location.pathname;
  var MAX_DOC_H = 16000;
  var MAX_SHOT_AREA = 14e6;          // เพดานพิกเซลภาพจับหน้าจอ (กัน iOS canvas ว่างเปล่า)
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
  var palmMode = localStorage.getItem('ink:palm') || 'any';   // 'pen' = Pencil เท่านั้น
  var drawing = null;                // stroke ระหว่างเขียน
  var activeId = null, activeType = null;
  var saveTimer = null;

  var docW = function () { return document.documentElement.scrollWidth || innerWidth; };
  var docH = function () { return document.documentElement.scrollHeight || innerHeight; };

  /* ---------- persistence (รูปแบบเดิม v1 — โน้ตเก่าอ่านต่อได้) ---------- */
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
        strokes.push(finishStroke({ tool: s.t, color: s.c, bw: s.w, pts: s.p }));
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

  /* ---------- viewport (รองรับ pinch-zoom) ---------- */
  function vp() {
    var v = window.visualViewport;
    if (v) return { x0: v.pageLeft, y0: v.pageTop, w: v.width, h: v.height, ox: v.offsetLeft, oy: v.offsetTop, z: v.scale };
    return { x0: scrollX, y0: scrollY, w: innerWidth, h: innerHeight, ox: 0, oy: 0, z: 1 };
  }

  /* ---------- canvas (โปร่งต่อ pointer เสมอ — วาดอย่างเดียว) ---------- */
  var canvas = document.createElement('canvas');
  canvas.id = 'inkToolCanvas';
  var ctx = canvas.getContext('2d');
  function sizeCanvas() {
    var v = vp();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var K = Math.min(dpr * v.z, 3);                     // ความคมภายใต้การซูม (มีเพดาน)
    canvas.style.left = v.ox + 'px';
    canvas.style.top = v.oy + 'px';
    canvas.style.width = v.w + 'px';
    canvas.style.height = v.h + 'px';
    canvas.width = Math.max(1, Math.round(v.w * K));
    canvas.height = Math.max(1, Math.round(v.h * K));
    repaint();
  }

  // วาดหนึ่งเส้นแบบโค้งลื่น: kk = พิกเซลปลายทางต่อ 1 CSS px เอกสาร, (x0,y0) = จุดอ้างอิงเอกสาร
  function paintStroke(c2, s, kk, x0, y0, curDocW) {
    var g = (curDocW || docW()) / s.bw;
    var pts = s.pts;
    if (pts.length < 2) return;
    var X = function (i) { return (pts[i][0] * g - x0) * kk; };
    var Y = function (i) { return (pts[i][1] * g - y0) * kk; };
    c2.lineCap = 'round'; c2.lineJoin = 'round';
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
      // วาดเป็นช่วงโค้งสั้น ๆ ปรับความหนาตามแรงกดของแต่ละช่วง
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

  var rafPending = false;
  function repaint() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var v = vp(), kk = canvas.width / v.w, w = docW();
      var vy1 = v.y0 - 40, vy2 = v.y0 + v.h + 40;
      strokes.forEach(function (s) {
        var g = w / s.bw;
        if (s.bb[1] * g > vy2 || s.bb[3] * g < vy1) return;
        paintStroke(ctx, s, kk, v.x0, v.y0, w);
      });
      if (drawing) paintStroke(ctx, finishStroke(drawing), kk, v.x0, v.y0, w);
    });
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
    if (e.target && e.target.closest && e.target.closest('#inkToolbar,#inkBusy')) return;   // ปุ่มเครื่องมือทำงานปกติ
    if (!accepts(e)) return;
    // ฝ่ามือแตะค้างอยู่ แล้ว Pencil ตามมา → ทิ้งเส้นฝ่ามือ ใช้ Pencil แทน
    if (drawing && activeType === 'touch' && e.pointerType === 'pen') { drawing = null; }
    else if (drawing) return;                                  // นิ้วอีกนิ้วระหว่างเขียน — ไม่สน
    if (e.pointerType === 'pen' && palmMode !== 'pen') setPalm('pen');   // พบ Pencil → เปิดกันฝ่ามือถาวร
    activeId = e.pointerId; activeType = e.pointerType;
    e.preventDefault();                                        // กัน select/callout ระหว่างเขียน
    if (tool === 'eraser') { eraseAt(e.pageX, e.pageY); return; }
    drawing = { tool: tool, color: tool === 'hl' ? HL_COLOR : penColor, bw: docW(), pts: [[e.pageX, e.pageY, e.pressure || 0.5]] };
    repaint();
  }, true);

  document.addEventListener('pointermove', function (e) {
    if (!tool || e.pointerId !== activeId) return;
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    if (tool === 'eraser') { if (e.buttons) evs.forEach(function (ev) { eraseAt(ev.pageX, ev.pageY); }); return; }
    if (!drawing) return;
    evs.forEach(function (ev) { drawing.pts.push([ev.pageX, ev.pageY, ev.pressure || 0.5]); });
    e.preventDefault();
    repaint();
  }, true);

  function endStroke(e) {
    if (e && e.pointerId !== activeId) return;
    activeId = null; activeType = null;
    if (!drawing) return;
    if (drawing.pts.length > 2) {
      strokes.push(finishStroke(drawing));
      undoStack.push({ type: 'add' });
      persist();
      armClickSuppress();                                      // กันเส้นที่ลากไปโดนลิงก์แล้วเด้ง
    }
    drawing = null;
    repaint();
  }
  document.addEventListener('pointerup', endStroke, true);
  document.addEventListener('pointercancel', function (e) { if (e.pointerId === activeId) { drawing = null; activeId = null; repaint(); } }, true);

  // กันหน้าจอเลื่อนเฉพาะตอน "กำลังเขียน": Pencil เสมอ · นิ้วเฉพาะโหมด ✋
  document.addEventListener('touchmove', function (e) {
    if (!tool) return;
    var stylus = false, i;
    for (i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].touchType === 'stylus') stylus = true;
    if (stylus || palmMode === 'any') e.preventDefault();
  }, { passive: false, capture: true });

  function eraseAt(x, y) {
    var w = docW();
    for (var i = strokes.length - 1; i >= 0; i--) {
      var s = strokes[i], g = w / s.bw;
      if (x < s.bb[0] * g || x > s.bb[2] * g || y < s.bb[1] * g || y > s.bb[3] * g) continue;
      for (var j = 0; j < s.pts.length; j++) {
        var dx = s.pts[j][0] * g - x, dy = s.pts[j][1] * g - y;
        if (dx * dx + dy * dy < 20 * 20) {
          undoStack.push({ type: 'del', stroke: s, index: i });
          strokes.splice(i, 1);
          persist(); repaint();
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
    persist(); repaint();
  }
  function clearAll() {
    strokes = []; undoStack = [];
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    repaint();
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
    var v = vp();
    var y0 = mode === 'view' ? v.y0 : 0;
    var h = mode === 'view' ? v.h : Math.min(docH(), MAX_DOC_H);
    if (mode === 'full' && docH() > MAX_DOC_H) toast('เอกสารยาวมาก — จับภาพช่วง ' + MAX_DOC_H + 'px แรก');
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

  /* ---------- UI ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#inkToolCanvas{position:fixed;left:0;top:0;z-index:999990;pointer-events:none}' +
    'body[data-ink]{cursor:crosshair;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
    '#inkToolbar{position:fixed;right:max(10px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);z-index:999999;' +
      'display:flex;flex-direction:column;align-items:center;gap:9px;font-family:-apple-system,"IBM Plex Sans Thai",Sarabun,sans-serif}' +
    '#inkToolbar .ink-tray{display:none;flex-direction:column;align-items:center;gap:9px}' +
    '#inkToolbar.open .ink-tray{display:flex}' +
    '.ink-b{width:46px;height:46px;border-radius:50%;border:1.5px solid rgba(255,255,255,.4);background:rgba(17,24,39,.94);color:#fff;' +
      'font-size:1.15rem;display:grid;place-items:center;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.5);' +
      '-webkit-tap-highlight-color:transparent;padding:0;touch-action:manipulation;transition:transform .12s ease}' +
    '.ink-b:active{transform:scale(.9)}' +
    '.ink-b.on{outline:3px solid #fbbf24;outline-offset:1px}' +
    '.ink-b.armed{background:#dc2626;border-color:#fecaca}' +
    '.ink-b .sw{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.9);display:block}' +
    '.ink-fab{width:54px;height:54px;font-size:1.4rem;background:rgba(17,24,39,.97)}' +
    '#inkToolbar.open .ink-fab{background:#fbbf24;color:#1f2937;border-color:#fbbf24}' +
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
  bar.innerHTML = '<div class="ink-tray">' + trayBtns + '</div><button class="ink-b ink-fab" data-act="fab" title="ปากกาเขียนหน้า (เปิด/หุบ)" aria-label="เปิดหรือหุบเครื่องมือปากกา">✎</button>';
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
  function setPalm(m) {
    palmMode = m;
    try { localStorage.setItem('ink:palm', m); } catch (_) {}
    refreshUI();
  }
  function openBar() { bar.classList.add('open'); if (!tool) tool = 'pen'; refreshUI(); }
  function closeBar() {
    bar.classList.remove('open'); tool = null; drawing = null; activeId = null;
    disarmClear(); refreshUI(); repaint();
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
  addEventListener('scroll', repaint, { passive: true });
  addEventListener('resize', sizeCanvas);
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', sizeCanvas);
    visualViewport.addEventListener('scroll', sizeCanvas);
  }
  if (window.ResizeObserver) new ResizeObserver(repaint).observe(document.body);
  restore();
  sizeCanvas();
  refreshUI();

  // debug hook สำหรับทดสอบอัตโนมัติ
  window.__inkDebug = {
    strokes: function () { return strokes.length; },
    tool: function () { return tool; },
    palm: function () { return palmMode; },
    drawing: function () { return !!drawing; },
    shotScale: shotScale
  };
})();
