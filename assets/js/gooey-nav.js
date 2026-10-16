/**
 * GooeyNav —— React Bits <GooeyNav /> (JavaScript + CSS 变体) 的原生 JS 移植
 *
 * 与原组件的对应关系：
 *   React refs            → 构造函数缓存的 DOM 引用
 *   useState(current)     → this.active
 *   useLayoutEffect(init) → this._init()
 *   useEffect([current])  → setActive() 内部调用 _go()
 *   useEffect([...deps])  → setOptions() 内部调用 _refresh()
 *   卸载清理               → destroy()
 *
 * 算法逐字保留：WebGL2 液态药丸 fragment shader（upset-smoothed 距离场 blend + fwidth 抗锯齿 + rim 光）、
 * CPU 侧 marching 描边（trace）用于 overlay 的 clip-path、药丸质点弹簧（zeta/omega 半隐式欧拉）、
 * 液滴贝塞尔飞行（travelEase + 三次贝塞尔）、hover 位置弹簧插值、静止判定（resting/hovering）。
 *
 * 站点级适配（与其余 React Bits 移植保持一致）：
 *   - 可传入 items，也可留空从宿主内已有的 <a> 收集（保留原 HTML 供 SEO 与无 JS 降级）
 *   - destroy() 会把宿主 innerHTML 还原成接管前的样子（移动端抽屉菜单需要原始结构）
 *   - 颜色 / 主题由 setOptions 同步，跟随站点 data-theme
 */
