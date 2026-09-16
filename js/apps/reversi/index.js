/* ============================================================
 * 应用:黑白棋(Reversi / Othello)
 * 8×8 棋盘;完整规则:夹翻、无合法棋自动跳过、双方无棋终局;
 * 合法位置提示;人机对弈(位置权重 + 子力贪心 AI)。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import { dialogs } from '../../core/dialogs.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (p) => (p === 'b' ? 'w' : 'b');

/** 位置权重表(角最贵,角旁负分) */
const WEIGHT = [
  [120, -20, 20, 5, 5, 20, -20, 120],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [120, -20, 20, 5, 5, 20, -20, 120],
];

function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  b[3][3] = 'w'; b[3][4] = 'b'; b[4][3] = 'b'; b[4][4] = 'w';
  return b;
}

/** 某格落子能翻转的所有对方子(返回坐标数组;无翻转则 []) */
function flipsFor(b, r, c, color) {
  if (b[r][c]) return [];
  const flips = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let rr = r + dr, cc = c + dc;
    while (inB(rr, cc) && b[rr][cc] && b[rr][cc] !== color) { line.push([rr, cc]); rr += dr; cc += dc; }
    if (line.length && inB(rr, cc) && b[rr][cc] === color) flips.push(...line);
  }
  return flips;
}

function legalMoves(b, color) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (!b[r][c] && flipsFor(b, r, c, color).length) out.push([r, c]);
  }
  return out;
}

function applyMove(b, r, c, color) {
  const flips = flipsFor(b, r, c, color);
  const nb = b.map(row => [...row]);
  nb[r][c] = color;
  for (const [fr, fc] of flips) nb[fr][fc] = color;
  return { board: nb, flipped: flips };
}

function counts(b) {
  let black = 0, white = 0;
  for (const row of b) for (const cell of row) { if (cell === 'b') black++; else if (cell === 'w') white++; }
  return { black, white };
}

