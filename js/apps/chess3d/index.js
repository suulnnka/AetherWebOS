/* ============================================================
 * 应用:3D 国际象棋(ogl 渲染)
 * - 拖拽旋转视角 / 滚轮缩放 / 点击走子
 * - 完整走子规则:各兵种 + 王车易位 + 吃过路兵 + 兵升变(自动升后)
 * - 将军 / 将死 / 逼和判定;简单 AI(一层贪心 + 子力价值)
 *
 * 渲染原用 three.js(压缩后 116 KB),已换成 ogl(约 15 KB):
 * ogl 不带光照材质系统,这里的 Lambert 光照与阴影采样由下方自写 GLSL 承担。
 * ============================================================ */
import { Renderer, Camera, Transform, Box, Cylinder, Sphere, Geometry, Program, Mesh, Vec3, Raycast, Shadow, RenderTarget } from 'ogl';
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './chess3d.css';
import { dialogs } from '../../core/dialogs.js';

/* ============ 棋规引擎(8x8 数组,null 或 {t:'p/r/n/b/q/k', c:'w/b'}) ============ */
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (c) => (c === 'w' ? 'b' : 'w');

function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = { t: back[c], c: 'b' };
    b[1][c] = { t: 'p', c: 'b' };
    b[6][c] = { t: 'p', c: 'w' };
    b[7][c] = { t: back[c], c: 'w' };
  }
  return b;
}

/** 伪合法走法(不考虑送王) */
function pseudoMoves(b, r, c, state) {
  const p = b[r][c];
  if (!p) return [];
  const out = [];
  const push = (rr, cc) => { if (inB(rr, cc) && (!b[rr][cc] || b[rr][cc].c !== p.c)) out.push([rr, cc]); };
  const ray = (dr, dc) => {
    let rr = r + dr, cc = c + dc;
    while (inB(rr, cc)) {
      if (!b[rr][cc]) out.push([rr, cc]);
      else { if (b[rr][cc].c !== p.c) out.push([rr, cc]); break; }
      rr += dr; cc += dc;
    }
  };
  if (p.t === 'p') {
    const dir = p.c === 'w' ? -1 : 1;
    const start = p.c === 'w' ? 6 : 1;
    if (inB(r + dir, c) && !b[r + dir][c]) {
      out.push([r + dir, c]);
      if (r === start && !b[r + 2 * dir][c]) out.push([r + 2 * dir, c]);
    }
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (inB(rr, cc) && b[rr][cc] && b[rr][cc].c !== p.c) out.push([rr, cc]);
      // 吃过路兵
      if (state.ep && state.ep[0] === rr && state.ep[1] === cc && !b[rr][cc]) out.push([rr, cc]);
    }
  } else if (p.t === 'n') {
    for (const [dr, dc] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) push(r + dr, c + dc);
  } else if (p.t === 'b') { for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) ray(dr, dc); }
  else if (p.t === 'r') { for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) ray(dr, dc); }
  else if (p.t === 'q') { for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) ray(dr, dc); }
  else if (p.t === 'k') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) push(r + dr, c + dc);
    // 王车易位(未移动过、路径空、不被将 — 简化:只查路径无子)
    const home = p.c === 'w' ? 7 : 0;
    if (r === home && c === 4 && !state.moved[`k${p.c}`]) {
      if (b[home][0]?.t === 'r' && b[home][0].c === p.c && !state.moved[`r${p.c}a`] && !b[home][1] && !b[home][2] && !b[home][3]) out.push([home, 2]);
      if (b[home][7]?.t === 'r' && b[home][7].c === p.c && !state.moved[`r${p.c}h`] && !b[home][5] && !b[home][6]) out.push([home, 6]);
    }
  }
  return out;
}

function cloneB(b) { return b.map(row => row.map(p => p ? { ...p } : null)); }

function attacked(b, r, c, byColor) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = b[rr][cc];
    if (p && p.c === byColor) {
      // 王的攻击格不含易位
      const ms = pseudoMoves(b, rr, cc, { moved: {}, ep: null });
      if (ms.some(([mr, mc]) => mr === r && mc === c)) return true;
    }
  }
  return false;
}

function findKing(b, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = b[r][c];
    if (p && p.t === 'k' && p.c === color) return [r, c];
  }
  return null;
}

function inCheck(b, color) {
  const k = findKing(b, color);
  return k ? attacked(b, k[0], k[1], other(color)) : false;
}

/** 执行走法(返回新棋盘;处理升变/易位/吃过路兵) */
function applyMove(b, fr, fc, tr, tc) {
  const nb = cloneB(b);
  const p = nb[fr][fc];
  nb[fr][fc] = null;
  if (p.t === 'p' && (tr === 0 || tr === 7)) { p.t = 'q'; }   // 自动升后
  nb[tr][tc] = p;
  // 易位:王横移两格 → 同时移车
  if (p.t === 'k' && Math.abs(tc - fc) === 2) {
    if (tc === 6) { nb[tr][5] = nb[tr][7]; nb[tr][7] = null; }
    else { nb[tr][3] = nb[tr][0]; nb[tr][0] = null; }
  }
  return nb;
}

