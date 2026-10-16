/* =========================================================
   globe.js — 零依赖 Canvas 2D 自转地球 + 航线弧光
   外贸主题：全球航线网络可视化
   ========================================================= */
(function () {
  const canvas = document.getElementById('globe');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, R = 0, cx = 0, cy = 0, dpr = 1;
  let rot = 0.6, tilt = -0.42;
  let parX = 0, parY = 0, parTX = 0, parTY = 0;
  let colors = { a: '#3DC0F5', b: '#7537ED', c: '#FF8A4C' };

  /* ---------- 主题色 ---------- */
  function readColors() {
    const s = getComputedStyle(document.documentElement);
    colors.a = (s.getPropertyValue('--accent') || '#3DC0F5').trim();
    colors.b = (s.getPropertyValue('--accent-2') || '#7537ED').trim();
    colors.c = (s.getPropertyValue('--accent-3') || '#FF8A4C').trim();
  }
  readColors();
  window.addEventListener('themechange', readColors);

  /* ---------- 尺寸 ---------- */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.min(W, H) * 0.36;
    cx = W / 2; cy = H / 2;
  }
  resize();
  window.addEventListener('resize', resize);

  /* ---------- 鼠标视差 ---------- */
  window.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    parTX = ((e.clientX - (r.left + r.width / 2)) / r.width) * 0.5;
    parTY = ((e.clientY - (r.top + r.height / 2)) / r.height) * 0.35;
  });

  /* ---------- 球面点阵（fibonacci） ---------- */
  const DOTS = 720;
  const dots = [];
  for (let i = 0; i < DOTS; i++) {
    const y = 1 - (i / (DOTS - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * 2.399963; // 黄金角
    dots.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }

  /* ---------- 经纬线 ---------- */
  const lats = [-0.9, -0.55, -0.2, 0.2, 0.55, 0.9];
  const lons = 12;

  /* ---------- 港口 / 贸易城市（lat, lon, 名称） ---------- */
  const CITIES = [
    [35.10, 118.35, '临沂'], [36.07, 120.38, '青岛'], [31.23, 121.47, '上海'],
    [22.54, 114.06, '深圳'], [1.29, 103.85, '新加坡'], [25.20, 55.27, '迪拜'],
    [51.92, 4.48, '鹿特丹'], [53.55, 9.99, '汉堡'], [41.01, 28.98, '伊斯坦布尔'],
    [19.08, 72.88, '孟买'], [-33.87, 151.21, '悉尼'], [35.68, 139.69, '东京'],
    [34.05, -118.24, '洛杉矶'], [-23.55, -46.63, '圣保罗'], [-26.20, 28.04, '约堡']
  ];
  const ROUTES = [
    [0, 6], [1, 7], [2, 12], [3, 4], [4, 5], [5, 6], [6, 13],
    [7, 8], [8, 9], [2, 10], [3, 11], [0, 9], [1, 12], [5, 14], [2, 6]
  ];

  function toVec(lat, lon) {
    const a = lat * Math.PI / 180, b = lon * Math.PI / 180;
    return [Math.cos(a) * Math.cos(b), Math.sin(a), Math.cos(a) * Math.sin(b)];
  }
  const cityVecs = CITIES.map(([la, lo]) => toVec(la, lo));

  /* ---------- 变换 ---------- */
  function project(v, scale) {
    const rr = (scale === undefined ? 1 : scale) * R;
    // 绕 Y 轴自转
    let x = v[0] * Math.cos(rot) + v[2] * Math.sin(rot);
    let z = -v[0] * Math.sin(rot) + v[2] * Math.cos(rot);
    let y = v[1];
    // 绕 X 轴倾斜
    const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
    const z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
    return [cx + x * rr, cy + y2 * rr, z2];
  }

  function slerp(a, b, t) {
    let d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const om = Math.acos(d);
    if (om < 1e-4) return a;
    const s = Math.sin(om);
    const w1 = Math.sin((1 - t) * om) / s;
    const w2 = Math.sin(t * om) / s;
    return [a[0] * w1 + b[0] * w2, a[1] * w1 + b[1] * w2, a[2] * w1 + b[2] * w2];
  }

  function drawArc(a, b, phase, alpha) {
    const steps = 42;
    const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const lift = 0.14 + ang * 0.16;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const v = slerp(a, b, t);
      const h = 1 + Math.sin(Math.PI * t) * lift;
      const p = project(v, h);
      if (p[2] < -0.08) { started = false; continue; }
      if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.strokeStyle = colors.a;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // 沿线流动光点
    const t = phase % 1;
    const v = slerp(a, b, t);
    const p = project(v, 1 + Math.sin(Math.PI * t) * lift);
    if (p[2] > -0.05) {
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 7);
      g.addColorStop(0, colors.c);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.95 * alpha;
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p[0], p[1], 1.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- 共享给 WebGL 能量层的几何状态 ---------- */
  window.__globeState = { ready: false, W: 0, H: 0, dpr: 1, R: 0, cx: 0, cy: 0, rot: 0, tilt: -0.42 };

  /* ---------- 主循环 ---------- */
  let t0 = performance.now();
  function frame(now) {
    const dt = Math.min(40, now - t0) / 1000; t0 = now;
    if (!reduce) rot += dt * 0.11;
    parX += (parTX - parX) * 0.06;
    parY += (parTY - parY) * 0.06;

    ctx.clearRect(0, 0, W, H);
    const rotSave = rot, cxSave = cx, cySave = cy;
    rot += parX * 0.35; cx += parX * 14; cy += parY * 12;

    const gs = window.__globeState;
    gs.ready = true; gs.W = W; gs.H = H; gs.dpr = dpr;
    gs.R = R; gs.cx = cx; gs.cy = cy; gs.rot = rot; gs.tilt = tilt;

    // 外辉光
    const glow = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 1.45);
    glow.addColorStop(0, hexA(colors.a, 0.20));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.45, 0, Math.PI * 2); ctx.fill();

    // 球体本体
    const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R * 1.08);
    body.addColorStop(0, hexA(colors.b, 0.30));
    body.addColorStop(0.55, hexA(colors.a, 0.10));
    body.addColorStop(1, 'rgba(0,0,0,0.02)');
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // 经纬线
    ctx.lineWidth = 0.7;
    for (const lat of lats) {
      ctx.beginPath(); let started = false;
      for (let i = 0; i <= 72; i++) {
        const lon = (i / 72) * Math.PI * 2;
        const v = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
        const p = project(v);
        if (p[2] < 0) { started = false; continue; }
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.strokeStyle = hexA(colors.a, 0.20); ctx.stroke();
    }
    for (let k = 0; k < lons; k++) {
      const lon = (k / lons) * Math.PI * 2;
      ctx.beginPath(); let started = false;
      for (let i = 0; i <= 48; i++) {
        const lat = -Math.PI / 2 + (i / 48) * Math.PI;
        const v = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
        const p = project(v);
        if (p[2] < 0) { started = false; continue; }
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.strokeStyle = hexA(colors.a, 0.13); ctx.stroke();
    }

    // 点阵：WebGL 能量层接管后交给 GPU 画更密的球面粉尘
    const fxOn = !!window.__globeFxOn;
    if (!fxOn) {
      for (const v of dots) {
        const p = project(v);
        if (p[2] < 0.02) continue;
        const a = 0.16 + p[2] * 0.72;
        ctx.fillStyle = hexA(colors.a, a * 0.9);
        const s = 0.9 + p[2] * 1.5;
        ctx.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
      }
    }

    // 港口节点
    cityVecs.forEach((v, i) => {
      const p = project(v);
      if (p[2] < 0) return;
      const a = 0.35 + p[2] * 0.65;
      ctx.fillStyle = hexA(colors.c, a);
      ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = hexA(colors.a, a * 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p[0], p[1], 5.5 + Math.sin(now / 700 + i) * 1.2, 0, Math.PI * 2); ctx.stroke();
    });

    // 航线
    ROUTES.forEach(([i, j], k) => {
      drawArc(cityVecs[i], cityVecs[j], ((now / 2600) + k * 0.17) % 1, 0.55);
    });

    // 边缘高光：由能量层的 rim 编织电弧接替，这里避免多一圈生硬描边
    if (!window.__globeFxOn) {
      ctx.strokeStyle = hexA(colors.a, 0.35);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    }

    rot = rotSave; cx = cxSave; cy = cySave;
    requestAnimationFrame(frame);
  }

  /* #RRGGBB -> rgba() */
  function hexA(hex, a) {
    hex = (hex || '').trim();
    if (hex.startsWith('rgb')) return hex;
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n)) return `rgba(61,192,245,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  requestAnimationFrame(frame);
})();
