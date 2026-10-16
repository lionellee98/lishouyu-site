/* =========================================================
   crystalized-globe.js
   React Bits <CrystalizedBall /> 特效移植到本站地球
   —— 在 Canvas 2D 地球之上叠加一层 WebGL2 能量场：
      rim 编织电弧 / 耀斑 / 光晕 / 内晕 haze / 弧光 sparks
      + 球面粉尘点阵（跟随自转）+ 鼠标搅动 & 点击冲击
   零依赖：内置约 200 行微型 WebGL2 层替代 ogl
   ========================================================= */
(function () {
  'use strict';

  /* =======================================================
     Part 1 — 微型 WebGL2 层（ogl 的最小等价物）
     ======================================================= */
  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '';
      console.error('[crystal-globe] shader compile failed:\n' + log);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  class Program {
    constructor(gl, { vertex, fragment, uniforms = {}, transparent = false, depthTest = true, depthWrite = true }) {
      this.gl = gl;
      this.uniforms = uniforms;
      this.transparent = transparent;
      this.depthTest = depthTest;
      this.depthWrite = depthWrite;
      this.blendSrc = null;
      this.blendDst = null;
      this.locations = Object.create(null);
      this.cache = new Map();

      const vs = compile(gl, gl.VERTEX_SHADER, vertex);
      const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
      if (!vs || !fs) { this.program = null; return; }
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error('[crystal-globe] link failed: ' + gl.getProgramInfoLog(p));
        this.program = null;
        return;
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.program = p;

      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const base = info.name.replace(/\[0\]$/, '');
        this.locations[base] = { loc: gl.getUniformLocation(p, base), type: info.type, size: info.size };
      }
      this.attributeLocations = Object.create(null);
      const an = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
      for (let i = 0; i < an; i++) {
        const a = gl.getActiveAttrib(p, i);
        this.attributeLocations[a.name] = gl.getAttribLocation(p, a.name);
      }
    }

    setBlendFunc(src, dst) { this.blendSrc = src; this.blendDst = dst; return this; }

    apply(isSync) {
      const gl = this.gl;
      gl.useProgram(this.program);
      if (this.transparent) {
        gl.enable(gl.BLEND);
        if (this.blendSrc !== null) gl.blendFunc(this.blendSrc, this.blendDst);
      } else {
        gl.disable(gl.BLEND);
      }
      let unit = 0;
      for (const name in this.locations) {
        const u = this.uniforms[name];
        if (!u || u.value === undefined) continue;
        const { loc, type, size } = this.locations[name];
        if (loc === null) continue;
        const v = u.value;
        switch (type) {
          case gl.FLOAT:
            if (size > 1) gl.uniform1fv(loc, v); else gl.uniform1f(loc, v);
            break;
          case gl.FLOAT_VEC2: gl.uniform2fv(loc, v); break;
          case gl.FLOAT_VEC3: gl.uniform3fv(loc, v); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(loc, v); break;
          case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, v); break;
          case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, v); break;
          case gl.SAMPLER_2D:
          case gl.SAMPLER_2D_SHADOW:
          case gl.INT_SAMPLER_2D:
          case gl.UNSIGNED_INT_SAMPLER_2D: {
            const tex = v && v.texture ? v.texture : v;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex || null);
            gl.uniform1i(loc, unit);
            unit++;
            break;
          }
          case gl.INT:
          case gl.BOOL:
            if (size > 1) gl.uniform1iv(loc, v); else gl.uniform1i(loc, v);
            break;
          default:
            break;
        }
      }
      void isSync;
    }
  }

  class Texture {
    constructor(gl, opts = {}) {
      this.gl = gl;
      this.texture = gl.createTexture();
      this.width = opts.width || 1;
      this.height = opts.height || 1;
      const {
        image = null, width = 1, height = 1,
        type = gl.UNSIGNED_BYTE, format = gl.RGBA, internalFormat = gl.RGBA,
        minFilter = gl.NEAREST, magFilter = gl.NEAREST,
        generateMipmaps = false, flipY = false, wrapS = gl.CLAMP_TO_EDGE, wrapT = gl.CLAMP_TO_EDGE
      } = opts;
      this.image = image;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY ? 1 : 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
      if (generateMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  class RenderTarget {
    constructor(gl, opts = {}) {
      this.gl = gl;
      const {
        width = 1, height = 1, color = 1, depth = true,
        type = gl.UNSIGNED_BYTE, format = gl.RGBA, internalFormat = gl.RGBA,
        minFilter = gl.NEAREST, magFilter = gl.NEAREST
      } = opts;
      this.width = width; this.height = height;
      this.buffer = gl.createFramebuffer();
      this.textures = [];
      this.attachments = [];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.buffer);
      for (let i = 0; i < color; i++) {
        const t = new Texture(gl, { width, height, type, format, internalFormat, minFilter, magFilter });
        this.textures.push(t);
        const att = gl.COLOR_ATTACHMENT0 + i;
        this.attachments.push(att);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, att, gl.TEXTURE_2D, t.texture, 0);
      }
      if (depth) {
        this.depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);
      }
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) console.error('[crystal-globe] framebuffer incomplete: 0x' + status.toString(16));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    setSize(w, h) {
      if (this.width === w && this.height === h) return;
      const gl = this.gl;
      this.width = w; this.height = h;
      this.textures.forEach(t => {
        gl.bindTexture(gl.TEXTURE_2D, t.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, t.internalFormat || gl.RGBA, w, h, 0, gl.RGBA, t.type || gl.UNSIGNED_BYTE, null);
      });
      if (this.depthBuffer) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      }
    }
  }

  class Geometry {
    constructor(gl, attributes) {
      this.gl = gl;
      this.attributes = attributes;
      this.count = 0;
      for (const k in attributes) {
        const a = attributes[k];
        this.count = this.count || a.data.length / a.size;
      }
      this.vaos = new WeakMap();
    }
    bind(program) {
      const gl = this.gl;
      let vao = this.vaos.get(program);
      if (!vao) {
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        for (const name in this.attributes) {
          const a = this.attributes[name];
          const loc = program.attributeLocations ? program.attributeLocations[name] : undefined;
          if (loc === undefined || loc < 0) continue;
          const buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, 0, 0);
          a.buffer = buf;
        }
        gl.bindVertexArray(null);
        this.vaos.set(program, vao);
      }
      gl.bindVertexArray(vao);
    }
    remove() {
      const gl = this.gl;
      for (const k in this.attributes) {
        if (this.attributes[k].buffer) gl.deleteBuffer(this.attributes[k].buffer);
      }
    }
  }

  class Mesh {
    constructor(gl, { geometry, program, mode }) {
      this.gl = gl;
      this.geometry = geometry;
      this.program = program;
      this.mode = mode === undefined ? gl.TRIANGLES : mode;
    }
  }

  class Renderer {
    constructor(opts = {}) {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', {
        alpha: opts.alpha !== false,
        premultipliedAlpha: opts.premultipliedAlpha !== false,
        antialias: !!opts.antialias,
        depth: opts.depth !== false,
        stencil: false,
        powerPreference: 'high-performance'
      });
      this.canvas = canvas;
      this.gl = gl;
      this.isWebgl2 = !!gl;
      this.dpr = 1;
    }
    setSize(w, h) {
      this.width = w; this.height = h;
      this.canvas.width = Math.max(1, Math.round(w * this.dpr));
      this.canvas.height = Math.max(1, Math.round(h * this.dpr));
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
    }
    render({ scene, target = null, clear = true }) {
      const gl = this.gl;
      const mesh = scene;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.buffer : null);
      if (target) {
        gl.viewport(0, 0, target.width, target.height);
        gl.drawBuffers(target.attachments);
      } else {
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
      if (clear) {
        gl.clearColor(0, 0, 0, 0);
        gl.colorMask(true, true, true, true);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (mesh && mesh.program && mesh.program.program) {
        mesh.program.apply();
        this.draw(mesh);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    draw(mesh) {
      const gl = this.gl;
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      mesh.geometry.bind(mesh.program);
      gl.drawArrays(mesh.mode, 0, mesh.geometry.count);
      gl.bindVertexArray(null);
    }
  }

  const triangle = gl => new Geometry(gl, {
    position: { size: 2, data: new Float32Array([-1, -1, 3, -1, -1, 3]) },
    uv: { size: 2, data: new Float32Array([0, 0, 2, 0, 0, 2]) }
  });

  /* =======================================================
     Part 2 — CrystalizedBall 的数值 / 调色工具（原样移植）
     ======================================================= */
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const smooth = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const mixColor = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const wrapAngle = a => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));

  const MAX_STRANDS = 8;
  const MAX_ARCS = 4;
  const MAX_PARTICLES = 40000;
  const STATE_WIDTH = 256;
  const PIXEL_BUDGET = 4.5e6;
  const INTRO_SECONDS = 2.2;
  const SETTLE_SECONDS = 7;
  const WHITE = [1, 1, 1];
  const BLACK = [0, 0, 0];
  const MOTIONS = { rise: 0, fall: 1, drift: 2, orbit: 3 };
  const SHAPES = { square: 0, round: 1 };

  const BALL_PRESETS = {
    plasma: { color: '#F25BD0', strands: 6, crackle: .85, flares: .65, glow: .9, sparks: .6, particleCount: 15000, fill: .5, motion: 'rise', particleShape: 'square', depth: .6, sway: .5, twinkle: .5, haze: .7, dustSpeed: 1 },
    aurora: { color: '#5CFFC8', strands: 5, crackle: .6, flares: .5, glow: .8, sparks: .45, particleCount: 15000, fill: .5, motion: 'rise', particleShape: 'square', depth: .6, sway: .5, twinkle: .5, haze: .7, dustSpeed: 1 },
    nebula: { color: '#9478FF', strands: 6, crackle: 1, flares: .5, glow: .9, sparks: .6, particleCount: 18000, fill: .45, motion: 'rise', particleShape: 'square', depth: .5, sway: .4, twinkle: .6, haze: .8, dustSpeed: 1.2 },
    ember: { color: '#FF8A2A', strands: 5, crackle: .9, flares: .8, glow: 1, sparks: .8, particleCount: 12000, fill: .35, motion: 'rise', particleShape: 'round', depth: .7, sway: .3, twinkle: .7, haze: .9, dustSpeed: 1.6 },
    frost: { color: '#BFE6FF', strands: 3, crackle: .3, flares: .3, glow: .6, sparks: .2, particleCount: 16000, fill: .6, motion: 'fall', particleShape: 'round', depth: .8, sway: .4, twinkle: .4, haze: .5, dustSpeed: .7 },
    solar: { color: '#FFD36E', strands: 6, crackle: .7, flares: 1, glow: 1.1, sparks: .5, particleCount: 15000, fill: .55, motion: 'orbit', particleShape: 'square', depth: .6, sway: .7, twinkle: .5, haze: .8, dustSpeed: 1 },
    eclipse: { color: '#FFFFFF', strands: 4, crackle: .5, flares: .4, glow: .7, sparks: .35, particleCount: 14000, fill: .5, motion: 'drift', particleShape: 'square', depth: .7, sway: .5, twinkle: .5, haze: .5, dustSpeed: .8 },
    abyss: { color: '#3F7BFF', strands: 5, crackle: .55, flares: .6, glow: .9, sparks: .4, particleCount: 20000, fill: .8, motion: 'orbit', particleShape: 'round', depth: .8, sway: .8, twinkle: .5, haze: .6, dustSpeed: .9 }
  };

  /* 地球专用 preset：低温外壳 + 密 PIN_point + 高识别度的 rim */
  const GLOBE_PRESET = {
    color: '#3DC0F5',
    strands: 6,
    crackle: 0.62,
    flares: 0.72,
    glow: 1.0,
    sparks: 0.5,
    particleCount: 13000,
    fill: 0.5,
    motion: 'drift',
    particleShape: 'square',
    depth: 0.75,
    sway: 0.12,
    twinkle: 0.28,
    haze: 0.8,
    dustSpeed: 0.42
  };

  const parseColor = (value, fallback) => {
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return fallback;
      ctx.fillStyle = '#000000';
      ctx.fillStyle = value;
      const resolved = ctx.fillStyle;
      if (resolved.startsWith('#')) {
        const n = parseInt(resolved.slice(1), 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
      }
      const parts = resolved.match(/[\d.]+/g);
      if (!parts || parts.length < 3) return fallback;
      return [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255];
    } catch (e) {
      return fallback;
    }
  };

  const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toGamma = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  const toOklab = rgb => {
    const [r, g, b] = rgb.map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    ];
  };
  const fromOklab = ([L, a, b]) => {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ].map(v => clamp(toGamma(clamp(v, 0, 1)), 0, 1));
  };
  const blend = (a, b, t) => fromOklab(mixColor(toOklab(a), toOklab(b), t));
  const shift = (rgb, hue, lightness, chroma) => {
    const [L, a, b] = toOklab(rgb);
    const c = Math.hypot(a, b) * chroma;
    const h = Math.atan2(b, a) + (hue * Math.PI) / 180;
    return fromOklab([clamp(L + lightness, 0, 1), c * Math.cos(h), c * Math.sin(h)]);
  };
  const withLightness = (rgb, hue, lightness, chroma) => {
    const [, a, b] = toOklab(rgb);
    const c = Math.max(Math.hypot(a, b) * chroma, 0.02);
    const h = Math.atan2(b, a) + (hue * Math.PI) / 180;
    return fromOklab([clamp(lightness, 0, 1), c * Math.cos(h), c * Math.sin(h)]);
  };

  const buildPalette = (color, light) => {
    if (light) {
      const ink = withLightness(color, 0, Math.min(toOklab(color)[0], 0.62), 1.15);
      return {
        rim: ink, rimHot: ink, rimMid: ink,
        rimDeep: withLightness(color, 0, 0.72, 0.8),
        spark: withLightness(color, 0, 0.6, 1.2),
        sparkGlow: withLightness(color, 0, 0.78, 0.8),
        haze: withLightness(color, 0, 0.8, 0.6),
        edge: withLightness(color, 0, 0.72, 0.8),
        tones: [
          withLightness(color, 0, 0.56, 1.1), withLightness(color, 16, 0.6, 1.05),
          withLightness(color, -16, 0.5, 1.1), withLightness(color, 0, 0.66, 0.9),
          withLightness(color, 0, 0.74, 0.7)
        ]
      };
    }
    return {
      rim: color,
      rimHot: mixColor(color, WHITE, 0.72),
      rimMid: mixColor(color, BLACK, 0.15),
      rimDeep: mixColor(color, BLACK, 0.45),
      spark: mixColor(color, WHITE, 0.45),
      sparkGlow: shift(color, 0, -0.15, 1),
      haze: mixColor(color, BLACK, 0.6),
      edge: shift(color, 0, -0.3, 0.9),
      tones: [
        shift(color, 0, -0.06, 1), shift(color, 16, -0.02, 1), shift(color, -16, -0.12, 1.05),
        shift(blend(color, WHITE, 0.25), 0, 0.04, 1), blend(color, WHITE, 0.7)
      ]
    };
  };

  const seeded = start => {
    let state = start >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const buildStrands = () => {
    const random = seeded(99);
    const bands = [[6, 12, .6, 1.6], [18, 34, 1.5, 3.5], [40, 70, 3, 7], [80, 130, 6, 12]];
    const data = { harmonics: [], rates: [], phases: [], flareHarmonics: [], flareRates: [], flarePhases: [] };
    for (let s = 0; s < MAX_STRANDS; s++) {
      bands.forEach(([low, high, slow, fast]) => {
        data.harmonics.push(Math.round(low + random() * (high - low)));
        data.rates.push((slow + random() * (fast - slow)) * (random() < 0.5 ? -1 : 1));
        data.phases.push(random() * Math.PI * 2);
      });
      for (let j = 0; j < 3; j++) {
        data.flareHarmonics.push(4 + Math.floor(random() * 6));
        data.flareRates.push((0.4 + random() * 0.8) * (random() < 0.5 ? -1 : 1));
        data.flarePhases.push(random() * Math.PI * 2);
      }
      const lead = s === 0;
      data.flareHarmonics.push(lead ? 0.75 : 0.95 + random() * 0.3);
      data.flareRates.push(lead ? 1.15 : 0.8 + random() * 0.2);
      data.flarePhases.push(lead ? 1 : 0.7 + random() * 0.25);
    }
    return data;
  };

  /* ---- 地球专用：把粉尘的「家」换成单位球面上的 fibonacci 点阵 ----
     原本 buildDust 在圆盘内做拒绝采样；地球需要的是随自转变换的球壳点。 */
  const buildGlobeDust = count => {
    const random = seeded(1337);
    const total = Math.min(count, MAX_PARTICLES);
    const rows = Math.max(1, Math.ceil(total / STATE_WIDTH));
    const home = new Float32Array(STATE_WIDTH * rows * 4);
    const seed = new Float32Array(STATE_WIDTH * rows * 4);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < total; i++) {
      const y = 1 - ((i + 0.5) / total) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * golden;
      const rad = 0.952 + random() * 0.028; // 薄壳，制造层次
      home[i * 4] = Math.cos(th) * r * rad;
      home[i * 4 + 1] = y * rad;
      home[i * 4 + 2] = Math.sin(th) * r * rad;
      // 色调档位：少量白热点作为高光
      const q = random();
      home[i * 4 + 3] = q < 0.30 ? 0 : q < 0.52 ? 1 : q < 0.74 ? 2 : q < 0.925 ? 3 : 4;
      seed[i * 4] = 1.05 + random() * 0.95;
      seed[i * 4 + 1] = random();
      seed[i * 4 + 2] = 3.5 + random() * 5.0;
      seed[i * 4 + 3] = 0.030 + random() * 0.055;
    }
    return { home, seed, count: total, rows };
  };

  /* =======================================================
     Part 3 — Shaders（原组件逐句移植，settle 换成球面自转）
     ======================================================= */
  const passVertex = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

  const hashChunk = `
uint scramble(uint v) {
  v = v * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}

float random(uint v) {
  return float(scramble(v)) * (1.0 / 4294967295.0);
}
`;

  /* settle 原本负责「按 fill 沉降成碗形」；地球改成：
     把静态球面点按 uSpin(绕Y) / uTilt(绕X) 旋转，
     与 globe.js 的 project() 数学完全一致，只是 y 轴取负以匹配
     gl_FragCoord / NDC 的「向上为正」。 */
  const dustChunk = `
uniform float uDustTime;
uniform vec2 uTurn;
uniform float uMotion;
uniform float uFill;
uniform float uSpin;
uniform float uTilt;

vec3 settle(vec3 p, out float spread) {
  spread = 1.0;
  float cs = cos(uSpin), ss = sin(uSpin);
  float x = p.x * cs + p.z * ss;
  float z = -p.x * ss + p.z * cs;
  float ct = cos(uTilt), st = sin(uTilt);
  float y2 = p.y * ct - z * st;
  float z2 = p.y * st + z * ct;
  return vec3(x, -y2, z2);
}

vec3 drift(vec4 home, vec4 seed, uint id, out float life, out float spread) {
  vec3 p = settle(home.xyz, spread);
  float t = uDustTime;
  float u = fract(t / seed.z + seed.y);
  life = sin(3.14159265 * u);
  float travel = seed.w;
  if (uMotion < 0.5) {
    p.y += travel * (u - 0.5);
  } else if (uMotion < 1.5) {
    p.y -= travel * (u - 0.5);
  } else if (uMotion < 2.5) {
    p += 0.045 * vec3(
      sin(t * 0.37 + seed.y * 17.0) + 0.5 * sin(t * 0.83 + seed.z * 5.0),
      sin(t * 0.29 + seed.z * 11.0) + 0.5 * sin(t * 0.61 + seed.w * 7.0),
      sin(t * 0.33 + seed.w * 23.0)
    );
  } else {
    float loop = t * (0.6 + 0.9 * random(id * 7u + 3u)) * (random(id * 7u + 10u) < 0.5 ? -1.0 : 1.0) + seed.y * 6.2831853;
    p.xy += (0.025 + 0.05 * random(id * 7u + 16u)) * vec2(cos(loop), sin(loop));
  }
  float wobble = 0.002 + 0.006 * random(id * 7u + 1u);
  float w1 = 0.8 + 2.4 * random(id * 7u + 2u);
  float w2 = 0.8 + 2.4 * random(id * 7u + 4u);
  p += wobble * vec3(sin(t * w1 + seed.y * 40.0), cos(t * w2 + seed.z * 30.0), sin(t * (w1 + w2) * 0.5 + seed.w * 20.0));
  float cy = cos(uTurn.x);
  float sy = sin(uTurn.x);
  p.xz = mat2(cy, -sy, sy, cy) * p.xz;
  float cx = cos(uTurn.y);
  float sx = sin(uTurn.y);
  p.yz = mat2(cx, -sx, sx, cx) * p.yz;
  return p;
}
`;

  const fieldFragment = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform float uRadius;
