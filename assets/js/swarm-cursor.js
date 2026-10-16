/*!
 * SwarmCursor —— React Bits <SwarmCursor />（JavaScript + CSS 变体）的原生 JS 移植
 *
 * 站点是纯静态 HTML，没有 React，因此把组件改写为等价的原生类：
 *   new SwarmCursor(layer, canvas, options) / setOptions(opts) / destroy()
 * 原组件的 VERTEX / FRAGMENT 两个 shader、流场（stir → curl 约束 → 半拉格朗日回溯
 * → 压力投影）、粒子群（网格邻域排斥 + 深度分层 + 拖尾拉伸）与点击 burst/pulse
 * 全部逐字保留，只把 React 生命周期换成 init / setOptions / destroy。
 *
 * 站点级适配（相对原组件的三处改动）：
 *   1. 原组件是「包住 children 的相对定位容器」，这里改为全屏 fixed 覆盖层，
 *      因此 findTarget() 不再用 container.contains()（站点内容不在层内），
 *      改为直接对指针下的元素做 closest(targets)，保留「悬停按钮时绕着它流」的效果。
 *   2. 新增 opacity 选项：整群粒子的全局透明度，便于在文字密集的内容站上收敛观感。
 *   3. 主题联动：深色用 screen 叠加（加法发光，不会盖住文字），
 *      浅色用 multiply + 近黑粒子（不会糊成一片），由 setOptions({theme}) 处理。
 */
