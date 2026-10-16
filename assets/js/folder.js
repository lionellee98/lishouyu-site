/* ============================================================
 * Folder — React Bits <Folder /> 原生 JS 移植
 * 弹簧物理 / 3D 矩阵 / WebGL 玻璃渲染逐字保留，仅把 React 层换成原生 DOM。
 * 用法：<div data-folder='{"label":"...","items":[...]}'></div>
 * ============================================================ */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const STEP = 1 / 240;
  const MAX_ITEMS = 6;
  const DEFAULT_ITEMS = [{ title: 'Brand guidelines' }, { title: 'Launch plan' }, { title: 'Moodboard' }];

  const PILE_TURN = [0.5, -1.1, 1.5, -0.7, 1.2, -1.6];
  const BOOK_REST = [
    { x: 0.14, y: -0.004, r: 1.4 },
    { x: 0.115, y: 0.008, r: -1.1 },
    { x: 0.09, y: 0, r: 0.6 }
  ];
  const BOOK_PEEK = [
    { x: 0.27, y: -0.016, r: 4.5 },
    { x: 0.2, y: 0.014, r: 1.2 },
    { x: 0.14, y: 0, r: -1.2 }
  ];
  const FLAP_REST = [
    { x: 0.16, rise: 0, r: 3 },
    { x: -0.17, rise: 0.05, r: -3.5 },
    { x: 0, rise: 0.1, r: 0.5 },
    { x: 0.25, rise: 0.08, r: 5 },
    { x: -0.25, rise: 0.09, r: -5.5 },
    { x: 0.08, rise: 0.12, r: 1.5 }
  ];
  const SPREAD_TURN = [4, -5, 3, -6, 5, -3];
  const SPREAD_DROP = [0.03, -0.04, 0.05, -0.02, 0.04, -0.05];
  const DROP_TURN = [-6, 4, -3, 7, -5, 3];
  const BOOK_ANGLES = { open: -180, receive: -24, peek: -13, rest: 0 };
  const FLAP_ANGLES = { open: -64, receive: -30, peek: -15, rest: 0 };
  const LAYERS = { out: 50, drag: 80, focus: 90 };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const parseColor = (() => {
    let context = null;
    const cache = new Map();
    return value => {
      const key = String(value);
      if (cache.has(key)) return cache.get(key);
      let rgb = [61, 139, 255];
      if (typeof document !== 'undefined') {
        context ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        if (context) {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = '#3d8bff';
          context.fillStyle = key;
          context.fillRect(0, 0, 1, 1);
          rgb = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        }
      }
      cache.set(key, rgb);
      return rgb;
    };
  })();

  const mixRgb = (rgb, target, amount) => rgb.map((channel, i) => Math.round(channel + (target[i] - channel) * amount));
  const rgbString = rgb => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  const luma = rgb => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

  const multiply = (a, b) => {
    const out = new Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
      }
    }
    return out;
  };

  const chain = (...list) => list.reduce(multiply);
  const move = (x, y, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const stretch = (x, y) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  const turnX = degrees => {
    const r = (degrees * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  };

  const turnY = degrees => {
    const r = (degrees * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  };

  const turnZ = degrees => {
    const r = (degrees * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  };

  const toCss = m => `matrix3d(${m.map(v => (Math.abs(v) < 1e-7 ? 0 : Number(v.toFixed(6)))).join(', ')})`;

  const measureFolder = (book, scale, labelWidth, hasLabel, tabPosition) => {
    const w = (book ? 180 : 224) * scale;
    const h = (book ? 232 : 176) * scale;
    const tabH = 20 * scale;
    const r = 12 * scale;
    const shoulder = tabH * 0.75;
    const frontTop = book ? tabH : tabH + h * 0.3;
    const corners = book ? [0, r, r, 0] : [r, r, r, r];
    const maxTab = w - corners[0] - corners[1] - shoulder * 2 - 10 * scale;
    const tabW = clamp(hasLabel ? labelWidth + 14 * scale + shoulder : w * 0.34, Math.min(w * 0.3, maxTab), maxTab);
    const tabX =
      tabPosition === 'left'
        ? corners[0] + 5 * scale + shoulder
        : tabPosition === 'center'
          ? (w - tabW) / 2
          : w - corners[1] - 5 * scale - shoulder - tabW;
    const docW = book ? w * 0.8 : w * 0.54;
    return {
      book,
      scale,
      w,
      h,
      tabH,
      r,
      shoulder,
      corners,
      tabW,
      tabX,
      frontTop,
      frontH: tabH + h - frontTop,
      docW,
      docH: docW * (book ? 1.28 : 1.22)
    };
  };

  const backPath = g => {
    const { w, h, tabX, tabW, tabH, shoulder } = g;
    const [tl, tr, br, bl] = g.corners;
    const top = tabH;
    const bottom = tabH + h;
    return [
      `M 0 ${top + tl}`,
      `Q 0 ${top} ${tl} ${top}`,
      `L ${tabX - shoulder} ${top}`,
      `C ${tabX} ${top} ${tabX} 0 ${tabX + shoulder} 0`,
      `L ${tabX + tabW - shoulder} 0`,
      `C ${tabX + tabW} 0 ${tabX + tabW} ${top} ${tabX + tabW + shoulder} ${top}`,
      `L ${w - tr} ${top}`,
      `Q ${w} ${top} ${w} ${top + tr}`,
      `L ${w} ${bottom - br}`,
      `Q ${w} ${bottom} ${w - br} ${bottom}`,
      `L ${bl} ${bottom}`,
      `Q 0 ${bottom} 0 ${bottom - bl}`,
      'Z'
    ].join(' ');
  };

  const VERTEX = `#version 300 es
layout(location = 0) in vec2 aCorner;
uniform mat4 uModel;
uniform vec2 uSize;
uniform float uDepth;
uniform vec2 uOrigin;
uniform vec4 uView;
uniform float uBleed;
out vec2 vLocal;
out vec2 vUv;
void main() {
  vLocal = aCorner * (uSize + vec2(uBleed, 0.0)) - vec2(uBleed, 0.0);
  vUv = aCorner;
  vec4 q = uModel * vec4(vLocal, 0.0, 1.0);
  float w = 1.0 - q.z / uDepth;
  vec2 p = q.xy - uOrigin + (uOrigin - uView.xy) * w;
  vec2 clip = p / uView.zw * 2.0 - w;
  gl_Position = vec4(clip.x, -clip.y, 0.0, w);
}`;

  const PAINT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImage;
uniform float uAlpha;
out vec4 outColor;
void main() {
  outColor = texture(uImage, vUv) * uAlpha;
}`;

  const SCREEN = `#version 300 es
layout(location = 0) in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

  const BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImage;
uniform vec2 uStep;
uniform float uSigma;
out vec4 outColor;
void main() {
  float spacing = max(1.0, uSigma * 2.5 / 24.0);
  int reach = int(min(ceil(uSigma * 2.5 / spacing), 24.0));
  vec4 sum = texture(uImage, vUv);
  float total = 1.0;
  for (int i = 1; i <= 24; i++) {
    if (i > reach) break;
    float x = float(i) * spacing;
    float weight = exp(-0.5 * x * x / (uSigma * uSigma));
    sum += (texture(uImage, vUv + uStep * x) + texture(uImage, vUv - uStep * x)) * weight;
    total += 2.0 * weight;
  }
  outColor = sum / total;
}`;

  const GLASS = `#version 300 es
precision highp float;
in vec2 vLocal;
uniform mat4 uModel;
uniform vec2 uSize;
uniform float uDepth;
uniform vec2 uOrigin;
uniform vec4 uView;
uniform sampler2D uBehind;
uniform vec4 uRadii;
uniform float uSpine;
uniform float uLens;
uniform float uMorph;
uniform vec3 uInsideTop;
uniform vec3 uInsideBottom;
uniform float uTabRatio;
uniform vec2 uGutter;
uniform float uBevel;
uniform float uStrength;
uniform float uSplit;
uniform vec4 uTint;
uniform float uHaze;
uniform float uDim;
uniform float uGlint;
uniform float uShine;
uniform vec2 uLight;
out vec4 outColor;

float box(vec2 p, vec2 b, vec4 r) {
  float k = p.x > 0.0 ? (p.y > 0.0 ? r.z : r.y) : (p.y > 0.0 ? r.w : r.x);
  vec2 q = abs(p) - b + k;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - k;
}

float shape(vec2 p) {
  vec2 halfSize = vec2(uSize.x + uSpine, uSize.y) * 0.5;
  return box(p - vec2(uSize.x - halfSize.x, halfSize.y), halfSize, uRadii);
}

vec2 locate(vec2 p) {
  vec4 q = uModel * vec4(p, 0.0, 1.0);
  float w = 1.0 - q.z / uDepth;
  vec2 s = uOrigin + (q.xy - uOrigin) / w;
  vec2 uv = (s - uView.xy) / uView.zw;
  return vec2(uv.x, 1.0 - uv.y);
}

void main() {
  float d = shape(vLocal);
  float aa = max(fwidth(d), 1e-3);
  float cover = clamp(0.5 - d / aa, 0.0, 1.0);
  if (cover <= 0.0) discard;
  float e = 0.5;
  vec2 n = vec2(
    shape(vLocal + vec2(e, 0.0)) - shape(vLocal - vec2(e, 0.0)),
    shape(vLocal + vec2(0.0, e)) - shape(vLocal - vec2(0.0, e))
  );
  n /= max(length(n), 1e-5);
  float inside = max(0.0, -d);
  float t = 1.0 - clamp(inside / uBevel, 0.0, 1.0);
  vec2 bend = -n * pow(t, 2.0) * uStrength + (uSize * 0.5 - vLocal) * uLens;
  vec2 p = vLocal + bend;
  vec2 uv = locate(p);
  mat2 jac = mat2(locate(p + vec2(1.0, 0.0)) - uv, locate(p + vec2(0.0, 1.0)) - uv);
  vec4 seen = texture(uBehind, uv);
  if (uSplit > 0.0) {
    vec2 split = jac * (bend * uSplit);
    seen.r = texture(uBehind, uv + split).r;
    seen.b = texture(uBehind, uv - split).b;
  }
  vec4 color = vec4(uTint.rgb, 1.0) * uTint.a + seen * (1.0 - uTint.a);
  color.rgb = mix(color.rgb, vec3(color.a), uHaze + uGlint);
  color.rgb *= 1.0 - uDim;
  float band = 0.0;
  if (uMorph > 0.0) {
    band = (1.0 - smoothstep(0.0, uSize.x * 0.75, vLocal.x)) * uMorph;
    vec3 solid = mix(uInsideTop, uInsideBottom, uTabRatio + vLocal.y / uSize.y * (1.0 - uTabRatio));
    color = mix(color, vec4(solid, 1.0), band);
  }
  if (uGutter.y > 0.0) color.rgb *= 1.0 - uGutter.y * (1.0 - smoothstep(0.0, uGutter.x, vLocal.x));
  float facing = dot(n, uLight);
  float edge = clamp(inside / aa, 0.0, 1.0);
  vec2 span = vLocal / uSize;
  float across = uLight.x > 0.0 ? 1.0 - span.x : span.x;
  float sheen = smoothstep(0.85, 0.0, across * 0.55 + span.y) * 0.07 * uShine * (1.0 - band);
  float light = (max(facing, 0.0) * 0.85 + max(-facing, 0.0) * 0.28) * t * t * t * uShine + sheen;
  light += exp(-inside / 0.9) * (0.16 + 0.3 * max(facing, 0.0)) * uShine;
  float shade = max(-facing, 0.0) * t * t * 0.22 * (1.0 - band);
  color = color * (1.0 - shade) + vec4(0.0, 0.0, 0.0, shade);
  light = clamp(light * edge * (1.0 - band), 0.0, 1.0);
  color = color * (1.0 - light) + vec4(light);
  outColor = color * cover;
}`;

  const compile = (gl, type, source) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader);
    return null;
  };

  const link = (gl, vertexSource, fragmentSource, names) => {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    const uniforms = {};
    names.forEach(name => {
      uniforms[name] = gl.getUniformLocation(program, name);
    });
    return { program, uniforms };
  };

  const PLACED = ['uModel', 'uSize', 'uDepth', 'uOrigin', 'uView', 'uBleed'];

  const createGlass = canvas => {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) return null;
    const paint = link(gl, VERTEX, PAINT, [...PLACED, 'uImage', 'uAlpha']);
    const blur = link(gl, SCREEN, BLUR, ['uImage', 'uStep', 'uSigma']);
    const glass = link(gl, VERTEX, GLASS, [
      ...PLACED,
      'uBehind',
      'uRadii',
      'uSpine',
      'uLens',
      'uMorph',
      'uInsideTop',
      'uInsideBottom',
      'uTabRatio',
      'uGutter',
      'uBevel',
      'uStrength',
      'uSplit',
      'uTint',
      'uHaze',
      'uDim',
      'uGlint',
      'uShine',
      'uLight'
    ]);
    if (!paint || !blur || !glass) return null;

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const makeTarget = () => ({ texture: gl.createTexture(), frame: gl.createFramebuffer() });
    const targets = [makeTarget(), makeTarget(), makeTarget()];
    const size = { width: 0, height: 0 };
    const textures = new Map();

    const placed = (program, scene) => {
      gl.uniform1f(program.uniforms.uDepth, scene.depth);
      gl.uniform2f(program.uniforms.uOrigin, scene.origin[0], scene.origin[1]);
      gl.uniform4f(program.uniforms.uView, scene.view.x, scene.view.y, scene.view.width, scene.view.height);
    };

    const resize = (width, height) => {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      if (size.width === width && size.height === height) return;
      size.width = width;
      size.height = height;
      targets.forEach(target => {
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.frame);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
      });
    };

    const pass = (source, target, stepX, stepY, sigma) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.frame);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform2f(blur.uniforms.uStep, stepX, stepY);
      gl.uniform1f(blur.uniforms.uSigma, sigma);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    return {
      upload(key, source) {
        let texture = textures.get(key);
        if (!texture) {
          texture = gl.createTexture();
          textures.set(key, texture);
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      },
      prune(keys) {
        textures.forEach((texture, key) => {
          if (keys.has(key)) return;
          gl.deleteTexture(texture);
          textures.delete(key);
        });
      },
      render(scene) {
        if (gl.isContextLost()) return;
        const width = Math.max(1, Math.round(scene.view.width * scene.dpr));
        const height = Math.max(1, Math.round(scene.view.height * scene.dpr));
        resize(width, height);
        const [sharp, half, soft] = targets;
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindFramebuffer(gl.FRAMEBUFFER, sharp.frame);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(paint.program);
        placed(paint, scene);
        gl.uniform1i(paint.uniforms.uImage, 0);
        gl.uniform1f(paint.uniforms.uBleed, 0);
        scene.layers.forEach(layer => {
          const texture = textures.get(layer.key);
          if (!texture) return;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.uniformMatrix4fv(paint.uniforms.uModel, false, layer.matrix);
          gl.uniform2f(paint.uniforms.uSize, layer.width, layer.height);
          gl.uniform1f(paint.uniforms.uAlpha, layer.alpha);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        });

        const pane = scene.glass;
        const sigma = pane.frost * scene.dpr;
        let behind = sharp;
        if (sigma > 0.35) {
          gl.disable(gl.BLEND);
          gl.useProgram(blur.program);
          gl.uniform1i(blur.uniforms.uImage, 0);
          pass(sharp, half, 1 / width, 0, sigma);
          pass(half, soft, 0, 1 / height, sigma);
          gl.enable(gl.BLEND);
          behind = soft;
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const u = glass.uniforms;
        gl.useProgram(glass.program);
        placed(glass, scene);
        gl.bindTexture(gl.TEXTURE_2D, behind.texture);
        gl.uniform1i(u.uBehind, 0);
        gl.uniformMatrix4fv(u.uModel, false, pane.matrix);
        gl.uniform2f(u.uSize, pane.width, pane.height);
        gl.uniform1f(u.uBleed, pane.bleed);
        gl.uniform4fv(u.uRadii, pane.radii);
        gl.uniform1f(u.uSpine, pane.spine);
        gl.uniform1f(u.uLens, pane.lens);
        gl.uniform1f(u.uMorph, pane.morph);
        gl.uniform3fv(u.uInsideTop, pane.insideTop);
        gl.uniform3fv(u.uInsideBottom, pane.insideBottom);
        gl.uniform1f(u.uTabRatio, pane.tabRatio);
        gl.uniform2fv(u.uGutter, pane.gutter);
        gl.uniform1f(u.uBevel, pane.bevel);
        gl.uniform1f(u.uStrength, pane.strength);
        gl.uniform1f(u.uSplit, pane.split);
        gl.uniform4fv(u.uTint, pane.tint);
        gl.uniform1f(u.uHaze, pane.haze);
        gl.uniform1f(u.uDim, pane.dim);
        gl.uniform1f(u.uGlint, pane.glint);
        gl.uniform1f(u.uShine, pane.shine);
        gl.uniform2fv(u.uLight, pane.light);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      dispose() {
        textures.forEach(texture => gl.deleteTexture(texture));
        textures.clear();
        targets.forEach(target => {
          gl.deleteTexture(target.texture);
          gl.deleteFramebuffer(target.frame);
        });
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(paint.program);
        gl.deleteProgram(blur.program);
        gl.deleteProgram(glass.program);
      }
    };
  };

  const roundedRect = (ctx, x, y, width, height, radius) => {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  };

  const offsetWithin = (element, root) => {
    let x = 0;
    let y = 0;
    let node = element;
    while (node && node !== root) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return node === root ? [x, y] : null;
  };

  const isClear = color => !color || color === 'transparent' || /rgba?\([^)]*[,/]\s*0\s*\)$/.test(color);

  const drawText = (ctx, element, x, y, width, style) => {
    const text = Array.from(element.childNodes)
      .filter(node => node.nodeType === 3)
      .map(node => node.textContent)
      .join('')
      .trim();
    if (!text) return;
    const size = parseFloat(style.fontSize) || 12;
    const lineHeight = parseFloat(style.lineHeight) || size * 1.2;
    const left = x + (parseFloat(style.paddingLeft) || 0);
    const top = y + (parseFloat(style.paddingTop) || 0);
    const room = width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'middle';
    const fit = line => {
      if (ctx.measureText(line).width <= room) return line;
      let cut = line;
      while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
      return `${cut.trimEnd()}…`;
    };
    if (style.whiteSpace === 'nowrap') {
      ctx.fillText(fit(text), left, top + lineHeight / 2);
      return;
    }
    let line = '';
    let row = 0;
    text.split(/\s+/).forEach(word => {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > room) {
        ctx.fillText(line, left, top + lineHeight * (row + 0.5));
        row += 1;
        line = word;
      } else {
        line = next;
      }
    });
    if (line) ctx.fillText(line, left, top + lineHeight * (row + 0.5));
  };

  const rasterize = (node, dpr, skipImages) => {
    const width = Math.max(1, node.offsetWidth);
    const height = Math.max(1, node.offsetHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const pending = [];
    const ctx = canvas.getContext('2d');
    if (!ctx) return { canvas, pending };
    ctx.scale(dpr, dpr);
    const paint = (element, x, y) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const w = element.offsetWidth;
      const h = element.offsetHeight;
      const radius = parseFloat(style.borderTopLeftRadius) || 0;
      const opacity = element !== node && Number.isFinite(parseFloat(style.opacity)) ? parseFloat(style.opacity) : 1;
      ctx.save();
      ctx.globalAlpha *= opacity;
      if (!isClear(style.backgroundColor)) {
        ctx.fillStyle = style.backgroundColor;
        roundedRect(ctx, x, y, w, h, radius);
        ctx.fill();
      }
      if (style.overflow !== 'visible') {
        roundedRect(ctx, x, y, w, h, radius);
        ctx.clip();
      }
      if (element instanceof HTMLImageElement) {
        if (!element.complete || !element.naturalWidth) pending.push(element);
        else if (!skipImages) {
          const ratio = Math.max(w / element.naturalWidth, h / element.naturalHeight);
          const sw = w / ratio;
          const sh = h / ratio;
          ctx.drawImage(element, (element.naturalWidth - sw) / 2, (element.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
        }
      } else {
        drawText(ctx, element, x, y, w, style);
        Array.from(element.children).forEach(child => {
          const at = offsetWithin(child, node);
          if (at) paint(child, at[0], at[1]);
        });
      }
      ctx.restore();
    };
    paint(node, 0, 0);
    return { canvas, pending };
  };

  const paintBack = (g, top, bottom, dpr) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(g.w * dpr));
    canvas.height = Math.max(1, Math.round((g.tabH + g.h) * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.scale(dpr, dpr);
    const fill = ctx.createLinearGradient(0, 0, 0, g.tabH + g.h);
    fill.addColorStop(0, top);
    fill.addColorStop(1, bottom);
    ctx.fillStyle = fill;
    ctx.fill(new Path2D(backPath(g)));
    return canvas;
  };

  /* ---------- 内容卡片（DocumentCard） ---------- */

  const docCardHTML = (title, description) => {
    let html = '';
    if (title) html += `<span class="folder-doc-title">${escapeHTML(title)}</span>`;
    else html += '<span class="folder-doc-heading"></span>';
    if (description) html += `<span class="folder-doc-text">${escapeHTML(description)}</span>`;
    html +=
      '<span class="folder-doc-line" style="width:92%"></span>' +
      '<span class="folder-doc-line" style="width:84%"></span>' +
      '<span class="folder-doc-line" style="width:88%"></span>' +
      '<span class="folder-doc-block"></span>' +
      '<span class="folder-doc-line" style="width:80%"></span>' +
      '<span class="folder-doc-line" style="width:62%"></span>';
    return `<div class="folder-doc">${html}</div>`;
  };

  const escapeHTML = s =>
    String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const renderItemHTML = item => {
    if (item && typeof item === 'object' && item.image) {
      return `<div class="folder-photo"><img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.alt ?? item.title ?? '')}" draggable="false"></div>`;
    }
    if (item && typeof item === 'object' && item.content) return item.content;
    if (typeof item === 'string' || typeof item === 'number') return docCardHTML(String(item), '');
    if (item && typeof item === 'object') return docCardHTML(item.title ?? '', item.description ?? '');
    return docCardHTML('', '');
  };

  const placeBook = (rank, count, phase, layout, g) => {
    const pileX = g.w / 2;
    const pileY = g.frontTop + g.frontH / 2;
    if (phase === 'open') {
      if (layout === 'row') {
        const gap = 10 * g.scale;
        const fit = Math.min(0.8, (g.w * 1.86 - gap * (count - 1)) / (count * g.docW));
        const step = g.docW * fit + gap;
        return { x: g.w / 2 + (rank - (count - 1) / 2) * step, y: pileY, z: 0, r: 0, ry: 0, s: fit };
      }
      if (layout === 'stack') {
        const fit = 0.74;
        const strip = Math.min(26 * g.scale, (g.h * 0.36) / Math.max(1, count - 1));
        const top = g.frontTop + 14 * g.scale + (count - 1) * strip;
        return { x: g.w, y: top + (g.docH * fit) / 2 - rank * strip, z: 0, r: 0, ry: 0, s: fit };
      }
      const fit = count > 4 ? 0.58 : count > 3 ? 0.64 : 0.72;
      const span = count === 2 ? g.w : Math.min(g.w * 1.3, g.w * 0.6 * (count - 1));
      const x = count > 1 ? span / 2 - (rank * span) / (count - 1) : g.w * 0.5;
      return { x: g.w / 2 + x, y: pileY + SPREAD_DROP[rank] * g.h, z: 0, r: SPREAD_TURN[rank], ry: 0, s: fit };
    }
    const offsets = phase === 'rest' ? BOOK_REST : BOOK_PEEK;
    const offset = offsets[rank] ?? { x: 0.06, y: 0, r: PILE_TURN[rank] ?? 0 };
    return {
      x: pileX + offset.x * g.w,
      y: pileY + offset.y * g.h + rank * 0.8 * g.scale,
      z: 0,
      r: offset.r,
      ry: 0,
      s: 1
    };
  };

  const placeFlap = (rank, count, phase, layout, g, pointer) => {
    const rest = FLAP_REST[rank] ?? FLAP_REST[FLAP_REST.length - 1];
    const floor = g.tabH + g.h - 5 * g.scale - g.docH / 2;
    const mid = (count - 1) / 2;
    if (phase === 'open') {
      const lift = g.tabH - g.h * 0.02;
      if (layout === 'stack') {
        const strip = Math.min(30 * g.scale, (g.h * 0.62) / Math.max(1, count - 1));
        const fit = 1.04 - rank * 0.05;
        return {
          x: g.w / 2,
          y: g.tabH + g.h * 0.1 - rank * strip - (g.docH * (1.04 - fit)) / 2,
          z: -rank * 18 * g.scale,
          r: 0,
          ry: 0,
          s: fit
        };
      }
      const gap = 12 * g.scale;
      const fit = Math.min(0.94, (g.w * 2.3 - gap * (count - 1)) / (count * g.docW));
      const step = g.docW * fit + gap;
      const tidy = layout === 'row';
      return {
        x: g.w / 2 + (rank - mid) * step,
        y: lift + (tidy ? 0 : SPREAD_DROP[rank] * g.h * 0.7),
        z: 0,
        r: tidy ? 0 : SPREAD_TURN[rank] * 0.55,
        ry: 0,
        s: fit
      };
    }
    const part = phase === 'receive' ? 1.7 : phase === 'peek' ? 1.3 : 1;
    const x = g.w / 2 + rest.x * g.w * part;
    if (phase === 'rest') return { x, y: floor - rest.rise * g.h, z: 0, r: rest.r, ry: 0, s: 1 };
    const near = phase === 'peek' && pointer != null ? Math.max(0, 1 - Math.abs(pointer - x) / (g.w * 0.32)) : 0;
    const rise = rest.rise + (phase === 'receive' ? 0.03 : 0.1);
    return { x, y: floor - rise * g.h - near * near * g.h * 0.09, z: 0, r: rest.r * 1.6, ry: 0, s: 1 };
  };

  /* ---------- Folder 类 ---------- */

  class Folder {
    constructor(root, options = {}) {
      this.root = root;
      this.opts = {
        mode: 'flap',
        variant: 'solid',
        color: '#3d8bff',
        paperColor: '#ffffff',
        label: undefined,
        tabPosition: 'right',
        layout: 'spread',
        size: 1,
        openOn: 'click',
        defaultOpen: false,
        draggable: true,
        zoomOnClick: true,
        peek: true,
        intro: true,
        tilt: 0.5,
        bounce: 0.4,
        speed: 1,
        frost: 0.25,
        closeOnOutsideClick: true,
        theme: 'light',
        onItemClick: null,
        onItemDrop: null,
        onOpenChange: null,
        ...options
      };
      this.labelWidth = 0;
      this.internalOpen = this.opts.defaultOpen;
      this.outside = [];
      this.gpu = false;
      this.entries = (this.opts.items?.length ? this.opts.items : DEFAULT_ITEMS).slice(0, MAX_ITEMS);
      this.count = this.entries.length;
      this.isOpen = () => this.internalOpen;
      this.buildDOM();
      this.measure();
      if (document.fonts?.ready) document.fonts.ready.then(() => this.measure());
      this.buildState();
      this.setup();
      this.setupGlass();
    }

    /* ---------- DOM ---------- */
    buildDOM() {
      const o = this.opts;
      this.el = {};
      const root = this.root;
      root.className = (root.className ? root.className + ' ' : '') + 'folder-root';
      root.dataset.mode = o.mode === 'book' ? 'book' : 'flap';
      root.dataset.variant = o.variant;
      root.dataset.theme = o.theme === 'light' ? 'light' : 'dark';
      if (o.draggable) root.dataset.draggable = '';
      if (this.internalOpen) root.dataset.open = '';
      root.style.userSelect = 'none';

      const stage = document.createElement('div');
      stage.className = 'folder-stage';
      stage.setAttribute('role', 'button');
      stage.tabIndex = 0;
      stage.setAttribute('aria-expanded', String(this.internalOpen));
      stage.setAttribute('aria-label', o.label ? `${o.label} folder` : 'Folder');
      this.el.stage = stage;

      const mk = (cls, ref) => {
        const el = document.createElement('span');
        el.className = 'folder-layer ' + cls;
        el.setAttribute('aria-hidden', 'true');
        stage.appendChild(el);
        if (ref) this.el[ref] = el;
        return el;
      };
      mk('folder-ground', 'ground');
      if (o.mode === 'book') mk('folder-cast', 'cast');

      const back = document.createElement('div');
      back.className = 'folder-layer folder-back';
      back.setAttribute('aria-hidden', 'true');
      this.el.back = back;
      const fill = document.createElement('div');
      fill.className = 'folder-back-fill';
      back.appendChild(fill);
      this.el.backFill = fill;
      if (o.mode === 'book') {
        const gutter = document.createElement('span');
        gutter.className = 'folder-gutter';
        fill.appendChild(gutter);
      }
      const rim = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      rim.setAttribute('class', 'folder-back-rim');
      this.el.rim = rim;
      this.el.focusPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      this.el.focusPath.setAttribute('class', 'folder-focus');
      rim.appendChild(this.el.focusPath);
      back.appendChild(rim);
      if (o.label) {
        const tabText = document.createElement('span');
        tabText.className = 'folder-tab-text';
        tabText.textContent = o.label;
        back.appendChild(tabText);
        this.el.tabText = tabText;
      }
      stage.appendChild(back);

      this.itemEls = [];
      this.entries.forEach((item, index) => {
        const el = document.createElement('div');
        el.className = 'folder-layer folder-item';
        el.dataset.folderItem = String(index);
        el.innerHTML = renderItemHTML(item);
        el.addEventListener('click', e => this.onItemActivate(e, index));
        el.addEventListener('keydown', e => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          this.engine?.select(index);
        });
        stage.appendChild(el);
        this.itemEls.push(el);
      });

      if (o.mode === 'book') mk('folder-shade', 'shade');

      const front = document.createElement('div');
      front.className = 'folder-layer folder-front';
      front.dataset.face = 'outer';
      front.setAttribute('aria-hidden', 'true');
      this.el.front = front;
      const faceOuter = document.createElement('div');
      faceOuter.className = 'folder-face folder-face-outer';
      front.appendChild(faceOuter);
      this.el.faceOuter = faceOuter;
      if (o.mode === 'book') {
        const faceInner = document.createElement('div');
        faceInner.className = 'folder-face folder-face-inner';
        const ig = document.createElement('span');
        ig.className = 'folder-inner-gutter';
        faceInner.appendChild(ig);
        front.appendChild(faceInner);
        this.el.faceInner = faceInner;
      }
      stage.appendChild(front);

      if (o.variant === 'glass') {
        const canvas = document.createElement('canvas');
        canvas.className = 'folder-glass';
        canvas.setAttribute('aria-hidden', 'true');
        stage.appendChild(canvas);
        this.el.glass = canvas;
      }
      root.appendChild(stage);
      this.el.root = root;

      if (o.label) {
        const measure = document.createElement('span');
        measure.className = 'folder-tab-text folder-measure';
        measure.setAttribute('aria-hidden', 'true');
        measure.textContent = o.label;
        root.appendChild(measure);
        this.el.measure = measure;
      }

      stage.addEventListener('click', () => this.toggle());
      stage.addEventListener('keydown', e => {
        if (e.target !== stage) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggle();
        }
      });
    }

    measure() {
      const node = this.el.measure;
      if (!node) return;
      this.labelWidth = node.offsetWidth;
      this.applyVars();
    }

    applyVars() {
      const o = this.opts;
      const g = this.geometry || measureFolder(o.mode === 'book', o.size, this.labelWidth, Boolean(o.label), o.tabPosition);
      const rgb = parseColor(o.color);
      const paper = parseColor(o.paperColor);
      const backTone = mixRgb(rgb, [0, 0, 0], 0.16);
      const insideTop = rgbString(mixRgb(rgb, [0, 0, 0], 0.08));
      const insideBottom = rgbString(backTone);
      const book = o.mode === 'book';
      const vars = {
        '--folder-rgb': rgb.join(', '),
        '--folder-base': rgbString(rgb),
        '--folder-front-top': rgbString(mixRgb(rgb, [255, 255, 255], 0.12)),
        '--folder-front-bottom': rgbString(mixRgb(rgb, [0, 0, 0], 0.06)),
        '--folder-inside-top': insideTop,
        '--folder-inside-bottom': insideBottom,
        '--folder-tab-ink': luma(backTone) > 0.6 ? 'rgba(0, 0, 0, 0.72)' : 'rgba(255, 255, 255, 0.92)',
        '--folder-paper': rgbString(paper),
        '--folder-paper-ink': rgbString(mixRgb(paper, [0, 0, 0], 0.11)),
        '--folder-paper-ink-strong': rgbString(mixRgb(paper, [0, 0, 0], 0.28)),
        '--folder-paper-text': rgbString(mixRgb(paper, [0, 0, 0], 0.72)),
        '--folder-w': `${g.w}px`,
        '--folder-h': `${g.h}px`,
        '--folder-tab-h': `${g.tabH}px`,
        '--folder-front-y': `${g.frontTop}px`,
        '--folder-front-h': `${g.frontH}px`,
        '--folder-r': `${g.r}px`,
        '--folder-front-radius': book ? `0 ${g.r}px ${g.r}px 0` : `${g.r}px`,
        '--folder-doc-w': `${g.docW}px`,
        '--folder-doc-h': `${g.docH}px`,
        '--folder-frost': `${(1.5 + clamp(o.frost, 0, 1) * 10) * o.size}px`
      };
      Object.entries(vars).forEach(([k, v]) => this.root.style.setProperty(k, v));
      if (this.el.rim) {
        this.el.rim.setAttribute('width', String(g.w));
        this.el.rim.setAttribute('height', String(g.tabH + g.h));
        this.el.rim.setAttribute('viewBox', `0 0 ${g.w} ${g.tabH + g.h}`);
      }
      if (this.el.focusPath) this.el.focusPath.setAttribute('d', backPath(g));
      if (this.el.backFill) this.el.backFill.style.clipPath = `path('${backPath(g)}')`;
      if (this.el.tabText) {
        this.el.tabText.style.left = `${g.tabX}px`;
        this.el.tabText.style.width = `${g.tabW}px`;
      }
      if (this.el.glass) {
        const view = this.viewFor(g);
        Object.assign(this.el.glass.style, {
          left: view.x + 'px',
          top: view.y + 'px',
          width: view.width + 'px',
          height: view.height + 'px'
        });
      }
    }

    viewFor(g) {
      const total = g.tabH + g.h;
      return g.book
        ? { x: -0.75 * g.w, y: -0.25 * total, width: 2.5 * g.w, height: 1.5 * total }
        : { x: -0.25 * g.w, y: -0.1 * total, width: 1.5 * g.w, height: 1.3 * total };
    }

    setTheme(real) {
      this.opts.theme = real === 'light' ? 'light' : 'dark';
      this.root.dataset.theme = this.opts.theme;
      this.engine?.invalidate();
      this.wake();
    }

    /* ---------- 状态 ---------- */
    buildState() {
      this.state = {
        raf: 0,
        last: 0,
        ready: false,
        hovered: false,
        pressed: false,
        pointerX: 0,
        pointerY: 0,
        deskX: 0,
        deskY: 0,
        hoveredItem: -1,
        phase: 'rest',
        previous: 'rest',
        changedAt: 0,
        front: { value: 0, velocity: 0 },
        rx: { value: 0, velocity: 0 },
        ry: { value: 0, velocity: 0 },
        lift: { value: 0, velocity: 0 },
        squash: { value: 1, velocity: 0 },
        items: [],
        focus: -1,
        drag: null,
        receiving: false,
        receiveUntil: 0,
        suppressClick: false,
        dropCount: 0,
        intro: { phase: 'done', start: 0, opening: false },
        anchor: { value: 0, velocity: 0 },
        appear: 1,
        content: { key: '', entries: null, renderer: null }
      };
    }

    settings() {
      const o = this.opts;
      const g = measureFolder(o.mode === 'book', o.size, this.labelWidth, Boolean(o.label), o.tabPosition);
      this.geometry = g;
      const rgb = parseColor(o.color);
      const backTone = mixRgb(rgb, [0, 0, 0], 0.16);
      return {
        open: this.internalOpen,
        layout: o.layout,
        openOn: o.openOn,
        peek: o.peek,
        intro: o.intro,
        draggable: o.draggable,
        zoomOnClick: o.zoomOnClick,
        closeOnOutsideClick: o.closeOnOutsideClick,
        onItemClick: o.onItemClick,
        onItemDrop: o.onItemDrop,
        tilt: clamp(o.tilt, 0, 1.5),
        bounce: clamp(o.bounce, 0, 1),
        speed: clamp(o.speed, 0.2, 3),
        frost: clamp(o.frost, 0, 1),
        count: this.count,
        entries: this.entries,
        glass: o.variant === 'glass',
        light: o.theme === 'light',
        tint: rgb,
        insideTop: rgbString(mixRgb(rgb, [0, 0, 0], 0.08)),
        insideBottom: rgbString(backTone),
        insideTone: [mixRgb(rgb, [0, 0, 0], 0.08).map(v => v / 255), backTone.map(v => v / 255)],
        content: `${o.mode}|${o.size}|${o.paperColor}|${o.color}|${g.tabX}|${g.tabW}`,
        depth: Math.round(Math.max(g.w, g.h) * 5),
        view: this.viewFor(g),
        g
      };
    }

    setOpen(next) {
      const value = typeof next === 'function' ? next(this.internalOpen) : next;
      if (value !== this.internalOpen) {
        this.internalOpen = value;
        if (value) this.root.dataset.open = '';
        else delete this.root.dataset.open;
        this.el.stage.setAttribute('aria-expanded', String(value));
        this.updateInteractivity();
        this.opts.onOpenChange?.(value);
      }
    }

    updateInteractivity() {
      this.itemEls.forEach((el, index) => {
        const interactive = this.internalOpen || this.outside.includes(index);
        if (interactive) {
          el.setAttribute('role', 'button');
          el.tabIndex = 0;
        } else {
          el.removeAttribute('role');
          el.tabIndex = -1;
        }
      });
    }

    syncOutside() {
      const list = [];
      this.state.items.forEach((item, index) => {
        if (item.place === 'out') list.push(index);
      });
      const same = this.outside.length === list.length && this.outside.every((v, i) => v === list[i]);
      if (!same) {
        this.outside = list;
        this.updateInteractivity();
      }
    }

    /* ---------- 引擎（React useEffect 主体逐字移植） ---------- */
    setup() {
      const root = this.root;
      const state = this.state;
      const self = this;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

      const ensureItems = n => {
        while (state.items.length < n) {
          state.items.push({
            x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 }, z: { value: 0, velocity: 0 },
            r: { value: 0, velocity: 0 }, ry: { value: 0, velocity: 0 }, s: { value: 1, velocity: 0 },
            hover: { value: 0, velocity: 0 }, mx: { value: 0, velocity: 0 }, my: { value: 0, velocity: 0 },
            alpha: { value: 1, velocity: 0 },
            place: 'inside', rank: 0, layer: 'inside', elevated: false, insertUntil: 0, insertFrom: null,
            outX: 0, outY: 0, outR: 0, outS: 1, outOrder: 0, localX: 0, localY: 0, fresh: true
          });
        }
        if (state.items.length > n) {
          state.items.length = n;
          if (state.focus >= n) state.focus = -1;
          self.syncOutside();
        }
      };

      const integrate = (item, target, omega, zeta, dt) => {
        const k = omega * omega;
        const d = 2 * zeta * omega;
        const steps = Math.max(1, Math.ceil(dt / STEP));
        const step = dt / steps;
        for (let i = 0; i < steps; i++) {
          item.velocity += (k * (target - item.value) - d * item.velocity) * step;
          item.value += item.velocity * step;
        }
        return Math.abs(target - item.value) > 0.01 || Math.abs(item.velocity) > 0.01;
      };

      const snap = (item, value) => {
        item.value = value;
        item.velocity = 0;
      };

      const shiftOf = () => {
        const { g: geometry } = self.lastSettings;
        return geometry.book ? (geometry.w / 2) * clamp(-state.front.value / 180, 0, 1) : 0;
      };

      const toDesk = (clientX, clientY) => {
        const box = root.getBoundingClientRect();
        const kx = root.offsetWidth / (box.width || 1);
        const ky = root.offsetHeight / (box.height || 1);
        return [(clientX - box.left) * kx, (clientY - box.top) * ky];
      };

      const clipBounds = () => {
        const box = root.getBoundingClientRect();
        let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
        for (let node = root.parentElement; node && node !== document.body; node = node.parentElement) {
          const computed = getComputedStyle(node);
          if (/(hidden|clip|auto|scroll)/.test(`${computed.overflowX} ${computed.overflowY}`)) {
            const rect = node.getBoundingClientRect();
            left = Math.max(left, rect.left);
            top = Math.max(top, rect.top);
            right = Math.min(right, rect.right);
            bottom = Math.min(bottom, rect.bottom);
            break;
          }
        }
        const kx = root.offsetWidth / (box.width || 1);
        const ky = root.offsetHeight / (box.height || 1);
        return {
          left: (left - box.left) * kx,
          top: (top - box.top) * ky,
          right: (right - box.left) * kx,
          bottom: (bottom - box.top) * ky
        };
      };

      const overFolder = (x, y) => {
        const { g: geometry } = self.lastSettings;
        const shift = shiftOf();
        if (geometry.book) {
          const left = state.front.value < -90 ? shift - geometry.w : shift;
          return x >= left && x <= shift + geometry.w && y >= geometry.tabH * 0.5 && y <= geometry.tabH + geometry.h;
        }
        return x >= 0 && x <= geometry.w && y >= 0 && y <= geometry.tabH + geometry.h;
      };

      const inPocket = item => {
        const { g: geometry } = self.lastSettings;
        const halfW = (geometry.docW * item.s.value) / 2;
        const halfH = (geometry.docH * item.s.value) / 2;
        if (geometry.book) {
          if (state.front.value < -60) return false;
          const shift = shiftOf();
          return (
            item.x.value - halfW < shift + geometry.w &&
            item.x.value + halfW > shift &&
            item.y.value + halfH > geometry.tabH &&
            item.y.value - halfH < geometry.tabH + geometry.h
          );
        }
        if (state.front.value < -45) return false;
        return (
          item.y.value + halfH > geometry.frontTop + 4 * geometry.scale &&
          item.x.value + halfW > 0 &&
          item.x.value - halfW < geometry.w
        );
      };

      const velocityOf = samples => {
        if (samples.length < 2) return [0, 0];
        const first = samples[0];
        const last = samples[samples.length - 1];
        const span = Math.max(0.016, (last[0] - first[0]) / 1000);
        return [(last[1] - first[1]) / span, (last[2] - first[2]) / span];
      };

      const phaseOf = (s, time) => {
        if (s.open) return 'open';
        if (state.receiving || time < state.receiveUntil) return 'receive';
        if (s.peek && state.hovered && !state.drag?.active) return 'peek';
        return 'rest';
      };

      const place = (rank, inside, phase, s) => {
        if (s.g.book) return placeBook(rank, inside, phase, s.layout, s.g);
        const pointer = state.hovered ? ((state.pointerX + 1) / 2) * s.g.w : null;
        return placeFlap(rank, inside, phase, s.layout, s.g, pointer);
      };

      const approach = (item, slot, s) => {
        const { g: geometry } = s;
        if (item.insertFrom === 'side') {
          return { ...slot, x: Math.max(slot.x, geometry.w + geometry.docW * 0.54 * slot.s) };
        }
        return { ...slot, y: Math.min(slot.y, geometry.frontTop - geometry.docH * 0.5 * slot.s - 8 * geometry.scale) };
      };

      const frame = now => {
        state.raf = 0;
        const s = (self.lastSettings = self.settings());
        const { g: geometry } = s;
        ensureItems(s.count);
        const time = now / 1000;
        const dt = state.last ? Math.min(0.05, (now - state.last) / 1000) : 1 / 60;
        state.last = now;
        const zeta = reduce ? 1 : 1 - 0.72 * s.bounce;
        const frontOmega = TAU * (geometry.book ? 1.55 : 2) * s.speed;
        const itemOmega = TAU * 2.1 * s.speed;
        const soft = TAU * 1.6 * s.speed;
        const phase = phaseOf(s, time);
        if (phase !== state.phase) {
          state.previous = state.phase;
          state.phase = phase;
          state.changedAt = now;
        }
        const elapsed = (now - state.changedAt) / 1000;
        let busy = time < state.receiveUntil;

        const ranks = [];
        state.items.forEach((item, index) => {
          if (item.place === 'inside') ranks.push(index);
        });
        const inside = ranks.length;
        ranks.forEach((index, rank) => {
          state.items[index].rank = rank;
        });
        if (state.focus >= 0 && phase !== 'open' && state.items[state.focus]?.place === 'inside') state.focus = -1;

        const intro = state.intro;
        if (!state.ready) intro.opening = s.open;
        if (intro.phase === 'run' && !intro.opening && (s.open || state.drag?.active)) intro.phase = 'done';
        const introTime = intro.phase === 'run' ? time - intro.start : 0;
        const staged = intro.phase !== 'done' && !intro.opening;
        const closeAt = (0.16 + inside * 0.085 + 0.3) / s.speed;
        const holding = staged && introTime < closeAt;
        const dropAt = rank => (0.16 + (inside - 1 - rank) * 0.085) / s.speed;
        const introPose = (item, slot) =>
          geometry.book
            ? { ...slot, r: slot.r + (item.rank % 2 ? 7 : -6), s: slot.s * 1.12 }
            : {
                ...slot,
                y: slot.y - (geometry.h * 0.8 + geometry.docH * 0.5),
                r: slot.r + (item.rank % 2 ? 9 : -7)
              };
        if (intro.phase === 'run') {
          busy = true;
          if (introTime > (intro.opening ? 1.4 : closeAt + 1) / s.speed) intro.phase = 'done';
        }
        const appear = intro.phase === 'wait' ? 0 : intro.phase === 'run' ? clamp(introTime / (0.34 / s.speed), 0, 1) : 1;
        state.appear = 1 - (1 - appear) ** 3;

        const closing = state.previous === 'open' && phase !== 'open';
        const frontDelay = closing && !reduce ? ((geometry.book ? 0.1 : 0.06) + 0.035 * inside) / s.speed : 0;
        const frontPhase = elapsed < frontDelay ? state.previous : phase;
        const frontTarget = holding
          ? geometry.book
            ? -150
            : -42
          : (geometry.book ? BOOK_ANGLES : FLAP_ANGLES)[frontPhase];

        if (!state.ready) {
          state.ready = true;
          const opening = intro.phase !== 'done' && intro.opening;
          if (opening) {
            state.phase = 'rest';
            state.previous = 'rest';
          }
          snap(state.front, opening ? 0 : frontTarget);
          snap(state.anchor, staged ? 1 : 0);
          state.items.forEach(item => {
            const slot = place(item.rank, inside, opening ? 'rest' : phase, s);
            const target = staged ? introPose(item, slot) : slot;
            snap(item.x, target.x);
            snap(item.y, target.y);
            snap(item.z, target.z);
            snap(item.r, target.r);
            snap(item.ry, target.ry);
            snap(item.s, target.s);
            snap(item.alpha, staged ? 0 : 1);
            snap(item.hover, staged && geometry.book ? 3 : 0);
            item.fresh = false;
          });
        }

        if (intro.phase === 'wait') {
          write();
          state.last = 0;
          return;
        }

        busy = integrate(state.front, frontTarget, frontOmega, zeta, dt) || busy;
        const restitution = 0.2 + 0.35 * s.bounce;
        if (geometry.book && state.front.value < -180) {
          state.front.value = -360 - state.front.value;
          state.front.velocity = -state.front.velocity * restitution;
        } else if (state.front.value > 0) {
          state.front.value = -state.front.value;
          state.front.velocity = -state.front.velocity * restitution;
        }
        if (elapsed < frontDelay) busy = true;
        busy = integrate(state.anchor, staged ? 1 : 0, frontOmega, 1, dt) || busy;

        const engaged = state.hovered && !reduce;
        busy = integrate(state.rx, engaged ? -state.pointerY * 8 * s.tilt : 0, soft, 1, dt) || busy;
        busy = integrate(state.ry, engaged ? state.pointerX * 10 * s.tilt : 0, soft, 1, dt) || busy;
        busy = integrate(state.lift, state.hovered && phase !== 'open' ? 1 : 0, soft, 1, dt) || busy;
        busy = integrate(state.squash, state.pressed ? 0.975 : 1, TAU * 3.2, 0.6, dt) || busy;

        const opening = phase === 'open' && state.previous !== 'open';
        const drag = state.drag?.active ? state.drag : null;
        const hover = state.hoveredItem;
        const hovering = !drag && hover >= 0 && state.items[hover] ? state.items[hover] : null;
        const lead =
          hovering && hovering.place === 'inside' && phase === 'open' ? place(hovering.rank, inside, 'open', s) : null;
        const focusScale = clamp(((geometry.tabH + geometry.h) * 1.18) / geometry.docH, 1.2, 2.2);
        const focusY = geometry.book ? geometry.tabH + geometry.h / 2 : geometry.tabH + geometry.h * 0.36;

        state.items.forEach((item, index) => {
          if (item.fresh) {
            const start = place(item.rank, inside, 'rest', s);
            snap(item.x, start.x);
            snap(item.y, start.y);
            snap(item.r, start.r);
            item.fresh = false;
          }
          let target;
          let omega = itemOmega;
          let damping = zeta;
          let lift = 0;
          let fade = 1;
          let magnet = false;
          if (state.focus === index) {
            target = { x: geometry.w / 2, y: focusY, z: 0, r: 0, ry: 0, s: focusScale };
            lift = 2.4;
            item.layer = 'focus';
          } else if (drag && drag.index === index) {
            const [vx] = velocityOf(drag.samples);
            target = {
              x: state.deskX + drag.grabX,
              y: state.deskY + drag.grabY,
              z: 0,
              r: clamp(vx * 0.012, -14, 14),
              ry: 0,
              s: drag.scale * 1.05
            };
            omega = TAU * 5;
            damping = 0.78;
            lift = 1.4;
            if (!item.elevated && !inPocket(item)) item.elevated = true;
            item.layer = item.elevated ? 'drag' : 'inside';
          } else if (item.place === 'out') {
            target = { x: item.outX, y: item.outY, z: 0, r: item.outR, ry: 0, s: item.outS };
            lift = hover === index ? 1 : 0.15;
            magnet = hover === index;
            item.layer = 'out';
          } else {
            const order = opening ? (geometry.book ? inside - 1 - item.rank : item.rank) : item.rank;
            const delay = reduce
              ? 0
              : opening
                ? ((geometry.book ? 0.16 : 0.05) + order * (geometry.book ? 0.055 : 0.045)) / s.speed
                : (order * 0.03) / s.speed;
            const active = elapsed >= delay ? phase : state.previous;
            target = place(item.rank, inside, active, s);
            if (elapsed < delay) busy = true;
            if (staged && introTime < dropAt(item.rank)) {
              target = introPose(item, target);
              fade = 0;
              lift = geometry.book ? 3 : 0;
              item.layer = 'inside';
            } else if (item.insertUntil > time) {
              busy = true;
              target = approach(item, target, s);
              item.layer = 'drag';
              lift = 0.6;
            } else {
              item.insertUntil = 0;
              item.elevated = false;
              item.layer = 'inside';
              if (lead && active === 'open') {
                if (hover === index) {
                  target = { ...target, y: target.y - 6 * geometry.scale, r: target.r * 0.2, ry: 0, s: target.s * 1.05 };
                  lift = 1;
                  magnet = true;
                } else {
                  const distance = target.x - lead.x;
                  target = {
                    ...target,
                    x:
                      target.x +
                      Math.sign(distance) * 12 * geometry.scale * Math.max(0, 1 - Math.abs(distance) / (geometry.w * 1.1))
                  };
                  lift = 0.2;
                }
              } else if (active === 'open') {
                lift = 0.2;
              }
            }
          }
          busy = integrate(item.x, target.x, omega, damping, dt) || busy;
          busy = integrate(item.y, target.y, omega, damping, dt) || busy;
          if (!geometry.book && item.layer === 'inside') {
            const tilt = (item.r.value * Math.PI) / 180;
            const reach =
              ((geometry.docW * Math.abs(Math.sin(tilt)) + geometry.docH * Math.abs(Math.cos(tilt))) * item.s.value) / 2;
            const floor = geometry.tabH + geometry.h - 2 * geometry.scale - reach;
            if (item.y.value > floor) {
              item.y.value = floor;
              if (item.y.velocity > 0) item.y.velocity *= -0.25;
            }
          }
          busy = integrate(item.z, target.z, itemOmega, zeta, dt) || busy;
          busy = integrate(item.r, target.r, omega, damping, dt) || busy;
          busy = integrate(item.ry, target.ry, itemOmega, zeta, dt) || busy;
          busy = integrate(item.s, target.s, itemOmega, zeta, dt) || busy;
          busy = integrate(item.hover, lift, itemOmega, zeta, dt) || busy;
          busy = integrate(item.alpha, fade, TAU * 3 * s.speed, 1, dt) || busy;
          busy = integrate(item.mx, magnet ? item.localX * 7 * geometry.scale : 0, soft, 0.85, dt) || busy;
          busy = integrate(item.my, magnet ? item.localY * 7 * geometry.scale : 0, soft, 0.85, dt) || busy;
        });

        write();
        if (busy || drag) state.raf = requestAnimationFrame(frame);
        else state.last = 0;
      };

      const refreshContent = (renderer, s) => {
        if (
          state.content.key === s.content &&
          state.content.entries === s.entries &&
          state.content.renderer === renderer
        ) {
          return;
        }
        state.content = { key: s.content, entries: s.entries, renderer };
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const keys = new Set(['back']);
        renderer.upload('back', paintBack(s.g, s.insideTop, s.insideBottom, dpr));
        self.itemEls.slice(0, s.count).forEach((node, index) => {
          if (!node) return;
          const key = `item-${index}`;
          keys.add(key);
          let result = rasterize(node, dpr, false);
          try {
            renderer.upload(key, result.canvas);
          } catch {
            result = rasterize(node, dpr, true);
            renderer.upload(key, result.canvas);
          }
          result.pending.forEach(image => image.addEventListener('load', invalidate, { once: true }));
        });
        renderer.prune(keys);
      };

      const write = () => {
        const s = self.lastSettings;
        const { w, h, tabH, frontTop, frontH, docW, docH, scale, book: isBook } = s.g;
        const pivotX = w / 2;
        const pivotY = tabH + h / 2;
        const theta = state.front.value;
        const angle = (theta * Math.PI) / 180;
        const unfold = isBook ? clamp(-theta / 180, 0, 1) : 0;
        const shift = (w / 2) * unfold * (1 - state.anchor.value);
        const zoom = (1 + state.lift.value * 0.012) * state.squash.value * (0.94 + 0.06 * state.appear);
        root.style.opacity = state.appear < 0.999 ? state.appear.toFixed(3) : '';
        const desk = chain(
          move(pivotX, pivotY),
          turnX(state.rx.value),
          turnY(state.ry.value),
          stretch(zoom, zoom),
          move(-pivotX, -pivotY)
        );
        const folder = multiply(desk, move(shift, 0));
        const flipped = isBook && theta < -90;
        const frontZ = flipped ? '3' : '40';

        if (self.el.back) {
          self.el.back.style.transform = toCss(folder);
          self.el.back.style.setProperty('--folder-gutter', unfold.toFixed(3));
          self.el.back.style.setProperty(
            '--folder-label',
            (isBook ? 1 : 1 - clamp((-theta - 18) / 26, 0, 1)).toFixed(3)
          );
        }

        const frontMatrix = isBook
          ? chain(folder, move(0, frontTop, 2 * scale * (1 - unfold)), turnY(theta))
          : chain(folder, move(0, tabH + h, 2 * scale), turnX(theta), move(0, -frontH));
        const facing = isBook
          ? Math.sin(angle) * -0.42 + Math.cos(angle) * 0.9
          : Math.sin(angle) * 0.5 + Math.cos(angle) * 0.86;
        const light = (flipped ? -facing : facing) / (isBook ? 0.9 : 0.86);
        const glint = clamp((light - 1) * 0.9, 0, 0.18);
        const dim = clamp((1 - light) * (isBook ? 0.5 : 0.22), 0, 0.5);

        const front = self.el.front;
        if (front) {
          front.style.transform = toCss(frontMatrix);
          front.style.zIndex = frontZ;
          front.dataset.face = flipped ? 'inner' : 'outer';
          front.style.setProperty('--folder-glint', glint.toFixed(3));
          front.style.setProperty('--folder-dim', dim.toFixed(3));
        }

        const rise = isBook ? Math.max(0, Math.sin(-angle)) : 0;
        if (self.el.ground) {
          self.el.ground.style.transform = toCss(multiply(folder, move(0, isBook ? tabH : tabH + h)));
          self.el.ground.style.opacity = (0.75 + state.lift.value * 0.25).toFixed(3);
        }
        if (self.el.cast) {
          self.el.cast.style.transform = toCss(
            chain(folder, move(w * rise * 0.12, frontTop + h * rise * 0.04), stretch(Math.cos(angle), 1))
          );
          self.el.cast.style.opacity = (flipped ? 1 - rise * 0.7 : 0).toFixed(3);
        }
        if (self.el.shade) {
          const edge = w * Math.cos(angle) + w * rise * 0.36;
          self.el.shade.style.transform = toCss(
            chain(folder, move(0, frontTop + h * rise * 0.03), stretch(edge / w, 1))
          );
          self.el.shade.style.zIndex = edge > 0 ? '39' : '2';
          self.el.shade.style.opacity = (clamp(rise * 4, 0, 1) * (1 - rise * 0.45)).toFixed(3);
        }

        const outs = state.items
          .map((item, index) => [item, index])
          .filter(([item]) => item.layer === 'out')
          .sort((a, b) => a[0].outOrder - b[0].outOrder)
          .map(([, index]) => index);
        const matrices = [];
        state.items.forEach((item, index) => {
          const node = self.itemEls[index];
          const z = 3 * scale + item.z.value + item.hover.value * 26 * scale;
          const matrix = chain(
            desk,
            move(item.x.value + item.mx.value, item.y.value + item.my.value, z),
            turnY(item.ry.value),
            turnZ(item.r.value),
            stretch(item.s.value, item.s.value),
            move(-docW / 2, -docH / 2)
          );
          let layer = 10 + s.count - item.rank;
          if (item.layer === 'inside' && state.phase === 'open' && state.hoveredItem === index) layer = 30;
          if (item.layer === 'out') layer = LAYERS.out + outs.indexOf(index);
          if (item.layer === 'drag') layer = LAYERS.drag;
          if (item.layer === 'focus') layer = LAYERS.focus;
          matrices.push({ index, matrix, layer, alpha: clamp(item.alpha.value, 0, 1), inside: item.layer === 'inside' });
          if (!node) return;
          node.style.transform = toCss(matrix);
          node.style.zIndex = String(layer);
          node.style.setProperty('--folder-lift', clamp(item.hover.value, 0, 2.4).toFixed(3));
          node.style.opacity = item.alpha.value < 0.995 ? Math.max(0, item.alpha.value).toFixed(3) : '';
        });

        const canvas = self.el.glass;
        const renderer = self.renderer;
        if (!canvas || !renderer || !s.glass) return;
        canvas.style.zIndex = frontZ;
        refreshContent(renderer, s);
        const layers = [];
        if (!flipped) {
          layers.push({ key: 'back', matrix: folder, width: w, height: tabH + h, alpha: 1 });
          matrices
            .filter(entry => entry.inside)
            .sort((a, b) => a.layer - b.layer)
            .forEach(entry =>
              layers.push({
                key: `item-${entry.index}`,
                matrix: entry.matrix,
                width: docW,
                height: docH,
                alpha: entry.alpha
              })
            );
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.render({
          dpr,
          depth: s.depth,
          origin: [pivotX, pivotY],
          view: s.view,
          layers,
          glass: {
            matrix: frontMatrix,
            width: w,
            height: frontH,
            radii: isBook ? [0, s.g.r, s.g.r, 0] : [s.g.r, s.g.r, s.g.r, s.g.r],
            spine: isBook ? w * 2 : 0,
            bleed: flipped ? 2 : 0,
            morph: isBook ? clamp((unfold - 0.55) / 0.45, 0, 1) ** 2 : 0,
            insideTop: s.insideTone[0],
            insideBottom: s.insideTone[1],
            tabRatio: tabH / (tabH + h),
            gutter: [12 * scale, isBook ? 0.12 * unfold : 0],
            bevel: 12 * scale,
            strength: 14 * scale,
            split: 0.26,
            lens: 0.02,
            frost: s.frost * 6 * scale,
            tint: [s.tint[0] / 255, s.tint[1] / 255, s.tint[2] / 255, s.light ? 0.1 : 0.14],
            haze: 0.04 + s.frost * 0.1,
            dim: dim * 0.8,
            glint,
            shine: s.light ? 0.72 : 0.85,
            light: flipped ? [0.55, -0.83] : [-0.55, -0.83]
          }
        });
      };

      const wake = () => {
        if (!state.raf) state.raf = requestAnimationFrame(frame);
      };
      self.wake = wake;

      const beginIntro = () => {
        if (state.intro.phase !== 'wait') return;
        state.intro.phase = 'run';
        state.intro.start = performance.now() / 1000;
        wake();
      };

      const invalidate = () => {
        state.content.key = '';
        wake();
      };
      self.engine = {
        wake,
        invalidate,
        consumeClick: () => {
          if (!state.suppressClick) return false;
          state.suppressClick = false;
          return true;
        },
        interactive: index => self.lastSettings.open || state.items[index]?.place === 'out' || state.focus === index,
        select: index => {
          const s = self.lastSettings;
          if (s.zoomOnClick) state.focus = state.focus === index ? -1 : index;
          s.onItemClick?.(s.entries[index], index);
          wake();
        },
        blur: () => {
          if (state.focus < 0) return false;
          state.focus = -1;
          wake();
          return true;
        }
      };

      const updateReceiving = () => {
        const drag = state.drag;
        const item = drag ? state.items[drag.index] : null;
        state.receiving = Boolean(
          drag?.active && item && (item.place === 'out' || item.elevated) && overFolder(state.deskX, state.deskY)
        );
      };

      const startDrag = drag => {
        const item = state.items[drag.index];
        if (!item) return;
        drag.active = true;
        drag.grabX = item.x.value - drag.downX;
        drag.grabY = item.y.value - drag.downY;
        drag.scale = item.place === 'out' ? item.outS : item.s.value;
        drag.clip = clipBounds();
        state.suppressClick = true;
        if (state.focus === drag.index) state.focus = -1;
        item.elevated = item.place === 'out' || !inPocket(item);
        root.dataset.dragging = '';
      };

      const drop = (drag, cancelled) => {
        const s = self.lastSettings;
        const item = state.items[drag.index];
        state.receiving = false;
        delete root.dataset.dragging;
        if (!item) return;
        const time = performance.now() / 1000;
        const [vx, vy] = cancelled ? [0, 0] : velocityOf(drag.samples);
        if (overFolder(state.deskX, state.deskY)) {
          const entering = item.place === 'out' || item.elevated;
          item.place = 'inside';
          if (entering && !reduce) {
            item.insertUntil = time + 0.24 / s.speed;
            item.insertFrom = s.g.book ? (state.front.value < -90 ? null : 'side') : 'top';
            if (!item.insertFrom) item.insertUntil = 0;
            state.receiveUntil = item.insertUntil ? item.insertUntil + 0.14 / s.speed : 0;
          }
          item.elevated = false;
          self.syncOutside();
          s.onItemDrop?.(s.entries[drag.index], drag.index, true);
          return;
        }
        const clip = drag.clip ?? clipBounds();
        const halfW = (s.g.docW * drag.scale) / 2;
        const halfH = (s.g.docH * drag.scale) / 2;
        const x = state.deskX + drag.grabX + clamp(vx, -2400, 2400) * 0.09;
        const y = state.deskY + drag.grabY + clamp(vy, -2400, 2400) * 0.09;
        item.place = 'out';
        item.elevated = true;
        const margin = 8 * s.g.scale;
        const reachX = halfW * 1.08 + margin;
        const reachY = halfH * 1.08 + margin;
        item.outX = clamp(x, clip.left + reachX, Math.max(clip.left + reachX, clip.right - reachX));
        item.outY = clamp(y, clip.top + reachY, Math.max(clip.top + reachY, clip.bottom - reachY));
        item.outR = clamp(item.r.value * 0.5 + clamp(vx, -2400, 2400) * 0.003 + DROP_TURN[drag.index % 6] * 0.6, -12, 12);
        item.outS = drag.scale;
        state.dropCount += 1;
        item.outOrder = state.dropCount;
        self.syncOutside();
        s.onItemDrop?.(s.entries[drag.index], drag.index, false);
      };

      const onMove = event => {
        const drag = state.drag;
        if (drag && event.pointerId === drag.id) {
          const [x, y] = toDesk(event.clientX, event.clientY);
          state.deskX = x;
          state.deskY = y;
          const now = performance.now();
          drag.samples.push([now, x, y]);
          while (drag.samples.length > 2 && now - drag.samples[0][0] > 100) drag.samples.shift();
          if (!drag.active) {
            const threshold = event.pointerType === 'touch' ? 8 : 4;
            if (Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) > threshold) startDrag(drag);
          }
          if (drag.active) updateReceiving();
          wake();
        }
        if (event.pointerType === 'touch') return;
        const box = root.getBoundingClientRect();
        state.pointerX = clamp(((event.clientX - box.left) / box.width) * 2 - 1, -1.5, 1.5);
        state.pointerY = clamp(((event.clientY - box.top) / box.height) * 2 - 1, -1.5, 1.5);
        const target = event.target.closest?.('[data-folder-item]');
        const index = target && root.contains(target) ? Number(target.getAttribute('data-folder-item')) : -1;
        state.hoveredItem = index;
        if (target && index >= 0 && !state.drag?.active) {
          const rect = target.getBoundingClientRect();
          const item = state.items[index];
          if (item) {
            item.localX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
            item.localY = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
          }
        }
        if (!state.hovered) {
          state.hovered = true;
          if (self.lastSettings.openOn === 'hover') self.setOpen(true);
        }
        wake();
      };

      const onLeave = event => {
        if (event.pointerType === 'touch' || state.drag?.active) return;
        state.hovered = false;
        state.pressed = false;
        state.hoveredItem = -1;
        if (self.lastSettings.openOn === 'hover') self.setOpen(false);
        wake();
      };

      const onDown = event => {
        if (event.button > 0) return;
        state.suppressClick = false;
        const target = event.target.closest?.('[data-folder-item]');
        if (target && root.contains(target) && self.lastSettings.draggable) {
          const [x, y] = toDesk(event.clientX, event.clientY);
          state.deskX = x;
          state.deskY = y;
          state.drag = {
            index: Number(target.getAttribute('data-folder-item')),
            id: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            downX: x,
            downY: y,
            grabX: 0,
            grabY: 0,
            scale: 1,
            clip: null,
            active: false,
            samples: [[performance.now(), x, y]]
          };
          try {
            target.setPointerCapture(event.pointerId);
          } catch {
            state.drag.id = event.pointerId;
          }
        } else {
          state.pressed = true;
        }
        wake();
      };

      const onUp = event => {
        state.pressed = false;
        const drag = state.drag;
        if (drag && event.pointerId === drag.id) {
          state.drag = null;
          if (drag.active) drop(drag, event.type === 'pointercancel');
        }
        wake();
      };

      const onDocumentDown = event => {
        if (root.contains(event.target)) return;
        const s = self.lastSettings;
        if (state.focus >= 0) {
          state.focus = -1;
          wake();
        }
        if (s.open && s.closeOnOutsideClick) self.setOpen(false);
      };

      const onKey = event => {
        if (event.key !== 'Escape') return;
        if (state.focus >= 0) {
          state.focus = -1;
          wake();
          return;
        }
        const s = self.lastSettings;
        if (s.open && s.closeOnOutsideClick) self.setOpen(false);
      };

      root.addEventListener('pointermove', onMove);
      root.addEventListener('pointerleave', onLeave);
      root.addEventListener('pointerdown', onDown);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      document.addEventListener('pointerdown', onDocumentDown);
      document.addEventListener('keydown', onKey);
      if (document.fonts?.ready) document.fonts.ready.then(invalidate);

      let observer = null;
      if (self.opts.intro && !reduce) {
        state.intro.phase = 'wait';
        root.style.opacity = '0';
        if (typeof IntersectionObserver === 'undefined') {
          beginIntro();
        } else {
          observer = new IntersectionObserver(
            entries => {
              if (!entries.some(entry => entry.isIntersecting)) return;
              observer?.disconnect();
              beginIntro();
            },
            { threshold: 0.2 }
          );
          observer.observe(root);
        }
      }

      this.cleanup = () => {
        cancelAnimationFrame(state.raf);
        root.removeEventListener('pointermove', onMove);
        root.removeEventListener('pointerleave', onLeave);
        root.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.removeEventListener('pointerdown', onDocumentDown);
        document.removeEventListener('keydown', onKey);
        observer?.disconnect();
      };
      self.updateInteractivity();
      wake();
    }

    setupGlass() {
      if (this.opts.variant !== 'glass') return;
      const canvas = this.el.glass;
      if (!canvas) return;
      const renderer = createGlass(canvas);
      if (!renderer) return;
      this.renderer = renderer;
      this.gpu = true;
      const onLost = event => {
        event.preventDefault();
        this.renderer = null;
        this.gpu = false;
      };
      canvas.addEventListener('webglcontextlost', onLost);
      this.engine?.invalidate();
    }

    toggle() {
      if (this.engine?.blur()) return;
      if (this.opts.openOn === 'hover') return;
      this.setOpen(!this.internalOpen);
    }

    onItemActivate(event, index) {
      const engine = this.engine;
      if (!engine) return;
      if (engine.consumeClick()) {
        event.stopPropagation();
        return;
      }
      if (!engine.interactive(index)) return;
      event.stopPropagation();
      engine.select(index);
    }
  }

  /* ---------- 自动挂载 ---------- */
  const mountAll = () => {
    document.querySelectorAll('[data-folder]').forEach(el => {
      if (el.__folder) return;
      let opts = {};
      try {
        opts = JSON.parse(el.dataset.folder || '{}');
      } catch (err) {
        console.warn('[Folder] data-folder JSON 解析失败', err);
      }
      const inst = new Folder(el, opts);
      el.__folder = inst;
      window.addEventListener('themechange', e => inst.setTheme(e.detail));
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();

  window.Folder = Folder;
})();