uniform float uDpr;
uniform float uLine;
uniform float uTime;
uniform float uFrame;
uniform float uBins;
uniform float uStrands;
uniform float uCrackle;
uniform float uFlares;
uniform float uGlow;
uniform float uHaze;
uniform float uFill;
uniform float uPresence;
uniform float uUnfold;
uniform float uBloom;
uniform float uInside;
uniform float uEncode;
uniform vec3 uRim;
uniform vec3 uRimHot;
uniform vec3 uRimMid;
uniform vec3 uRimDeep;
uniform vec3 uSpark;
uniform vec3 uSparkGlow;
uniform vec3 uHazeColor;
uniform vec3 uEdgeColor;
uniform vec4 uHeat;
uniform vec4 uHarmonics[8];
uniform vec4 uRates[8];
uniform vec4 uPhases[8];
uniform vec4 uFlareHarmonics[8];
uniform vec4 uFlareRates[8];
uniform vec4 uFlarePhases[8];
uniform vec4 uArcs[4];

out vec4 fragColor;
${hashChunk}
const float PI = 3.14159265;
const float TAU = 6.28318531;
const vec4 AMPS = vec4(0.35, 0.3, 0.22, 0.13);

float bell(float d, float w) {
  float x = d / w;
  return exp(-x * x);
}

