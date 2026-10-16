/* =========================================================
   main.js — 主题系统 / 滚动揭示 / 数字滚动 / 交互微动效
   ========================================================= */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let swarm = null; // SwarmCursor 实例（提前声明，避免主题初始化时的 TDZ）
  let star = null;  // StarBorder 实例（同上）
  let mesh = null;  // ElasticMesh 实例（同上）
  let gooey = null; // GooeyNav 实例（同上）
  let themeToggleEl = null; // 主题开关按钮（DOM 就绪后赋值）

  /* ---------- 主题：light / dark / system ---------- */
  const THEME_KEY = 'li-shouyu-theme';
  function applyTheme(mode) {
    const real = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
    root.setAttribute('data-theme', real);
    localStorage.setItem(THEME_KEY, mode);
    if (themeToggleEl) {
      themeToggleEl.dataset.mode = real;
      themeToggleEl.setAttribute('aria-pressed', String(real === 'dark'));
    }
    syncSwarm(real);
    syncStar(real);
    syncMesh(real);
    syncGooey(real);
    window.dispatchEvent(new CustomEvent('themechange', { detail: real }));
  }
  // 本次版本的默认基线迁移（仅生效一次）：无用户操作即进入浅色 + 光标开启
  const BOOT_MARK = 'li-shouyu-boot2';
  if (localStorage.getItem(BOOT_MARK) !== '1') {
    localStorage.setItem(THEME_KEY, 'light');
    localStorage.setItem('li-shouyu-swarm', 'on');
    localStorage.setItem(BOOT_MARK, '1');
  }

  // 默认日间（浅色）模式
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(saved);
  media.addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'light') === 'system') applyTheme('system');
  });
  // 主题开关：单按钮 太阳/月亮 切换
  themeToggleEl = $('#themeToggle');
  themeToggleEl.addEventListener('click', () =>
    applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  /* ---------- 导航状态 & 移动端菜单 ---------- */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  $('#burger').addEventListener('click', () => $('#navLinks').classList.toggle('open'));
  // 事件委托：GooeyNav 接管后会重建内部节点，逐节点绑定会随重建失效
  $('#navLinks').addEventListener('click', e => {
    if (e.target.closest('a')) $('#navLinks').classList.remove('open');
  });

  /* ---------- 滚动揭示 ---------- */
  document.body.classList.add('js');
  // 兜底：任何情况下 3s 后强制显示，避免内容被动画卡住
  setTimeout(() => $$('.reveal').forEach(el => el.classList.add('in')), 3000);

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (!e.isIntersecting) return;
      const el = e.target;
      setTimeout(() => el.classList.add('in'), i * 70);
      io.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  $$('.reveal').forEach(el => io.observe(el));

  /* ---------- 数字滚动 ---------- */
  function runCount(el) {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const target = parseFloat(el.dataset.count);
    // 数字文本节点置于最前，保留 em 单位后缀
    let node = el.firstChild;
    if (!node || node.nodeType !== 3) {
      node = document.createTextNode('0');
      el.insertBefore(node, el.firstChild);
    }
    const dur = 1200, start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    (function step(now) {
      const p = Math.max(0, Math.min(1, (now - start) / dur));
      node.nodeValue = Math.round(target * ease(p)).toString();
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }
  function fillBar(el) {
    if (!el.style.width) el.style.width = el.dataset.fill + '%';
  }
  // 兜底：3s 后无条件补齐动画终点，防止观察器未触发导致内容缺失
  setTimeout(() => {
    $$('.reveal').forEach(el => el.classList.add('in'));
    $$('[data-count]').forEach(runCount);
    $$('.bar-fill').forEach(fillBar);
  }, 3000);

  const countIO = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      runCount(e.target);
      countIO.unobserve(e.target);
    });
  }, { threshold: 0.4 });
  $$('[data-count]').forEach(el => countIO.observe(el));

  /* ---------- 能力条 ---------- */
  const barIO = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.style.width = e.target.dataset.fill + '%';
      barIO.unobserve(e.target);
    });
  }, { threshold: 0.5 });
  $$('.bar-fill').forEach(el => barIO.observe(el));

  /* ---------- 复制联系方式 ---------- */
  const toast = $('#toast');
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
  }
  $$('[data-copy]').forEach(row => row.addEventListener('click', async () => {
    const text = row.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制：' + text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      showToast('已复制：' + text);
    }
  }));

  /* ---------- 光标光效（SwarmCursor · 粒子群） ---------- */
  const SWARM_KEY = 'li-shouyu-swarm';
  const swarmLayer = $('#swarmLayer');
  const swarmBtn = $('#swarmToggle');

  function accentColors() {
    const s = getComputedStyle(root);
    return {
      accentColor: (s.getPropertyValue('--accent') || '#3DC0F5').trim()
    };
  }
  // 光标粒子统一天蓝（本色 + 加速/点击高光同色，深浅主题都不再变白或变黑）
  const SWARM_INK = '#87CEEB';
  function swarmColors() {
    return { color: SWARM_INK, accentColor: SWARM_INK };
  }
  // 主题变化时同步明暗模式（浅色下降低柔化半径，保持天蓝颗粒锐利）
  function syncSwarm(realTheme) {
    if (!swarm) return;
    swarm.setOptions(Object.assign(swarmColors(), {
      lightMode: realTheme === 'light'
    }));
  }

  // 只要求“有鼠标悬停能力”，不再强制 pointer:fine（触屏笔记本/混合设备常判 coarse）
  const finePointer = window.matchMedia('(hover:hover)').matches;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const swarmOn = localStorage.getItem(SWARM_KEY) !== 'off';

  // 实例始终创建（enabled 控制显隐），否则关掉后 ✦ 按钮不可见、永远无法重新开启
  if (finePointer && window.SwarmCursor && SwarmCursor.isSupported()) {
    swarm = new SwarmCursor(swarmLayer, $('#swarmCanvas'), Object.assign(swarmColors(), {
      lightMode: root.getAttribute('data-theme') === 'light',
      // 官方 SwarmCursor 默认参数：更多粒子、更大颗粒、鼠标静止/离开时仍在中场游动（idle:'roam' 保证随时可见）
      count: 800,
      size: 2.6,
      shape: 'dot',
      spread: 90,
      speed: 1,
      swirl: 0.6,
      tail: 0.5,
      trail: 0.6,
      wander: 0.5,
      depth: 0.7,
      idle: 'roam',
      clickEffect: 'burst',
      intro: true,
      opacity: 1,
      dpr: 1.5
    }));
    // 系统开启“减弱动态效果”时组件会完全不绘制；光标拖尾不属眩晕型动画，这里保留并提示可手动关闭
    if (swarm && swarm.reduce) {
      swarm.reduce = false;
      swarm.wake();
    }
  }

  if (swarm && swarm.supported) {
    window.__swarm = swarm; // 调试钩子
    swarmBtn.hidden = false;
    if (reduceMotion) {
      setTimeout(() => showToast('检测到系统「减弱动态效果」，已为你保留光标光效（可点 ✦ 关闭）'), 900);
    }
    const setSwarm = on => {
      localStorage.setItem(SWARM_KEY, on ? 'on' : 'off');
      swarmLayer.dataset.off = on ? 'false' : 'true';
      swarmBtn.setAttribute('aria-pressed', String(on));
      swarm.setOptions({ enabled: on });
    };
    setSwarm(swarmOn);
    swarmBtn.addEventListener('click', () => {
      setSwarm(localStorage.getItem(SWARM_KEY) === 'off');
      showToast(localStorage.getItem(SWARM_KEY) === 'off' ? '光标光效已关闭' : '光标光效已开启');
    });
  } else {
    swarmLayer.dataset.off = 'true';
    swarm = null;
  }

  /* ---------- 磁性按钮（仅指针设备） ---------- */
  if (window.matchMedia('(hover:hover)').matches) {
    $$('.btn').forEach(btn => {
      btn.addEventListener('pointermove', (e) => {
        const r = btn.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        btn.style.transform = `translate(${dx * 0.18}px, ${dy * 0.28}px) scale(1.03)`;
      });
      btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
    });
  }

  /* ---------- 首屏姓名 · ElasticMesh 充气网格 ---------- */
  // 姓名固定纯白；浅色主题下白底白字会「消失」，改用近黑保证可读
  function meshColor(isLight) { return isLight ? '#101828' : '#FFFFFF'; }
  const heroName = $('#heroName');
  if (heroName && window.ElasticMesh && ElasticMesh.isSupported()) {
    const meshFont = '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
    mesh = new ElasticMesh(heroName, {
      text: '李寿昱',
      fontFamily: meshFont,
      fontWeight: 900,
      color: meshColor(root.getAttribute('data-theme') === 'light'),
      material: 'balloon',
      inflate: 1.05,
      stiffness: 0.42,
      wobble: 0.7,
      stretch: 0.55,
      press: 0.55,
      shadow: 0.5,
      intro: true,
      lightMode: root.getAttribute('data-theme') === 'light',
      dpr: 1.6
    });
    if (mesh.supported) {
      heroName.classList.add('mesh-on'); // 只有网格就绪才隐藏原文字
      window.__mesh = mesh; // 调试钩子
    } else {
      mesh = null;
    }
  }
  // 主题变化时同步材质配色与光照（浅色走 studio() 的亮部光照）
  function syncMesh(realTheme) {
    if (!mesh) return;
    mesh.setOptions({
      color: meshColor(realTheme === 'light'),
      lightMode: realTheme === 'light'
    });
  }

  /* ---------- 顶部导航 · GooeyNav 液态药丸 ---------- */
  // 只在桌面宽度接管：≤720px 时导航是抽屉菜单，需要原始 <a> 结构
  const navLinks = $('#navLinks');
  const gooeyQuery = window.matchMedia('(min-width: 721px)');

  function mountGooey() {
    if (gooey || !navLinks || !window.GooeyNav || !gooeyQuery.matches) return;
    gooey = new GooeyNav(navLinks, {
      theme: root.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
      color: accentColors().accentColor,
      size: 'md',
      frame: false, // 试运行：取消导航栏磨砂面板与边框，药丸直接悬浮（想恢复改回 true）
      activeIndex: 0,
      particleCount: 18,
      spread: 64,
      animationTime: 620,
      timeVariance: 280,
      gooeyness: 0.55,
      wobble: 0.5,
      hoverEffect: true,
      onChange: () => {
        // 药丸飞行交给组件；页内锚点跳转沿用 a[href] 默认行为（html{scroll-behavior:smooth}）
        navLinks.classList.remove('open');
      }
    });
    window.__gooey = gooey; // 调试钩子
  }

  function unmountGooey() {
    if (!gooey) return;
    gooey.destroy();
    gooey = null;
    window.__gooey = null;
  }

  function syncGooey(realTheme) {
    if (!gooey) return;
    gooey.setOptions({
      theme: realTheme === 'light' ? 'light' : 'dark',
      color: accentColors().accentColor
    });
  }

  if (navLinks && window.GooeyNav) {
    mountGooey();
    const onBreakpoint = () => (gooeyQuery.matches ? mountGooey() : unmountGooey());
    if (gooeyQuery.addEventListener) gooeyQuery.addEventListener('change', onBreakpoint);
    else gooeyQuery.addListener(onBreakpoint);

    // 滚动联动：当前所在区块 → 药丸自动流过去（IntersectionObserver，零滚动监听开销）
    const spy = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting || !gooey) return;
        const index = gooey.items.findIndex(item => item.href === '#' + e.target.id);
        if (index > -1) gooey.setActive(index, true);
      });
    }, { rootMargin: '-42% 0px -52% 0px' });
    $$('main section[id]').forEach(section => spy.observe(section));
  }

  /* ---------- 下载简历按钮 · StarBorder 星轨 ---------- */
  const resumeBtn = $('#resumeBtn');
  if (resumeBtn && window.StarBorder) {
    star = new StarBorder(resumeBtn, {
      color: accentColors().accentColor,
      lightMode: root.getAttribute('data-theme') === 'light',
      duration: 4.2,
      thickness: 1,
      trailLength: 0.3,
      glow: 0.6,
      sparkle: true,
      hover: 'lap',
      clickPulse: true
    });
    if (star.supported) window.__star = star; // 调试钩子
    else star = null;
  }
  // 主题变化时同步星轨颜色与明暗模式（浅色降低光晕避免发灰）
  function syncStar(realTheme) {
    if (!star) return;
    star.setOptions({
      color: accentColors().accentColor,
      lightMode: realTheme === 'light',
      glow: realTheme === 'light' ? 0.45 : 0.6
    });
  }
})();