/** 合法走法(过滤送王) */
function legalMoves(b, r, c, state) {
  return pseudoMoves(b, r, c, state).filter(([tr, tc]) => !inCheck(applyMove(b, r, c, tr, tc), b[r][c].c));
}

function hasAnyMove(b, color, state) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = b[r][c];
    if (p && p.c === color && legalMoves(b, r, c, state).length) return true;
  }
  return false;
}

/* ============ 着色器(ogl 无内置光照,这里自写 Lambert + 阴影采样) ============ */
const VERT = `
attribute vec3 position;
attribute vec3 normal;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 shadowProjectionMatrix;
uniform mat4 shadowViewMatrix;

varying vec3 vNormal;
varying vec4 vShadowCoord;

void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  vShadowCoord = shadowProjectionMatrix * shadowViewMatrix * modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform vec3 uColor;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform sampler2D tShadow;

varying vec3 vNormal;
varying vec4 vShadowCoord;

float unpackRGBA(vec4 v) {
  const vec4 bits = vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0);
  return dot(v, bits);
}

void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, normalize(uLightDir)), 0.0);

  float shade = 1.0;
  vec3 sc = vShadowCoord.xyz / vShadowCoord.w;
  sc = sc * 0.5 + 0.5;
  if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z > 0.0 && sc.z < 1.0) {
    float depth = unpackRGBA(texture2D(tShadow, sc.xy));
    shade = (sc.z - 0.004 > depth) ? 0.45 : 1.0;   // 0.45 = 阴影处保留的光量
  }

  vec3 col = uColor * (uAmbient + (1.0 - uAmbient) * diff * shade);
  gl_FragColor = vec4(col, 1.0);
}
`;