register({
  id: 'reversi',
  name: '黑白棋',
  icon: 'circle',
  color: 'linear-gradient(135deg,#059669,#065f46)',
  neon: { a: '#10b981', b: '#a3e635' },
  width: 640, height: 660,
  min: { w: 460, h: 480 },
  singleton: true,
  order: 9.8,
  mount({ root, setTitle, bus }) {
    let board = initBoard();
    let turn = 'b';          // 玩家执黑,先手
    let gameOver = false;
    let vsAI = true;
    let lastMove = null;

    const statusL = el('span', {}, '');
    const boardEl = el('div', { class: 'rv-board' });
    const blackCount = el('span', { class: 'rv-count black' }, '2');
    const whiteCount = el('span', { class: 'rv-count white' }, '2');

    /** 合法位置标记 */
    function showHints() {
      boardEl.querySelectorAll('.rv-cell').forEach(cell => {
        const r = +cell.dataset.r, c = +cell.dataset.c;
        cell.classList.toggle('hint', !board[r][c] && !gameOver && flipsFor(board, r, c, turn).length > 0);
        cell.classList.toggle('last', !!lastMove && lastMove[0] === r && lastMove[1] === c);
        cell.innerHTML = '';
        const piece = board[r][c];
        if (piece) cell.append(el('div', { class: `rv-piece ${piece}${lastMove && lastMove[0] === r && lastMove[1] === c ? ' just' : ''}` }));
      });
    }

    function renderBoard() {
      boardEl.innerHTML = '';
      const hints = legalMoves(board, turn);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const piece = board[r][c];
          const isHint = !gameOver && piece === null && flipsFor(board, r, c, turn).length > 0;
          const cell = el('button', {
            class: 'rv-cell' + (isHint ? ' hint' : '') + (lastMove && lastMove[0] === r && lastMove[1] === c ? ' last' : ''),
            dataset: { r: String(r), c: String(c) },
            onClick: () => humanMove(r, c),
          });
          if (piece) cell.append(el('div', { class: `rv-piece ${piece}${lastMove && lastMove[0] === r && lastMove[1] === c ? ' just' : ''}` }));
          else if (isHint && turn === 'b') cell.append(el('div', { class: 'rv-hint-dot' }));
          boardEl.append(cell);
        }
      }
      const n = counts(board);
      blackCount.textContent = String(n.black);
      whiteCount.textContent = String(n.white);
    }

    function updateStatus(msg) {
      const n = counts(board);
      if (msg) statusL.textContent = msg;
      else statusL.textContent = gameOver ? '终局' : `${turn === 'b' ? '黑方(你)' : '白方(AI)'}行棋 · 合法步 ${legalMoves(board, turn).length}`;
      setTitle(`黑白棋 ${n.black}:${n.white} — ${gameOver ? '终局' : turn === 'b' ? '你的回合' : 'AI 回合'}`);
    }

    function finish() {
      const { black, white } = counts(board);
      gameOver = true;
      let title, msg;
      if (black > white) { title = '🎉 你赢了!'; msg = `黑 ${black} : 白 ${white}`; }
      else if (white > black) { title = 'AI 获胜'; msg = `黑 ${black} : 白 ${white}`; }
      else { title = '平局'; msg = `${black} : ${white}`; }
      dialogs.info({ title, message: msg });
      updateStatus(`${title}(${msg})`);
    }

    /** 回合推进:处理跳过与终局;vsAI 时驱动 AI */
    function advance(afterAI = false) {
      const n = counts(board);
      const full = n.black + n.white === 64;
      const noMovesBlack = legalMoves(board, 'b').length === 0;
      const noMovesWhite = legalMoves(board, 'w').length === 0;
      if (full || (noMovesBlack && noMovesWhite)) { finish(); renderBoard(); return; }
      if (legalMoves(board, turn).length === 0) {
        // 当前方无棋:跳过
        bus.notify('黑白棋', `${turn === 'b' ? '黑方' : '白方'}无合法棋,跳过回合`);
        turn = other(turn);
      }
      renderBoard();
      updateStatus();
      if (vsAI && turn === 'w' && !gameOver && !afterAI) {
        setTimeout(aiMove, 500);
      }
    }

    function humanMove(r, c) {
      if (gameOver || turn !== 'b') return;
      const flips = flipsFor(board, r, c, 'b');
      if (!flips.length) return;
      const { board: nb, flipped } = applyMove(board, r, c, 'b');
      board = nb;
      lastMove = [r, c];
      turn = 'w';
      renderBoard();
      updateStatus(`${flipped.length} 子被翻`);
      advance();
    }

    function aiMove() {
      if (gameOver) return;
      const moves = legalMoves(board, 'w');
      if (!moves.length) { advance(true); return; }
      // 评分:位置权重 + 翻转数
      let best = null, bestScore = -Infinity;
      for (const [r, c] of moves) {
        const flips = flipsFor(board, r, c, 'w');
        const score = WEIGHT[r][c] + flips.length * 2;
        if (score > bestScore) { bestScore = score; best = [r, c]; }
      }
      const [r, c] = best;
      const { board: nb } = applyMove(board, r, c, 'w');
      board = nb;
      lastMove = [r, c];
      turn = 'b';
      renderBoard();
      advance(true);
    }

    const newBtn = el('button', { class: 'btn primary', onClick: () => {
      board = initBoard(); turn = 'b'; gameOver = false; lastMove = null;
      renderBoard(); updateStatus();
    } }, '新对局');
    const aiBtn = el('button', {
      class: 'btn', onClick: (e) => {
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机:开' : '双人';
        if (!vsAI) updateStatus();
        else advance();
      },
    }, '人机:开');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn, aiBtn,
        el('span', { class: 'grow' }),
        el('span', { class: 'row' },
          el('span', { class: 'rv-count black' }, '2'),
          el('span', { class: 'dim' }, ':'),
          el('span', { class: 'rv-count white' }, '2'))),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '你执黑先行 · 点亮圈为可落子位'))));

    renderBoard();
    updateStatus();
  },
});