(function () {
  'use strict';

  const THEMES = {
    dark: {
      '--gn-frame': 'rgba(38, 35, 46, 0.66)',
      '--gn-frame-edge': 'rgba(255, 255, 255, 0.08)',
      '--gn-frame-highlight': 'rgba(255, 255, 255, 0.07)',
      '--gn-frame-shadow': '0 22px 44px -20px rgba(0, 0, 0, 0.8), 0 6px 16px -8px rgba(0, 0, 0, 0.5)',
      '--gn-ink': '#f4f4f5',
      '--gn-muted': 'rgba(244, 244, 245, 0.62)'
    },
    light: {
      '--gn-frame': 'rgba(240, 240, 243, 0.8)',
      '--gn-frame-edge': 'rgba(24, 24, 27, 0.07)',
      '--gn-frame-highlight': 'rgba(255, 255, 255, 0.95)',
      '--gn-frame-shadow': '0 22px 44px -22px rgba(24, 24, 27, 0.3), 0 6px 16px -10px rgba(24, 24, 27, 0.16)',
      '--gn-ink': '#27272a',
      '--gn-muted': 'rgba(39, 39, 42, 0.62)'
    }
  };

  const PILLS = {
    dark: { color: '#f4f4f5', hover: 'rgba(255, 255, 255, 0.08)', shadow: 0.4 },
    light: { color: '#27272a', hover: 'rgba(24, 24, 27, 0.06)', shadow: 0.2 }
  };

  const SIZES = { sm: 'gooey-nav--sm', md: 'gooey-nav--md', lg: 'gooey-nav--lg' };

  const DEFAULT_ITEMS = [
    { label: 'Home', href: '#' },
    { label: 'Work', href: '#' },
    { label: 'About', href: '#' },
    { label: 'Contact', href: '#' }
  ];

  const MAX_DROPS = 32;
  const MAX_PILLS = 4;
  const MARGIN = 72;

  const VERTEX = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

  const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uSize;
uniform float uRatio;
uniform vec4 uPills[${MAX_PILLS}];
uniform vec4 uHover;
uniform vec4 uDrops[${MAX_DROPS}];
uniform vec2 uTails[${MAX_DROPS}];
uniform vec3 uTints[${MAX_DROPS}];
uniform int uCount;
uniform float uSmooth;
uniform vec3 uPill;
uniform vec4 uHoverColor;
uniform float uShadow;

out vec4 outColor;

float sdPill(vec2 p, vec4 box) {
  vec2 extent = max(box.zw, vec2(0.0));
  float r = min(extent.x, extent.y);
  vec2 q = abs(p - box.xy) - extent + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

vec4 blend(vec4 a, vec4 b, float k) {
  float h = clamp(0.5 + 0.5 * (b.w - a.w) / k, 0.0, 1.0);
  return vec4(mix(b.rgb, a.rgb, h), mix(b.w, a.w, h) - k * h * (1.0 - h));
}

vec4 field(vec2 p) {
  vec4 shape = vec4(uPill, 1e5);
  for (int i = 0; i < ${MAX_PILLS}; i++) {
    vec4 pill = uPills[i];
    if (pill.z <= 0.0) continue;
    shape = blend(shape, vec4(uPill, sdPill(p, pill)), uSmooth);
  }
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uCount) break;
    vec4 drop = uDrops[i];
    if (drop.z <= 0.0) continue;
    float d = sdCapsule(p, drop.xy, drop.xy - uTails[i], drop.z);
    if (d > shape.w + uSmooth) continue;
    shape = blend(shape, vec4(uTints[i], d), uSmooth);
  }
  return shape;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y * uRatio - gl_FragCoord.y) / uRatio;
  vec4 shape = field(p);
  float d = shape.w;
  float aa = max(fwidth(d), 0.35);
  float body = clamp(0.5 - d / aa, 0.0, 1.0);

  vec2 grad = vec2(dFdx(d), -dFdy(d));
  vec2 n = length(grad) > 0.0001 ? normalize(grad) : vec2(0.0, 1.0);
  float rim = (1.0 - smoothstep(0.0, 1.6, -d)) * max(0.0, -n.y) * 0.3;
  vec3 fill = mix(shape.rgb, vec3(1.0), rim) * (1.0 - 0.06 * max(0.0, n.y) * (1.0 - smoothstep(0.0, 6.0, -d)));

  float lifted = field(p - vec2(0.0, 3.0)).w;
  float shadow = (1.0 - smoothstep(-3.0, 9.0, lifted)) * uShadow * (1.0 - body);

  float hover = clamp(0.5 - sdPill(p, uHover) / aa, 0.0, 1.0) * uHoverColor.a;

  vec4 color = vec4(0.0, 0.0, 0.0, shadow);
  color = vec4(uHoverColor.rgb * hover, hover) + color * (1.0 - hover);
  color = vec4(fill * body, body) + color * (1.0 - body);
  outColor = color;
}
`;

  const parse = value => {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim());
    if (match) {
      const hex = match[1].length === 3 ? match[1].replace(/./g, digit => digit + digit) : match[1];
      return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).concat(1);
    }
    const rgba = /rgba?\(([^)]+)\)/i.exec(String(value));
    if (rgba) {
      const parts = rgba[1].split(',').map(part => parseFloat(part));
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts[3] ?? 1];
    }
    return [1, 1, 1, 1];
  };

  const contrastInk = rgb => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.55 ? '#18161d' : '#ffffff');

  const clamp01 = value => Math.min(1, Math.max(0, value));

  const travelEase = t => {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  };

  const bezier = (a, b, c, d, t) => {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  };

  const pillPath = (x, y, w, h) => {
    if (w <= 0.5 || h <= 0.5) return '';
    const r = Math.min(w, h) / 2;
    return `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
  };

  const compile = (gl, type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };

  const UNIFORMS = [
    'uSize',
    'uRatio',
    'uPills',
    'uHover',
    'uDrops',
    'uTails',
    'uTints',
    'uCount',
    'uSmooth',
    'uPill',
    'uHoverColor',
    'uShadow'
  ];

  const build = gl => {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    const uniforms = Object.fromEntries(UNIFORMS.map(name => [name, gl.getUniformLocation(program, name)]));
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    return { program, uniforms, buffer, position: gl.getAttribLocation(program, 'aPosition') };
  };

  class GooeyNav {
    static isSupported() {
      try {
        const canvas = document.createElement('canvas');
        return !!canvas.getContext('webgl2');
      } catch (error) {
        return false;
      }
    }

    constructor(host, options = {}) {
      if (!host) throw new Error('GooeyNav: host element is required');
      this.host = host;
      this.options = Object.assign(
        {
          items: null,
          theme: 'dark',
          color: null,
          activeTextColor: null,
          colors: [],
          size: 'md',
          frame: true,
          animationTime: 600,
          particleCount: 15,
          timeVariance: 300,
          spread: 56,
          gooeyness: 0.5,
          wobble: 0.5,
          hoverEffect: true,
          activeIndex: 0,
          onChange: null,
          className: '',
          themeVars: null
        },
        options
      );

      this.items = this.options.items || this._readItems();
      if (!this.items.length) this.items = DEFAULT_ITEMS.slice();
      this.originalHTML = host.innerHTML;

      this.palette = this.options.theme === 'light' ? 'light' : 'dark';
      this.active = this._clampIndex(this.options.activeIndex);
      this.settings = this._buildSettings();

      this._buildStructure();
      this._init();
      this.supported = !!this.state.pipeline;
    }

    /* ---------------- 数据 / 尺寸工具 ---------------- */

    _readItems() {
      return Array.from(this.host.querySelectorAll('a')).map(a => ({
        label: (a.textContent || '').trim(),
        href: a.getAttribute('href') || '#'
      })).filter(item => item.label);
    }

    _clampIndex(index) {
      return Math.min(Math.max(0, index | 0), Math.max(0, this.items.length - 1));
    }

    _buildSettings() {
      const o = this.options;
      const palette = this.palette;
      const pillColor = o.color || PILLS[palette].color;
      const pillRgb = parse(pillColor);
      this.pillColor = pillColor;
      this.pillRgb = pillRgb;
      this.activeInk = o.activeTextColor || contrastInk(pillRgb);
      return {
        animationTime: o.animationTime,
        particleCount: o.particleCount,
        timeVariance: o.timeVariance,
        spread: o.spread,
        gooeyness: o.gooeyness,
        wobble: o.wobble,
        hoverEffect: o.hoverEffect,
        pillRgb,
        tints: (o.colors || []).map(parse),
        hoverRgb: parse(PILLS[palette].hover),
        shadow: PILLS[palette].shadow
      };
    }

    /* ---------------- 结构 ---------------- */

    _buildStructure() {
      const o = this.options;
      const root = document.createElement('div');
      root.className = ['gooey-nav', SIZES[o.size] || SIZES.md, o.frame ? 'gooey-nav--framed' : '', o.className || '']
        .filter(Boolean)
        .join(' ')
        .trim();

      const rim = document.createElement('span');
      rim.className = 'gooey-nav__rim';

      const stage = document.createElement('div');
      stage.className = 'gooey-nav__stage';

      const canvas = document.createElement('canvas');
      canvas.className = 'gooey-nav__canvas';
      canvas.setAttribute('aria-hidden', 'true');

      const fallback = document.createElement('span');
      fallback.className = 'gooey-nav__fallback';
      fallback.setAttribute('aria-hidden', 'true');

      const list = document.createElement('ul');
      list.className = 'gooey-nav__list';
      const overlay = document.createElement('ul');
      overlay.className = 'gooey-nav__list gooey-nav__list--active';
      overlay.setAttribute('aria-hidden', 'true');

      this.items.forEach((item, index) => {
        const li = document.createElement('li');
        li.className = 'gooey-nav__item';
        li.dataset.gooeyIndex = String(index);
        if (index === this.active) li.dataset.active = '';

        const link = document.createElement(item.href ? 'a' : 'button');
        link.className = 'gooey-nav__link';
        if (item.href) link.setAttribute('href', item.href);
        else link.setAttribute('type', 'button');
        if (index === this.active) link.setAttribute('aria-current', 'page');
        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'gooey-nav__icon';
          if (typeof item.icon === 'string') icon.innerHTML = item.icon;
          else icon.appendChild(item.icon);
          link.appendChild(icon);
        }
        if (item.label) {
          const label = document.createElement('span');
          label.className = 'gooey-nav__label';
          label.textContent = item.label;
          link.appendChild(label);
        }
        li.appendChild(link);
        list.appendChild(li);

        const oLi = document.createElement('li');
        oLi.className = 'gooey-nav__item';
        const oLink = document.createElement('span');
        oLink.className = 'gooey-nav__link';
        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'gooey-nav__icon';
          if (typeof item.icon === 'string') icon.innerHTML = item.icon;
          else icon.appendChild(icon);
          oLink.appendChild(icon);
        }
        if (item.label) {
          const label = document.createElement('span');
          label.className = 'gooey-nav__label';
          label.textContent = item.label;
          oLink.appendChild(label);
        }
        oLi.appendChild(oLink);
        overlay.appendChild(oLi);
      });

      stage.appendChild(canvas);
      stage.appendChild(fallback);
      stage.appendChild(list);
      stage.appendChild(overlay);
      if (o.frame) root.appendChild(rim);
      root.appendChild(stage);

      this.host.innerHTML = '';
      this.host.appendChild(root);

      this.$root = root;
      this.$rim = o.frame ? rim : null;
      this.$stage = stage;
      this.$canvas = canvas;
      this.$fallback = fallback;
      this.$list = list;
      this.$overlay = overlay;

      this._applyVars();
    }

    _applyVars() {
      const vars = Object.assign({}, THEMES[this.palette], this.options.themeVars || {});
      Object.keys(vars).forEach(name => this.$root.style.setProperty(name, vars[name]));
      this.$root.style.setProperty('--gn-pill', this.pillColor);
      this.$root.style.setProperty('--gn-active-ink', this.activeInk);
    }

    /* ---------------- 引擎（对应 useLayoutEffect） ---------------- */

    _init() {
      const stage = this.$stage;
      const canvas = this.$canvas;
      const list = this.$list;
      const overlay = this.$overlay;
      const fallback = this.$fallback;

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
      const pipeline = gl ? build(gl) : null;
      fallback.style.display = pipeline ? 'none' : 'block';
      canvas.style.display = pipeline ? 'block' : 'none';

      const state = {
        view: { width: 0, height: 0 },
        rects: [],
        target: -1,
        pills: new Map(),
        drops: [],
        hover: { x: 0, y: 0, w: 0, h: 0, alpha: 0, index: -1 },
        pillData: new Float32Array(MAX_PILLS * 4),
        dropData: new Float32Array(MAX_DROPS * 4),
        tailData: new Float32Array(MAX_DROPS * 2),
        tintData: new Float32Array(MAX_DROPS * 3),
        raf: 0,
        last: 0,
        disposed: false,
        gl,
        pipeline
      };
      this.state = state;
      this.reduced = reduced;

      const measure = () => {
        const box = stage.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        state.view.width = box.width;
        state.view.height = box.height;
        const outerWidth = box.width + MARGIN * 2;
        const outerHeight = box.height + MARGIN * 2;
        Object.assign(canvas.style, {
          left: `${-MARGIN}px`,
          top: `${-MARGIN}px`,
          width: `${outerWidth}px`,
          height: `${outerHeight}px`
        });
        const width = Math.max(1, Math.round(outerWidth * ratio));
        const height = Math.max(1, Math.round(outerHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        state.rects = Array.from(list.children).map(item => {
          const rect = item.getBoundingClientRect();
          return { x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height };
        });
      };
      this._measure = measure;

      const trace = (boxes, blobs, smooth) => {
        const field = (x, y) => {
          let d = 1e5;
          const merge = value => {
            const h = clamp01(0.5 + (0.5 * (value - d)) / smooth);
            d = value + (d - value) * h - smooth * h * (1 - h);
          };
          for (const box of boxes) {
            const r = Math.min(box.hw, box.hh);
            const qx = Math.abs(x - box.cx) - box.hw + r;
            const qy = Math.abs(y - box.cy) - box.hh + r;
            merge(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
          }
          for (const blob of blobs) {
            const px = x - blob.x;
            const py = y - blob.y;
            const bx = -blob.tx;
            const by = -blob.ty;
            const span = bx * bx + by * by;
            const h = span > 0.0001 ? clamp01((px * bx + py * by) / span) : 0;
            const value = Math.hypot(px - bx * h, py - by * h) - blob.r;
            if (value > d + smooth) continue;
            merge(value);
          }
          return d;
        };
        const step = 2;
        const parts = [];
        for (let y = 0; y < state.view.height; y += 1) {
          const cy = y + 0.5;
          let previous = field(0, cy);
          let start = previous < 0 ? 0 : null;
          for (let x = step; x <= state.view.width + step; x += step) {
            const value = field(Math.min(x, state.view.width), cy);
            if (previous < 0 !== value < 0) {
              const cross = x - step + (step * previous) / (previous - value);
              if (value < 0) start = cross;
              else if (start !== null) {
                parts.push(`M${start.toFixed(1)},${y}H${cross.toFixed(1)}V${y + 1}H${start.toFixed(1)}Z`);
                start = null;
              }
            }
            previous = value;
          }
          if (start !== null) parts.push(`M${start.toFixed(1)},${y}H${state.view.width}V${y + 1}H${start.toFixed(1)}Z`);
        }
        return parts.join('');
      };

      const pill = index => {
        if (!state.pills.has(index)) state.pills.set(index, { mass: 0, scale: 0, velocity: 0, outgoing: 0 });
        return state.pills.get(index);
      };

      const shape = (index, amount) => {
        const rect = state.rects[index];
        if (!rect || amount <= 0.002) return null;
        const h = rect.h * Math.min(1.08, 0.42 + 0.58 * Math.sqrt(Math.max(0, amount)));
        const w = Math.max(h, rect.w * Math.max(0, amount) ** 0.75);
        return { x: rect.x + rect.w / 2 - w / 2, y: rect.y + rect.h / 2 - h / 2, w, h };
      };

      const plan = (drop, index, now, fresh) => {
        const s = this.settings;
        const rect = state.rects[index];
        if (!rect) return;
        const reach = Math.max(0, s.spread);
        const ex = rect.x + rect.w / 2 + (Math.random() - 0.5) * rect.w * 0.45;
        const ey = rect.y + rect.h / 2 + (Math.random() - 0.5) * rect.h * 0.2;
        const base = Math.max(0.15, s.animationTime / 1000);
        const variance = (Math.random() - 0.5) * (Math.max(0, s.timeVariance) / 1000);
        const duration = Math.max(0.15, base * (0.62 + Math.random() * 0.32) + variance * 0.6);
        const out = Math.random() * Math.PI * 2;
        const into = Math.random() * Math.PI * 2;
        const burst = reach * (0.7 + Math.random() * 0.6);
        const swing = reach * (0.55 + Math.random() * 0.55);
        const carry = Math.min(duration / 3, 0.12);
        drop.index = index;
        drop.start = now;
        drop.duration = duration;
        drop.path = [
          drop.x,
          drop.y,
          fresh ? drop.x + Math.cos(out) * burst * 1.6 : drop.x + drop.vx * carry,
          fresh ? drop.y + Math.sin(out) * burst * 1.6 : drop.y + drop.vy * carry,
          ex + Math.cos(into) * swing * 1.5,
          ey + Math.sin(into) * swing * 1.5,
          ex,
          ey
        ];
      };

      const emit = (from, to, now) => {
        const s = this.settings;
        const source = state.pills.get(from);
        const rect = state.rects[from];
        if (!source || !rect || !state.rects[to]) return;
        const available = source.mass - source.outgoing;
        if (available <= 0.002) return;
        const room = MAX_DROPS - state.drops.length;
        const count = Math.min(room, Math.max(1, Math.round(Math.max(1, s.particleCount) * available)));
        if (count <= 0) return;
        const window_ = Math.max(0.15, s.animationTime / 1000) * 0.16;
        for (let i = 0; i < count; i++) {
          const mass = available / count;
          source.outgoing += mass;
          state.drops.push({
            x: rect.x + rect.w / 2 + (Math.random() - 0.5) * rect.w * 0.6,
            y: rect.y + rect.h / 2 + (Math.random() - 0.5) * rect.h * 0.3,
            vx: 0,
            vy: 0,
            mass,
            size: 0.8 + Math.random() * 0.4,
            given: 0,
            source: from,
            index: to,
            leave: now + Math.random() * window_ * 1000,
            emerged: 0,
            absorbed: 0,
            state: 'waiting',
            tint: s.tints.length ? s.tints[Math.floor(Math.random() * s.tints.length)] : null
          });
        }
      };

      const render = () => {
        const s = this.settings;
        const height = state.rects[state.target]?.h ?? state.rects[0]?.h ?? 36;
        const smooth = height * (0.18 + 0.5 * clamp01(s.gooeyness));
        const boxes = [];
        const blobs = [];
        for (const [index, st] of state.pills) {
          const box = shape(index, st.scale);
          if (box) boxes.push({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, hw: box.w / 2, hh: box.h / 2 });
        }
        for (const drop of state.drops) {
          if (drop.state === 'waiting') continue;
          const radius = 0.26 * height * drop.size * Math.min(drop.emerged, 1 - drop.absorbed);
          if (radius <= 0.05) continue;
          const speed = Math.hypot(drop.vx, drop.vy);
          const length = Math.min(radius * 1.1, speed * 0.018);
          blobs.push({
            x: drop.x,
            y: drop.y,
            r: radius,
            tx: speed > 0.01 ? (drop.vx / speed) * length : 0,
            ty: speed > 0.01 ? (drop.vy / speed) * length : 0,
            tint: drop.tint
          });
        }

        const settledPill = boxes.length === 1 && !blobs.length;
        if (settledPill) {
          const box = boxes[0];
          overlay.style.clipPath = `path('${pillPath(box.cx - box.hw, box.cy - box.hh, box.hw * 2, box.hh * 2)}')`;
        } else {
          overlay.style.clipPath = `path('${trace(boxes, blobs, smooth) || 'M0,0Z'}')`;
        }
        overlay.style.visibility = 'visible';

        if (!pipeline || !gl) {
          const box = shape(state.target, 1);
          if (box) {
            fallback.style.transform = `translate(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px)`;
            fallback.style.width = `${box.w}px`;
            fallback.style.height = `${box.h}px`;
          }
          fallback.style.opacity = box ? '1' : '0';
          return;
        }

        let slot = 0;
        for (const box of boxes) {
          if (slot >= MAX_PILLS) break;
          state.pillData[slot * 4] = box.cx + MARGIN;
          state.pillData[slot * 4 + 1] = box.cy + MARGIN;
          state.pillData[slot * 4 + 2] = box.hw;
          state.pillData[slot * 4 + 3] = box.hh;
          slot += 1;
        }
        state.pillData.fill(0, slot * 4);
        let count = 0;
        for (const blob of blobs) {
          if (count >= MAX_DROPS) break;
          state.dropData[count * 4] = blob.x + MARGIN;
          state.dropData[count * 4 + 1] = blob.y + MARGIN;
          state.dropData[count * 4 + 2] = blob.r;
          state.dropData[count * 4 + 3] = 0;
          state.tailData[count * 2] = blob.tx;
          state.tailData[count * 2 + 1] = blob.ty;
          const tint = blob.tint || s.pillRgb;
          state.tintData[count * 3] = tint[0];
          state.tintData[count * 3 + 1] = tint[1];
          state.tintData[count * 3 + 2] = tint[2];
          count += 1;
        }

        const { program, uniforms, buffer, position } = pipeline;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(uniforms.uSize, state.view.width + MARGIN * 2, state.view.height + MARGIN * 2);
        gl.uniform1f(uniforms.uRatio, canvas.width / Math.max(1, state.view.width + MARGIN * 2));
        gl.uniform4fv(uniforms.uPills, state.pillData);
        gl.uniform4f(
          uniforms.uHover,
          state.hover.x + MARGIN,
          state.hover.y + MARGIN,
          state.hover.w / 2,
          state.hover.h / 2
        );
        gl.uniform4fv(uniforms.uDrops, state.dropData);
        gl.uniform2fv(uniforms.uTails, state.tailData);
        gl.uniform3fv(uniforms.uTints, state.tintData);
        gl.uniform1i(uniforms.uCount, count);
        gl.uniform1f(uniforms.uSmooth, smooth);
        gl.uniform3f(uniforms.uPill, s.pillRgb[0], s.pillRgb[1], s.pillRgb[2]);
        gl.uniform4f(
          uniforms.uHoverColor,
          s.hoverRgb[0],
          s.hoverRgb[1],
          s.hoverRgb[2],
          s.hoverRgb[3] * state.hover.alpha
        );
        gl.uniform1f(uniforms.uShadow, s.shadow);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };

      const frame = now => {
        state.raf = 0;
        if (state.disposed) return;
        const s = this.settings;
        const dt = Math.min(0.05, (now - state.last) / 1000 || 0);
        state.last = now;
        const emergeTime = 0.09;
        const absorbTime = 0.12;

        for (let i = state.drops.length - 1; i >= 0; i--) {
          const drop = state.drops[i];
          if (drop.state === 'waiting') {
            if (now < drop.leave) continue;
            drop.state = 'flying';
            plan(drop, drop.index, now, true);
          }
          if (drop.state === 'flying') {
            drop.emerged = Math.min(1, drop.emerged + dt / emergeTime);
            const source = state.pills.get(drop.source);
            if (source && drop.given < drop.mass) {
              const step = Math.min(drop.mass * (dt / emergeTime), drop.mass - drop.given);
              source.mass = Math.max(0, source.mass - step);
              source.outgoing = Math.max(0, source.outgoing - step);
              drop.given += step;
            }
            const t = clamp01((now - drop.start) / 1000 / drop.duration);
            const eased = travelEase(t);
            const [x0, y0, x1, y1, x2, y2, x3, y3] = drop.path;
            const x = bezier(x0, x1, x2, x3, eased);
            const y = bezier(y0, y1, y2, y3, eased);
            if (dt > 0) {
              drop.vx = (x - drop.x) / dt;
              drop.vy = (y - drop.y) / dt;
            }
            drop.x = x;
            drop.y = y;
            if (t >= 1) drop.state = 'absorbing';
          }
          if (drop.state === 'absorbing') {
            const step = Math.min(1 - drop.absorbed, dt / absorbTime);
            drop.absorbed += step;
            drop.vx *= 0.8;
            drop.vy *= 0.8;
            const host = pill(drop.index);
            host.mass = Math.min(1, host.mass + drop.mass * step);
            if (drop.absorbed >= 1) state.drops.splice(i, 1);
          }
        }

        const zeta = reduced ? 1 : 1 - 0.72 * clamp01(s.wobble);
        const omega = 26;
        const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / steps;
        for (const [index, st] of state.pills) {
          for (let n = 0; n < steps; n++) {
            st.velocity += (omega * omega * (st.mass - st.scale) - 2 * zeta * omega * st.velocity) * h;
            st.scale += st.velocity * h;
          }
          if (index !== state.target && st.mass <= 0.002 && st.outgoing <= 0.002 && Math.abs(st.scale) < 0.004) {
            state.pills.delete(index);
          }
        }

        if (state.hover.index >= 0 && state.rects[state.hover.index]) {
          const rect = state.rects[state.hover.index];
          const k = 1 - Math.exp(-dt / 0.06);
          state.hover.x += (rect.x + rect.w / 2 - state.hover.x) * k;
          state.hover.y += (rect.y + rect.h / 2 - state.hover.y) * k;
          state.hover.w += (rect.w - state.hover.w) * k;
          state.hover.h += (rect.h - state.hover.h) * k;
        }
        const hoverGoal = s.hoverEffect && state.hover.index >= 0 && state.hover.index !== state.target ? 1 : 0;
        state.hover.alpha += (hoverGoal - state.hover.alpha) * (1 - Math.exp(-dt / 0.08));

        render();

        const host = state.pills.get(state.target);
        const resting =
          state.drops.length === 0 &&
          state.pills.size === 1 &&
          host &&
          Math.abs(host.mass - host.scale) < 0.0008 &&
          Math.abs(host.velocity) < 0.004;
        const hoverRect = state.rects[state.hover.index];
        const hovering =
          Math.abs(hoverGoal - state.hover.alpha) > 0.003 ||
          (hoverRect && Math.abs(hoverRect.x + hoverRect.w / 2 - state.hover.x) + Math.abs(hoverRect.w - state.hover.w) > 0.1);
        if (!resting || hovering) state.raf = requestAnimationFrame(frame);
        else {
          host.mass = 1;
          host.scale = 1;
          host.velocity = 0;
          state.hover.alpha = hoverGoal;
          render();
        }
      };

      const wake = () => {
        if (state.raf || state.disposed) return;
        state.last = performance.now();
        state.raf = requestAnimationFrame(frame);
      };

      const settle = index => {
        state.pills.clear();
        state.drops.length = 0;
        state.target = index;
        const st = pill(index);
        st.mass = 1;
        st.scale = 1;
        st.velocity = 0;
        render();
      };
      this._settle = settle;
      this._render = render;
      this._wake = wake;

      const go = (index, animate) => {
        if (index === state.target) return;
        if (!state.rects[index] || !animate || reduced || state.target < 0) {
          settle(index);
          return;
        }
        const now = performance.now();
        state.target = index;
        pill(index);
        for (const drop of state.drops) {
          drop.index = index;
          if (drop.state === 'flying') plan(drop, index, now, false);
          if (drop.state === 'absorbing') {
            drop.state = 'flying';
            drop.mass *= 1 - drop.absorbed;
            drop.absorbed = 0;
            plan(drop, index, now, false);
          }
        }
        for (const from of [...state.pills.keys()]) {
          if (from !== index) emit(from, index, now);
        }
        wake();
      };
      this._go = go;

      const onOver = event => {
        const item = event.target.closest('[data-gooey-index]');
        if (!item || !list.contains(item)) return;
        const index = Number(item.dataset.gooeyIndex);
        const rect = state.rects[index];
        if (!rect) return;
        if (state.hover.alpha < 0.01) {
          state.hover.x = rect.x + rect.w / 2;
          state.hover.y = rect.y + rect.h / 2;
          state.hover.w = rect.w;
          state.hover.h = rect.h;
        }
        state.hover.index = index;
        wake();
      };

      const onLeave = () => {
        state.hover.index = -1;
        wake();
      };

      const onClick = event => {
        const item = event.target.closest('[data-gooey-index]');
        if (!item || !list.contains(item)) return;
        const index = Number(item.dataset.gooeyIndex);
        const data = this.items[index];
        const link = item.querySelector('a, button');
        if (!data || !data.href || data.href === '#') event.preventDefault();
        this._select(index, link);
      };

      const resizeObserver = new ResizeObserver(() => {
        if (state.disposed) return;
        measure();
        if (!state.drops.length) settle(state.target < 0 ? this.active : state.target);
        else render();
      });
      resizeObserver.observe(stage);
      resizeObserver.observe(list);

      list.addEventListener('pointerover', onOver);
      list.addEventListener('pointerleave', onLeave);
      list.addEventListener('click', onClick);

      measure();
      settle(this.active);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          if (state.disposed) return;
          measure();
          if (!state.drops.length) settle(state.target);
        });
      }

      this._handlers = { onOver, onLeave, onClick, resizeObserver };
    }

    /* ---------------- 交互 ---------------- */

    _select(index, link) {
      if (index === this.active) return;
      this.active = index;
      this._syncActiveAttrs();
      this._go(index, true);
      if (typeof this.options.onChange === 'function') this.options.onChange(index, this.items[index], link);
    }

    _syncActiveAttrs() {
      Array.from(this.$list.children).forEach((li, i) => {
        if (i === this.active) li.dataset.active = '';
        else delete li.dataset.active;
        const link = li.querySelector('a, button');
        if (link) {
          if (i === this.active) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        }
      });
    }

    /** 外部设置当前项（如滚动监听），不触发 onChange */
    setActive(index, animate = true) {
      const i = this._clampIndex(index);
      if (i === this.active && this.state && this.state.target === i) return this;
      this.active = i;
      this._syncActiveAttrs();
      this._go(i, animate !== false);
      return this;
    }

    setOptions(next = {}) {
      const prevSize = this.options.size;
      const prevFrame = this.options.frame;
      Object.assign(this.options, next);
      if (next.items) {
        this.items = next.items;
        this.active = this._clampIndex(this.active);
      }
      this.palette = this.options.theme === 'light' ? 'light' : 'dark';
      this.settings = this._buildSettings();

      if (this.options.size !== prevSize || this.options.frame !== prevFrame) {
        const root = this.$root;
        root.className = ['gooey-nav', SIZES[this.options.size] || SIZES.md, this.options.frame ? 'gooey-nav--framed' : '', this.options.className || '']
          .filter(Boolean)
          .join(' ')
          .trim();
        if (this.options.frame && !this.$rim) {
          const rim = document.createElement('span');
          rim.className = 'gooey-nav__rim';
          root.insertBefore(rim, root.firstChild);
          this.$rim = rim;
        } else if (!this.options.frame && this.$rim) {
          this.$rim.remove();
          this.$rim = null;
        }
      }

      this._applyVars();
      this._refresh();
      return this;
    }

    _refresh() {
      if (!this.state || this.state.disposed) return;
      this._measure();
      if (!this.state.drops.length) this._settle(this.state.target < 0 ? this.active : this.state.target);
      else this._render();
      this._wake();
    }

    refresh() {
      this._refresh();
      return this;
    }

    debug() {
      const s = this.state || {};
      return {
        supported: !!this.supported,
        raf: !!s.raf,
        active: this.active,
        target: s.target,
        items: this.items.map(item => item.label),
        rects: (s.rects || []).map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]),
        pills: s.pills ? [...s.pills.keys()] : [],
        drops: s.drops ? s.drops.length : 0,
        hover: s.hover ? { index: s.hover.index, alpha: Number(s.hover.alpha.toFixed(3)) } : null,
        canvas: [this.$canvas ? this.$canvas.width : 0, this.$canvas ? this.$canvas.height : 0],
        view: s.view ? [Math.round(s.view.width), Math.round(s.view.height)] : [0, 0],
        pillColor: this.pillColor,
        activeInk: this.activeInk,
        theme: this.palette,
        reduced: !!this.reduced,
        gooeyness: this.settings.gooeyness,
        wobble: this.settings.wobble
      };
    }

    destroy() {
      if (this.state) {
        this.state.disposed = true;
        cancelAnimationFrame(this.state.raf);
        const { gl, pipeline } = this.state;
        const h = this._handlers;
        if (h) {
          h.resizeObserver.disconnect();
          this.$list.removeEventListener('pointerover', h.onOver);
          this.$list.removeEventListener('pointerleave', h.onLeave);
          this.$list.removeEventListener('click', h.onClick);
        }
        if (gl && pipeline) {
          gl.deleteBuffer(pipeline.buffer);
          gl.deleteProgram(pipeline.program);
        }
      }
      this.host.innerHTML = this.originalHTML; // 还原接管前的结构（移动端菜单依赖）
      this.state = null;
      this.$root = this.$stage = this.$canvas = this.$fallback = this.$list = this.$overlay = this.$rim = null;
    }
  }

  window.GooeyNav = GooeyNav;
})();
