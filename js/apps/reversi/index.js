/* ============================================================
 * 应用:黑白棋(Reversi / Othello)
 * 8×8 棋盘;完整规则:夹翻、无合法棋自动跳过、双方无棋终局;
 * 合法位置提示;人机对弈。
 *
 * AI 引擎在独立子项目 vendor/AetherOthello(github.com/suulnnka/AetherOthello):
 * 位棋盘 + PVS/置换表 + 残局完全求解,测试与基准都在该仓库。
 * 搜索过程(深度/最佳步/评分/节点数/耗时)实时写入窗口内信息行。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './reversi.css';
import { dialogs } from '../../core/dialogs.js';
import { think, LEVELS } from '../../../vendor/AetherOthello/src/engine.js';

/* ==================== 应用 UI ==================== */

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (p) => (p === 'b' ? 'w' : 'b');

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

const moveName = (p) => 'abcdefgh'[p & 7] + ((p >> 3) + 1);
const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));
const fmtT = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms');
const fmtNps = (res) => (res.ms > 0 ? ` · ${fmtN(Math.round(res.nodes / res.ms * 1000))}节点/s` : '');

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let board = initBoard();
    let turn = 'b';          // 玩家执黑,先手
    let gameOver = false;
    let vsAI = true;
    let lastMove = null;
    let searchGen = 0;       // 搜索代数:新对局/模式切换时 +1,打断进行中的搜索
    let thinking = false;
    let levelIdx = 2;        // 默认高级

    const statusL = el('span', {}, '');
    const boardEl = el('div', { class: 'rv-board' });
    const blackCount = el('span', { class: 'rv-count black' }, '2');
    const whiteCount = el('span', { class: 'rv-count white' }, '2');
    const searchLine = el('div', { class: 'rv-search' }, levelHint());

    function levelHint() {
      const lv = LEVELS[levelIdx];
      return `AI 待命(难度:${lv.name}) · ${lv.desc}`;
    }

    /** 把搜索过程写入信息行 */
    function showSearch(res, done) {
      if (res.greedy) {
        const sc = res.score >= 0 ? `白 +${res.score}` : `黑 +${-res.score}`;
        searchLine.textContent = `初级 贪心选点 ${moveName(res.move)} · 评估 ${sc} · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}`;
        return;
      }
      if (res.only) { searchLine.textContent = `唯一合法步 ${moveName(res.move)},无需搜索`; return; }
      const tail = ` · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}${fmtNps(res)}`;
      if (res.warm) { // 残局前置中层搜索:只为完全求解排序
        const sc = res.score >= 0 ? `白 +${res.score}` : `黑 +${-res.score}`;
        searchLine.textContent = `残局预热 深度 ${res.depth}/${res.depthMax} · 最佳 ${moveName(res.move)} · 评估 ${sc}${tail}`;
        return;
      }
      if (res.endgame) {
        if (res.pending) { searchLine.textContent = `残局完全求解中…(${res.empties} 空) · 先行着法 ${moveName(res.move)}`; return; }
        const d = Math.round((res.score || 0) / 100);
        const verdict = d > 0 ? `白胜 ${d} 子` : d < 0 ? `黑胜 ${-d} 子` : '和棋';
        searchLine.textContent = `残局完全求解(${res.empties}空):${verdict} · 最佳 ${moveName(res.move)}${tail}`;
      } else {
        const sc = res.score >= 0 ? `白 +${res.score}` : `黑 +${-res.score}`;
        searchLine.textContent = `${done ? '' : '搜索中… '}深度 ${res.depth}/${res.depthMax} · 最佳 ${moveName(res.move)} · 评估 ${sc}${tail}`;
      }
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
    function advance() {
      const n = counts(board);
      const full = n.black + n.white === 64;
      if (full || (legalMoves(board, 'b').length === 0 && legalMoves(board, 'w').length === 0)) {
        finish(); renderBoard(); return;
      }
      if (legalMoves(board, turn).length === 0) {
        // 当前方无棋:跳过(双方均无棋的情况已在上面终局处理)
        bus.notify('黑白棋', `${turn === 'b' ? '黑方' : '白方'}无合法棋,跳过回合`);
        turn = other(turn);
      }
      renderBoard();
      updateStatus();
      if (vsAI && turn === 'w' && !gameOver) setTimeout(aiMove, 260);
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

    async function aiMove() {
      if (gameOver || !vsAI || turn !== 'w') return;
      if (!root.isConnected) { searchGen++; return; }
      if (thinking) { setTimeout(aiMove, 260); return; } // 上一轮搜索尚未结束,稍后重试
      thinking = true;
      const gen = searchGen;
      try {
        const res = await think(board, 'w', LEVELS[levelIdx], showSearch, () => gen !== searchGen);
        if (!res || gen !== searchGen || gameOver || !root.isConnected) return;
        const r = res.move >> 3, c = res.move & 7;
        const { board: nb, flipped } = applyMove(board, r, c, 'w');
        board = nb;
        lastMove = [r, c];
        turn = 'b';
        renderBoard();
        updateStatus(`AI 落子 ${moveName(res.move)}(翻 ${flipped.length} 子)`);
        advance();
      } finally {
        thinking = false;
      }
    }

    const newBtn = el('button', { class: 'btn primary', onClick: () => {
      searchGen++; // 打断进行中的搜索
      board = initBoard(); turn = 'b'; gameOver = false; lastMove = null;
      searchLine.textContent = levelHint();
      renderBoard(); updateStatus();
    } }, '新对局');
    const aiBtn = el('button', {
      class: 'btn', onClick: (e) => {
        searchGen++;
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机:开' : '双人';
        if (!vsAI) { searchLine.textContent = '双人模式 · 无 AI 搜索'; updateStatus(); }
        else advance();
      },
    }, '人机:开');
    const levelBtn = el('button', {
      class: 'btn', onClick: (e) => {
        searchGen++;
        levelIdx = (levelIdx + 1) % LEVELS.length;
        e.currentTarget.textContent = `难度:${LEVELS[levelIdx].name}`;
        searchLine.textContent = levelHint();
        // 若切换发生在 AI 思考中,重新调度被打断的 AI
        if (vsAI && turn === 'w' && !gameOver) setTimeout(aiMove, 260);
      },
    }, `难度:${LEVELS[levelIdx].name}`);

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn, aiBtn, levelBtn,
        el('span', { class: 'grow' }),
        el('span', { class: 'row' }, blackCount, el('span', { class: 'dim' }, ':'), whiteCount)),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      searchLine,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '你执黑先行 · 点亮圈为可落子位'))));

    renderBoard();
    updateStatus();
  },
});