float pool(vec2 q) {
  float t = length(q - vec2(0.0, mix(-1.0, -0.66, uFill))) / mix(0.8, 1.35, uFill);
  return t < 0.6 ? mix(0.5, 0.22, t / 0.6) : mix(0.22, 0.0, clamp((t - 0.6) / 0.4, 0.0, 1.0));
}

void main() {
  vec2 p = gl_FragCoord.xy / uDpr - uCenter;
  float r = length(p);
  float R = uRadius;
  float theta = atan(p.y, p.x);
  float lift = p.y / max(r, 1e-3);
  float topDim = 1.0 - 0.35 * pow(max(lift, 0.0), 1.5);
  vec3 col = vec3(0.0);
  float hot = 0.0;
  uint frame = uint(uFrame);

  if (r < R) {
    vec2 q = p / R;
    float chord = sqrt(max(1.0 - dot(q, q), 0.0));
    float haze = pool(q) * (0.55 + 0.45 * chord);
    col += uHazeColor * haze * uHaze * uInside;
    float e = length(q - vec2(0.0, 0.2)) / 1.2;
    float edge = 0.5 * pow(smoothstep(0.62, 1.0, e), 1.4);
    col += uEdgeColor * edge * uInside * (0.5 + 0.5 * uHaze);
  }

  float dr = r - R;
  float halo = 1.0 - smoothstep(R * 0.05, R * 0.105, abs(dr - R * 0.0213));
  col += uRimDeep * 0.18 * halo * topDim * uGlow * uBloom;
  col += uRim * 0.12 * bell(dr + R * 0.0383, R * 0.032) * uGlow * uBloom;
  col += uRim * 0.32 * bell(dr, max(R * 0.0117, uLine)) * uPresence * uUnfold;

  float delta = mod(theta - uHeat.x + PI, TAU) - PI;
  float heat = uHeat.z * uHeat.y * exp(-delta * delta / 0.3);
  float crackle = uCrackle + heat * 0.9;
  float amp = R * 0.016 * (0.3 + 1.4 * crackle) * uUnfold;
  float jitterAmp = R * 0.0048 * (0.3 + 1.4 * uCrackle) * uUnfold * (1.0 + heat * 0.3);
  float flareAmp = R * 0.064 * (0.4 + 1.2 * crackle) * uFlares * 1.6 * uUnfold;

  if (abs(dr) < amp * 2.0 + flareAmp + R * 0.3) {
    float step = TAU / uBins;
    float binPos = (theta + PI) / step;
    float bin0 = floor(binPos);
    float binF = binPos - bin0;
    float th0 = bin0 * step - PI;
    float th1 = th0 + step;
    uint b0 = uint(mod(bin0, uBins));
    uint b1 = uint(mod(bin0 + 1.0, uBins));
    float gain = min(1.0, 2.4 / max(uStrands, 1.0));
    for (int k = 0; k < 8; k++) {
      if (float(k) >= uStrands) break;
      vec4 m = uHarmonics[k];
      vec4 lead = uRates[k] * uTime + uPhases[k];
      float wave0 = dot(AMPS, sin(m * th0 + lead));
      float wave1 = dot(AMPS, sin(m * th1 + lead));
      uint salt = uint(k) * 1013u + frame * 7919u;
      vec4 shape = uFlareHarmonics[k];
      vec4 look = uFlareRates[k];
      vec4 tone = uFlarePhases[k];
      float a = amp * shape.w;
      float off0 = a * wave0 + jitterAmp * (random(b0 + salt) - 0.5);
      float off1 = a * wave1 + jitterAmp * (random(b1 + salt) - 0.5);
      float rc = R + mix(off0, off1, binF);
      float grade = (off1 - off0) / (step * max(r, 1.0));
      float d = abs(r - rc) * inversesqrt(1.0 + grade * grade);
      float swell = 0.8 + 0.4 * (0.5 + 0.5 * sin(3.0 * theta + uTime * 0.7 + tone.x * 1.7));
      float width = uLine * look.w * swell * (1.0 + heat * 0.25);
      float core = exp(-d * d / (width * width));
      float sheath = exp(-d * d / (width * width * 3.0));
      float bright = tone.w * (1.0 + heat * 0.45) * uPresence;
      col += (uRimHot * core * 0.8 + uRim * sheath * 0.32) * bright;
      hot += core * bright;
      vec3 fargs = shape.xyz * theta + look.xyz * uTime + tone.xyz;
      float flare = max(0.0, (sin(fargs.x) + sin(fargs.y) + sin(fargs.z)) / 3.0);
      flare = (flare * flare + heat * 0.35) * flareAmp;
      float dw = abs(r - rc - flare);
      float dm = abs(r - rc - flare * 0.6);
      float dn = abs(r - rc - flare * 0.25);
      vec3 glow = uRimDeep * (0.07 * bell(dw, R * 0.09) + 0.16 * bell(dw, R * 0.05));
      glow += uRimMid * 0.28 * bell(dm, R * 0.027) + uRim * 0.38 * bell(dn, R * 0.013);
      col += glow * gain * topDim * uGlow * uBloom * (1.0 + heat * 1.4);
    }
  }

  for (int i = 0; i < 4; i++) {
    vec4 arc = uArcs[i];
    if (arc.w <= 0.002) continue;
    float mid = arc.x + arc.y * 0.5;
    vec2 center = R * 0.93 * vec2(cos(mid), sin(mid));
    if (distance(p, center) > R * (abs(arc.y) * 0.6 + 0.1) + 12.0) continue;
    float ar = R * 0.955;
    vec2 a0 = ar * vec2(cos(arc.x), sin(arc.x));
    vec2 a2 = ar * vec2(cos(arc.x + arc.y), sin(arc.x + arc.y));
    vec2 a1 = R * (0.955 - arc.z) * vec2(cos(mid), sin(mid));
    float dmin = 1e5;
    float along = 0.0;
    vec2 prev = a0;
    for (int s = 1; s <= 10; s++) {
      float u = float(s) / 10.0;
      vec2 b = mix(mix(a0, a1, u), mix(a1, a2, u), u);
      vec2 pa = p - prev;
      vec2 ba = b - prev;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
      float dist = length(pa - ba * h);
      if (dist < dmin) {
        dmin = dist;
        along = (float(s) - 1.0 + h) / 10.0;
      }
      prev = b;
    }
    float taper = sqrt(max(sin(PI * along), 0.0));
    float arcWidth = uLine * (0.55 + 0.6 * taper);
    float arcCore = exp(-dmin * dmin / (arcWidth * arcWidth));
    float arcGlow = exp(-dmin * dmin / (arcWidth * arcWidth * 12.0));
    col += (uSpark * 0.95 * arcCore + uSparkGlow * 0.4 * arcGlow) * arc.w * taper;
    hot += arcCore * arc.w * taper * 0.6;
  }

  fragColor = vec4(col, hot) * uEncode;
}
`;

  /* dustVertex：新增背面剔除 uBack Proxy —— 地球是不透明球体，
     背面的点不应像玻璃球那样透出来。 */
  const dustVertex = `#version 300 es