const VERT_FLAT = `
attribute vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG_FLAT = `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
void main() { gl_FragColor = vec4(uColor, uOpacity); }
`;

const rgb = (hex) => new Vec3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

/* 棋子整体缩放系数(1 = 底座直径 0.88,几乎填满 1.0 的格子) */
const PIECE_SCALE = 0.8;
/* 拾取用的包围圆柱 [半径, 高]:棋子是回转体,射线打圆柱足够准也比逐三角形求交快得多。
 * 半径放宽 1.15 倍让点击更好命中,但仍小于半格(0.5)不会误伤邻格。
 * 若改动棋子剖面高度,这里要同步。 */
const HIT_CYL = { p: [0.44, 0.79], r: [0.44, 0.96], n: [0.45, 1.09], b: [0.44, 1.25], q: [0.44, 1.46], k: [0.45, 1.69] };

/* ============ 注册应用 ============ */
register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let board = initBoard();
    let turn = 'w';
    let moved = {};            // 易位用:k w/b、r w a/h 等
    let ep = null;             // 吃过路兵目标格
    let sel = null;            // 选中格
    let legal = [];            // 选中格的合法走法
    let gameOver = false;
    let vsAI = true;

    const statusL = el('span', {}, '白方行棋');
    const container = el('div', { class: 'chess3d-view' });
    const square = 1;

    /* ---------- ogl 渲染器 ---------- */
    // 某些环境(无硬件加速 / 远程桌面)拿不到 WebGL 上下文,
    // 这里兜住异常,给出可读提示而不是整窗口崩掉。
    let renderer = null, gl = null, canvas = null;
    try {
      renderer = new Renderer({ antialias: true, dpr: Math.min(window.devicePixelRatio || 1, 2) });
      gl = renderer.gl;
      canvas = gl.canvas;
      container.append(canvas);
      gl.clearColor(0.051, 0.082, 0.149, 1);   // 背景 0x0d1526
    } catch (err) {
      console.error('[chess3d] WebGL 初始化失败:', err);
      container.append(el('div', { class: 'dim', style: { padding: '20px', textAlign: 'center', lineHeight: '1.8' } },
        '当前环境无法创建 WebGL 上下文,无法显示 3D 画面。',
        el('br'),
        el('span', { class: 'mono', style: { fontSize: '12px' } }, String(err?.message || err))));
    }

    let scene = null, camera = null, shadow = null, program = null, flatProgram = null, boardGroup = null;
    const pieceMeshes = [];     // { mesh, r, c }
    const highlightMeshes = [];
    const geoCache = new Map();
    let pieceMesh = null;       // 棋子工厂(需要 gl,成功初始化后才有)

    if (gl) {
      scene = new Transform();
      camera = new Camera(gl, { fov: 45, near: 0.1, far: 100 });

      // 光源相机(正交):只用来生成阴影贴图,光照方向在片元里用 uLightDir
      const lightCam = new Camera(gl, { left: -7.5, right: 7.5, bottom: -7.5, top: 7.5, near: 0.1, far: 30 });
      lightCam.position.set(6, 10, 4);
      lightCam.lookAt(new Vec3(0, 0, 0));
      shadow = new Shadow(gl, { light: lightCam, width: 1024, height: 1024 });
      // Shadow 自建的 RenderTarget 默认 LINEAR 过滤,会对 RGBA 打包的深度做插值,
      // 解包出来是错值,阴影会失效或出现条纹 —— 必须换成 NEAREST。
      shadow.target = new RenderTarget(gl, { width: 1024, height: 1024, minFilter: gl.NEAREST, magFilter: gl.NEAREST });
      shadow.targetUniform.value = shadow.target.texture;

      // cullFace 关掉:自写的 lathe / extrude 几何不保证绕序统一,
      // 关掉背面剔除可以避免某个件内壁朝外导致的破面(这点几何量没有性能压力)。
      program = new Program(gl, {
        vertex: VERT, fragment: FRAG, cullFace: false,
        uniforms: {
          uColor: { value: new Vec3(1, 1, 1) },
          uLightDir: { value: new Vec3(6, 10, 4) },
          uAmbient: { value: 0.48 },
        },
      });
      flatProgram = new Program(gl, {
        vertex: VERT_FLAT, fragment: FRAG_FLAT,
        uniforms: { uColor: { value: new Vec3(0, 1, 1) }, uOpacity: { value: 0.55 } },
        transparent: true, depthWrite: false,
      });

      // 几何体缓存:同参数只建一份,所有网格复用
      const cached = (key, make) => {
        if (!geoCache.has(key)) geoCache.set(key, make());
        return geoCache.get(key);
      };
      const cylGeo = (rt, rb, h) => cached(`c|${rt}|${rb}|${h}`,
        () => new Cylinder(gl, { radiusTop: rt, radiusBottom: rb, height: h, radialSegments: 20 }));
      const sphGeo = (r) => cached(`s|${r}`,
        () => new Sphere(gl, { radius: r, widthSegments: 16, heightSegments: 12, thetaLength: Math.PI * 2 }));
      const boxGeo = (w, h, d) => cached(`b|${w}|${h}|${d}`, () => new Box(gl, { width: w, height: h, depth: d }));

      /** 建网格。颜色是共享 program 的 uniform,所以每次绘制前写入 */
      const makeMesh = (geometry, colorVec) => {
        const m = new Mesh(gl, { geometry, program });
        m.onBeforeRender(() => { program.uniforms.uColor.value = colorVec; });
        return m;
      };

      // 棋盘
      boardGroup = new Transform();
      boardGroup.setParent(scene);
      const lightV = rgb(0xe8d5b0), darkV = rgb(0x6b4a2f);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const m = makeMesh(boxGeo(square, 0.15, square), (r + c) % 2 === 0 ? lightV : darkV);
          m.position.set((c - 3.5) * square, -0.075, (r - 3.5) * square);
          m.setParent(boardGroup);
          shadow.add({ mesh: m, cast: false, receive: true });
        }
      }
      // 边框(顶面略低于格子顶面,否则会整片盖住棋盘格纹)
      const frame = makeMesh(boxGeo(8.7, 0.22, 8.7), rgb(0x3a2a1a));
      frame.position.y = -0.16;
      frame.setParent(boardGroup);
      shadow.add({ mesh: frame, cast: false, receive: true });

      /* ---- 棋子造型 ----
       * 除马之外,标准棋子都是回转体 → 用 lathe(旋转成型)生成,
       * 剖面为 [半径, 高度] 序列(自下而上),首尾半径取 0 即为封闭曲面,无需端盖。
       * 城垛 / 后冠 / 王冠十字这类非回转特征,用少量小几何体按圆周摆放补齐。 */
      const latheGeo = (key, profile, segments = 28) => cached(`l|${key}|${segments}`, () => {
        const pos = [], nor = [], idx = [];
        const n = profile.length;
        // 剖面法线:与相邻两点连线垂直
        const nrm2 = [];
        for (let i = 0; i < n; i++) {
          const a = profile[Math.max(0, i - 1)], b = profile[Math.min(n - 1, i + 1)];
          const dr = b[0] - a[0], dy = b[1] - a[1];
          const len = Math.hypot(dr, dy) || 1;
          nrm2.push([dy / len, -dr / len]);
        }
        for (let s = 0; s <= segments; s++) {
          const ang = (s / segments) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
          for (let i = 0; i < n; i++) {
            const r = profile[i][0], y = profile[i][1];
            pos.push(r * ca, y, r * sa);
            const nx = nrm2[i][0] * ca, ny = nrm2[i][1], nz = nrm2[i][0] * sa;
            const l = Math.hypot(nx, ny, nz) || 1;
            nor.push(nx / l, ny / l, nz / l);
          }
        }
        for (let s = 0; s < segments; s++) for (let i = 0; i < n - 1; i++) {
          const a = s * n + i, b = (s + 1) * n + i;
          idx.push(a, a + 1, b + 1, a, b + 1, b);
        }
        return new Geometry(gl, {
          position: { size: 3, data: new Float32Array(pos) },
          normal: { size: 3, data: new Float32Array(nor) },
          index: { data: new Uint16Array(idx) },
        });
      });

      /** 把 2D 轮廓沿 Z 轴挤出:给非回转体(马头)用 */
      const extrudeGeo = (key, outline, thick) => cached(`x|${key}|${thick}`, () => {
        const pos = [], nor = [], idx = [];
        const n = outline.length, hz = thick / 2;
        for (let i = 0; i < n; i++) {
          const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % n];
          let nx = y1 - y0, ny = -(x1 - x0);
          const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
          const b = pos.length / 3;
          pos.push(x0, y0, -hz, x1, y1, -hz, x1, y1, hz, x0, y0, hz);
          for (let k = 0; k < 4; k++) nor.push(nx, ny, 0);
          idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
        let cx = 0, cy = 0;
        for (const [x, y] of outline) { cx += x / n; cy += y / n; }
        const cap = (z, nz, flip) => {
          const c = pos.length / 3;
          pos.push(cx, cy, z); nor.push(0, 0, nz);
          for (const [x, y] of outline) { pos.push(x, y, z); nor.push(0, 0, nz); }
          for (let i = 0; i < n; i++) {
            const a = c + 1 + i, b2 = c + 1 + ((i + 1) % n);
            if (flip) idx.push(c, b2, a); else idx.push(c, a, b2);
          }
        };
        cap(-hz, -1, true);
        cap(hz, 1, false);
        return new Geometry(gl, {
          position: { size: 3, data: new Float32Array(pos) },
          normal: { size: 3, data: new Float32Array(nor) },
          index: { data: new Uint16Array(idx) },
        });
      });

      /* 造型参考了外部一份 three.js 棋子模型(两级台阶底座 / 椭球主教冠 / 圆柱王冠),
       * 但那份代码用的是 three 的 API,本项目已换 ogl,故只在 lathe 剖面上复刻其造型语言。
       * 它的高度梯队有硬伤(兵 2.55 高于车 2.3、马最矮、象高于后),没有照搬;
       * 这里按 Staunton 实物的相对比例重排:兵 0.79 < 车 0.96 < 马 1.09 < 象 1.25 < 后 1.46 < 王 1.69。
       * 各件底座统一两级台阶、最大半径 0.44–0.45(格宽 1.0,相邻棋子不打架),向上逐级收细。 */

      // 兵:两级底座 → 细腰 → 颈环 → 圆球头
      const P_PAWN = [[0, 0], [0.44, 0], [0.44, 0.025], [0.41, 0.06], [0.39, 0.11], [0.335, 0.20],
        [0.26, 0.28], [0.19, 0.38], [0.165, 0.44],
        [0.235, 0.475], [0.24, 0.50], [0.165, 0.525],
        [0.19, 0.575], [0.185, 0.665], [0.135, 0.735], [0.07, 0.775], [0, 0.785]];
      // 车:两级底座 → 收腰塔身 → 顶部外张边沿(顶面留给 6 个城垛)
      const P_ROOK = [[0, 0], [0.44, 0], [0.44, 0.025], [0.41, 0.06], [0.39, 0.11], [0.335, 0.20],
        [0.30, 0.30], [0.275, 0.50], [0.265, 0.62],
        [0.305, 0.68], [0.35, 0.74], [0.355, 0.80], [0, 0.80]];
      // 象:两级底座 → 长细腰 → 颈环 → 椭球主教冠(顶上加小球)
      const P_BISHOP = [[0, 0], [0.44, 0], [0.44, 0.025], [0.41, 0.06], [0.39, 0.11], [0.335, 0.20],
        [0.265, 0.32], [0.215, 0.50], [0.19, 0.62],
        [0.25, 0.665], [0.255, 0.69], [0.195, 0.715],
        [0.215, 0.76], [0.212, 0.86], [0.19, 1.00], [0.145, 1.09], [0.08, 1.16], [0, 1.18]];
      // 后:修长身形 → 外张的开口冠(冠沿一圈大宝珠 + 正中一颗)
      const P_QUEEN = [[0, 0], [0.44, 0], [0.44, 0.025], [0.41, 0.06], [0.39, 0.11], [0.335, 0.20],
        [0.27, 0.34], [0.225, 0.58], [0.20, 0.76],
        [0.27, 0.81], [0.275, 0.835], [0.205, 0.86],
        [0.235, 0.96], [0.275, 1.08], [0.325, 1.18], [0.375, 1.235], [0.40, 1.275],
        [0.375, 1.31], [0.285, 1.31], [0, 1.31]];
      // 王:最高最壮 → 冠口外张后收成圆柱冠盖(与后的开口碗截然不同)→ 顶上立十字
      const P_KING = [[0, 0], [0.45, 0], [0.45, 0.025], [0.42, 0.06], [0.40, 0.11], [0.34, 0.20],
        [0.28, 0.36], [0.235, 0.62], [0.21, 0.82],
        [0.285, 0.875], [0.29, 0.90], [0.215, 0.925],
        [0.25, 1.03], [0.29, 1.16], [0.34, 1.26], [0.40, 1.315], [0.395, 1.35],
        [0.30, 1.35], [0.295, 1.42], [0.29, 1.44], [0, 1.45]];
      // 马:回转底座 + 挤出的马头侧影(面朝 +x)
      const P_KNIGHT_BASE = [[0, 0], [0.44, 0], [0.44, 0.025], [0.41, 0.06], [0.39, 0.11], [0.335, 0.20],
        [0.285, 0.30], [0.25, 0.40], [0.235, 0.46], [0, 0.48]];
      /* 马头侧影。必须逆时针排列 —— extrudeGeo 的外法线按 (dy, -dx) 算,
       * 顺时针轮廓算出来是内法线,光照会整个反掉(OpenGL 默认 CCW 为正面)。 */
      const O_KNIGHT_HEAD = [[0.115, 0.38], [0.23, 0.459], [0.30, 0.551], [0.345, 0.630],
        [0.328, 0.722], [0.270, 0.781], [0.23, 0.880], [0.190, 0.972],
        [0.178, 1.077], [0.132, 1.024], [0.104, 1.090], [0.052, 0.972],
        [-0.023, 0.827], [-0.104, 0.669], [-0.161, 0.512], [-0.178, 0.406]];

      const whiteV = rgb(0xf5f0e6), blackV = rgb(0x4a5266);   // 黑棋带蓝灰,暗背景下也能看清造型
      pieceMesh = (t, color) => {
        const cv = color === 'w' ? whiteV : blackV;
        const g = new Transform();
        // 整体缩放:0.8 让棋子留出格间空隙(底座直径 0.88→0.70),画面不再挤满格子。
        // 缩放在 group 上做,所有剖面比例/高度梯队保持不动,需要调松紧只改这一个数。
        g.scale.set(PIECE_SCALE, PIECE_SCALE, PIECE_SCALE);
        const add = (geometry, x, y, z, ry = 0) => {
          const m = makeMesh(geometry, cv);
          m.position.set(x, y, z);
          m.rotation.y = ry;
          m.setParent(g);
          shadow.add({ mesh: m, cast: true, receive: true });
          return m;
        };
        if (t === 'p') {
          add(latheGeo('pawn', P_PAWN), 0, 0, 0);
        } else if (t === 'r') {
          add(latheGeo('rook', P_ROOK), 0, 0, 0);
          // 城垛:顶部沿圆周摆 6 个小方块,略内缩形成垛口
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            add(boxGeo(0.105, 0.155, 0.09), Math.cos(a) * 0.285, 0.877, Math.sin(a) * 0.285, -a);
          }
        } else if (t === 'n') {
          add(latheGeo('knightBase', P_KNIGHT_BASE), 0, 0, 0);
          // 白马朝 -z(对手方向),黑马朝 +z
          add(extrudeGeo('knightHead', O_KNIGHT_HEAD, 0.26), 0, 0, 0,
            color === 'w' ? Math.PI / 2 : -Math.PI / 2);
        } else if (t === 'b') {
          add(latheGeo('bishop', P_BISHOP), 0, 0, 0);
          add(sphGeo(0.058), 0, 1.19, 0);                      // 冠顶小球
        } else if (t === 'q') {
          add(latheGeo('queen', P_QUEEN), 0, 0, 0);
          // 后冠:冠沿一圈大宝珠 + 正中一颗更大的
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            add(sphGeo(0.062), Math.cos(a) * 0.375, 1.335, Math.sin(a) * 0.375);
          }
          add(sphGeo(0.088), 0, 1.37, 0);
        } else {
          add(latheGeo('king', P_KING), 0, 0, 0);
          add(boxGeo(0.062, 0.32, 0.062), 0, 1.53, 0);         // 十字:竖
          add(boxGeo(0.235, 0.062, 0.062), 0, 1.46, 0);        // 十字:横
        }
        return g;
      };
    }

    function syncPieces() {
      if (!gl) return;
      for (const p of pieceMeshes) p.mesh.setParent(null);
      pieceMeshes.length = 0;
      shadow.castMeshes.length = 0;            // 旧棋子的投影登记作废
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p) continue;
        const mesh = pieceMesh(p.t, p.c);
        mesh.position.set((c - 3.5) * square, 0, (r - 3.5) * square);
        mesh.setParent(boardGroup);
        pieceMeshes.push({ mesh, r, c });
      }
    }
    syncPieces();

    // 高亮标记
    function showHighlights() {
      if (!gl) return;
      for (const m of highlightMeshes) m.setParent(null);
      highlightMeshes.length = 0;
      const mk = (r, c, color) => {
        const geo = geoCache.get('hl') || (() => {
          const g = new Cylinder(gl, { radiusTop: 0.42, radiusBottom: 0.42, height: 0.04, radialSegments: 24 });
          geoCache.set('hl', g);
          return g;
        })();
        const m = new Mesh(gl, { geometry: geo, program: flatProgram });
        m.onBeforeRender(() => { flatProgram.uniforms.uColor.value = color; });
        m.position.set((c - 3.5) * square, 0.03, (r - 3.5) * square);
        m.setParent(scene);
        highlightMeshes.push(m);
      };
      if (sel) mk(sel[0], sel[1], rgb(0x22d3ee));
      for (const [r, c] of legal) mk(r, c, board[r][c] ? rgb(0xef4444) : rgb(0x22c55e));
    }

    /* 相机轨道(自实现)—— 支持的输入:
     *   鼠标左键拖          → 旋转
     *   滚轮                → 缩放
     *   触控板捏合          → 缩放(浏览器会转成 ctrl+wheel;Safari 另见下方 GestureEvent)
     *   两指转动 / 触屏双指  → 旋转方位角 + 同时捏合缩放
     */
    /* 标准视角:正对棋盘(X 轴横向铺满画面,白方在近处正下方)的 65° 俯角。
     * theta 是相机方位角 —— 必须是 0(相机落在 +z 正前方),
     * 取 π/4 的话相机站在棋盘对角线上,画面会变成菱形,认格子很别扭。
     * phi 是与 +Y 轴的夹角,所以 俯角 = 90° - phi,即 phi = 25°。
     * 想更平/更俯只需要改这里的 65。 */
    const HOME = { theta: 0, phi: (90 - 65) * Math.PI / 180, radius: 13 };
    let theta = HOME.theta, phi = HOME.phi, radius = HOME.radius;
    function updateCam() {
      if (!camera) return;
      camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta));
      camera.lookAt(new Vec3(0, 0, 0));
    }
    updateCam();
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

    /* 视角过渡:归位时用 300ms ease-out 飞过去,比瞬间跳过去好认路 */
    let tween = null;
    function flyTo(to, dur = 300) {
      if (!camera) return;
      let d = (to.theta - theta) % (Math.PI * 2);        // 走最短弧
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      tween = { from: { theta, phi, radius }, to: { theta: theta + d, phi: to.phi, radius: to.radius }, t0: performance.now(), dur };
    }
    function stepTween(now) {
      if (!tween) return;
      const k = Math.min(1, (now - tween.t0) / tween.dur);
      const e = 1 - Math.pow(1 - k, 3);
      theta = tween.from.theta + (tween.to.theta - tween.from.theta) * e;
      phi = tween.from.phi + (tween.to.phi - tween.from.phi) * e;
      radius = tween.from.radius + (tween.to.radius - tween.from.radius) * e;
      if (k >= 1) tween = null;
      updateCam();
    }
    /** 归正:回到标准俯角与距离,但保留当前朝的是白方还是黑方 */
    function goHome() {
      const off = Math.atan2(Math.sin(theta - HOME.theta), Math.cos(theta - HOME.theta));
      flyTo({ theta: HOME.theta + (Math.abs(off) > Math.PI / 2 ? Math.PI : 0), phi: HOME.phi, radius: HOME.radius });
    }

    let dragging = false, lx = 0, ly = 0;
    let downX = 0, downY = 0, dragged = false;   // 拖视角后松手会补发 click,超过阈值就判为拖拽
    const pointers = new Map();   // 多指:pointerId -> {x, y}
    let pinch = null;             // 双指基线 {dist, ang},为空表示当前不是双指手势
    let suppressClick = false;    // 双指手势结束后浏览器会补发一次 click,要吃掉避免误走子

    const twoFinger = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    const onMove = (e) => {
      const p = pointers.get(e.pointerId);
      if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (pointers.size >= 2) {                       // 双指:捏合缩放 + 转动
        const n = twoFinger();
        if (pinch) {
          tween = null;                                // 用户接管,取消归位动画
          // 两指分开 → dist 变大 → 拉近;比值乘法天然带阻尼,快速开合也不会跳
          radius = clamp(radius * (pinch.dist / n.dist), 7, 24);
          theta += n.ang - pinch.ang;                  // 顺时针转 → 视角顺时针转
          suppressClick = true;
          updateCam();
        }
        pinch = n;
        return;
      }
      if (!dragging) return;
      tween = null;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) dragged = true;
      theta += (e.clientX - lx) * 0.008;
      phi = clamp(phi + (e.clientY - ly) * 0.006, 0.35, 1.45);
      lx = e.clientX; ly = e.clientY;
      updateCam();
    };
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && dragged) suppressClick = true;   // 拖过视角,别当走子
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {                      // 松开一指,剩下那指接管拖拽(不跳变)
        const [p] = [...pointers.values()];
        dragging = true; lx = p.x; ly = p.y;
      } else if (pointers.size === 0) dragging = false;
    };
    const onWheel = (e) => {
      e.preventDefault();
      tween = null;
      if (e.ctrlKey) {
        // ctrl+wheel = 触控板双指捏合(Chrome/Edge/Firefox 的统一做法),指数缩放手感更贴合
        radius = clamp(radius * Math.exp(clamp(e.deltaY, -120, 120) * 0.006), 7, 24);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // 触控板两指横滑 → 旋转方位角(鼠标滚轮几乎不产生 deltaX,不会误伤)
        theta += clamp(e.deltaX, -80, 80) * 0.006;
      } else {
        // 鼠标滚轮 / 触控板两指纵滑 → 缩放
        radius = clamp(radius + clamp(e.deltaY, -120, 120) * 0.01, 7, 24);
      }
      updateCam();
    };
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size >= 2) { pinch = twoFinger(); dragging = false; suppressClick = true; }
        else if (pointers.size === 1) {
          dragging = true; lx = e.clientX; ly = e.clientY;
          downX = e.clientX; downY = e.clientY; dragged = false;
        }
      });
      canvas.addEventListener('pointercancel', endPointer);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endPointer);

      /* Safari 桌面私有 GestureEvent:唯一能拿到「真实两指旋转角度」的桌面接口
       * (触控板在 macOS Chrome 下不会产生 PointerEvent,只能拿到 ctrl+wheel 的缩放)。 */
      let gs = null;
      const gesture = (fn) => (e) => { e.preventDefault(); fn(e); };
      canvas.addEventListener('gesturestart', gesture((e) => {
        gs = { scale: e.scale, rotation: e.rotation, theta, radius };
        suppressClick = true;
      }));
      canvas.addEventListener('gesturechange', gesture((e) => {
        if (!gs) return;
        tween = null;
        theta = gs.theta + ((e.rotation - gs.rotation) * Math.PI) / 180;
        radius = clamp(gs.radius / (e.scale / gs.scale || 1), 7, 24);
        updateCam();
      }));
      canvas.addEventListener('gestureend', gesture(() => { gs = null; }));
    }

    /* 点击走子 —— 两段式拾取:
     * ① 先拿射线打棋子的包围圆柱。只算平面交点是不行的:棋子高 1 格以上,
     *    点棋子时射线穿过去落在 y=0 的交点会跑到它后面的格子,表现为"点不中棋子"。
     * ② 没打中任何棋子,再退回棋盘平面求交 → 点格子同样有效(空格、走子落点)。
     * 不用 ogl 的 Raycast.intersectMeshes:它按包围球粗筛,扁平方格会互相重叠。 */
    const ray = new Raycast();
    function pickPiece(o, d) {
      let hit = null, bestT = Infinity;
      for (const it of pieceMeshes) {
        const [br, bh] = HIT_CYL[board[it.r][it.c].t];
        const R = br * PIECE_SCALE * 1.15, H = bh * PIECE_SCALE;
        const ox = o.x - (it.c - 3.5) * square, oz = o.z - (it.r - 3.5) * square;
        const a = d.x * d.x + d.z * d.z;
        if (a < 1e-9) continue;                       // 视线垂直,与圆柱轴平行
        const b = 2 * (ox * d.x + oz * d.z);
        const cc = ox * ox + oz * oz - R * R;
        const disc = b * b - 4 * a * cc;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
          if (t <= 0 || t >= bestT) continue;
          const y = o.y + d.y * t;
          if (y < 0 || y > H) continue;               // 交点必须在棋子高度范围内
          bestT = t; hit = [it.r, it.c];
        }
      }
      return hit;
    }
    function onClick(e) {
      if (suppressClick) { suppressClick = false; return; }   // 手势/拖拽刚结束,别当走子
      if (!camera || gameOver || (vsAI && turn === 'b')) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.castMouse(camera, [mx, my]);
      const { origin, direction } = ray;
      const piece = pickPiece(origin, direction);
      if (piece) { handleSquare(piece[0], piece[1]); return; }
      if (Math.abs(direction.y) < 1e-6) return;
      const t = -origin.y / direction.y;
      if (t <= 0) return;
      const x = origin.x + direction.x * t;
      const z = origin.z + direction.z * t;
      const c = Math.round(x + 3.5), r = Math.round(z + 3.5);
      if (!inB(r, c)) return;
      // 落点必须真的落在该格内(格边长 1,中心在 (c-3.5, r-3.5))
      if (Math.abs(x - (c - 3.5)) > 0.5 || Math.abs(z - (r - 3.5)) > 0.5) return;
      handleSquare(r, c);
    }
    if (canvas) canvas.addEventListener('click', onClick);

    function handleSquare(r, c) {
      const target = legal.find(([tr, tc]) => tr === r && tc === c);
      if (sel && target) { doMove(sel[0], sel[1], r, c); return; }
      const p = board[r][c];
      if (p && p.c === turn) {
        sel = [r, c];
        legal = legalMoves(board, r, c, { moved, ep });
        showHighlights();
      } else { sel = null; legal = []; showHighlights(); }
    }

    function doMove(fr, fc, tr, tc) {
      // 易位状态记录
      const p = board[fr][fc];
      if (p.t === 'k') moved[`k${p.c}`] = true;
      if (p.t === 'r') {
        if (fc === 0) moved[`r${p.c}a`] = true;
        if (fc === 7) moved[`r${p.c}h`] = true;
      }
      // 吃过路兵:移除被吃的兵
      if (p.t === 'p' && ep && ep[0] === tr && ep[1] === tc && !board[tr][tc]) {
        board[fr][tc] = null;
      }
      // 设置下一次 ep 目标
      ep = null;
      if (p.t === 'p' && Math.abs(tr - fr) === 2) ep = [(fr + tr) / 2, fc];

      board = applyMove(board, fr, fc, tr, tc);
      sel = null; legal = []; showHighlights();
      syncPieces();
      turn = other(turn);
      checkEnd();
      if (!gameOver && vsAI && turn === 'b') {
        statusL.textContent = '黑方(AI)思考中…';
        setTimeout(aiMove, 450);
      } else updateStatus();
    }

    function updateStatus() {
      const inC = inCheck(board, turn);
      statusL.textContent = (turn === 'w' ? '白方' : '黑方(AI)') + '行棋' + (inC ? ' — 将军!⚠' : '');
      setTitle(`3D 国际象棋 — ${turn === 'w' ? '白' : '黑'}方行棋${inC ? '(将军)' : ''}`);
    }

    function checkEnd() {
      if (!hasAnyMove(board, turn, { moved, ep })) {
        gameOver = true;
        if (inCheck(board, turn)) {
          dialogs.info({ title: '将死', message: `${turn === 'w' ? '黑方' : '白方'}获胜!` });
          statusL.textContent = `将死 — ${turn === 'w' ? '黑方' : '白方'}胜`;
        } else {
          dialogs.info({ title: '逼和', message: '和棋(无子可动)' });
          statusL.textContent = '逼和 — 和棋';
        }
        setTitle('3D 国际象棋 — 终局');
      } else updateStatus();
    }

    /* AI:一层贪心(最大化子力 + 简单位置噪声) */
    function aiMove() {
      if (gameOver) return;
      let best = null, bestScore = -Infinity;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || p.c !== 'b') continue;
        for (const [tr, tc] of legalMoves(board, r, c, { moved, ep })) {
          const target = board[tr][tc];
          let score = (target ? VAL[target.t] * 10 : 0) + Math.random() * 3;
          if (target?.t === 'k') score += 500;
          // 走后不被吃回的奖励(粗略)
          const nb = applyMove(board, r, c, tr, tc);
          if (!attacked(nb, tr, tc, 'w')) score += 2;
          if (score > bestScore) { bestScore = score; best = [r, c, tr, tc]; }
        }
      }
      if (best) doMove(best[0], best[1], best[2], best[3]);
    }

    /* 工具栏 */
    const newBtn = el('button', { class: 'btn primary', onClick: () => {
      board = initBoard(); turn = 'w'; moved = {}; ep = null; sel = null; legal = [];
      gameOver = false; syncPieces(); showHighlights(); updateStatus();
    } }, icon('refresh', 13), '新对局');
    const aiBtn = el('button', {
      class: 'btn', onClick: (e) => {
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机:开' : '人人对战';
      },
    }, '人机:开');
    const viewBtn = el('button', { class: 'btn', title: '切换到白/黑方视角', onClick: () => { flyTo({ theta: theta + Math.PI, phi, radius }, 420); } }, icon('refresh', 13), '换边视角');
    const homeBtn = el('button', { class: 'btn', title: '归正到 65° 标准俯视角', onClick: goHome }, icon('home', 13), '归正');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn, aiBtn, viewBtn, homeBtn,
        el('span', { class: 'grow' }),
        el('span', { class: 'dim', style: { fontSize: '12px' } }, '拖拽旋转 · 滚轮/捏合缩放 · 两指滑动转向 · 点击走子')),
      container,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', { class: 'mono' }, 'ogl'))));

    /* ---------- 尺寸自适应 + 渲染循环 ----------
     * WebGL 不会自动刷新画面,必须每帧手动 render()。
     */
    let vw = 0, vh = 0, frames = 0;
    function fit() {
      if (!renderer) return;
      const r = container.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;           // 未布局 / 窗口最小化
      if (Math.abs(r.width - vw) < 1 && Math.abs(r.height - vh) < 1) return;
      vw = r.width; vh = r.height;
      renderer.setSize(vw, vh);
      camera.perspective({ aspect: vw / vh });
    }

    let disposed = false, raf = 0;
    function tick(ts = 0) {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (!renderer) return;
      fit();
      stepTween(ts);
      frames++;
      if (shadow) {
        // 关键:阴影贴图必须清成白色(深度 1.0 = 无遮挡)。
        // 若用场景背景色清屏,unpack 后约 0.05,会被当成"离光很近",
        // 不在深度图里的东西(如只接收阴影的棋盘格)会被整体误判进阴影。
        gl.clearColor(1, 1, 1, 1);
        shadow.render({ scene });
        gl.clearColor(0.051, 0.082, 0.149, 1);   // 恢复场景背景 0x0d1526
      }
      renderer.render({ scene, camera });
    }
    tick();

    const ro = renderer ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(container);
    window.addEventListener('resize', fit);

    updateStatus();

    // e2e 测试钩子:绕过屏幕坐标,直接按格子坐标走子
    window.__chess = {
      click: (r, c) => handleSquare(r, c),
      turn: () => turn,
      board: () => board,
      sel: () => sel,
      legal: () => legal,
      goHome, flyHome: goHome,
      /** e2e 用:某格(可指定高度 y)中心的屏幕坐标,便于发真实鼠标事件 */
      screen: (r, c, y = 0) => {
        if (!camera || !canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const v = new Vec3((c - 3.5) * square, y, (r - 3.5) * square);
        v.applyMatrix4(camera.projectionViewMatrix);
        return [rect.left + (v.x * 0.5 + 0.5) * rect.width, rect.top + (0.5 - v.y * 0.5) * rect.height];
      },
      home: () => ({ theta, phi, radius,俯角: Math.round((90 - phi * 180 / Math.PI) * 10) / 10 }),
      /** 供测试/排障用:确认渲染器是否活着、画面是否真的在出帧 */
      stats: () => renderer ? { alive: true, frames, size: [vw, vh], lib: 'ogl' } : { alive: false },
    };

    /* ---------- 关闭时释放 ---------- */
    return {
      onResize: fit,
      onClose() {
        disposed = true;
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', fit);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', endPointer);
        ro?.disconnect();
        delete window.__chess;
        // 释放 GPU 资源(WebGL 上下文数量有限,不释放会拖垮后续 reopen)
        for (const [, g] of geoCache) g.remove?.();
        geoCache.clear();
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
  },
});
