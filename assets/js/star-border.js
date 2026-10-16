/*!
 * star-border.js — React Bits <StarBorder /> 原生 JS 移植（JavaScript + CSS 变体）
 *
 * 与原组件的差异（站点级适配）：
 * 1. React 组件自渲染 <canvas class="star-border__light"> 并接管按钮底色/文字色；
 *    站点按钮已有完整样式（.btn-ghost），这里只注入 canvas 光效层 + isolation，
 *    不覆盖按钮自身的背景、边框、文字。
 * 2. as='button'|'a' 的多态渲染改为：构造函数直接接收现有 DOM 元素（<a> 也可以）。
 * 3. radius 未传时自动读取元素 computed border-radius，保证星轨与按钮圆角一致。
 * 4. theme 适配站点主题系统：lightMode 由 main.js 按 data-theme 传入。
 *
 * 生命周期：new StarBorder(el, options) / setOptions(next) / destroy()
 */
(() => {
  'use strict';

  const THEMES = {
    dark: { light: '#ffffff' },
    light: { light: '#18181b' }
  };

  const HOVERS = ['lap', 'brighten', 'reveal', 'none'];
  const BLEED = 48;
  const LAP = 0.9;
  const TAU = Math.PI * 2;
  const WHITE = [255, 255, 255];

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const wrap = (value, total) => ((value % total) + total) % total;
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgba = (rgb, alpha) =>
    `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${clamp(alpha, 0, 1).toFixed(3)})`;

  let colorContext = null;

  const toRgb = color => {
    colorContext = colorContext || document.createElement('canvas').getContext('2d');
    if (!colorContext) return WHITE;
    colorContext.fillStyle = '#000000';
    colorContext.fillStyle = color;
    const value = String(colorContext.fillStyle);
    if (value.startsWith('#')) {
      const hex = parseInt(value.slice(1, 7), 16);
      return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    }
    const parts = value.match(/[\d.]+/g)?.map(Number) || WHITE;
    return [parts[0], parts[1], parts[2]];
  };

  const outline = (width, height, radius) => {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const arc = (Math.PI * r) / 2;
    const across = Math.max(0, width - 2 * r);
    const down = Math.max(0, height - 2 * r);
    const segments = [
      { length: across, x: r, y: 0, dx: 1, dy: 0, angle: null },
      { length: arc, x: width - r, y: r, dx: 0, dy: 0, angle: -Math.PI / 2 },
      { length: down, x: width, y: r, dx: 0, dy: 1, angle: null },
      { length: arc, x: width - r, y: height - r, dx: 0, dy: 0, angle: 0 },
      { length: across, x: width - r, y: height, dx: -1, dy: 0, angle: null },
      { length: arc, x: r, y: height - r, dx: 0, dy: 0, angle: Math.PI / 2 },
      { length: down, x: 0, y: height - r, dx: 0, dy: -1, angle: null },
      { length: arc, x: r, y: r, dx: 0, dy: 0, angle: Math.PI }
    ];
    return {
      r,
      segments,
      total: Math.max(1, segments.reduce((sum, segment) => sum + segment.length, 0))
    };
  };

  const pointAt = (shape, distance, point) => {
    let s = wrap(distance, shape.total);
    for (const segment of shape.segments) {
      if (segment.length > 0 && s <= segment.length) {
        if (segment.angle === null) {
          point.x = segment.x + segment.dx * s;
          point.y = segment.y + segment.dy * s;
          point.nx = segment.dy;
          point.ny = -segment.dx;
        } else {
          const angle = segment.angle + s / shape.r;
          point.nx = Math.cos(angle);
          point.ny = Math.sin(angle);
          point.x = segment.x + point.nx * shape.r;
          point.y = segment.y + point.ny * shape.r;
        }
        return point;
      }
      s -= segment.length;
    }
    return point;
  };

  const project = (shape, px, py) => {
    let best = Infinity;
    let found = 0;
    let offset = 0;
    shape.segments.forEach(segment => {
      if (segment.length > 0) {
        let s = 0;
        let x = 0;
        let y = 0;
        if (segment.angle === null) {
          s = clamp((px - segment.x) * segment.dx + (py - segment.y) * segment.dy, 0, segment.length);
          x = segment.x + segment.dx * s;
          y = segment.y + segment.dy * s;
        } else {
          let angle = wrap(Math.atan2(py - segment.y, px - segment.x) - segment.angle, TAU);
          if (angle > Math.PI / 2) angle = angle > Math.PI * 1.25 ? 0 : Math.PI / 2;
          s = angle * shape.r;
          x = segment.x + Math.cos(segment.angle + angle) * shape.r;
          y = segment.y + Math.sin(segment.angle + angle) * shape.r;
        }
        const distance = (px - x) ** 2 + (py - y) ** 2;
        if (distance < best) {
          best = distance;
          found = offset + s;
        }
      }
      offset += segment.length;
    });
    return found;
  };

  class StarBorder {
    constructor(el, options) {
      if (!el || !el.appendChild) throw new Error('StarBorder: 需要 root 元素');
      this.root = el;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'star-border__light';
      this.canvas.setAttribute('aria-hidden', 'true');
      el.insertBefore(this.canvas, el.firstChild);
      el.classList.add('star-border');
      this.ctx = this.canvas.getContext('2d');
      if (!this.ctx) {
        this.supported = false;
        return;
      }
      this.supported = true;

      this.props = Object.assign(
        {
          color: null,
          trailColor: null,
          duration: 4,
          thickness: 1,
          radius: null,
          trailLength: 0.3,
          stars: 1,
          glow: 0.6,
          sparkle: false,
          direction: 'clockwise',
          hover: 'lap',
          clickPulse: true,
          lightMode: false
        },
        options || {}
      );
      this.settings = this._build(this.props);
      this.colors = { key: '', head: WHITE, tail: WHITE };
      this._applyPalette(true);

      this.state = {
        width: 0,
        height: 0,
        dpr: 1,
        phase: 0,
        velocity: 0,
        motion: 0,
        lap: -1,
        time: 0,
        reveal: 1,
        boost: 0,
        flash: 0,
        emit: 0,
        hovered: false,
        focused: false,
        pointerX: 0,
        pointerY: 0,
        visible: true
      };
      this.pulses = [];
      this.dust = [];
      this.point = { x: 0, y: 0, nx: 0, ny: -1 };

      this.raf = 0;
      this.last = performance.now();
      this.alive = true;
      // rAF 回调必须绑定 this（严格模式下未绑定调用会让 this 变成 undefined）
      this._tick = now => this._frame(now);
      this.reduce =
        (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || false;

      this._bind();
      this._measure();
    }

    _build(p) {
      const palette = THEMES[p.lightMode ? 'light' : 'dark'];
      const light = p.color || palette.light;
      // radius 未指定时读取元素圆角，星轨与按钮形状保持一致
      let radius = p.radius;
      if (radius == null) {
        const br = parseFloat(getComputedStyle(this.root).borderRadius);
        radius = Number.isFinite(br) ? br : 12;
      }
      return {
        light: !!p.lightMode,
        color: light,
        trailColor: p.trailColor || light,
        duration: Math.max(0.3, p.duration),
        thickness: Math.max(0.5, p.thickness),
        radius: Math.max(0, radius),
        trailLength: clamp(p.trailLength, 0, 1),
        stars: clamp(Math.round(p.stars), 1, 6),
        glow: clamp(p.glow, 0, 1),
        sparkle: !!p.sparkle,
        direction: p.direction === 'counterclockwise' ? -1 : 1,
        hover: HOVERS.includes(p.hover) ? p.hover : 'lap',
        clickPulse: p.clickPulse !== false
      };
    }

    _applyPalette(force) {
      const s = this.settings;
      const key = `${s.color}|${s.trailColor}`;
      if (force || key !== this.colors.key) {
        this.colors.key = key;
        this.colors.head = toRgb(s.color);
        this.colors.tail = toRgb(s.trailColor);
      }
    }

    setOptions(next) {
      if (!this.supported || !next) return;
      this.props = Object.assign({}, this.props, next);
      this.settings = this._build(this.props);
      this._applyPalette(false);
      this._wake();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.alive = false;
      cancelAnimationFrame(this.raf);
      this._unbind();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.visibility) this.visibility.disconnect();
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      if (this.root) this.root.classList.remove('star-border');
    }

    _bind() {
      const root = this.root;
      this.resizeObserver = new ResizeObserver(() => this._measure());
      this.resizeObserver.observe(root);
      this.visibility = new IntersectionObserver(entries => {
        this.state.visible = entries.some(entry => entry.isIntersecting);
        if (this.state.visible) this._wake();
      });
      this.visibility.observe(root);

      this._onEnter = event => {
        const s = this.settings;
        const p = this._local(event);
        this.state.pointerX = p[0];
        this.state.pointerY = p[1];
        this.state.hovered = true;
        if (s.hover === 'reveal' && this.state.reveal < 0.15) {
          this.state.phase = project(this._shapeFor(s), this.state.pointerX - s.thickness / 2, this.state.pointerY - s.thickness / 2);
          this.state.velocity = 0;
        }
        if (s.hover === 'lap' && this.state.lap < 0 && !this.reduce) this.state.lap = 0;
        this._wake();
      };
      this._onLeave = () => {
        this.state.hovered = false;
        this._wake();
      };
      this._onDown = event => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        const s = this.settings;
        const p = this._local(event);
        this._pulse(project(this._shapeFor(s), p[0] - s.thickness / 2, p[1] - s.thickness / 2));
      };
      this._onClick = event => {
        if (event.detail === 0) this._pulse(this.state.phase);
      };
      this._onFocus = () => {
        this.state.focused = this.root.matches(':focus-visible');
        if (this.state.focused && this.settings.hover === 'lap' && this.state.lap < 0 && !this.reduce)
          this.state.lap = 0;
        this._wake();
      };
      this._onBlur = () => {
        this.state.focused = false;
        this._wake();
      };

      root.addEventListener('pointerenter', this._onEnter);
      root.addEventListener('pointerleave', this._onLeave);
      root.addEventListener('pointerdown', this._onDown);
      root.addEventListener('click', this._onClick);
      root.addEventListener('focus', this._onFocus);
      root.addEventListener('blur', this._onBlur);
    }

    _unbind() {
      const root = this.root;
      root.removeEventListener('pointerenter', this._onEnter);
      root.removeEventListener('pointerleave', this._onLeave);
      root.removeEventListener('pointerdown', this._onDown);
      root.removeEventListener('click', this._onClick);
      root.removeEventListener('focus', this._onFocus);
      root.removeEventListener('blur', this._onBlur);
    }

    _measure() {
      this.state.width = this.root.offsetWidth;
      this.state.height = this.root.offsetHeight;
      this.state.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.max(1, Math.round((this.state.width + BLEED * 2) * this.state.dpr));
      this.canvas.height = Math.max(1, Math.round((this.state.height + BLEED * 2) * this.state.dpr));
      this._wake();
    }

    _local(event) {
      const rect = this.root.getBoundingClientRect();
      const scaleX = rect.width ? this.state.width / rect.width : 1;
      const scaleY = rect.height ? this.state.height / rect.height : 1;
      return [(event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY];
    }

    _shapeFor(s) {
      return outline(
        Math.max(1, this.state.width - s.thickness),
        Math.max(1, this.state.height - s.thickness),
        s.radius - s.thickness / 2
      );
    }

    _pulse(origin) {
      if (!this.settings.clickPulse) return;
      this.pulses.push({ origin, age: 0 });
      if (this.pulses.length > 4) this.pulses.shift();
      this.state.flash = 1;
      this._wake();
    }

    _stroke(x1, y1, x2, y2, width, style) {
      const ctx = this.ctx;
      ctx.lineWidth = width;
      ctx.strokeStyle = style;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    _drawTrail(s, shape, head, length, sign, intensity, tip = true) {
      const ctx = this.ctx;
      const point = this.point;
      if (length < 0.5 || intensity <= 0) return;
      const steps = clamp(Math.ceil(length / 2), 2, 90);
      pointAt(shape, head, point);
      let px = point.x;
      let py = point.y;
      for (let i = 1; i <= steps; i++) {
        pointAt(shape, head - sign * length * (i / steps), point);
        const u = 1 - (i - 0.5) / steps;
        const fade = u * u * intensity;
        let tone = mix(this.colors.tail, this.colors.head, u);
        if (!s.light) tone = mix(tone, WHITE, u ** 6 * 0.65);
        ctx.lineCap = tip && i === 1 ? 'round' : 'butt';
        this._stroke(px, py, point.x, point.y, 2 + 6 * s.glow, rgba(tone, fade * (s.light ? 0.1 : 0.2) * s.glow));
        this._stroke(px, py, point.x, point.y, s.thickness, rgba(tone, fade));
        px = point.x;
        py = point.y;
      }
    }

    _drawHead(s, x, y, intensity, twinkle) {
      const ctx = this.ctx;
      if (intensity <= 0) return;
      const tone = this.colors.head;
      const reach = (12 + 40 * s.glow) * (s.light ? 0.6 : 1);
      const bloom = ctx.createRadialGradient(x, y, 0, x, y, reach);
      const strength = (s.light ? 0.08 : 0.4) * s.glow * intensity;
      bloom.addColorStop(0, rgba(tone, strength));
      bloom.addColorStop(0.2, rgba(tone, strength * 0.4));
      bloom.addColorStop(0.5, rgba(tone, strength * 0.1));
      bloom.addColorStop(1, rgba(tone, 0));
      ctx.fillStyle = bloom;
      ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
      if (!s.sparkle) return;

      const size = (1 + s.thickness * 0.6) * (s.light ? 0.85 : 1);
      const core = ctx.createRadialGradient(x, y, 0, x, y, size * 2.2);
      core.addColorStop(0, rgba(s.light ? tone : WHITE, intensity));
      core.addColorStop(s.light ? 0.3 : 0.4, rgba(s.light ? tone : mix(tone, WHITE, 0.5), intensity * 0.9));
      core.addColorStop(s.light ? 0.55 : 1, rgba(tone, s.light ? intensity * 0.12 : 0));
      core.addColorStop(1, rgba(tone, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, size * 2.2, 0, TAU);
      ctx.fill();

      const spike = (3 + 4 * s.glow + s.thickness * 1.5) * twinkle;
      const center = s.light ? tone : WHITE;
      const horizontal = ctx.createLinearGradient(x - spike, y, x + spike, y);
      horizontal.addColorStop(0, rgba(tone, 0));
      horizontal.addColorStop(0.5, rgba(center, intensity * 0.95));
      horizontal.addColorStop(1, rgba(tone, 0));
      this._stroke(x - spike, y, x + spike, y, s.light ? 0.75 : 1, horizontal);
      const vertical = ctx.createLinearGradient(x, y - spike, x, y + spike);
      vertical.addColorStop(0, rgba(tone, 0));
      vertical.addColorStop(0.5, rgba(center, intensity * 0.95));
      vertical.addColorStop(1, rgba(tone, 0));
      this._stroke(x, y - spike, x, y + spike, s.light ? 0.75 : 1, vertical);
    }

    _spawnDust(x, y, nx, ny, speed) {
      if (this.dust.length > 48) return;
      const push = 3 + Math.random() * 10;
      const drift = (Math.random() - 0.5) * 8;
      this.dust.push({
        x: x + nx * (Math.random() * 3 - 1),
        y: y + ny * (Math.random() * 3 - 1),
        vx: nx * push - ny * drift - speed * -ny * 0.04,
        vy: ny * push + nx * drift - speed * nx * 0.04,
        age: 0,
        life: 0.35 + Math.random() * 0.5,
        size: 0.45 + Math.random() * 0.7,
        seed: Math.random() * TAU
      });
    }

    _draw(base, shape) {
      const ctx = this.ctx;
      const st = this.state;
      const s = st.boost > 0.001 ? Object.assign({}, base, { glow: Math.min(1.5, base.glow + 0.4 * st.boost) }) : base;
      const point = this.point;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (st.width < 2 || st.height < 2) return;
      const offset = (BLEED + s.thickness / 2) * st.dpr;
      ctx.setTransform(st.dpr, 0, 0, st.dpr, offset, offset);
      ctx.globalCompositeOperation = s.light ? 'source-over' : 'lighter';
      ctx.lineCap = 'butt';

      const total = shape.total;
      const spacing = total / s.stars;
      const speed = Math.abs(st.motion);
      const sign = st.motion >= 0 ? 1 : -1;
      const span = s.trailLength * s.duration;
      const length = Math.min(speed * span, spacing * 0.92, total * 0.6);
      const intensity = st.reveal * (1 + 0.4 * st.boost + 0.6 * st.flash);

      const ring = st.flash * (s.light ? 0.18 : 0.32) + st.boost * st.reveal * (s.light ? 0.07 : 0.12);
      if (ring > 0.005) {
        ctx.lineWidth = s.thickness + 2 * s.glow;
        ctx.strokeStyle = rgba(this.colors.head, ring);
        ctx.beginPath();
        ctx.roundRect(
          0,
          0,
          Math.max(1, st.width - s.thickness),
          Math.max(1, st.height - s.thickness),
          Math.max(0, shape.r)
        );
        ctx.stroke();
      }

      const still = clamp(1 - speed / Math.max(1, (total / s.duration) * 0.6), 0, 1) * Math.min(1, intensity);
      const rest = (10 + 14 * s.glow + s.thickness * 2) * still;
      for (let i = 0; i < s.stars; i++) {
        const head = st.phase + i * spacing;
        this._drawTrail(s, shape, head, length, sign, Math.min(1, intensity));
        if (still > 0.01) {
          this._drawTrail(s, shape, head, rest, 1, still, false);
          this._drawTrail(s, shape, head, rest, -1, still, false);
        }
      }

      this.pulses.forEach(pulse => {
        const progress = pulse.age / 0.65;
        const fade = (1 - progress) ** 2;
        const travel = (total / 2) * (1 - (1 - Math.min(1, pulse.age / 0.5)) ** 2);
        const tail = Math.min(travel, total * 0.16);
        [1, -1].forEach(way => {
          const front = pulse.origin + way * travel;
          this._drawTrail(s, shape, front, tail, way, fade);
          pointAt(shape, front, point);
          this._drawHead(s, point.x, point.y, fade * 0.8, 0.8);
        });
      });

      for (let i = 0; i < s.stars; i++) {
        pointAt(shape, st.phase + i * spacing, point);
        const twinkle = 0.82 + 0.18 * Math.sin(st.time * 6.1 + i * 2.3) * Math.sin(st.time * 2.7 + i);
        this._drawHead(s, point.x, point.y, Math.min(1.3, intensity), twinkle);
      }

      this.dust.forEach(mote => {
        const left = 1 - mote.age / mote.life;
        const shimmer = 0.45 + 0.55 * Math.sin(st.time * 20 + mote.seed);
        const alpha = left * shimmer * st.reveal * (s.light ? 0.35 : 0.9);
        if (alpha <= 0.01) return;
        ctx.fillStyle = rgba(s.light ? this.colors.head : mix(this.colors.tail, WHITE, 0.6), alpha);
        ctx.beginPath();
        ctx.arc(mote.x, mote.y, mote.size * (0.6 + 0.4 * left), 0, TAU);
        ctx.fill();
      });
    }

    _frame(now) {
      this.raf = 0;
      if (!this.alive) return;
      const s = this.settings;
      const st = this.state;
      const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
      this.last = now;
      st.time += dt;

      this._applyPalette(false);

      const shape = this._shapeFor(s);
      const total = shape.total;
      const spacing = total / s.stars;
      const engaged = st.hovered || st.focused;
      const cruise = this.reduce ? 0 : (s.direction * total) / s.duration;

      const revealTarget = s.hover === 'reveal' && !engaged ? 0 : 1;
      st.reveal += (revealTarget - st.reveal) * (1 - Math.exp(-dt / (revealTarget > st.reveal ? 0.16 : 0.45)));
      const boostTarget = s.hover === 'brighten' && engaged ? 1 : 0;
      st.boost += (boostTarget - st.boost) * (1 - Math.exp(-dt / (boostTarget > st.boost ? 0.18 : 0.5)));
      st.flash *= Math.exp(-dt / 0.22);

      st.velocity += (cruise - st.velocity) * (1 - Math.exp(-dt / 0.45));
      let extra = 0;
      if (st.lap >= 0) {
        const before = ease(Math.min(1, st.lap / LAP));
        st.lap += dt;
        extra = (ease(Math.min(1, st.lap / LAP)) - before) * total * s.direction;
        if (st.lap >= LAP) st.lap = -1;
      }
      st.motion = st.velocity + extra / dt;
      st.phase = wrap(st.phase + st.velocity * dt + extra, total);

      const pace = Math.abs(st.motion) / Math.max(1, Math.abs(total / s.duration));
      if (s.sparkle && !this.reduce && st.reveal > 0.05) {
        st.emit += dt * (2 + 6 * Math.min(2, pace)) * s.stars;
        while (st.emit > 1) {
          st.emit -= 1;
          pointAt(shape, st.phase + Math.floor(Math.random() * s.stars) * spacing, this.point);
          this._spawnDust(this.point.x, this.point.y, this.point.nx, this.point.ny, st.motion);
        }
      }
      for (let i = this.dust.length - 1; i >= 0; i--) {
        const mote = this.dust[i];
        mote.age += dt;
        mote.x += mote.vx * dt;
        mote.y += mote.vy * dt;
        mote.vx *= Math.exp(-dt * 2.2);
        mote.vy *= Math.exp(-dt * 2.2);
        if (mote.age >= mote.life) this.dust.splice(i, 1);
      }
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        this.pulses[i].age += dt;
        if (this.pulses[i].age >= 0.65) this.pulses.splice(i, 1);
      }

      this._draw(s, shape);

      const settling =
        Math.abs(revealTarget - st.reveal) > 0.002 ||
        Math.abs(boostTarget - st.boost) > 0.002 ||
        st.flash > 0.01 ||
        this.pulses.length > 0 ||
        this.dust.length > 0;
      const moving = Math.abs(st.motion) > 0.05 || cruise !== 0 || st.lap >= 0;
      const showing = st.reveal > 0.002 || revealTarget > 0;
      if (st.visible && (settling || (moving && showing) || st.hovered)) {
        this.raf = requestAnimationFrame(this._tick);
      }
    }

    _wake() {
      if (this.raf || !this.alive || !this.state.visible) return;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this._tick);
    }

    debug() {
      const st = this.state;
      return {
        supported: !!this.supported,
        raf: !!this.raf,
        size: [st.width, st.height],
        canvas: [this.canvas.width, this.canvas.height],
        phase: Math.round(st.phase),
        reveal: Number(st.reveal.toFixed(3)),
        dust: this.dust.length,
        pulses: this.pulses.length,
        lightMode: !!this.settings.light,
        color: this.settings.color,
        visible: st.visible
      };
    }
  }

  window.StarBorder = StarBorder;
})();