precision highp float;

in float aIndex;

uniform sampler2D tHome;
uniform sampler2D tSeed;
uniform sampler2D tOffset;
uniform float uStirred;
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uRadius;
uniform float uDpr;
uniform float uDepth;
uniform float uTwinkle;
uniform float uPointScale;
uniform float uReveal;
uniform float uEncode;
uniform float uRimBoost;
uniform vec3 uTones[5];
uniform vec3 uRimTone;

out vec3 vColor;
out float vSize;
${hashChunk}
${dustChunk}
void main() {
  ivec2 cell = ivec2(int(mod(aIndex, ${STATE_WIDTH}.0)), int(floor(aIndex / ${STATE_WIDTH}.0)));
  uint id = uint(aIndex);
  vec4 home = texelFetch(tHome, cell, 0);
  vec4 seed = texelFetch(tSeed, cell, 0);
  float life;
  float spread;
  vec3 p = drift(home, seed, id, life, spread);
  if (uStirred > 0.5) p += texelFetch(tOffset, cell, 0).xyz;
  float len = length(p);
  float inside = 1.0 - smoothstep(0.955, 0.985, length(p.xy));
  if (len > 0.975) p *= 0.975 / len;

  // 地球背面：z < 0 的点被本体挡住
  float vis = smoothstep(-0.10, 0.06, p.z);

  float front = p.z * 0.5 + 0.5;
  float depthSize = mix(1.0, 0.7 + 0.6 * front, uDepth);
  float depthLight = mix(1.0, 0.35 + 0.8 * front, uDepth);
  float blink = sin(uDustTime * (2.0 + 6.0 * random(id * 7u + 5u)) + random(id * 7u + 6u) * 6.2831853);
  float twinkle = mix(1.0, smoothstep(-0.9, -0.6, blink), uTwinkle);
  float fade = smoothstep(0.04, 0.12, life);
  float order = (home.y + 1.0) * 0.5 * 0.55 + random(id * 7u + 8u) * 0.25;
  float reveal = smoothstep(order, order + 0.2, uReveal * 1.0);
  float alpha = random(id * 7u + 9u) < 0.5 || home.w > 3.5 ? 1.0 : 0.6;

  float size = seed.x * uPointScale * (0.35 + 0.95 * life) * depthSize * mix(0.5, 1.0, reveal);
  vec2 screen = uCenter + p.xy * uRadius;
  gl_Position = vec4(screen / uViewport * 2.0 - 1.0, 0.0, 1.0);
  float px = size * uDpr;
  gl_PointSize = px + 2.0;
  vSize = px;

  int tone = int(home.w + 0.5);
  float rimLit = smoothstep(0.78, 0.98, length(p.xy));
  vec3 color = uTones[tone] + uRimTone * rimLit * rimLit * uRimBoost;
  vColor = color * alpha * fade * twinkle * depthLight * reveal * inside * sqrt(spread) * vis * uEncode;
}
`;

  const dustFragment = `#version 300 es
