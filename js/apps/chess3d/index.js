/* ============================================================
 * 应用:3D 国际象棋(ogl 渲染)
 * - 拖拽旋转视角 / 滚轮缩放 / 点击走子
 * - 完整走子规则:各兵种 + 王车易位 + 吃过路兵 + 兵升变(自动升后)
 * - 将军 / 将死 / 逼和判定;简单 AI(一层贪心 + 子力价值)
 *
 * 渲染原用 three.js(压缩后 116 KB),已换成 ogl(约 15 KB):
 * ogl 不带光照材质系统,这里的 Lambert 光照与阴影采样由下方自写 GLSL 承担。
 * ============================================================ */
import { Renderer, Camera, Transform, Box, Cylinder, Sphere, Program, Mesh, Vec3, Raycast, Shadow, RenderTarget } from 'ogl';
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

      program = new Program(gl, {
        vertex: VERT, fragment: FRAG,
        uniforms: {
          uColor: { value: new Vec3(1, 1, 1) },
          uLightDir: { value: new Vec3(6, 10, 4) },
          uAmbient: { value: 0.42 },
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

      // 棋子几何工厂(组合体)
      const whiteV = rgb(0xf5f0e6), blackV = rgb(0x2b2f3a);
      pieceMesh = (t, color) => {
        const cv = color === 'w' ? whiteV : blackV;
        const g = new Transform();
        const add = (geometry, y) => {
          const m = makeMesh(geometry, cv);
          m.position.y = y;
          m.setParent(g);
          shadow.add({ mesh: m, cast: true, receive: true });
        };
        add(cylGeo(0.3, 0.36, 0.14), 0.07);                        // 底座
        if (t === 'p') { add(cylGeo(0.16, 0.26, 0.42), 0.35); add(sphGeo(0.18), 0.66); }
        else if (t === 'r') { add(cylGeo(0.24, 0.28, 0.6), 0.44); add(cylGeo(0.3, 0.24, 0.16), 0.8); }
        else if (t === 'n') { add(cylGeo(0.2, 0.28, 0.4), 0.34); add(boxGeo(0.3, 0.34, 0.34), 0.68); }
        else if (t === 'b') { add(cylGeo(0.18, 0.28, 0.5), 0.4); add(cylGeo(0, 0.2, 0.4), 0.82); }   // 顶部圆锥
        else if (t === 'q') { add(cylGeo(0.2, 0.3, 0.62), 0.45); add(sphGeo(0.22), 0.9); add(sphGeo(0.09), 1.12); }
        else { add(cylGeo(0.22, 0.3, 0.44), 0.36); add(sphGeo(0.24), 0.76); add(cylGeo(0.16, 0.16, 0.1), 1.0); }
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

    /* 相机轨道(自实现:拖拽旋转 + 滚轮缩放) */
    let theta = Math.PI / 4, phi = Math.PI / 3.4, radius = 13;
    function updateCam() {
      if (!camera) return;
      camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta));
      camera.lookAt(new Vec3(0, 0, 0));
    }
    updateCam();
    let dragging = false, lx = 0, ly = 0;
    const onMove = (e) => {
      if (!dragging) return;
      theta += (e.clientX - lx) * 0.008;
      phi = Math.min(1.45, Math.max(0.35, phi + (e.clientY - ly) * 0.006));
      lx = e.clientX; ly = e.clientY;
      updateCam();
    };
    const onUp = () => { dragging = false; };
    const onWheel = (e) => {
      e.preventDefault();
      radius = Math.min(24, Math.max(7, radius + e.deltaY * 0.01));
      updateCam();
    };
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
      canvas.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    /* 点击走子:射线与棋盘平面求交,再换算成格子坐标。
     * 不用 ogl 的 Raycast.intersectBounds —— 它按包围球求交,
     * 对扁平的方格会互相重叠,直接算平面交点更准也更省。 */
    const ray = new Raycast();
    function onClick(e) {
      if (!camera || gameOver || (vsAI && turn === 'b')) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.castMouse(camera, [mx, my]);
      const { origin, direction } = ray;
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
    const viewBtn = el('button', { class: 'btn', title: '切换到白/黑方视角', onClick: () => { theta += Math.PI; updateCam(); } }, icon('refresh', 13), '换边视角');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn, aiBtn, viewBtn,
        el('span', { class: 'grow' }),
        el('span', { class: 'dim', style: { fontSize: '12px' } }, '拖拽旋转 · 滚轮缩放 · 点击走子')),
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
    function tick() {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (!renderer) return;
      fit();
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
        window.removeEventListener('pointerup', onUp);
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