(() => {
  'use strict';

  const MAX_PARTICLES = 2000;
  const INTRO_SECONDS = 1.4;
  const HIDDEN = 'swarm-cursor-hidden';
  const SHAPES = { dot: 0, square: 1, streak: 2 };
  const CELL = 16;
  const MAX_COLS = 72;
  const MAX_ROWS = 48;
  const PRESSURE_STEPS = 12;

  const VERTEX = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aAgent;
layout(location = 2) in vec4 aLook;
layout(location = 3) in vec2 aExtra;
uniform vec2 uView;
out vec2 vLocal;
out vec2 vHalf;
out float vAlpha;
out float vTint;
out float vSoft;
out float vShape;

void main() {
  vec2 dir = aAgent.zw;
  vec2 side = vec2(-dir.y, dir.x);
  vec2 extent = aLook.xy * 0.5;
  vec2 pad = extent + 1.0 + aExtra.x * 1.5;
  vec2 local = aCorner * pad;
  vec2 center = aAgent.xy - dir * (extent.x - extent.y);
  vec2 pos = center + dir * local.x + side * local.y;
  vLocal = local;
  vHalf = extent;
  vAlpha = aLook.z;
  vTint = aLook.w;
  vSoft = aExtra.x;
  vShape = aExtra.y;
  vec2 clip = pos / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

  const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uRatio;
in vec2 vLocal;
in vec2 vHalf;
in float vAlpha;
in float vTint;
in float vSoft;
in float vShape;
out vec4 outColor;

void main() {
  float d;
  if (vShape > 0.5 && vShape < 1.5) {
    float corner = vHalf.y * 0.3;
    vec2 q = abs(vLocal) - vHalf + corner;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
  } else {
    vec2 q = vLocal;
    q.x = max(abs(q.x) - (vHalf.x - vHalf.y), 0.0);
    d = length(q) - vHalf.y;
  }
  float edge = 0.6 / uRatio + vSoft;
  float cover = 1.0 - smoothstep(-edge, edge, d);
  float stretch = clamp(1.0 - vHalf.y / max(vHalf.x, 0.001), 0.0, 1.0);
  float head = clamp((vLocal.x + vHalf.x) / max(2.0 * vHalf.x, 0.001), 0.0, 1.0);
  cover *= mix(1.0, 0.12 + 0.88 * head * head, stretch);
  float alpha = cover * vAlpha;
  outColor = vec4(mix(uColor, uAccent, vTint) * alpha, alpha);
}`;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const compile = (gl, type, source) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    console.warn('[SwarmCursor] 着色器编译失败：', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  };

  const link = gl => {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[SwarmCursor] 着色器链接失败：', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return { program, uniforms };
  };

  const random = seed => {
    let state = seed >>> 0 || 1;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
  };

  const rectField = (x, y, hx, hy, r, out) => {
    const sx = x < 0 ? -1 : 1;
    const sy = y < 0 ? -1 : 1;
    const qx = Math.abs(x) - (hx - r);
    const qy = Math.abs(y) - (hy - r);
    if (qx > 0 && qy > 0) {
      const l = Math.hypot(qx, qy) || 1;
      out[0] = l - r;
      out[1] = (qx / l) * sx;
      out[2] = (qy / l) * sy;
    } else if (qx > qy) {
      out[0] = qx - r;
      out[1] = sx;
      out[2] = 0;
    } else {
      out[0] = qy - r;
      out[1] = 0;
      out[2] = sy;
    }
    return out;
  };

  const DEFAULTS = {
    count: 800,
    size: 2.6,
    shape: 'dot',
    color: null,
    accentColor: null,
    spread: 90,
    speed: 1,
    swirl: 0.6,
    tail: 0.5,
    trail: 0.6,
    wander: 0.5,
    depth: 0.7,
    targets: 'a, button, [data-swarm-target]',
    idle: 'roam',
    clickEffect: 'burst',
    hideCursor: false,
    intro: true,
    enabled: true,
    lightMode: false,
    dpr: null,
    opacity: 1
  };

  class SwarmCursor {
    constructor(layer, canvas, options = {}) {
      this.layer = layer;
      this.canvas = canvas;
      this.props = Object.assign({}, DEFAULTS, options);
      this.supported = false;
      this._init();
    }

    static isSupported() {
      try {
        const probe = document.createElement('canvas');
        return !!probe.getContext('webgl2');
      } catch {
        return false;
      }
    }

    setOptions(next = {}) {
      const wasEnabled = this.settings ? this.settings.enabled : true;
      this.props = Object.assign(this.props, next);
      this.settings = this._build(this.props);
      this._applyTheme();
      if (!wasEnabled && this.settings.enabled) {
        this._resize();
        this.wake();
      }
      if (!this.settings.enabled) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      } else {
        this.wake();
      }
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.alive = false;
      this._setHidden(false);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerdown', this._onPointerDown);
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
      document.documentElement.removeEventListener('pointerleave', this._onPointerLeave);
      document.removeEventListener('visibilitychange', this._onVisibility);
      const gl = this.gl;
      if (!gl) return;
      if (this.buffers) {
        this.buffers.forEach(buffer => gl.deleteBuffer(buffer));
        this.buffers = null;
      }
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.shader) gl.deleteProgram(this.shader.program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.gl = null;
    }

    /* ---------------- 初始化 ---------------- */

    _build(p) {
      const ink = p.lightMode ? '#18181b' : '#ffffff';
      return {
        count: Math.round(clamp(p.count, 1, MAX_PARTICLES)),
        size: clamp(p.size, 0.5, 16),
        shape: SHAPES[p.shape] ?? 0,
        color: p.color || ink,
        accentColor: p.accentColor || p.color || ink,
        spread: clamp(p.spread, 20, 400),
        speed: clamp(p.speed, 0, 4),
        swirl: clamp(p.swirl, 0, 1),
        tail: clamp(p.tail, 0, 1),
        trail: clamp(p.trail, 0, 3),
        wander: clamp(p.wander, 0, 2),
        depth: clamp(p.depth, 0, 1),
        targets: p.targets,
        idle: p.idle,
        clickEffect: p.clickEffect,
        hideCursor: p.hideCursor,
        intro: p.intro,
        enabled: p.enabled,
        lightMode: p.lightMode,
        dpr: p.dpr,
        opacity: clamp(p.opacity, 0, 1)
      };
    }

    _applyTheme() {
      if (!this.canvas) return;
      // 深色：screen 加法发光（文字不会被压暗）；浅色：正常叠加，近黑粒子保持锐利
      this.canvas.style.mixBlendMode = this.props.lightMode ? 'normal' : 'screen';
    }

    _init() {
      const container = this.layer;
      const canvas = this.canvas;
      // 重入保护：上下文恢复重建时先摘除旧监听/观察器，避免重复绑定
      if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerdown', this._onPointerDown);
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
      document.documentElement.removeEventListener('pointerleave', this._onPointerLeave);
      document.removeEventListener('visibilitychange', this._onVisibility);
      canvas?.removeEventListener('webglcontextlost', this._onLost);
      canvas?.removeEventListener('webglcontextrestored', this._onRestored);
      const gl = canvas?.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false
      });
      if (!container || !canvas || !gl) return;
      // WebGL 上下文丢失自愈：preventDefault 允许恢复，恢复后完整重建
      canvas.addEventListener('webglcontextlost', this._onLost = e => {
        e.preventDefault();
        this.supported = false;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      });
      canvas.addEventListener('webglcontextrestored', this._onRestored = () => {
        if (!this.alive) return;
        this.gl = null;
        this.shader = null;
        this.vao = null;
        this.buffers = null;
        this.supported = false;
        this._init();
        if (this.supported) { this._resize(); this.wake(); }
      });
      const shader = link(gl);
      if (!shader) return;
      this.gl = gl;
      this.shader = shader;
      this.supported = true;
      this.alive = true;
      this.raf = 0;

      const u = shader.uniforms;
      const slots = MAX_PARTICLES + 1;
      const vao = gl.createVertexArray();
      this.vao = vao;
      gl.bindVertexArray(vao);
      const cornerBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.agentData = new Float32Array(slots * 4);
      this.lookData = new Float32Array(slots * 4);
      this.extraData = new Float32Array(slots * 2);
      const instanced = (location, width, data) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, width, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(location, 1);
        return buffer;
      };
      const agentBuffer = instanced(1, 4, this.agentData);
      const lookBuffer = instanced(2, 4, this.lookData);
      const extraBuffer = instanced(3, 2, this.extraData);
      this.buffers = [cornerBuffer, agentBuffer, lookBuffer, extraBuffer];
      gl.bindVertexArray(null);

      const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const colorCache = new Map();
      this._parse = value => {
        const key = String(value);
        const cached = colorCache.get(key);
        if (cached) return cached;
        let rgb = [1, 1, 1];
        if (probe) {
          probe.clearRect(0, 0, 1, 1);
          probe.fillStyle = '#000000';
          probe.fillStyle = key;
          probe.fillRect(0, 0, 1, 1);
          const data = probe.getImageData(0, 0, 1, 1).data;
          rgb = [data[0] / 255, data[1] / 255, data[2] / 255];
        }
        colorCache.set(key, rgb);
        return rgb;
      };

      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      this.reduce = reduce;
      this.view = { width: 1, height: 1, ratio: 1 };
      this.px = new Float32Array(MAX_PARTICLES);
      this.py = new Float32Array(MAX_PARTICLES);
      this.pz = new Float32Array(MAX_PARTICLES);
      this.vx = new Float32Array(MAX_PARTICLES);
      this.vy = new Float32Array(MAX_PARTICLES);
      this.vz = new Float32Array(MAX_PARTICLES);
      this.home = new Float32Array(MAX_PARTICLES);
      this.heft = new Float32Array(MAX_PARTICLES);
      this.bob = new Float32Array(MAX_PARTICLES);
      this.bobRate = new Float32Array(MAX_PARTICLES);
      this.grain = new Float32Array(MAX_PARTICLES);
      this.glint = new Float32Array(MAX_PARTICLES);
      this.order = new Int32Array(MAX_PARTICLES);
      this.field = [0, 0, 0];
      this.cols = 1;
      this.rows = 1;
      this.cell = CELL;
      this.flowX = new Float32Array(1);
      this.flowY = new Float32Array(1);
      this.lastX = new Float32Array(1);
      this.lastY = new Float32Array(1);
      this.pressure = new Float32Array(1);
      this.divergence = new Float32Array(1);
      this.curl = new Float32Array(1);
      this.pointer = { x: 0, y: 0, inside: false };
      this.anchor = { x: 0, y: 0, lastX: 0, lastY: 0, moveX: 0, moveY: 0 };
      this.ring = { active: false, x: 0, y: 0, hx: 0, hy: 0, corner: 0, spin: 1 };
      this.burst = { age: 10 };
      this.ping = { age: 10, x: 0, y: 0 };
      this.hovered = null;
      this.time = 0;
      this.presence = 1;
      this.introClock = this.props.intro && !reduce ? 0 : 1;
      this.last = 0;
      this.seeded = false;
      this.hidden = false;
      this.sorted = 0;
      this.crowd = new Int32Array(MAX_PARTICLES);
      this.crowdHeads = new Int32Array(1);
      this.crowdRows = 1;

      this.settings = this._build(this.props);
      this._applyTheme();
      // rAF 回调必须绑定 this（严格模式下未绑定调用会让 this 变成 undefined）
      this._tick = now => this._frame(now);

      this._onPointerMove = event => {
        const spot = this._locate(event);
        this.pointer.x = spot.x;
        this.pointer.y = spot.y;
        this.pointer.inside = spot.inside;
      };
      this._onPointerDown = event => {
        const s = this.settings;
        const spot = this._locate(event);
        if (!spot.inside || !s.enabled || this.reduce || s.clickEffect === 'none') return;
        const x = spot.x;
        const y = spot.y;
        const reachOut = s.spread * 2.2;
        if (s.clickEffect === 'pulse') {
          this.ping.x = x;
          this.ping.y = y;
          this.ping.age = 0;
        } else {
          this.burst.age = 0;
        }
        const kick = s.clickEffect === 'pulse' ? 160 : 780;
        for (let i = 0; i < s.count; i++) {
          const dx = this.px[i] - x;
          const dy = this.py[i] - y;
          const d = Math.hypot(dx, dy) || 1;
          if (d > reachOut) continue;
          const k = (1 - d / reachOut) * kick * (0.6 + 0.4 * this.grain[i]);
          this.vx[i] += (dx / d) * k;
          this.vy[i] += (dy / d) * k;
        }
        if (s.clickEffect === 'pulse') return;
        const twist = 520 * (this.time % 2 < 1 ? 1 : -1);
        const inv = 1 / (s.spread * s.spread);
        for (let j = 1; j < this.rows - 1; j++) {
          for (let i = 1; i < this.cols - 1; i++) {
            const k = i + j * this.cols;
            const rx = (i + 0.5) * this.cell - x;
            const ry = (j + 0.5) * this.cell - y;
            const d2 = rx * rx + ry * ry;
            const w = (Math.sqrt(d2) / s.spread) * Math.exp(-d2 * inv);
            if (w < 0.003) continue;
            const d = Math.sqrt(d2) + 0.001;
            this.flowX[k] += (-ry / d) * twist * w;
            this.flowY[k] += (rx / d) * twist * w;
          }
        }
        this.wake();
      };
      this._onPointerUp = event => {
        if (event.pointerType !== 'mouse') this.pointer.inside = false;
      };
      this._onPointerLeave = () => {
        this.pointer.inside = false;
      };
      this._onVisibility = () => {
        this.last = 0;
        this.wake();
      };

      window.addEventListener('pointermove', this._onPointerMove, { passive: true });
      window.addEventListener('pointerdown', this._onPointerDown, { passive: true });
      window.addEventListener('pointerup', this._onPointerUp, { passive: true });
      window.addEventListener('pointercancel', this._onPointerUp, { passive: true });
      document.documentElement.addEventListener('pointerleave', this._onPointerLeave);
      document.addEventListener('visibilitychange', this._onVisibility);

      this.resizeObserver = new ResizeObserver(() => this._resize());
      this.resizeObserver.observe(container);

      this._resize();
      this.wake();
      void u;
    }

    /* ---------------- 内部：尺寸 / 网格 ---------------- */

    _setHidden(value) {
      if (value === this.hidden) return;
      this.hidden = value;
      this.layer.classList.toggle(HIDDEN, value);
    }

    _allocate() {
      const nextCols = clamp(Math.round(this.view.width / CELL), 8, MAX_COLS);
      const nextRows = clamp(Math.round(this.view.height / CELL), 8, MAX_ROWS);
      this.cell = Math.max(this.view.width / nextCols, this.view.height / nextRows);
      if (nextCols === this.cols && nextRows === this.rows) return;
      this.cols = nextCols;
      this.rows = nextRows;
      const total = this.cols * this.rows;
      this.flowX = new Float32Array(total);
      this.flowY = new Float32Array(total);
      this.lastX = new Float32Array(total);
      this.lastY = new Float32Array(total);
      this.pressure = new Float32Array(total);
      this.divergence = new Float32Array(total);
      this.curl = new Float32Array(total);
    }

    _sample(values, x, y) {
      let gx = x / this.cell - 0.5;
      let gy = y / this.cell - 0.5;
      if (gx < 0) gx = 0;
      else if (gx > this.cols - 1.001) gx = this.cols - 1.001;
      if (gy < 0) gy = 0;
      else if (gy > this.rows - 1.001) gy = this.rows - 1.001;
      const i = gx | 0;
      const j = gy | 0;
      const fx = gx - i;
      const fy = gy - j;
      const k = i + j * this.cols;
      return (
        (values[k] * (1 - fx) + values[k + 1] * fx) * (1 - fy) +
        (values[k + this.cols] * (1 - fx) + values[k + this.cols + 1] * fx) * fy
      );
    }

    _walls(values, axis) {
      const cols = this.cols;
      const rows = this.rows;
      for (let j = 1; j < rows - 1; j++) {
        const left = j * cols;
        const right = left + cols - 1;
        values[left] = axis === 1 ? -values[left + 1] : values[left + 1];
        values[right] = axis === 1 ? -values[right - 1] : values[right - 1];
      }
      for (let i = 1; i < cols - 1; i++) {
        const bottom = i + (rows - 1) * cols;
        values[i] = axis === 2 ? -values[i + cols] : values[i + cols];
        values[bottom] = axis === 2 ? -values[bottom - cols] : values[bottom - cols];
      }
      values[0] = 0.5 * (values[1] + values[cols]);
      values[cols - 1] = 0.5 * (values[cols - 2] + values[2 * cols - 1]);
      values[(rows - 1) * cols] = 0.5 * (values[(rows - 2) * cols] + values[(rows - 1) * cols + 1]);
      values[rows * cols - 1] = 0.5 * (values[rows * cols - 2] + values[(rows - 1) * cols - 1]);
    }

    /* ---------------- 内部���流场 ---------------- */

    _stir(s, dt, ease) {
      const radius = s.spread;
      const reach = radius * 2.2;
      const i0 = Math.max(1, Math.floor((this.anchor.x - reach) / this.cell));
      const i1 = Math.min(this.cols - 2, Math.ceil((this.anchor.x + reach) / this.cell));
      const j0 = Math.max(1, Math.floor((this.anchor.y - reach) / this.cell));
      const j1 = Math.min(this.rows - 2, Math.ceil((this.anchor.y + reach) / this.cell));
      const inv = 1 / (radius * radius * 0.55);
      const moving = Math.hypot(this.anchor.moveX, this.anchor.moveY);
      const grab = (1 - Math.exp(-dt * 20)) * clamp(moving / 240, 0, 1) * this.presence;
      const whirl = this.ring.active ? 0 : radius * (0.5 + 4 * (1 - ease)) * (0.35 + 0.65 * s.speed);
      const churn = s.wander * radius * 14 * (0.4 + 0.6 * s.speed);
      const fk = 1.4 / radius;
      const ft = this.time * 0.75 * (0.4 + 0.6 * s.speed);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = i + j * this.cols;
          const x = (i + 0.5) * this.cell;
          const y = (j + 0.5) * this.cell;
          const rx = x - this.anchor.x;
          const ry = y - this.anchor.y;
          const d2 = rx * rx + ry * ry;
          const w = Math.exp(-d2 * inv);
          if (w < 0.003) continue;
          const d = Math.sqrt(d2) + 0.001;
          this.flowX[k] += (this.anchor.moveX - this.flowX[k]) * w * grab;
          this.flowY[k] += (this.anchor.moveY - this.flowY[k]) * w * grab;
          const reachOut = Math.min(1, d / (radius * 0.45));
          this.flowX[k] += (-ry / d) * whirl * reachOut * w * dt;
          this.flowY[k] += (rx / d) * whirl * reachOut * w * dt;
          const a1 = x * fk + ft;
          const b1 = y * fk * 1.1 - ft * 0.8;
          const a2 = y * fk * 1.7 + ft * 1.2 + 1.3;
          const b2 = x * fk * 1.3 - 0.7;
          const curlX = -Math.sin(a1) * Math.sin(b1) * 1.1 + 1.02 * Math.cos(a2) * Math.cos(b2);
          const curlY = -(Math.cos(a1) * Math.cos(b1) - 0.78 * Math.sin(a2) * Math.sin(b2));
          this.flowX[k] += curlX * churn * w * dt;
          this.flowY[k] += curlY * churn * w * dt;
        }
      }
      if (!this.ring.active) return;
      const band = Math.max(4, radius * 0.16);
      const margin = band + 24;
      const circulate = 230 * (0.4 + 0.6 * s.speed) * this.ring.spin;
      const r0 = Math.max(1, Math.floor((this.ring.x - this.ring.hx - margin) / this.cell));
      const r1 = Math.min(this.cols - 2, Math.ceil((this.ring.x + this.ring.hx + margin) / this.cell));
      const c0 = Math.max(1, Math.floor((this.ring.y - this.ring.hy - margin) / this.cell));
      const c1 = Math.min(this.rows - 2, Math.ceil((this.ring.y + this.ring.hy + margin) / this.cell));
      const rate = 1 - Math.exp(-dt * 6);
      for (let j = c0; j <= c1; j++) {
        for (let i = r0; i <= r1; i++) {
          const k = i + j * this.cols;
          rectField((i + 0.5) * this.cell - this.ring.x, (j + 0.5) * this.cell - this.ring.y, this.ring.hx, this.ring.hy, this.ring.corner, this.field);
          const off = this.field[0] - (5 + band * 0.5);
          const w = Math.exp(-(off * off) / (margin * margin * 0.35));
          if (w < 0.01) continue;
          this.flowX[k] += (-this.field[2] * circulate - this.flowX[k]) * w * rate;
          this.flowY[k] += (this.field[1] * circulate - this.flowY[k]) * w * rate;
        }
      }
    }

    _flow(s, dt) {
      const cols = this.cols;
      const rows = this.rows;
      const total = cols * rows;
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          const k = i + j * cols;
          this.curl[k] = (this.flowY[k + 1] - this.flowY[k - 1] - this.flowX[k + cols] + this.flowX[k - cols]) * (0.5 / this.cell);
        }
      }
      const confine = s.swirl * this.cell * 9;
      for (let j = 2; j < rows - 2; j++) {
        for (let i = 2; i < cols - 2; i++) {
          const k = i + j * cols;
          const gx = Math.abs(this.curl[k + 1]) - Math.abs(this.curl[k - 1]);
          const gy = Math.abs(this.curl[k + cols]) - Math.abs(this.curl[k - cols]);
          const len = Math.hypot(gx, gy) + 1e-5;
          this.flowX[k] += (gy / len) * this.curl[k] * confine * dt;
          this.flowY[k] -= (gx / len) * this.curl[k] * confine * dt;
        }
      }
      this.lastX.set(this.flowX);
      this.lastY.set(this.flowY);
      const back = dt / this.cell;
      const fade = Math.exp(-dt / (0.35 + 1.5 * s.swirl));
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          const k = i + j * cols;
          let x = i - back * this.lastX[k];
          let y = j - back * this.lastY[k];
          if (x < 0.5) x = 0.5;
          else if (x > cols - 1.5) x = cols - 1.5;
          if (y < 0.5) y = 0.5;
          else if (y > rows - 1.5) y = rows - 1.5;
          const i0 = x | 0;
          const j0 = y | 0;
          const fx = x - i0;
          const fy = y - j0;
          const a = i0 + j0 * cols;
          this.flowX[k] =
            ((this.lastX[a] * (1 - fx) + this.lastX[a + 1] * fx) * (1 - fy) +
              (this.lastX[a + cols] * (1 - fx) + this.lastX[a + cols + 1] * fx) * fy) *
            fade;
          this.flowY[k] =
            ((this.lastY[a] * (1 - fx) + this.lastY[a + 1] * fx) * (1 - fy) +
              (this.lastY[a + cols] * (1 - fx) + this.lastY[a + cols + 1] * fx) * fy) *
            fade;
        }
      }
      this._walls(this.flowX, 1);
      this._walls(this.flowY, 2);
      const h2 = this.cell * this.cell;
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          const k = i + j * cols;
          this.divergence[k] = (this.flowX[k + 1] - this.flowX[k - 1] + this.flowY[k + cols] - this.flowY[k - cols]) * (0.5 / this.cell);
        }
      }
      this.pressure.fill(0, 0, total);
      this._walls(this.divergence, 0);
      for (let step = 0; step < PRESSURE_STEPS; step++) {
        for (let j = 1; j < rows - 1; j++) {
          for (let i = 1; i < cols - 1; i++) {
            const k = i + j * cols;
            this.pressure[k] =
              (this.pressure[k - 1] + this.pressure[k + 1] + this.pressure[k - cols] + this.pressure[k + cols] - h2 * this.divergence[k]) * 0.25;
          }
        }
        this._walls(this.pressure, 0);
      }
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          const k = i + j * cols;
          this.flowX[k] -= (this.pressure[k + 1] - this.pressure[k - 1]) * (0.5 / this.cell);
          this.flowY[k] -= (this.pressure[k + cols] - this.pressure[k - cols]) * (0.5 / this.cell);
        }
      }
      this._walls(this.flowX, 1);
      this._walls(this.flowY, 2);
    }

    /* ---------------- 内部：粒子 ---------------- */

    _push(n, h) {
      const gc = Math.max(1, Math.ceil(this.view.width / h) + 2);
      const gr = Math.max(1, Math.ceil(this.view.height / h) + 2);
      if (this.crowdHeads.length < gc * gr) this.crowdHeads = new Int32Array(gc * gr);
      this.crowdHeads.fill(-1, 0, gc * gr);
      this.crowdRows = gr;
      for (let i = 0; i < n; i++) {
        const cx = clamp(Math.floor(this.px[i] / h) + 1, 0, gc - 1);
        const cy = clamp(Math.floor(this.py[i] / h) + 1, 0, gr - 1);
        const key = cy * gc + cx;
        this.crowd[i] = this.crowdHeads[key];
        this.crowdHeads[key] = i;
      }
      return gc;
    }

    _move(s, dt, ease) {
      const n = s.count;
      const radius = s.spread;
      const loose = 1 - 0.6 * s.tail;
      const gather = 12 * loose * (0.2 + 0.8 * ease);
      const pull = 30 * loose * (0.2 + 0.8 * ease);
      const band = Math.max(4, radius * 0.16);
      const w = this.view.width;
      const h = this.view.height;
      const gap = radius * Math.sqrt(Math.PI / Math.max(n, 1)) * 1.6;
      const repel = 4000;
      const gc = this._push(n, gap);
      for (let i = 0; i < n; i++) {
        const x = this.px[i];
        const y = this.py[i];
        const k = 10 * (1 - 0.6 * s.tail * this.heft[i]);
        let ax = (this._sample(this.flowX, x, y) - this.vx[i]) * k;
        let ay = (this._sample(this.flowY, x, y) - this.vy[i]) * k;
        const cx = clamp(Math.floor(x / gap) + 1, 0, gc - 1);
        const cy = clamp(Math.floor(y / gap) + 1, 0, this.crowdRows - 1);
        for (let oy = -1; oy <= 1; oy++) {
          const row = cy + oy;
          if (row < 0 || row >= this.crowdRows) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const col = cx + ox;
            if (col < 0 || col >= gc) continue;
            for (let j = this.crowdHeads[row * gc + col]; j !== -1; j = this.crowd[j]) {
              if (j === i) continue;
              const dx = x - this.px[j];
              const dy = y - this.py[j];
              const d2 = dx * dx + dy * dy;
              if (d2 >= gap * gap || d2 < 1e-6) continue;
              const d = Math.sqrt(d2);
              const q = 1 - d / gap;
              ax += (dx / d) * q * q * repel;
              ay += (dy / d) * q * q * repel;
            }
          }
        }
        if (this.ring.active) {
          rectField(x - this.ring.x, y - this.ring.y, this.ring.hx, this.ring.hy, this.ring.corner, this.field);
          const e = this.field[0] - (5 + band * this.home[i] * this.home[i]);
          const hold = e > 0 ? 70 : 140;
          ax -= this.field[1] * e * hold;
          ay -= this.field[2] * e * hold;
        } else {
          const dx = this.anchor.x - x;
          const dy = this.anchor.y - y;
          const d = Math.hypot(dx, dy) + 0.001;
          const over = Math.max(0, d - radius);
          ax += (dx / d) * (d * gather + over * pull);
          ay += (dy / d) * (d * gather + over * pull);
        }
        if (this.introClock >= 1) {
          if (x < 8) ax += (8 - x) * 30;
          else if (x > w - 8) ax -= (x - w + 8) * 30;
          if (y < 8) ay += (8 - y) * 30;
          else if (y > h - 8) ay -= (y - h + 8) * 30;
        }
        const lift = Math.sin(this.time * this.bobRate[i] + this.bob[i]) * radius * (this.ring.active ? 0.15 : 0.55);
        const az = (lift - this.pz[i]) * 36 - this.vz[i] * 9;
        this.vx[i] += ax * dt;
        this.vy[i] += ay * dt;
        this.vz[i] += az * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
      }
    }

    _seed() {
      const rand = random(7);
      for (let i = 0; i < MAX_PARTICLES; i++) {
        this.home[i] = 0.08 + 0.92 * Math.sqrt(rand());
        this.heft[i] = rand() * rand();
        this.bob[i] = rand() * Math.PI * 2;
        this.bobRate[i] = 0.5 + rand() * 1.1;
        this.grain[i] = 0.55 + rand() * 0.9;
        this.glint[i] = rand() * 100;
      }
      this.seeded = true;
    }

    _place(gathered) {
      const s = this.settings;
      const rand = random(11);
      const reachOut = Math.hypot(this.view.width, this.view.height) * 0.5;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const a = rand() * Math.PI * 2;
        const r = gathered ? this.home[i] * s.spread : (0.35 + 0.65 * Math.sqrt(rand())) * reachOut;
        this.px[i] = this.anchor.x + Math.cos(a) * r;
        this.py[i] = this.anchor.y + Math.sin(a) * r;
        this.pz[i] = Math.sin(this.bob[i]) * s.spread * 0.55;
        this.vx[i] = 0;
        this.vy[i] = 0;
        this.vz[i] = 0;
      }
    }

    // 站点级适配：内容不在覆盖层内，因此直接对指针下的元素做 closest(targets)
    _findTarget() {
      const s = this.settings;
      if (!s.targets || !this.pointer.inside) return null;
      const rect = this.layer.getBoundingClientRect();
      const element = document.elementFromPoint(rect.left + this.pointer.x, rect.top + this.pointer.y);
      if (!element) return null;
      let match = null;
      try {
        match = element.closest(s.targets);
      } catch {
        match = null;
      }
      return match || null;
    }

    _updateAnchor(s, dt) {
      const w = this.view.width;
      const h = this.view.height;
      if (this.hovered && this.hovered.isConnected) {
        const box = this.hovered.getBoundingClientRect();
        const frame = this.layer.getBoundingClientRect();
        const radius = parseFloat(getComputedStyle(this.hovered).borderTopLeftRadius) || 0;
        this.ring.x = box.left - frame.left + box.width / 2;
        this.ring.y = box.top - frame.top + box.height / 2;
        this.ring.hx = box.width / 2;
        this.ring.hy = box.height / 2;
        this.ring.corner = Math.min(radius, this.ring.hx, this.ring.hy);
        if (!this.ring.active) {
          let turning = 0;
          for (let i = 0; i < s.count; i++) turning += (this.px[i] - this.ring.x) * this.vy[i] - (this.py[i] - this.ring.y) * this.vx[i];
          this.ring.spin = turning < 0 ? -1 : 1;
        }
        this.ring.active = true;
      } else {
        this.ring.active = false;
      }
      let goal = 1;
      if (this.pointer.inside) {
        this.anchor.x = this.pointer.x;
        this.anchor.y = this.pointer.y;
      } else if (s.idle === 'gather') {
        this.anchor.x = w * 0.5;
        this.anchor.y = h * 0.5;
      } else if (s.idle === 'hide') {
        goal = 0;
      } else {
        this.anchor.x = w * (0.5 + 0.3 * Math.sin(this.time * 0.21) + 0.06 * Math.sin(this.time * 0.53 + 1.7));
        this.anchor.y = h * (0.5 + 0.24 * Math.sin(this.time * 0.29 + 0.8) + 0.05 * Math.sin(this.time * 0.71));
      }
      if (dt > 0) {
        const moveX = clamp((this.anchor.x - this.anchor.lastX) / dt, -4000, 4000);
        const moveY = clamp((this.anchor.y - this.anchor.lastY) / dt, -4000, 4000);
        const blend = 1 - Math.exp(-dt * 30);
        this.anchor.moveX += (moveX - this.anchor.moveX) * blend;
        this.anchor.moveY += (moveY - this.anchor.moveY) * blend;
      }
      this.anchor.lastX = this.anchor.x;
      this.anchor.lastY = this.anchor.y;
      this.presence += (goal - this.presence) * (1 - Math.exp(-dt / 0.25));
    }

    _draw() {
      const gl = this.gl;
      const s = this.settings;
      const n = s.count;
      const fade = this.introClock * this.introClock * (3 - 2 * this.introClock) * this.presence;
      const zr = Math.max(s.spread * 0.55, 10);
      if (this.sorted !== n) {
        for (let a = 0; a < n; a++) this.order[a] = a;
        this.sorted = n;
      }
      for (let a = 1; a < n; a++) {
        const value = this.order[a];
        const key = this.pz[value];
        let b = a - 1;
        while (b >= 0 && this.pz[this.order[b]] > key) {
          this.order[b + 1] = this.order[b];
          b--;
        }
        this.order[b + 1] = value;
      }
      const flash = this.burst.age < 1.2 ? Math.exp(-this.burst.age / 0.3) : 0;
      const front = this.ping.age * 520;
      let written = 0;
      for (let a = 0; a < n; a++) {
        const i = this.order[a];
        const near = clamp(this.pz[i] / zr, -1, 1);
        const scale = 1 + s.depth * 0.6 * near;
        const body = s.size * this.grain[i] * scale;
        const soft = s.depth * s.size * (s.lightMode ? 0.35 : 1.4) * Math.pow(Math.abs(near), 1.6);
        const flat = Math.hypot(this.vx[i], this.vy[i]);
        const dx = flat > 0.001 ? this.vx[i] / flat : 1;
        const dy = flat > 0.001 ? this.vy[i] / flat : 0;
        let wave = 0;
        if (this.ping.age < 1.6) {
          const offset = (Math.hypot(this.px[i] - this.ping.x, this.py[i] - this.ping.y) - front) / 40;
          wave = Math.exp(-offset * offset) * (1 - this.ping.age / 1.6);
        }
        const tint = Math.max(clamp((flat - 380) / 900, 0, 1), flash, wave);
        const width = body * (1 + wave * 0.8);
        let length = width + Math.min(flat * s.trail * 0.02, body * 14);
        if (s.shape === 2) length = width * 2.6 + Math.min(flat * s.trail * 0.03, body * 18);
        const twinkle = 0.86 + 0.14 * Math.sin(this.time * 3.1 + this.glint[i]);
        const dim = 1 - s.depth * 0.45 * Math.max(0, -near);
        const o = written * 4;
        this.agentData[o] = this.px[i];
        this.agentData[o + 1] = this.py[i];
        this.agentData[o + 2] = dx;
        this.agentData[o + 3] = dy;
        this.lookData[o] = length;
        this.lookData[o + 1] = width;
        this.lookData[o + 2] = clamp(0.95 * dim * (body / (body + soft)) * twinkle * (1 + wave * 0.4), 0, 1) * fade * s.opacity;
        this.lookData[o + 3] = tint;
        this.extraData[written * 2] = soft;
        this.extraData[written * 2 + 1] = s.shape;
        written++;
      }
      if (s.hideCursor && this.pointer.inside) {
        const o = written * 4;
        this.agentData[o] = this.pointer.x;
        this.agentData[o + 1] = this.pointer.y;
        this.agentData[o + 2] = 1;
        this.agentData[o + 3] = 0;
        this.lookData[o] = 6;
        this.lookData[o + 1] = 6;
        this.lookData[o + 2] = 1;
        this.lookData[o + 3] = 0;
        this.extraData[written * 2] = 0;
        this.extraData[written * 2 + 1] = 0;
        written++;
      }
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!s.enabled || !written) return;
      gl.useProgram(this.shader.program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.vao);
      const buffers = this.buffers;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[1]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.agentData, 0, written * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[2]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lookData, 0, written * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[3]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.extraData, 0, written * 2);
      gl.uniform2f(this.shader.uniforms.uView, this.view.width, this.view.height);
      gl.uniform3fv(this.shader.uniforms.uColor, this._parse(s.color));
      gl.uniform3fv(this.shader.uniforms.uAccent, this._parse(s.accentColor));
      gl.uniform1f(this.shader.uniforms.uRatio, this.view.ratio);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, written);
      gl.bindVertexArray(null);
    }

    /* ---------------- 循环 ---------------- */

    _resize() {
      const s = this.settings;
      const container = this.layer;
      const canvas = this.canvas;
      this.view.width = Math.max(1, container.clientWidth);
      this.view.height = Math.max(1, container.clientHeight);
      this.view.ratio = Math.min(s.dpr || window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(this.view.width * this.view.ratio));
      canvas.height = Math.max(1, Math.round(this.view.height * this.view.ratio));
      this._allocate();
      if (!this.seeded) {
        this._seed();
        this._updateAnchor(s, 0);
        if (this.reduce) {
          this.anchor.x = this.view.width / 2;
          this.anchor.y = this.view.height / 2;
        }
        this.anchor.lastX = this.anchor.x;
        this.anchor.lastY = this.anchor.y;
        this._place(this.introClock >= 1);
      }
      this._draw();
      this.wake();
    }

    _frame(now) {
      this.raf = 0;
      if (!this.alive || document.hidden) return;
      const s = this.settings;
      const dt = this.last ? clamp((now - this.last) / 1000, 0.001, 1 / 30) : 1 / 60;
      this.last = now;
      if (!s.enabled || this.reduce) {
        this._setHidden(false);
        this._draw();
        return;
      }
      this.time += dt;
      this.burst.age += dt;
      this.ping.age += dt;
      if (this.introClock < 1) this.introClock = Math.min(1, this.introClock + dt / INTRO_SECONDS);
      const ease = this.introClock * this.introClock * (3 - 2 * this.introClock);
      this.hovered = this._findTarget();
      this._updateAnchor(s, dt);
      this._setHidden(s.hideCursor && this.pointer.inside);
      this._stir(s, dt, ease);
      this._flow(s, dt);
      this._move(s, dt / 2, ease);
      this._move(s, dt / 2, ease);
      this._draw();
      this.raf = requestAnimationFrame(this._tick);
    }

    wake() {
      if (!this.raf && this.alive && !document.hidden && this.settings && this.settings.enabled) {
        this.raf = requestAnimationFrame(this._tick);
      }
    }

    _locate(event) {
      const rect = this.layer.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return { x, y, inside: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
    }

    debug() {
      return {
        supported: this.supported,
        raf: !!this.raf,
        count: this.settings ? this.settings.count : 0,
        view: [Math.round(this.view.width), Math.round(this.view.height)],
        grid: [this.cols, this.rows],
        presence: Number(this.presence.toFixed(3)),
        introClock: Number(this.introClock.toFixed(3)),
        lightMode: this.settings ? this.settings.lightMode : null,
        color: this.settings ? this.settings.color : null,
        accentColor: this.settings ? this.settings.accentColor : null,
        ring: this.ring.active,
        pointerInside: this.pointer.inside,
        pointer: [Math.round(this.pointer.x), Math.round(this.pointer.y)],
        blend: this.canvas ? this.canvas.style.mixBlendMode : null
      };
    }
  }

  window.SwarmCursor = SwarmCursor;
})();