precision highp float;

uniform float uShape;

in vec3 vColor;
in float vSize;

out vec4 fragColor;

void main() {
  vec2 q = (gl_PointCoord - 0.5) * (vSize + 2.0);
  float half_ = max(vSize * 0.5, 0.5);
  float cover;
  if (uShape < 0.5) {
    vec2 c = clamp(half_ - abs(q) + 0.5, 0.0, 1.0);
    cover = c.x * c.y;
  } else {
    cover = clamp(half_ - length(q) + 0.5, 0.0, 1.0);
  }
  if (cover <= 0.0) discard;
  fragColor = vec4(vColor * cover, 0.0);
}
`;

  const stirFragment = `#version 300 es
precision highp float;

uniform sampler2D tHome;
uniform sampler2D tSeed;
uniform sampler2D tOffset;
uniform sampler2D tVelocity;
uniform float uDt;
uniform float uReset;
uniform vec4 uBrush;
uniform float uBrushPower;
uniform vec4 uKick;

layout(location = 0) out vec4 outOffset;
layout(location = 1) out vec4 outVelocity;
${hashChunk}
${dustChunk}
vec3 swirl(vec3 p) {
  float t = uDustTime * 0.15;
  vec3 a = vec3(1.7, 1.9, 1.5) * p.yzx + vec3(t, 1.2, 2.1);
  vec3 b = vec3(2.3, 2.1, 2.7) * p.zxy + vec3(0.4, t * 1.3, 0.9);
  vec3 ca = cos(a) * vec3(1.7, 1.9, 1.5);
  vec3 cb = cos(b) * vec3(2.3, 2.1, 2.7);
  return vec3(ca.z - cb.x, cb.y - ca.x, ca.y - cb.z);
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  if (uReset > 0.5) {
    outOffset = vec4(0.0);
    outVelocity = vec4(0.0);
    return;
  }
  uint id = uint(cell.y * ${STATE_WIDTH} + cell.x);
  vec4 home = texelFetch(tHome, cell, 0);
  vec4 seed = texelFetch(tSeed, cell, 0);
  vec3 o = texelFetch(tOffset, cell, 0).xyz;
  vec3 v = texelFetch(tVelocity, cell, 0).xyz;
  float life;
  float spread;
  vec3 base = drift(home, seed, id, life, spread);
  vec3 p = base + o;

  float k = mix(0.8, 2.2, random(id * 7u + 11u));
  vec3 acc = -k * o - 1.5 * sqrt(k) * v;

  vec2 gap = p.xy - uBrush.xy;
  float touch = exp(-dot(gap, gap) / 0.07) * uBrushPower;
  acc += (vec3(uBrush.zw, 0.0) - v) * touch * 14.0;
  float pace = length(v);
  if (pace > 1e-4) {
    vec3 heading = v / pace;
    vec3 curl = swirl(p * 1.6);
    acc += (curl - heading * dot(curl, heading)) * min(pace, 2.0) * 1.8;
  }

  if (uKick.z > 0.0) {
    vec3 jolt = vec3(random(id * 7u + 12u), random(id * 7u + 13u), random(id * 7u + 14u)) - 0.5;
    float near = exp(-dot(p.xy - uKick.xy, p.xy - uKick.xy) / 0.4);
    vec3 spinKick = vec3(-p.z, 0.0, p.x) * 0.9;
    vec3 lift = vec3(0.0, 0.5 + 0.8 * random(id * 7u + 15u), 0.0) * (0.3 + 0.7 * smoothstep(0.2, -0.8, p.y));
    v += (jolt * 0.8 + spinKick + lift) * uKick.z * (0.4 + 0.45 * near);
  }

  v += acc * uDt;
  o += v * uDt;
  vec3 q = base + o;
  float len = length(q);
  if (len > 0.97) {
    vec3 n = q / len;
    o -= n * (len - 0.97);
    v -= n * max(dot(v, n), 0.0) * 1.5;
  }
  outOffset = vec4(o, 1.0);
  outVelocity = vec4(v, 1.0);
}
`;

  const compositeFragment = `#version 300 es
precision highp float;

uniform sampler2D tScene;
uniform float uLight;
uniform float uDecode;
uniform float uInkGain;

in vec2 vUv;
out vec4 fragColor;

vec3 soften(vec3 x) {
  vec3 over = max(x - 0.6, 0.0);
  return min(x, 0.6) + 0.4 * (1.0 - exp(-over / 0.4));
}

