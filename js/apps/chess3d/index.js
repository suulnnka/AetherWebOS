/* ============================================================
 * 应用:国际象棋(2D/3D 双视图,默认 ogl 渲染 3D,工具栏可切 2D 平面视图)
 * - 3D:拖拽旋转视角 / 滚轮缩放;2D:平面棋盘;两视图共用同一局面与点击走子
 * - 走子规则在 rules.js,AI 搜索在 ai.js(经 ai-worker.js 跑在 Worker 里)
 * - 多档难度:初级 / 中级 / 高级 / 大师;支持换边(与 AI 互换执子方)与悔棋
 * - 开局库在引擎内(vendor/AetherChess src/book.js):Worker 查谱命中直接回着,谱外才进搜索
 *
 * 渲染原用 three.js(压缩后 116 KB),已换成 ogl(约 15 KB):
 * ogl 不带光照材质系统,这里的 Lambert 光照与阴影采样由下方自写 GLSL 承担。
 *
 * 本文件只负责「渲染 + 交互 + 难度档 UI」;棋规、搜索、评估一律走引擎模块 ——
 * 引擎在独立子项目 vendor/AetherChess(github.com/suulnnka/AetherChess),
 * 不 import ogl 也不碰 DOM,Node 里能直接跑 perft 与战术测试(见该仓库 test/)。
 * 将来要换 WASM 实现,只需替换这一段调用。
 * ============================================================ */
import { Renderer, Camera, Transform, Box, Cylinder, Sphere, Geometry, Program, Mesh, Vec3, Raycast, Shadow, RenderTarget } from 'ogl';
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './chess3d.css';
import { piece2d } from './pieces2d.js';
import { dialogs } from '../../core/dialogs.js';
import {
  WHITE, BLACK, QUEEN, CHARS, NAME, C_WK, C_WQ, C_BK, C_BQ,
  mFrom, mTo, mFlag, mCap, mPromo, mkMove,
  newPos, make, unmake, genMoves, genLegal, hasLegalMove, isLegal,
  inCheck, isThreefold, insufficientMaterial,
} from '../../../vendor/AetherChess/src/rules.js';
import { LEVELS, DEFAULT_LEVEL } from '../../../vendor/AetherChess/src/ai.js';

/* ============ 引擎侧的薄适配层 ============
 * 渲染/高亮沿用 8x8 的 {t,c} 对象数组与 [r,c] 坐标(绘制代码一行不动),
 * 引擎内部是 Int8Array(64) 的 sq = r*8+c,这里做一层换算。 */
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const otherStm = (s) => (s === WHITE ? BLACK : WHITE);

