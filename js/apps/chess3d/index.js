/* ============================================================
 * 应用:3D 国际象棋(Three.js 渲染)
 * - 拖拽旋转视角 / 滚轮缩放 / 点击走子
 * - 完整走子规则:各兵种 + 王车易位 + 吃过路兵 + 兵升变(自动升后)
 * - 将军 / 将死 / 逼和判定;简单 AI(一层贪心 + 子力价值)
 * ============================================================ */
import * as THREE from 'three';
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
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

/* ============ 注册应用 ============ */
register({
  id: 'chess3d',
  name: '3D 国际象棋',
  icon: 'star',
  color: 'linear-gradient(135deg,#0f766e,#134e4a)',
  neon: { a: '#2dd4bf', b: '#818cf8' },
  width: 900, height: 660,
  min: { w: 620, h: 460 },
  singleton: true,
  order: 9.5,
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

    /* ---------- Three.js 场景 ---------- */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1526);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

    // 渲染器:某些环境(无硬件加速 / 远程桌面)拿不到 WebGL 上下文,
    // 这里兜住异常,给出可读提示而不是整窗口崩掉。
    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      container.append(renderer.domElement);
    } catch (err) {
      console.error('[chess3d] WebGL 初始化失败:', err);
      container.append(el('div', { class: 'dim', style: { padding: '20px', textAlign: 'center', lineHeight: '1.8' } },
        '当前环境无法创建 WebGL 上下文,无法显示 3D 画面。',
        el('br'),
        el('span', { class: 'mono', style: { fontSize: '12px' } }, String(err?.message || err))));
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(6, 10, 4);
    dir.castShadow = true;
    scene.add(dir);

    // 棋盘
    const square = 1;
    const boardGroup = new THREE.Group();
    const sqMeshes = [];
    const matLight = new THREE.MeshStandardMaterial({ color: 0xe8d5b0, roughness: 0.6 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.6 });
    const geo = new THREE.BoxGeometry(square, 0.15, square);
    for (let r = 0; r < 8; r++) {
      sqMeshes.push([]);
      for (let c = 0; c < 8; c++) {
        const m = new THREE.Mesh(geo, (r + c) % 2 === 0 ? matLight : matDark);
        m.position.set((c - 3.5) * square, -0.075, (r - 3.5) * square);
        m.receiveShadow = true;
        m.userData = { r, c };
        boardGroup.add(m);
        sqMeshes[r].push(m);
      }
    }
    // 边框(顶面略低于格子顶面,否则会整片盖住棋盘格纹)
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(8.7, 0.22, 8.7),
      new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.5 }));
    frame.position.y = -0.16;
    boardGroup.add(frame);
    scene.add(boardGroup);

    // 棋子几何工厂(组合体)
    const matW = new THREE.MeshStandardMaterial({ color: 0xf5f0e6, roughness: 0.35 });
    const matB = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.4, metalness: 0.2 });
    const cyl = (rt, rb, h) => new THREE.CylinderGeometry(rt, rb, h, 20);

    function pieceMesh(t, color) {
      const mat = color === 'w' ? matW : matB;
      const g = new THREE.Group();
      const add = (geo2, y) => { const m = new THREE.Mesh(geo2, mat); m.position.y = y; m.castShadow = true; g.add(m); return m; };
      add(cyl(0.3, 0.36, 0.14), 0.07);                       // 底座
      if (t === 'p') { add(cyl(0.16, 0.26, 0.42), 0.35); add(new THREE.SphereGeometry(0.18, 16, 12), 0.66); }
      else if (t === 'r') { add(cyl(0.24, 0.28, 0.6), 0.44); add(cyl(0.3, 0.24, 0.16), 0.8); }
      else if (t === 'n') { add(cyl(0.2, 0.28, 0.4), 0.34); add(new THREE.BoxGeometry(0.3, 0.34, 0.34), 0.68); }
      else if (t === 'b') { add(cyl(0.18, 0.28, 0.5), 0.4); add(new THREE.ConeGeometry(0.2, 0.4, 16), 0.82); }
      else if (t === 'q') { add(cyl(0.2, 0.3, 0.62), 0.45); add(new THREE.SphereGeometry(0.22, 16, 12), 0.9); add(new THREE.SphereGeometry(0.09, 10, 8), 1.12); }
      else { add(cyl(0.22, 0.3, 0.44), 0.36); add(new THREE.SphereGeometry(0.24, 16, 12), 0.76); add(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 16), 1.0).rotation.x = 0; }
      return g;
    }

    const pieceMeshes = [];   // { mesh, r, c }
    function syncPieces() {
      for (const p of pieceMeshes) boardGroup.remove(p.mesh);
      pieceMeshes.length = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p) continue;
        const mesh = pieceMesh(p.t, p.c);
        mesh.position.set((c - 3.5) * square, 0, (r - 3.5) * square);
        boardGroup.add(mesh);
        pieceMeshes.push({ mesh, r, c });
      }
    }
    syncPieces();

    // 高亮标记
    const highlights = new THREE.Group();
    scene.add(highlights);
    function showHighlights() {
      highlights.clear();
      const mk = (r, c, color) => {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.42, 0.04, 24),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }));
        m.position.set((c - 3.5) * square, 0.03, (r - 3.5) * square);
        highlights.add(m);
      };
      if (sel) mk(sel[0], sel[1], 0x22d3ee);
      for (const [r, c] of legal) mk(r, c, board[r][c] ? 0xef4444 : 0x22c55e);
    }

    /* 相机轨道(自实现:拖拽旋转 + 滚轮缩放) */
    let theta = Math.PI / 4, phi = Math.PI / 3.4, radius = 13;
    function updateCam() {
      camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta));
      camera.lookAt(0, 0, 0);
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
    if (renderer) {
      renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
      renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    /* 点击走子(Raycaster) */
    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    function onClick(e) {
      if (gameOver || (vsAI && turn === 'b')) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(mouse, camera);
      const hits = ray.intersectObjects(sqMeshes.flat());
      if (!hits.length) return;
      const { r, c } = hits[0].object.userData;
      handleSquare(r, c);
    }
    if (renderer) renderer.domElement.addEventListener('click', onClick);

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
        el('span', { class: 'mono' }, 'Three.js r160'))));

    /* ---------- 尺寸自适应 + 渲染循环 ----------
     * WebGL 不会自动刷新画面,必须每帧手动 render()。
     */
    let vw = 0, vh = 0;
    function fit() {
      if (!renderer) return;
      const r = container.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;           // 未布局 / 窗口最小化
      if (Math.abs(r.width - vw) < 1 && Math.abs(r.height - vh) < 1) return;
      vw = r.width; vh = r.height;
      renderer.setSize(vw, vh);
      camera.aspect = vw / vh;
      camera.updateProjectionMatrix();
    }

    let disposed = false, raf = 0;
    function tick() {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (!renderer) return;
      fit();
      renderer.render(scene, camera);
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
      stats: () => renderer ? {
        alive: true, frames: renderer.info.render.frame,
        size: [vw, vh], calls: renderer.info.render.calls,
      } : { alive: false },
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
        highlights.clear();
        boardGroup.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
        });
        renderer?.dispose();
      },
    };
  },
});
