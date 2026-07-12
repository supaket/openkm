/* ============================================================
   Ink Tool — ปากกา Apple Pencil / เมาส์ สำหรับหน้าติวหนังสือ
   ใช้ร่วมกันทุกหน้าใน books/law-legal และ books/utcc
   สเปก: docs/superpowers/specs/2026-07-13-ink-tool-design.md
   ============================================================
   - เส้นเก็บเป็น vector (จุด+แรงกด) อิงพิกัดเอกสาร → เลื่อนหน้าแล้วเส้นติดเนื้อหา
   - canvas ขนาดวิวพอร์ต วาดใหม่ตาม scroll (ประหยัดแรมบนหน้ายาว)
   - จำเส้นลง localStorage ต่อหน้า · Undo ทีละเส้น · ยางลบลบทีละเส้น
   - โหมดกันฝ่ามือ: Pencil เขียน / นิ้วเลื่อนหน้า
   - บันทึกภาพ PNG: เฉพาะที่เห็น หรือทั้งเอกสาร (html2canvas โหลดเมื่อใช้)
*/
(function () {
  'use strict';
  if (window.__inkToolLoaded) return;
  window.__inkToolLoaded = true;

  var LS_KEY = 'ink:' + location.pathname;
  var MAX_DOC_H = 16000;            // เพดานความสูงที่จับภาพ "ทั้งเอกสาร"
  var HL_COLOR = '#ffe066';
  var PENS = [
    { c: '#c9a227', name: 'ทอง' },
    { c: '#e0433f', name: 'แดง' },
    { c: '#2563eb', name: 'น้ำเงิน' }
  ];

  /* ---------- state ---------- */
  var strokes = [];                 // {tool:'pen'|'hl', color, bw(docWidth ตอนวาด), pts:[[x,y,p],...], bb:[x1,y1,x2,y2]}
  var undoStack = [];               // {type:'add'} | {type:'del', stroke, index}
  var tool = null;                  // 'pen' | 'hl' | 'eraser' | null(ปิด)
  var penColor = PENS[0].c;
  var palmMode = 'any';             // 'pen' = รับเฉพาะ Apple Pencil, 'any' = นิ้ว/เมาส์เขียนได้
  var drawing = null;               // stroke ที่กำลังเขียน
  var saveTimer = null;

  var docW = function () { return document.documentElement.scrollWidth || innerWidth; };
  var docH = function () { return document.documentElement.scrollHeight || innerHeight; };

  /* ---------- persistence ---------- */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var slim = strokes.map(function (s) {
          return { t: s.tool, c: s.color, w: s.bw, p: s.pts.map(function (q) { return [Math.round(q[0]), Math.round(q[1]), Math.round(q[2] * 100) / 100]; }) };
        });
        localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, s: slim }));
      } catch (e) {
        if (!persist.warned) { persist.warned = true; alert('พื้นที่บันทึกเส้นเต็ม — เส้นใหม่จะไม่ถูกจำ (ลองล้างเส้นหน้าเก่า ๆ)'); }
      }
    }, 400);
  }
  function restore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      (d.s || []).forEach(function (s) {
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

  /* ---------- canvas (วิวพอร์ต + แปลงพิกัดตาม scroll) ---------- */
  var canvas = document.createElement('canvas');
  canvas.id = 'inkToolCanvas';
  var ctx = canvas.getContext('2d');
  var dpr = 1;
  function sizeCanvas() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    repaint();
  }

  // วาด stroke หนึ่งเส้นลง context ใด ๆ ด้วย scale k และ offset (ox,oy) หน่วยปลายทาง
  function paintStroke(c2, s, k, ox, oy) {
    var scale = k * (docW() / s.bw);           // ชดเชยความกว้างเอกสารตอนวาด vs ตอนนี้
    var pts = s.pts;
    if (pts.length < 2) return;
    if (s.tool === 'hl') {
      c2.globalAlpha = 0.4;
      c2.strokeStyle = s.color;
      c2.lineWidth = 18 * scale;
      c2.lineCap = 'round'; c2.lineJoin = 'round';
      c2.beginPath();
      c2.moveTo(pts[0][0] * scale + ox, pts[0][1] * scale + oy);
      for (var i = 1; i < pts.length; i++) c2.lineTo(pts[i][0] * scale + ox, pts[i][1] * scale + oy);
      c2.stroke();
      c2.globalAlpha = 1;
    } else {
      c2.strokeStyle = s.color;
      c2.lineCap = 'round'; c2.lineJoin = 'round';
      for (var j = 1; j < pts.length; j++) {
        var p = (pts[j - 1][2] + pts[j][2]) / 2 || 0.5;
        c2.lineWidth = Math.max(1, 2.6 * (0.4 + p * 1.2)) * scale;
        c2.beginPath();
        c2.moveTo(pts[j - 1][0] * scale + ox, pts[j - 1][1] * scale + oy);
        c2.lineTo(pts[j][0] * scale + ox, pts[j][1] * scale + oy);
        c2.stroke();
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
      var k = dpr, sy = window.scrollY, sx = window.scrollX;
      var vy1 = sy - 40, vy2 = sy + innerHeight + 40;
      strokes.forEach(function (s) {
        var g = docW() / s.bw;                 // สัดส่วนพิกัดเอกสารปัจจุบัน
        if (s.bb[1] * g > vy2 || s.bb[3] * g < vy1) return;   // นอกจอ — ข้าม
        paintStroke(ctx, s, k, -sx * k, -sy * k);
      });
      if (drawing) paintStroke(ctx, finishStroke(drawing), k, -window.scrollX * k, -window.scrollY * k);
    });
  }

  /* ---------- input (Pointer Events: pen / mouse / touch) ---------- */
  function docPoint(e) {
    var w = docW();
    return [(e.clientX + window.scrollX), (e.clientY + window.scrollY), e.pressure || 0.5, w];
  }
  function accepts(e) {
    if (!tool) return false;
    if (palmMode === 'pen' && e.pointerType === 'touch') return false; // นิ้ว = เลื่อนหน้า
    return true;
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (!accepts(e)) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    if (e.pointerType === 'pen' && palmMode !== 'pen') setPalm('pen'); // เจอ Pencil → เปิดกันฝ่ามืออัตโนมัติ
    var q = docPoint(e);
    if (tool === 'eraser') { eraseAt(q[0], q[1]); return; }
    drawing = { tool: tool, color: tool === 'hl' ? HL_COLOR : penColor, bw: q[3], pts: [[q[0], q[1], q[2]]] };
    repaint();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!accepts(e)) return;
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    if (tool === 'eraser') { if (e.buttons) evs.forEach(function (ev) { var q = docPoint(ev); eraseAt(q[0], q[1]); }); return; }
    if (!drawing) return;
    evs.forEach(function (ev) { var q = docPoint(ev); drawing.pts.push([q[0], q[1], q[2]]); });
    e.preventDefault();
    repaint();
  });
  function endStroke() {
    if (!drawing) return;
    if (drawing.pts.length > 1) {
      strokes.push(finishStroke(drawing));
      undoStack.push({ type: 'add' });
      persist();
    }
    drawing = null;
    repaint();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', function () { drawing = null; repaint(); });

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
    if (!strokes.length) return;
    if (!confirm('ล้างเส้นที่เขียนทั้งหมดในหน้านี้?')) return;
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
  function inkOnlyCanvas(y0, h) {
    var w = docW(), cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var c2 = cv.getContext('2d');
    c2.fillStyle = '#fff'; c2.fillRect(0, 0, cv.width, cv.height);
    strokes.forEach(function (s) { paintStroke(c2, s, 1, 0, -y0); });
    return cv;
  }
  function saveImage(mode) {                     // 'view' | 'full'
    var y0 = mode === 'view' ? window.scrollY : 0;
    var h = mode === 'view' ? innerHeight : Math.min(docH(), MAX_DOC_H);
    if (mode === 'full' && docH() > MAX_DOC_H) alert('เอกสารยาวมาก — จะจับภาพช่วง ' + MAX_DOC_H + 'px แรก');
    setBusy(true);
    loadH2C().then(function (h2c) {
      return h2c(document.body, {
        backgroundColor: '#ffffff',
        y: y0, height: h,
        width: docW(), windowWidth: document.documentElement.clientWidth,
        scale: Math.min(2, window.devicePixelRatio || 1),
        useCORS: true, logging: false,
        ignoreElements: function (el) { return el.id === 'inkToolbar' || el.id === 'inkToolCanvas' || el.id === 'inkBusy'; }
      });
    }).then(function (shot) {
      var k = shot.width / docW();
      var c2 = shot.getContext('2d');
      strokes.forEach(function (s) { paintStroke(c2, s, k, 0, -y0 * k); });
      download(shot, mode === 'view' ? 'screen' : 'full');
    }).catch(function () {
      // ออฟไลน์/โหลดไลบรารีไม่ได้ → ดาวน์โหลดเฉพาะลายเส้นบนพื้นขาว
      download(inkOnlyCanvas(y0, h), 'ink-only');
      alert('จับภาพเนื้อหาไม่ได้ (อาจออฟไลน์) — บันทึกเฉพาะลายเส้นแทน');
    }).finally(function () { setBusy(false); });
  }

  /* ---------- UI ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#inkToolCanvas{position:fixed;inset:0;z-index:999990;pointer-events:none}' +
    'body[data-ink] #inkToolCanvas{pointer-events:auto;cursor:crosshair}' +
    'body[data-ink][data-palm="pen"] #inkToolCanvas{touch-action:pan-x pan-y pinch-zoom}' +
    'body[data-ink][data-palm="any"] #inkToolCanvas{touch-action:none}' +
    '#inkToolbar{position:fixed;right:14px;bottom:16px;z-index:999999;display:flex;flex-direction:column;align-items:center;gap:8px;font-family:-apple-system,"IBM Plex Sans Thai",Sarabun,sans-serif}' +
    '#inkToolbar .ink-tray{display:none;flex-direction:column;align-items:center;gap:8px}' +
    '#inkToolbar.open .ink-tray{display:flex}' +
    '.ink-b{width:44px;height:44px;border-radius:50%;border:1px solid rgba(0,0,0,.25);background:#1f2937;color:#fff;font-size:1.15rem;display:grid;place-items:center;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent;padding:0}' +
    '.ink-b:active{transform:scale(.94)}' +
    '.ink-b.on{outline:3px solid #fbbf24;outline-offset:1px}' +
    '.ink-b .sw{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.85);display:block}' +
    '.ink-fab{width:52px;height:52px;font-size:1.4rem;background:#111827}' +
    '#inkToolbar.open .ink-fab{background:#fbbf24;color:#1f2937}' +
    '#inkBusy{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:999999;background:rgba(17,24,39,.95);color:#fde68a;border-radius:999px;padding:8px 18px;font-size:.9rem;display:none}' +
    '@media print{#inkToolbar,#inkToolCanvas,#inkBusy{display:none!important}}';
  document.head.appendChild(css);

  var bar = document.createElement('div');
  bar.id = 'inkToolbar';
  var trayBtns =
    PENS.map(function (p) {
      return '<button class="ink-b" data-act="pen" data-color="' + p.c + '" title="ปากกาสี' + p.name + '"><span class="sw" style="background:' + p.c + '"></span></button>';
    }).join('') +
    '<button class="ink-b" data-act="hl" title="ปากกาไฮไลต์">🖍️</button>' +
    '<button class="ink-b" data-act="eraser" title="ยางลบ (ลบทีละเส้น)">🧽</button>' +
    '<button class="ink-b" data-act="undo" title="ย้อนกลับทีละเส้น">↩️</button>' +
    '<button class="ink-b" data-act="clear" title="ล้างทั้งหน้า">🗑️</button>' +
    '<button class="ink-b" data-act="palm" title="โหมดกันฝ่ามือ: Pencil เขียน / นิ้วเลื่อนหน้า">✋</button>' +
    '<button class="ink-b" data-act="save-view" title="บันทึกภาพเฉพาะที่เห็นบนจอ">📸</button>' +
    '<button class="ink-b" data-act="save-full" title="บันทึกภาพทั้งเอกสาร">📰</button>';
  bar.innerHTML = '<div class="ink-tray">' + trayBtns + '</div><button class="ink-b ink-fab" data-act="fab" title="ปากกาเขียนหน้า (เปิด/หุบ)">✎</button>';
  document.body.appendChild(bar);
  document.body.appendChild(canvas);

  var busy = document.createElement('div');
  busy.id = 'inkBusy'; busy.textContent = '📸 กำลังสร้างภาพ…';
  document.body.appendChild(busy);
  function setBusy(on) { busy.style.display = on ? 'block' : 'none'; }

  function refreshUI() {
    bar.querySelectorAll('.ink-b').forEach(function (b) {
      var act = b.dataset.act;
      if (act === 'pen') b.classList.toggle('on', tool === 'pen' && penColor === b.dataset.color);
      else if (act === 'hl' || act === 'eraser') b.classList.toggle('on', tool === act);
      else if (act === 'palm') { b.textContent = palmMode === 'pen' ? '✍️' : '✋'; b.classList.toggle('on', palmMode === 'pen'); }
    });
    if (tool) document.body.setAttribute('data-ink', '1'); else document.body.removeAttribute('data-ink');
    document.body.setAttribute('data-palm', palmMode);
  }
  function setPalm(m) { palmMode = m; refreshUI(); }
  function openBar() { bar.classList.add('open'); if (!tool) tool = 'pen'; refreshUI(); }
  function closeBar() { bar.classList.remove('open'); tool = null; drawing = null; refreshUI(); repaint(); }

  bar.addEventListener('click', function (e) {
    var b = e.target.closest('.ink-b'); if (!b) return;
    var act = b.dataset.act;
    if (act === 'fab') { bar.classList.contains('open') ? closeBar() : openBar(); return; }
    if (act === 'pen') { tool = 'pen'; penColor = b.dataset.color; }
    else if (act === 'hl' || act === 'eraser') tool = act;
    else if (act === 'undo') undo();
    else if (act === 'clear') clearAll();
    else if (act === 'palm') setPalm(palmMode === 'pen' ? 'any' : 'pen');
    else if (act === 'save-view') saveImage('view');
    else if (act === 'save-full') saveImage('full');
    refreshUI();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && bar.classList.contains('open')) closeBar();
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && tool) { e.preventDefault(); undo(); }
  });

  /* ---------- lifecycle ---------- */
  addEventListener('scroll', repaint, { passive: true });
  addEventListener('resize', sizeCanvas);
  if (window.ResizeObserver) new ResizeObserver(repaint).observe(document.body); // หน้า React เรนเดอร์ทีหลัง/สลับแท็บ
  restore();
  sizeCanvas();
  refreshUI();
})();