void main() {
  vec4 scene = texture(tScene, vUv) * uDecode;
  vec3 light = max(scene.rgb, 0.0);
  float peak = max(light.r, max(light.g, light.b));
  if (uLight > 0.5) {
    // 墨迹模式：降低覆盖增益，保住颗粒感，也让下层网格透出来
    float p = peak * uInkGain;
    vec3 hue = light / max(peak, 1e-4);
    float cover = 1.0 - exp(-p * 2.4);
    vec3 ink = hue * mix(0.92, 0.72, cover);
    float core = clamp(scene.a * 0.7, 0.0, 1.0) * cover;
    vec3 tint = mix(vec3(1.0), hue, 0.22);
    fragColor = vec4(tint * core + ink * cover * (1.0 - core), core + cover * (1.0 - core));
    return;
  }
  light += vec3(max(peak - 1.8, 0.0) * 0.25);
  vec3 shown = soften(light);
  fragColor = vec4(shown, max(shown.r, max(shown.g, shown.b)));
}
`;

  /* =======================================================
     Part 4 — 主逻辑
     ======================================================= */
  const stage = document.querySelector('.globe-stage');
  const globeCanvas = document.getElementById('globe');
  if (!stage || !globeCanvas) return;

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
  if (!renderer.isWebgl2) return;
  const gl = renderer.gl;
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return;

  const canvas = renderer.canvas;
  canvas.className = 'globe-fx';
  canvas.setAttribute('aria-hidden', 'true');
  stage.appendChild(canvas);

  const config = Object.assign({}, GLOBE_PRESET);

  /* ---------- 主题色 ---------- */
  let palette = null;
  let lightMode = false;
  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const accent = (s.getPropertyValue('--accent') || '#3DC0F5').trim();
    lightMode = document.documentElement.getAttribute('data-theme') === 'light';
    palette = buildPalette(parseColor(accent, [0.24, 0.75, 0.96]), false);
  }
  readColors();
  window.addEventListener('themechange', readColors);

  /* ---------- WebGL 资源 ---------- */
  const fullFloat = !!gl.getExtension('EXT_color_buffer_float');
  const halfFloat = fullFloat || !!gl.getExtension('EXT_color_buffer_half_float');
  const encode = halfFloat ? 1 : 0.25;
  const geo = triangle(gl);
  const blank = new Texture(gl);
  const strandData = buildStrands();

  const sceneTarget = new RenderTarget(gl, {
    width: 1, height: 1, depth: false,
    type: halfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    format: gl.RGBA, internalFormat: halfFloat ? gl.RGBA16F : gl.RGBA,
    minFilter: gl.NEAREST, magFilter: gl.NEAREST
  });

  const arcData = new Array(MAX_ARCS * 4).fill(0);
  const fieldUniforms = {
    uCenter: { value: [0, 0] }, uRadius: { value: 1 }, uDpr: { value: 1 }, uLine: { value: 0.6 },
    uTime: { value: 0 }, uFrame: { value: 0 }, uBins: { value: 420 }, uStrands: { value: 5 },
    uCrackle: { value: 0.6 }, uFlares: { value: 0.5 }, uGlow: { value: 0.8 }, uHaze: { value: 0.7 },
    uFill: { value: 0.5 }, uPresence: { value: 0 }, uUnfold: { value: 0 }, uBloom: { value: 0 },
    uInside: { value: 0 }, uEncode: { value: encode },
    uRim: { value: [1, 1, 1] }, uRimHot: { value: [1, 1, 1] }, uRimMid: { value: [1, 1, 1] },
    uRimDeep: { value: [1, 1, 1] }, uSpark: { value: [1, 1, 1] }, uSparkGlow: { value: [1, 1, 1] },
    uHazeColor: { value: [0, 0, 0] }, uEdgeColor: { value: [0, 0, 0] }, uHeat: { value: [0, 0, 0, 0] },
    uHarmonics: { value: strandData.harmonics }, uRates: { value: strandData.rates },
    uPhases: { value: strandData.phases }, uFlareHarmonics: { value: strandData.flareHarmonics },
    uFlareRates: { value: strandData.flareRates }, uFlarePhases: { value: strandData.flarePhases },
    uArcs: { value: arcData }
  };

  const dustShared = {
    uDustTime: { value: 0 }, uTurn: { value: [0, 0] }, uMotion: { value: 0 },
    uFill: fieldUniforms.uFill, uSpin: { value: 0.6 }, uTilt: { value: -0.42 },
    tHome: { value: blank }, tSeed: { value: blank }
  };

  const dustUniforms = {
    ...dustShared,
    tOffset: { value: blank }, uStirred: { value: 0 },
    uCenter: fieldUniforms.uCenter, uViewport: { value: [1, 1] },
    uRadius: fieldUniforms.uRadius, uDpr: fieldUniforms.uDpr,
    uDepth: { value: 0.75 }, uTwinkle: { value: 0.3 }, uPointScale: { value: 1 },
    uReveal: { value: 0 }, uEncode: { value: encode }, uRimBoost: { value: 0.55 },
    uTones: { value: new Array(15).fill(1) }, uRimTone: { value: [1, 1, 1] }, uShape: { value: 0 }
  };

  const stirUniforms = {
    ...dustShared,
    tOffset: { value: blank }, tVelocity: { value: blank },
    uDt: { value: 0.016 }, uReset: { value: 1 },
    uBrush: { value: [0, 0, 0, 0] }, uBrushPower: { value: 0 }, uKick: { value: [0, 0, 0, 0] }
  };

  const compositeUniforms = { tScene: { value: sceneTarget.textures[0] }, uLight: { value: 0 }, uDecode: { value: 1 / encode }, uInkGain: { value: 1 } };

  const additive = program => { program.setBlendFunc(gl.ONE, gl.ONE); return program; };

  const fieldProgram = additive(new Program(gl, {
    vertex: passVertex, fragment: fieldFragment, uniforms: fieldUniforms,
    transparent: true, depthTest: false, depthWrite: false
  }));
  const dustProgram = additive(new Program(gl, {
    vertex: dustVertex, fragment: dustFragment, uniforms: dustUniforms,
    transparent: true, depthTest: false, depthWrite: false
  }));
  const stirProgram = new Program(gl, {
    vertex: passVertex, fragment: stirFragment, uniforms: stirUniforms,
    depthTest: false, depthWrite: false
  });
  const compositeProgram = new Program(gl, {
    vertex: passVertex, fragment: compositeFragment, uniforms: compositeUniforms,
    depthTest: false, depthWrite: false
  });

  if (!fieldProgram.program || !dustProgram.program || !stirProgram.program || !compositeProgram.program) {
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    return;
  }

  const fieldMesh = new Mesh(gl, { geometry: geo, program: fieldProgram });
  const stirMesh = new Mesh(gl, { geometry: geo, program: stirProgram });
  const compositeMesh = new Mesh(gl, { geometry: geo, program: compositeProgram });

  const disposeTarget = target => {
    if (!target) return;
    gl.deleteFramebuffer(target.buffer);
    target.textures.forEach(t => gl.deleteTexture(t.texture));
  };

  const stateTarget = rows => new RenderTarget(gl, {
    width: STATE_WIDTH, height: rows, color: 2, depth: false,
    type: fullFloat ? gl.FLOAT : gl.HALF_FLOAT,
    format: gl.RGBA, internalFormat: fullFloat ? gl.RGBA32F : gl.RGBA16F,
    minFilter: gl.NEAREST, magFilter: gl.NEAREST
  });

  const dataTexture = (data, rows) => new Texture(gl, {
    image: data, width: STATE_WIDTH, height: rows,
    type: gl.FLOAT, format: gl.RGBA, internalFormat: gl.RGBA32F,
    minFilter: gl.NEAREST, magFilter: gl.NEAREST, generateMipmaps: false, flipY: false
  });

  let dust = null;
  const disposeDust = () => {
    if (!dust) return;
    dust.mesh.geometry.remove();
    gl.deleteTexture(dust.home.texture);
    gl.deleteTexture(dust.seed.texture);
    disposeTarget(dust.read);
    disposeTarget(dust.write);
    dust = null;
  };
  const resetStir = () => {
    if (!dust || !dust.read || !dust.write) return;
    stirUniforms.tOffset.value = blank;
    stirUniforms.tVelocity.value = blank;
    stirUniforms.uReset.value = 1;
    renderer.render({ scene: stirMesh, target: dust.read, clear: false });
    renderer.render({ scene: stirMesh, target: dust.write, clear: false });
    stirUniforms.uReset.value = 0;
  };
  const rebuildDust = requested => {
    const total = clamp(Math.round(requested / 100) * 100, 0, MAX_PARTICLES);
    if (dust && dust.requested === total) return;
    disposeDust();
    if (!total) { dust = null; return; }
    const data = buildGlobeDust(total);
    const indices = new Float32Array(data.count);
    for (let i = 0; i < data.count; i++) indices[i] = i;
    const points = new Geometry(gl, { aIndex: { size: 1, data: indices } });
    dust = {
      requested: total, rows: data.rows,
      home: dataTexture(data.home, data.rows), seed: dataTexture(data.seed, data.rows),
      mesh: new Mesh(gl, { mode: gl.POINTS, geometry: points, program: dustProgram }),
      read: stateTarget(data.rows), write: stateTarget(data.rows)
    };
    dustShared.tHome.value = dust.home;
    dustShared.tSeed.value = dust.seed;
    resetStir();
    stirring = 0;
  };

  const random = seeded(913);
  let width = 1, height = 1;
  let raf = 0, last = performance.now();
  let rimTime = 0, dustTime = 0, swayClock = 0, introClock = 0;
  let visible = true, alive = true, everDrawn = false, surge = 0, stirring = 0, stirEnergy = 0, kick = null, nextArc = 0.3;
  const arcs = [];
  const pointer = { x: 0, y: 0, inside: false, fresh: true };
  const heat = { angle: 0, velocity: 0, power: 0, near: 0 };
  const brush = { x: 0, y: 0, vx: 0, vy: 0 };
  const look = { x: 0, y: 0, vx: 0, vy: 0 };

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    renderer.dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / Math.max(1, width * height)));
    renderer.setSize(width, height);
    sceneTarget.setSize(gl.canvas.width, gl.canvas.height);
    start();
  }

  const spawnArc = (angle, strength) => {
    if (arcs.length >= MAX_ARCS) return;
    arcs.push({
      start: angle,
      span: (0.05 + random() * 0.07) * (random() < 0.5 ? -1 : 1),
      curl: 0.02 + random() * 0.04,
      life: 0, duration: 0.2 + random() * 0.2,
      drift: (random() - 0.5) * 0.3, strength
    });
  };

  /* 可见性用 rect 直接判断，而不是 IntersectionObserver：
     IO 的回调是异步的，一旦最后一次报告是「不可见」而之后
     视口变化没再触发回调（滚动恢复、移动端缩放等），循环就会
     永久停住。这里改成同步判断 + 自愈心跳，稳得多。 */
  function stageVisible() {
    const r = stage.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (!r.width || !r.height) return false;
    // 留出上下各一个自身高度、左右各 80px 的余量，进场前就开始动
    return r.bottom > -r.height && r.top < vh + r.height && r.right > -80 && r.left < vw + 80;
  }

  function frame(now) {
    raf = 0;
    if (!alive) return;
    visible = stageVisible();
    if (!visible) return; // 交给心跳重新拉起
    const st = window.__globeState;
    if (!st || !st.ready) { raf = requestAnimationFrame(frame); return; }

    const dt = Math.min(0.05, Math.max(1 / 240, (now - last) / 1000));
    last = now;
    if (!palette) { raf = requestAnimationFrame(frame); return; }

    const s = config;
    const moving = !reducedMotion;
    introClock = s.intro && !reducedMotion ? Math.min(1, introClock + dt / INTRO_SECONDS) : 1;
    const presence = easeOut(smooth(0, 0.42, introClock));
    const unfold = easeOut(smooth(0, 0.32, introClock));
    const charge = Math.sin(Math.PI * smooth(0.22, 0.78, introClock)) * 0.35;

    // —— 与 Canvas 2D 地球完全同步的几何 ——
    const cx = st.cx, cy = st.cy, R = st.R;
    const radius = R;
    // gl_FragCoord 以左下为原点；DOM y 向下 → 取 H - cy
    const centerGL = [cx, st.H - cy];

    const strength = s.interactive && !reducedMotion ? clamp(s.hoverStrength, 0, 1) : 0;
    const px = pointer.x - cx;
    const py = cy - pointer.y; // 转成 GL 的 y 向上
    const reach = Math.hypot(px, py);
    const target = pointer.inside ? strength : 0;
    if (heat.power < 0.02) { heat.angle = Math.atan2(py, px); heat.velocity = 0; }
    const turn = wrapAngle(Math.atan2(py, px) - heat.angle);
    heat.velocity += (120 * turn - 19 * heat.velocity) * dt;
    heat.angle = wrapAngle(heat.angle + heat.velocity * dt);
    heat.power += (target - heat.power) * (1 - Math.exp(-dt / (target > heat.power ? 0.3 : 0.55)));
    const nearTarget = Math.exp(-Math.pow((reach - radius) / (radius * 0.45), 2));
    heat.near += (nearTarget - heat.near) * (1 - Math.exp(-dt / 0.15));
    surge *= Math.exp(-dt / 0.7);

    const bx = px / radius;
    const by = py / radius;
    if (Math.hypot(bx - brush.x, by - brush.y) > 0.6) pointer.fresh = true;
    if (pointer.fresh) { brush.x = bx; brush.y = by; brush.vx = 0; brush.vy = 0; pointer.fresh = false; }
    const follow = 1 - Math.exp(-dt / 0.05);
    brush.vx += ((bx - brush.x) / dt - brush.vx) * follow;
    brush.vy += ((by - brush.y) / dt - brush.vy) * follow;
    brush.x = bx; brush.y = by;
    const brushSpeed = Math.hypot(brush.vx, brush.vy);
    const cap = brushSpeed > 4 ? 4 / brushSpeed : 1;
    const inBall = Math.exp(-Math.max(0, Math.hypot(bx, by) - 1) * 6);
    const brushPower = pointer.inside ? strength * inBall * presence : 0;
    stirEnergy = stirEnergy * Math.exp(-dt / 1.2) + brushPower * Math.min(brushSpeed, 4) * dt;

    if (moving) {
      const pace = 1 + surge * 0.6 + heat.power * heat.near * 0.3;
      const step = dt * Math.max(0, s.speed) * 2 * pace;
      rimTime += step;
      dustTime += dt * Math.max(0, s.dustSpeed) * (1 + surge * 0.4);
      swayClock += dt * Math.max(0, s.dustSpeed);
      const crackleNow = clamp(s.crackle + surge * 0.5, 0, 1.5);
      if (s.sparks > 0.01 && introClock > 0.55) {
        nextArc -= step * s.sparks * 2 * (0.6 + crackleNow * 0.6);
        if (nextArc <= 0) {
          const local = heat.power * heat.near;
          const angle = random() < local * 0.7
            ? heat.angle + (random() - 0.5) * 0.8
            : random() < 0.7 ? Math.PI / 2 + (random() - 0.5) * 1.5 : random() * Math.PI * 2;
          spawnArc(angle, 0.8 + local * 0.6 + surge * 0.4);
          nextArc = 0.15 + random() * 0.6;
        }
      }
      for (let i = arcs.length - 1; i >= 0; i--) {
        const arc = arcs[i];
        arc.life += step;
        arc.start += arc.drift * step;
        if (arc.life >= arc.duration) arcs.splice(i, 1);
      }
    } else {
      arcs.length = 0;
    }
    for (let i = 0; i < MAX_ARCS; i++) {
      const arc = arcs[i];
      arcData[i * 4] = arc ? arc.start : 0;
      arcData[i * 4 + 1] = arc ? arc.span : 0;
      arcData[i * 4 + 2] = arc ? arc.curl : 0;
      arcData[i * 4 + 3] = arc ? Math.sin((Math.PI * arc.life) / arc.duration) * arc.strength : 0;
    }

    // 粒子密度按球面积缩放，避免小屏（移动端）点阵糊成一团
    const areaScale = clamp((width * height) / (620 * 620), 0.32, 1.15);
    rebuildDust(Math.round(s.particleCount * areaScale));
    // 浅色主题：对白底做加法发光无效，改用原组件的 ink 墨迹合成
    // （清晰墨点 + 白热 rim 核心），并把内晕压到极低，
    // 好让下层的经纬网与航线透出来。
    const lightScale = lightMode ? 0.55 : 1;
    const hazeScale = lightMode ? 0.10 : 1;

    fieldUniforms.uCenter.value = centerGL;
    fieldUniforms.uRadius.value = radius;
    fieldUniforms.uDpr.value = renderer.dpr;
    fieldUniforms.uLine.value = Math.max(0.6, radius * 0.0035);
    fieldUniforms.uTime.value = rimTime;
    fieldUniforms.uFrame.value = Math.floor(rimTime * 24) % 100000;
    fieldUniforms.uBins.value = clamp(Math.round((Math.PI * 2 * radius) / 2.6), 240, 900);
    fieldUniforms.uStrands.value = Math.round(clamp(s.strands, 1, MAX_STRANDS));
    fieldUniforms.uCrackle.value = clamp(s.crackle, 0, 1) + surge * 0.5 + charge;
    fieldUniforms.uFlares.value = clamp(s.flares, 0, 1);
    fieldUniforms.uGlow.value = clamp(s.glow, 0, 2) * (1 + surge * 0.5 + charge) * lightScale;
    fieldUniforms.uHaze.value = clamp(s.haze, 0, 2) * lightScale * hazeScale;
    fieldUniforms.uFill.value = clamp(s.fill, 0, 1);
    fieldUniforms.uPresence.value = presence;
    fieldUniforms.uUnfold.value = unfold;
    fieldUniforms.uBloom.value = presence * presence;
    fieldUniforms.uInside.value = smooth(0.2, 0.95, introClock) * (lightMode ? 0.12 : 0.85);
    fieldUniforms.uRim.value = palette.rim;
    fieldUniforms.uRimHot.value = palette.rimHot;
    fieldUniforms.uRimMid.value = palette.rimMid;
    fieldUniforms.uRimDeep.value = palette.rimDeep;
    fieldUniforms.uSpark.value = palette.spark;
    fieldUniforms.uSparkGlow.value = palette.sparkGlow;
    fieldUniforms.uHazeColor.value = palette.haze;
    fieldUniforms.uEdgeColor.value = palette.edge;
    fieldUniforms.uHeat.value = [heat.angle, heat.near, heat.power * presence, 0];

    dustShared.uDustTime.value = dustTime;
    dustShared.uSpin.value = st.rot;
    dustShared.uTilt.value = st.tilt;
    const gaze = pointer.inside ? strength * presence : 0;
    const lookX = clamp(bx, -1.6, 1.6) * gaze;
    const lookY = clamp(by, -1.6, 1.6) * gaze;
    look.vx += (40 * (lookX - look.x) - 11 * look.vx) * dt;
    look.vy += (40 * (lookY - look.y) - 11 * look.vy) * dt;
    look.x += look.vx * dt;
    look.y += look.vy * dt;
    const swing = clamp(s.sway, 0, 1);
    dustShared.uTurn.value = [
      swing * 0.42 * Math.sin(swayClock * 0.23) + look.x * 0.3,
      swing * 0.12 * Math.sin(swayClock * 0.17 + 1.3) - look.y * 0.16
    ];
    dustShared.uMotion.value = MOTIONS[s.motion] === undefined ? 0 : MOTIONS[s.motion];
    dustUniforms.uViewport.value = [width, height];
    dustUniforms.uDepth.value = clamp(s.depth, 0, 1);
    dustUniforms.uTwinkle.value = clamp(s.twinkle, 0, 1);
    dustUniforms.uPointScale.value = Math.max(1, radius / 420);
    dustUniforms.uReveal.value = smooth(0.18, 1, introClock);
    dustUniforms.uTones.value = palette.tones.flat();
    dustUniforms.uRimTone.value = palette.rim;
    dustUniforms.uShape.value = SHAPES[s.particleShape] === undefined ? 0 : SHAPES[s.particleShape];

    const layer = dust;
    if (layer && (stirEnergy > 0.002 || kick)) stirring = SETTLE_SECONDS;
    let stirred = false;
    if (layer && layer.read && layer.write && stirring > 0) {
      stirUniforms.uDt.value = Math.min(dt, 1 / 30);
      stirUniforms.uBrush.value = [brush.x, brush.y, brush.vx * cap, brush.vy * cap];
      stirUniforms.uBrushPower.value = brushPower;
      stirUniforms.uKick.value = kick ? [kick.x, kick.y, kick.strength, 0] : [0, 0, 0, 0];
      stirUniforms.tOffset.value = layer.read.textures[0];
      stirUniforms.tVelocity.value = layer.read.textures[1];
      renderer.render({ scene: stirMesh, target: layer.write, clear: false });
      const swap = layer.read; layer.read = layer.write; layer.write = swap;
      stirring -= dt;
      stirred = stirring > 0;
      if (!stirred) { stirring = 0; resetStir(); }
    }
    kick = null;
    dustUniforms.uStirred.value = stirred ? 1 : 0;
    dustUniforms.tOffset.value = layer && layer.read ? layer.read.textures[0] : blank;

    renderer.render({ scene: fieldMesh, target: sceneTarget, clear: true });
    if (dust) renderer.render({ scene: dust.mesh, target: sceneTarget, clear: false });
    compositeUniforms.uLight.value = lightMode ? 1 : 0;
    compositeUniforms.uInkGain.value = lightMode ? 0.5 : 1;
    renderer.render({ scene: compositeMesh, clear: false });

    // 首帧真正画出来之后才接管 Canvas 2D 的点阵，避免任何异常下丢内容
    if (!everDrawn) { everDrawn = true; window.__globeFxOn = true; }

    const settling =
      Math.abs(target - heat.power) > 0.002 || surge > 0.002 || stirring > 0 ||
      Math.abs(heat.velocity) > 0.01 || Math.hypot(look.vx, look.vy, look.x - lookX, look.y - lookY) > 0.001;
    if (visible && (moving || introClock < 1 || settling)) raf = requestAnimationFrame(frame);
  }

  const start = () => {
    if (raf || !alive) return;
    if (!stageVisible()) { visible = false; return; }
    visible = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const locate = e => {
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, inside: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
  };
  const onPointerMove = e => {
    const spot = locate(e);
    if (spot.inside && !pointer.inside) pointer.fresh = true;
    pointer.x = spot.x; pointer.y = spot.y; pointer.inside = spot.inside;
    if (spot.inside) start();
  };
  const onPointerDown = e => {
    const spot = locate(e);
    if (reducedMotion || !spot.inside) return;
    const st = window.__globeState;
    if (!st || !st.ready) return;
    if (!pointer.inside) pointer.fresh = true;
    pointer.x = spot.x; pointer.y = spot.y; pointer.inside = true;
    const radius = st.R;
    const kx = (spot.x - st.cx) / radius;
    const ky = (st.cy - spot.y) / radius;
    if (Math.hypot(kx, ky) > 1.3) return;
    const strength = clamp(config.hoverStrength, 0, 1);
    kick = { x: kx, y: ky, strength: strength * 1.2 };
    surge = Math.max(surge, strength);
    const angle = Math.atan2(ky, kx);
    spawnArc(angle + (random() - 0.5) * 0.5, 1.3);
    spawnArc(angle + Math.PI + (random() - 0.5) * 1.2, 1.1);
    start();
  };
  const onPointerLeave = () => { pointer.inside = false; start(); };
  const onPointerOut = e => { if (!e.relatedTarget) onPointerLeave(); };
  const onPointerUp = e => { if (e.pointerType === 'touch') onPointerLeave(); };
  const onVisibility = () => { if (!document.hidden) start(); };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerout', onPointerOut, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('blur', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);

  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  window.addEventListener('resize', resize, { passive: true });

  // 自愈心跳：循环停了就把它拉起来（reduced-motion 下只补首帧）
  const heartbeat = setInterval(() => {
    if (raf) return;
    if (!everDrawn || !reducedMotion) start();
  }, 400);
  void heartbeat;

  config.speed = 1;
  config.interactive = true;
  config.hoverStrength = 0.8;
  config.intro = true;
  config.paused = false;

  resize();
  start();

  window.__crystalGlobe = {
    start,
    set(opts) { Object.assign(config, opts); start(); },
    preset(name) { Object.assign(config, BALL_PRESETS[name] || {}); },
    /* 诊断用：内部运行状态快照 */
    debug() {
      return {
        raf: !!raf, visible, alive, everDrawn,
        width, height, dpr: renderer.dpr,
        backing: [canvas.width, canvas.height],
        introClock: +introClock.toFixed(3), lightMode, palette: !!palette,
        dust: dust ? dust.requested : 0, rows: dust ? dust.rows : 0,
        rimTime: +rimTime.toFixed(2), dustTime: +dustTime.toFixed(2),
        R: +fieldUniforms.uRadius.value.toFixed(1),
        presence: +fieldUniforms.uPresence.value.toFixed(3),
        glow: +fieldUniforms.uGlow.value.toFixed(3),
        pointScale: +dustUniforms.uPointScale.value.toFixed(3),
        viewport: dustUniforms.uViewport.value.map(v => Math.round(v)),
        center: fieldUniforms.uCenter.value.map(v => Math.round(v)),
        motion: dustShared.uMotion.value, spin: +dustShared.uSpin.value.toFixed(3)
      };
    }
  };
})();