/** 引擎局面 → 8x8 视图(只给渲染与 e2e 钩子看,搜索从不碰它) */
function viewOf(pos) {
  const v = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let s = 0; s < 64; s++) {
    const p = pos.b[s];
    if (p) v[s >> 3][s & 7] = { t: CHARS[p & 7], c: (p >> 3) === WHITE ? 'w' : 'b' };
  }
  return v;
}
/** 该方全部合法着法(压紧到普通数组,UI 用) */
function allLegal(pos) {
  const buf = new Int32Array(256);
  const n = genLegal(pos, buf);
  const out = [];
  for (let i = 0; i < n; i++) out.push(buf[i]);
  return out;
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

/* 引擎评分(白方视角、单位厘兵)→ 给人看的字符串。±20000 以上是将杀分,只标 M。 */
const fmtScore = (s) => {
  if (Math.abs(s) >= 20000) return s > 0 ? '+M' : '-M';
  return (s >= 0 ? '+' : '') + (s / 100).toFixed(2);
};

/* 棋子整体缩放系数(1 = 底座直径 0.88,几乎填满 1.0 的格子) */
const PIECE_SCALE = 0.8;

/* 2D 视图的棋子:classic 赛用造型 SVG(见 pieces2d.js),
 * 白子深描边、黑子剪影加浅色细节,不再依赖系统字体的 Unicode 字形。 */

/* ============ 注册应用 ============ */
register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let pos = newPos();          // 引擎局面(棋盘 + 走子权 + 易位权 + 吃过路兵 + 历史)
    let moves = [];              // 走过的完整着法(mkMove 编码,含旗位,悔棋要靠它 unmake);
                                 // 发给 Worker 时再压成 (from<<6|to),replayMoves 会还原旗位
    let sel = null;              // 选中格 [r, c]
    let legal = [];              // 选中格的合法落点 [[r, c], ...](已按落点去重)
    let legalRaw = [];           // 与 legal 并列的打包走法
    let gameOver = false;
    let vsAI = true;
    let humanColor = WHITE;      // 人机模式下玩家执子方,「换边」互换;2D 棋盘朝向与 3D 视角跟它走
    let levelIdx = DEFAULT_LEVEL;
    let searching = false;
    const aiColor = () => otherStm(humanColor);
    const sideChar = (col) => (col === WHITE ? 'w' : 'b');
    const sideName = (col) => (col === WHITE ? '白方' : '黑方');

    const statusL = el('span', {}, '白方行棋');
    const infoL = el('span', { class: 'mono', style: { fontSize: '11px' } }, '');
    const container = el('div', { class: 'chess3d-view' });
    const square = 1;
    const turnChar = () => (pos.stm === WHITE ? 'w' : 'b');
    const level = () => LEVELS[levelIdx];

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
      // 浅格调深(木色 #d2aa6e):原来的 #e8d5b0 太接近白棋的象牙色,
      // 白子落在浅格上糊成一片;2D 的 .chess2d-cell.light 与这里保持一致。
      const lightV = rgb(0xd2aa6e), darkV = rgb(0x7a5233);
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

    /* ---------- 2D 视图 ----------
     * 与 3D 共用同一局面(pos/sel/legal)与 handleSquare 交互,只换渲染层:
     * DOM 网格 + 实心棋子字符。WebGL 初始化失败时初始视图直接落在 2D,应用仍可用。
     * 高亮配色与 3D 一致:青框=选中,绿点=可落格,红圈=可吃子。 */
    let mode = gl ? '3d' : '2d';
    const board2d = el('div', { class: 'chess2d-board' });
    const wrap2d = el('div', { class: 'chess3d-view chess2d-wrap' }, board2d);
    function render2d() {
      board2d.innerHTML = '';
      const target = new Map(legal.map(([r, c]) => [r * 8 + c, !!pos.b[r * 8 + c]]));
      const flip = humanColor === BLACK;    // 执黑时棋盘转 180°,自己的子永远在近处
      for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
        const r = flip ? 7 - dr : dr, c = flip ? 7 - dc : dc;
        const s = r * 8 + c, p = pos.b[s];
        const to = target.get(s);                     // undefined=非落点,false= quiet,true=吃子
        const cell = el('button', {
          class: 'chess2d-cell ' + ((r + c) % 2 === 0 ? 'light' : 'dark')
            + (sel && sel[0] === r && sel[1] === c ? ' sel' : '')
            + (to === undefined ? '' : to ? ' cap' : ' mv'),
          'aria-label': NAME(s),
          onClick: () => handleSquare(r, c),
        });
        if (p) cell.append(el('span', {
          class: 'chess2d-pc ' + ((p >> 3) === WHITE ? 'w' : 'b'),
          html: piece2d(CHARS[p & 7], (p >> 3) === WHITE ? 'w' : 'b'),
        }));
        else if (to === false) cell.append(el('span', { class: 'chess2d-dot' }));
        board2d.append(cell);
      }
    }
    /** 2D 棋盘取容器短边(留边距);格子尺寸写入 --cell,字号/提示点按它换算 */
    function fit2d() {
      const r = wrap2d.getBoundingClientRect();
      const size = Math.floor(Math.min(r.width, r.height)) - 28;
      if (size < 80) return;                          // 未布局 / 窗口太小,等下次
      board2d.style.width = board2d.style.height = size + 'px';
      board2d.style.setProperty('--cell', (size / 8) + 'px');
    }

    function syncPieces() {
      if (mode === '2d') { render2d(); return; }      // 2D:整盘重画,棋子与高亮一并刷新
      if (!gl) return;
      for (const p of pieceMeshes) p.mesh.setParent(null);
      pieceMeshes.length = 0;
      shadow.castMeshes.length = 0;            // 旧棋子的投影登记作废
      for (let s = 0; s < 64; s++) {
        const p = pos.b[s];
        if (!p) continue;
        const r = s >> 3, c = s & 7;
        const mesh = pieceMesh(CHARS[p & 7], (p >> 3) === WHITE ? 'w' : 'b');
        mesh.position.set((c - 3.5) * square, 0, (r - 3.5) * square);
        mesh.setParent(boardGroup);
        pieceMeshes.push({ mesh, r, c });
      }
    }
    syncPieces();

    // 高亮标记
    function showHighlights() {
      if (mode === '2d') { render2d(); return; }
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
        // uOpacity 也是共享 uniform(悬停片每帧写不同值),这里显式写回自己的档
        m.onBeforeRender(() => {
          flatProgram.uniforms.uColor.value = color;
          flatProgram.uniforms.uOpacity.value = 0.55;
        });
        m.position.set((c - 3.5) * square, 0.03, (r - 3.5) * square);
        m.setParent(scene);
        highlightMeshes.push(m);
      };
      if (sel) mk(sel[0], sel[1], rgb(0x22d3ee));
      for (const [r, c] of legal) mk(r, c, pos.b[r * 8 + c] ? rgb(0xef4444) : rgb(0x22c55e));
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
    /** 转向指定一方(白 θ=0 / 黑 θ=π)的标准视角,走最短弧 —— 换边时用 */
    function faceSide(color) {
      const base = HOME.theta + (color === BLACK ? Math.PI : 0);
      let d = (base - theta) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      flyTo({ theta: theta + d, phi: HOME.phi, radius: HOME.radius }, 420);
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

    /* 点击走子 —— 纯按格子拾取:射线与棋盘平面(y=0)求交,落在哪格就算哪格。
     * 旧实现先拿射线打棋子的包围圆柱、没打中再退回平面,但 65° 俯视下棋子互相
     * 遮挡,放宽的圆柱经常截走本想点后排 / 邻格的点击,表现为「点不中棋子、
     * 吃不到想吃的子」。纯格子拾取配合悬停高亮(指针在哪格哪格亮,见下)反而
     * 可预期:点棋子底座所在格就是它本身,悬停反馈让误点在落手前就看得见。 */
    const ray = new Raycast();
    /** 鼠标事件 → 棋盘平面射线;画布还没布局时返回 null */
    function eventRay(e) {
      if (!camera) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.castMouse(camera, [mx, my]);
      return [ray.origin, ray.direction];
    }
    /** 射线 → 格子 [r, c];视线与棋盘平行或交点在板外返回 null */
    function pickSquare(o, d) {
      if (Math.abs(d.y) < 1e-6) return null;
      const t = -o.y / d.y;
      if (t <= 0) return null;                        // 交点在相机背后
      const x = o.x + d.x * t, z = o.z + d.z * t;
      const c = Math.round(x + 3.5), r = Math.round(z + 3.5);
      if (!inB(r, c)) return null;
      // 落点必须真的落在该格内(格边长 1,中心在 (c-3.5, r-3.5))
      if (Math.abs(x - (c - 3.5)) > 0.5 || Math.abs(z - (r - 3.5)) > 0.5) return null;
      return [r, c];
    }
    /** 玩家此刻是否可落子(终局 / AI 想棋 / 轮到 AI 都锁盘) */
    const canInput = () => !!camera && !gameOver && !searching
      && !(vsAI && turnChar() !== sideChar(humanColor));
    function onClick(e) {
      if (suppressClick) { suppressClick = false; return; }   // 手势/拖拽刚结束,别当走子
      if (!canInput()) return;
      const rd = eventRay(e);
      if (!rd) return;
      const sq = pickSquare(rd[0], rd[1]);
      if (sq) handleSquare(sq[0], sq[1]);
    }
    if (canvas) canvas.addEventListener('click', onClick);

    /* 悬停指示 —— 纯格子拾取的「瞄准镜」:指针悬在哪格就垫一块浅色圆片,
     * 可选中的己方子 / 当前选中子的合法落点再加亮并切成 pointer 光标。
     * 高个子棋子挡住后排视线时,点下去之前就能确认这一击落在哪格。 */
    const HOVER_COLD = rgb(0xffffff), HOVER_HOT = rgb(0xffe08a);
    let hoverMesh = null, hoverHot = false;
    function hideHover() {
      if (hoverMesh) hoverMesh.setParent(null);
      if (canvas) canvas.style.cursor = 'grab';
    }
    function isActionable(r, c) {
      const p = pos.b[r * 8 + c];
      if (p && (p >> 3) === pos.stm) return true;     // 可选中的己方子
      return !!(sel && legal.some(([lr, lc]) => lr === r && lc === c));
    }
    function updateHover(e) {
      const rd = eventRay(e);
      if (!rd) return;
      const sq = pickSquare(rd[0], rd[1]);
      if (!sq) { hideHover(); return; }
      hoverHot = isActionable(sq[0], sq[1]);
      if (!hoverMesh) {
        const geo = geoCache.get('hover') || (() => {
          const g = new Cylinder(gl, { radiusTop: 0.46, radiusBottom: 0.46, height: 0.03, radialSegments: 24 });
          geoCache.set('hover', g);
          return g;
        })();
        hoverMesh = new Mesh(gl, { geometry: geo, program: flatProgram });
        hoverMesh.onBeforeRender(() => {
          flatProgram.uniforms.uColor.value = hoverHot ? HOVER_HOT : HOVER_COLD;
          flatProgram.uniforms.uOpacity.value = hoverHot ? 0.5 : 0.22;
        });
      }
      hoverMesh.position.set((sq[1] - 3.5) * square, 0.012, (sq[0] - 3.5) * square);
      hoverMesh.setParent(scene);
      canvas.style.cursor = hoverHot ? 'pointer' : 'grab';
    }
    if (canvas) {
      canvas.addEventListener('pointermove', (e) => {
        if (pointers.size > 0 || dragging) { hideHover(); return; }   // 拖视角 / 多指手势中不显示
        updateHover(e);
      });
      canvas.addEventListener('pointerleave', hideHover);
    }

    function handleSquare(r, c) {
      if (gameOver) return;
      if (searching) return;              // AI 想棋时锁盘,免得和在途结果打架
      if (sel) {
        const m = moveTo(r, c);
        if (m) { doMove(m); return; }
      }
      const p = pos.b[r * 8 + c];
      if (p && (p >> 3) === pos.stm) {
        const from = r * 8 + c;
        sel = [r, c];
        legal = []; legalRaw = [];
        const buf = new Int32Array(256);
        const n = genLegal(pos, buf);
        for (let i = 0; i < n; i++) {
          const m = buf[i];
          if (mFrom(m) !== from) continue;
          if (mPromo(m) && mPromo(m) !== QUEEN) continue;   // 落点去重:升变只留升后
          legalRaw.push(m);
          legal.push([mTo(m) >> 3, mTo(m) & 7]);
        }
        showHighlights();
      } else if (sel) {
        sel = null; legal = []; legalRaw = []; showHighlights();
      }
    }

    /** 在选中格的合法着法里取「落到 (r,c)」的那一手(升变优先升后) */
    function moveTo(r, c) {
      const to = r * 8 + c;
      let first = 0;
      for (const m of legalRaw) {
        if (mTo(m) !== to) continue;
        const pr = mPromo(m);
        if (!pr || pr === QUEEN) return m;
        if (!first) first = m;
      }
      return first;
    }

    /** 升变统一成升后:Worker 靠 (from<<6|to) 重演局面,还原出来的也只可能是升后 */
    function normalize(m) {
      const pr = mPromo(m);
      if (!pr || pr === QUEEN) return m;
      return mkMove(mFrom(m), mTo(m), mFlag(m) >= 10 ? 13 : 9, mCap(m));
    }

    /** 落子:先走引擎局面,再刷视图与状态;轮到 AI 就交给 Worker */
    function doMove(m) {
      m = normalize(m);
      make(pos, m);
      moves.push(m);
      sel = null; legal = []; legalRaw = []; showHighlights();
      syncPieces();
      checkEnd();
      if (gameOver) return;
      if (vsAI && pos.stm === aiColor()) thinkAI();
      else updateStatus();
    }

    function updateStatus() {
      const inC = inCheck(pos);
      const who = sideChar(pos.stm) === 'w' ? '白方' : '黑方';
      statusL.textContent = who + '行棋' + (inC ? ' — 将军!⚠' : '');
      setTitle('国际象棋');
    }

    /* 终局判定:将死 / 逼和 / 子力不足 / 三次重复。状态行只说哪方胜,不标 (AI) */
    function checkEnd() {
      const buf = new Int32Array(256);
      const inC = inCheck(pos);
      const wcol = otherStm(pos.stm);        // 刚走子的一方获胜(若有)
      const winner = sideName(wcol) + (vsAI && wcol === aiColor() ? '(AI)' : '');
      let title = null, msg = null, line = null;
      if (!hasLegalMove(pos, buf)) {
        if (inC) { title = '将死'; msg = `${winner}获胜!`; line = `将死 — ${sideName(wcol)}胜`; }
        else { title = '逼和'; msg = '和棋(无子可动)'; line = '逼和 — 和棋'; }
      } else if (insufficientMaterial(pos)) {
        title = '和棋'; msg = '子力不足,无法将死'; line = '子力不足 — 和棋';
      } else if (isThreefold(pos)) {
        title = '和棋'; msg = '三次重复局面'; line = '三次重复 — 和棋';
      }
      if (!title) { updateStatus(); return; }
      gameOver = true;
      abortEngine();
      dialogs.info({ title, message: msg });
      statusL.textContent = line;
      setTitle('国际象棋');
    }

    /* ---------- AI:搜索跑在 Worker 里 ----------
     * 传的是走法序列(不是棋盘):结构化克隆更省,且 UI 与 Worker 共用同一份
     * rules.js,走法编码天然一致,不存在第二套解析路径。
     * 每条请求带自增 id,回来的 id 对不上就当过期结果丢掉;需要立刻刹车
     * (新对局 / 换难度 / 关窗)时直接 terminate 再新建 —— Worker 里的迭代加深
     * 是同步跑的,消息只会排队,terminate 才是真中断。 */
    let worker = null, reqSeq = 0, pendingId = 0;

    function onEngineMsg(e) {
      const d = e.data;
      if (!d || d.type === 'pong' || d.id !== pendingId) return;      // 过期 / 无关消息
      if (d.error || !d.move) { pendingId = 0; searching = false; infoL.textContent = 'AI 无可用着法'; checkEnd(); return; }
      if (d.book) {
        // 引擎查谱命中:短暂延时落子让节奏像"想了一下";seq 快照对照 reqSeq,
        // 期间新对局 / 悔棋 / 关窗会作废这次落子
        infoL.textContent = d.name ? `开局库 · ${d.name}` : '开局库';
        const seq = reqSeq;
        setTimeout(() => { if (seq !== reqSeq) return; searching = false; doMove(d.move); }, 350 + Math.random() * 450);
        return;
      }
      pendingId = 0; searching = false;
      infoL.textContent = `${level().name} · 深度 ${d.depth} · ${Math.round(d.nodes / 1000)}k 节点 · ${d.ms}ms · ${fmtScore(d.score)}`;
      doMove(d.move);
    }

    function killWorker() {
      if (worker) { worker.terminate(); worker = null; }
      pendingId = 0; searching = false;
    }

    /** 作废在途请求(局面已变 / 窗口关闭),免得过期着法落到新对局上 */
    function abortEngine() {
      reqSeq++;
      killWorker();
      infoL.textContent = '';
    }

    function thinkAI() {
      if (gameOver || searching) return;
      const cfg = level();
      searching = true;
      sel = null; legal = []; legalRaw = []; showHighlights();
      statusL.textContent = `${sideName(aiColor())}思考中…`;
      setTitle('国际象棋');
      infoL.textContent = '';
      if (typeof Worker === 'undefined') {
        searching = false;
        statusL.textContent = '当前环境不支持 Web Worker,AI 不可用';
        return;
      }
      if (!worker) {
        try {
          worker = new Worker(new URL('../../../vendor/AetherChess/src/worker.js', import.meta.url), { type: 'module' });
          worker.onmessage = onEngineMsg;
          worker.onerror = (ev) => {
            console.warn('[chess3d] AI Worker 异常:', ev.message || ev);
            killWorker();
            statusL.textContent = 'AI 出错,已跳过本步';
          };
        } catch (err) {
          console.error('[chess3d] 无法创建 AI Worker:', err);
          worker = null; searching = false;
          statusL.textContent = 'AI 不可用(Worker 创建失败)';
          return;
        }
      }
      const id = ++reqSeq;
      pendingId = id;
      // 压成 (from<<6|to) 再发:Worker 的 replayMoves 会按合法着法还原旗位
      worker.postMessage({ id, moves: moves.map((m) => (mFrom(m) << 6) | mTo(m)), nodes: cfg.nodes, ms: cfg.ms, depth: cfg.depth });
    }

    function resetGame() {
      abortEngine();
      pos = newPos();
      moves = [];
      sel = null; legal = []; legalRaw = [];
      gameOver = false;
      syncPieces(); showHighlights(); updateStatus();
      if (vsAI && pos.stm === aiColor()) thinkAI();   // 换边后玩家执黑时,AI 执白先行
    }

    /** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手(对方应手 + 自己那手),
     * 人人撤一手;AI 想棋中悔棋先掐掉在途搜索;终局后悔棋可复活对局。 */
    function doUndo() {
      if (!moves.length) return;
      abortEngine();
      let n = 1;
      if (vsAI && pos.stm === humanColor && moves.length >= 2) n = 2;
      while (n-- > 0 && moves.length) unmake(pos, moves.pop());
      gameOver = false;
      sel = null; legal = []; legalRaw = [];
      syncPieces(); showHighlights();
      if (vsAI && pos.stm === aiColor()) thinkAI();   // 撤完轮到 AI(如执黑方在起点悔棋)就让它重想
      else updateStatus();
    }

    /** 换边:与 AI 互换执子方。中途换边作废在途搜索并立即接手;
     * 3D 视角飞向新一侧,2D 棋盘由 render2d 按 humanColor 翻转。终局后换边只改偏好,下局生效。 */
    function switchSide() {
      abortEngine();
      humanColor = otherStm(humanColor);
      faceSide(humanColor);
      if (!gameOver && pos.stm === aiColor()) thinkAI();
      else if (!gameOver) updateStatus();
    }

    /* 工具栏 */
    const newBtn = el('button', { class: 'btn primary', onClick: resetGame }, icon('refresh', 13), '新对局');
    /* 难度档:原生 <select>(计划 §3.6 的首选形态,比循环按钮少点几下、状态一眼可见)。
     * 换档时若 AI 正在想棋就掐掉重想 —— 否则要等旧档位的结果回来才生效,用户会以为下拉没反应。 */
    const levelSel = el('select', {
      class: 'select chess3d-level',
      title: 'AI 难度:初级 / 中级 / 高级 / 大师',
      'aria-label': 'AI 难度',
      onChange: (e) => {
        levelIdx = Number(e.currentTarget.value) || 0;
        if (searching) { abortEngine(); thinkAI(); }
      },
    }, ...LEVELS.map((lv, i) => el('option', { value: String(i) }, lv.name)));
    levelSel.value = String(levelIdx);            // 默认「高级」
    const aiBtn = el('button', {
      class: 'btn', title: '切换人机 / 双人对战',
      onClick: (e) => {
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机' : '双人';
        sideBtn.disabled = !vsAI;                                  // 换边只对人机模式有意义
        if (!vsAI) { abortEngine(); updateStatus(); }              // 关掉 AI 要把在途搜索停掉
        else if (!gameOver && pos.stm === aiColor()) thinkAI();    // 轮到 AI 一侧就立刻接手
        else updateStatus();
      },
    }, '人机');
    const sideBtn = el('button', {
      class: 'btn', title: '换边:与 AI 互换执子方,视角随之转向',
      onClick: switchSide,
    }, '换边');
    const undoBtn = el('button', {
      class: 'btn', title: '悔棋:人机模式连 AI 的应手一起撤,人人模式撤一手',
      onClick: doUndo,
    }, icon('reply', 13), '悔棋');
    /* 归正:3D 视角专属操作,做成画面内悬浮按钮,2D 视图下随容器一起隐藏,
     * 工具栏只留对局级操作。换边不需要按钮 —— 拖拽转过去即可,归正会保留朝向。 */
    const homeBtn = el('button', { class: 'btn chess3d-home', title: '归正到 65° 标准俯视角', onClick: goHome }, icon('home', 13), '归正');
    container.append(homeBtn);

    /* 2D/3D 视图切换(分段按钮,样式同扫雷的难度档)。2D 下两个 3D 视角按钮随之禁用。 */
    const modeBtns = [];
    const modeSeg = el('div', { class: 'seg', role: 'group', 'aria-label': '棋盘视图', title: '切换 2D / 3D 视图' },
      ...['2d', '3d'].map((id) => {
        const b = el('button', { class: 'seg-btn', onClick: () => setMode(id) }, id.toUpperCase());
        modeBtns.push([id, b]);
        return b;
      }));
    /** 把界面各处同步到当前 mode:容器显隐 / 分段按钮态 */
    function applyMode() {
      const two = mode === '2d';
      for (const [id, b] of modeBtns) {
        b.classList.toggle('active', id === mode);
        b.setAttribute('aria-pressed', String(id === mode));
      }
      wrap2d.style.display = two ? '' : 'none';
      container.style.display = two ? 'none' : '';
      if (two) fit2d(); else fit();
    }
    /** 切换后各重建一遍视图:2D 期间 3D 网格没跟着走子更新,切回来要重摆;反向同理 */
    function setMode(m) {
      if ((m !== '2d' && m !== '3d') || mode === m) return;
      mode = m;
      hideHover();      // 切走的瞬间清掉悬停片,切回来别残留旧位置
      applyMode();
      syncPieces();
      showHighlights();
    }

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn,
        el('label', { class: 'chess3d-level-wrap', title: 'AI 难度' },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '难度'), levelSel),
        aiBtn, sideBtn, undoBtn, modeSeg),
      container,
      wrap2d,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        infoL)));
    applyMode();    // 初始视图:WebGL 可用为 3D,失败则落在 2D(错误提示留在 container 里备用)

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
      if (!renderer || mode === '2d') return;   // 2D 期间画面由 DOM 承担,跳过 3D 出帧
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

    const onWinResize = () => { fit(); fit2d(); };
    const ro = new ResizeObserver(onWinResize);
    ro.observe(container);
    ro.observe(wrap2d);
    window.addEventListener('resize', onWinResize);

    updateStatus();

    // e2e 测试钩子:绕过屏幕坐标,直接按格子坐标走子
    window.__chess = {
      click: (r, c) => handleSquare(r, c),
      turn: () => turnChar(),
      board: () => viewOf(pos),
      sel: () => sel,
      legal: () => legal,
      /** 引擎侧信息:已走着法数 / 搜索是否在跑 / 当前难度 id */
      moves: () => moves.length,
      searching: () => searching,
      level: () => LEVELS[levelIdx].id,
      mode: () => mode,
      /** 测试用:切 2D / 3D 视图 */
      setMode: (m) => setMode(m),
      /** 玩家执子方('w'/'b')与换边、悔棋(测试用) */
      human: () => sideChar(humanColor),
      switchSide: () => switchSide(),
      undo: () => doUndo(),
      /** 测试用:直接切换难度(0 初级 … 3 大师),与下拉保持同步 */
      setLevel: (i) => {
        if (i >= 0 && i < LEVELS.length) {
          levelIdx = i;
          levelSel.value = String(i);
        }
      },
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
      /** 供测试/排障用:确认渲染器是否活着、画面是否真的在出帧;附引擎侧状态 */
      stats: () => (renderer ? {
        alive: true, frames, size: [vw, vh], lib: 'ogl',
        ai: { level: LEVELS[levelIdx].id, vsAI, searching, plies: moves.length },
      } : { alive: false }),
    };

    /* ---------- 关闭时释放 ---------- */
    return {
      onResize: fit,
      onClose() {
        disposed = true;
        abortEngine();                  // 停掉在途的 AI 搜索并释放 Worker
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onWinResize);
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
