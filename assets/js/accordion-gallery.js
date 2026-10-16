/* =========================================================
   accordion-gallery.js
   React Bits <AccordionGallery /> 的原生 JS 移植版
   ---------------------------------------------------------
   与原组件的等价实现：
   · GSAP timeline  ->  CSS transition（缓动 cubic-bezier(.22,1,.36,1) ≈ power3.out）
   · flexGrow 展开比例 / rotateY(tilt) 3D 倾斜  —— 保留
   · 灰度 + 压暗（--ag-dim）/ 图片内部视差漂移  —— 保留
   · 标签逐级揭示（bar -> text 的 stagger）      —— 保留
   · hover / click 触发、方向键导航、焦点展开    —— 保留
   · ResizeObserver 重算 media 尺寸             —— 保留
   · prefers-reduced-motion 降级                —— 保留
   ========================================================= */
(function (global) {
  'use strict';

  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var HOVERABLE = !!(window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches);

  function AccordionGallery(root, options) {
    if (!root) return;
    var o = this.opts = Object.assign({
      defaultIndex: 0,
      duration: 0.6,
      expandRatio: 0.52,
      tilt: 8,
      parallax: 0.5,
      stagger: 0.06,
      grayscale: true,
      showLabels: true,
      trigger: 'hover',
      height: 420,
      orientation: 'horizontal'
    }, options || {});

    // 允许在 HTML 上以 data-* 覆盖默认值
    var d = root.dataset || {};
    var num = function (key, target) { if (d[key] != null && d[key] !== '') o[target] = parseFloat(d[key]); };
    num('defaultIndex', 'defaultIndex');
    num('duration', 'duration');
    num('expandRatio', 'expandRatio');
    num('tilt', 'tilt');
    num('parallax', 'parallax');
    num('stagger', 'stagger');
    num('height', 'height');
    if (d.trigger) o.trigger = d.trigger;
    if (d.orientation) o.orientation = d.orientation;
    if (d.grayscale != null) o.grayscale = d.grayscale !== 'false';
    if (d.showLabels != null) o.showLabels = d.showLabels !== 'false';

    this.root = root;
    this.vertical = o.orientation === 'vertical';
    this.panels = Array.prototype.slice.call(root.querySelectorAll('.ag-panel'));
    this.count = this.panels.length;
    if (!this.count) return;

    this.active = clamp(Math.round(o.defaultIndex), 0, this.count - 1);
    this.mediaSize = 320;
    this.firstRun = true;

    // 高度与圆角写进 CSS 变量
    root.style.height = this.vertical
      ? Math.round(o.height * 1.6) + 'px'
      : o.height + 'px';

    this._bind();
    this._measure();

    if (typeof ResizeObserver !== 'undefined') {
      var self = this;
      this.ro = new ResizeObserver(function () { self._measure(); });
      this.ro.observe(root);
    } else {
      var self2 = this;
      this._onWinResize = function () { self2._measure(); };
      global.addEventListener('resize', this._onWinResize);
    }
  }

  AccordionGallery.prototype._measure = function () {
    var rect = this.root.getBoundingClientRect();
    var total = this.vertical ? rect.height : rect.width;
    if (!total) return;
    var usable = Math.max(total - 12 * (this.count - 1), 120);
    var r = clamp(this.opts.expandRatio, 0.2, 0.9);
    var size = Math.max(140, usable * r * 1.22);
    this.mediaSize = size;
    this.root.style.setProperty('--ag-media-size', size + 'px');
    this.render(!this.firstRun);
    this.firstRun = false;
  };

  AccordionGallery.prototype.setActive = function (i) {
    if (i === this.active) return;
    this.active = i;
    this.render(true);
  };

  AccordionGallery.prototype.render = function (animate) {
    var o = this.opts;
    var self = this;
    var r = clamp(o.expandRatio, 0.2, 0.9);
    var grow = this.count > 1 ? (r * (this.count - 1)) / (1 - r) : 1;
    var dur = (animate && !REDUCED) ? o.duration : 0;
    var durS = dur + 's';
    // 首屏（不带动画）时延迟必须归零，否则 duration=0 + delay>0 会把标签挂在延迟里
    var st = (animate && !REDUCED) ? o.stagger : 0;

    this.panels.forEach(function (panel, i) {
      var isActive = i === self.active;
      var rot = isActive ? 0 : (i < self.active ? o.tilt : -o.tilt);

      panel.style.transitionDuration = durS;
      panel.style.flexGrow = String(isActive ? grow : 1);
      panel.style.transform = self.vertical ? 'rotateX(' + (-rot) + 'deg)' : 'rotateY(' + rot + 'deg)';
      panel.classList.toggle('ag-panel--active', isActive);
      panel.setAttribute('aria-current', isActive ? 'true' : 'false');

      var media = panel.querySelector('.ag-panel__media');
      if (media) {
        var drift = clamp(self.active - i, -1.5, 1.5);
        var shift = drift * o.parallax * self.mediaSize * 0.06;
        var t = self.vertical
          ? 'translate(-50%,-50%) translate(0,' + (isActive ? 0 : shift) + 'px)'
          : 'translate(-50%,-50%) translate(' + (isActive ? 0 : shift) + 'px,0)';
        media.style.transitionDuration = durS;
        media.style.transform = t;
        media.style.filter = o.grayscale ? 'grayscale(' + (isActive ? 0 : 1) + ')' : 'none';
        panel.style.setProperty('--ag-dim', isActive ? '0' : '0.35');
      }

      if (o.showLabels) {
        var bar = panel.querySelector('.ag-panel__bar');
        var text = panel.querySelector('.ag-panel__text');
        if (bar) {
          bar.style.transitionDuration = durS;
          bar.style.transitionDelay = isActive ? st + 's' : '0s';
          bar.style.opacity = isActive ? '1' : '0';
          bar.style.transform = isActive ? 'translateX(0)' : 'translateX(-14px)';
        }
        if (text) {
          text.style.transitionDuration = durS;
          text.style.transitionDelay = isActive ? (st * 2) + 's' : '0s';
          text.style.opacity = isActive ? '1' : '0';
          text.style.transform = isActive ? 'translateX(0)' : 'translateX(-14px)';
        }
      }
    });
  };

  AccordionGallery.prototype._bind = function () {
    var self = this;
    var o = this.opts;
    var hoverMode = o.trigger === 'hover' && HOVERABLE;

    this.panels.forEach(function (panel, i) {
      if (hoverMode) {
        panel.addEventListener('pointerenter', function () {
          if (i !== self.active) self.setActive(i);
        });
      }
      panel.addEventListener('click', function (e) {
        if (i !== self.active) {
          e.preventDefault();
          self.setActive(i);
        }
      });
      panel.addEventListener('focus', function () {
        if (i !== self.active) self.setActive(i);
      });
      panel.addEventListener('keydown', function (e) {
        var next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % self.count;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + self.count) % self.count;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = self.count - 1;
        if (next < 0) return;
        e.preventDefault();
        self.setActive(next);
        self.panels[next].focus();
      });
    });
  };

  AccordionGallery.prototype.destroy = function () {
    if (this.ro) this.ro.disconnect();
    if (this._onWinResize) global.removeEventListener('resize', this._onWinResize);
  };

  function autoInit() {
    var nodes = document.querySelectorAll('[data-accordion-gallery], .accordion-gallery');
    var list = [];
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.dataset.agReady === '1') return;
      el.dataset.agReady = '1';
      list.push(new AccordionGallery(el));
    });
    return list;
  }

  global.AccordionGallery = AccordionGallery;
  global.initAccordionGalleries = autoInit;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
