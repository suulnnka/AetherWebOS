/* ============================================================
 * 应用:黑白棋(Reversi / Othello)
 * 8×8 棋盘;完整规则:夹翻、无合法棋自动跳过、双方无棋终局;
 * 合法位置提示;人机对弈,支持换边(与 AI 互换执子方)与悔棋。
 *
 * AI 引擎在独立子项目 vendor/AetherOthello(github.com/suulnnka/AetherOthello):
 * 位棋盘 + PVS/置换表 + 残局完全求解,测试与基准都在该仓库。
 * 搜索过程(深度/最佳步/评分/节点数/耗时)实时写入状态栏右侧(样式同 chess)。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
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
const sideName = (p) => (p === 'b' ? '黑方' : '白方');

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let board = initBoard();
    let turn = 'b';          // 行棋方(黑先)
    let gameOver = false;
    let vsAI = true;
    let humanColor = 'b';    // 人机模式下玩家执子方,「换边」互换
    let moves = [];          // 走子历史 { color, r, c, flips },悔棋按它还原
    let lastMove = null;
    let searchGen = 0;       // 搜索代数:新对局/模式切换时 +1,打断进行中的搜索
    let thinking = false;
    let levelIdx = 2;        // 默认高级
    const aiColor = () => other(humanColor);

    const statusL = el('span', {}, '');
    const infoL = el('span', {
      class: 'mono', style: { fontSize: '11px', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, '');
    const boardEl = el('div', { class: 'rv-board' });
    const blackCount = el('span', { class: 'rv-count black' }, '2');
    const whiteCount = el('span', { class: 'rv-count white' }, '2');

    /** 把搜索过程写入状态栏右侧(样式同 chess 的 infoL:mono 11px) */
    function showSearch(res, done) {
      const me = sideName(aiColor()), opp = sideName(other(aiColor()));
      const sc = (s) => (s >= 0 ? `${me} +${s}` : `${opp} +${-s}`);
      if (res.greedy) {
        infoL.textContent = `初级 贪心选点 ${moveName(res.move)} · 评估 ${sc(res.score)} · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}`;
        return;
      }
      if (res.only) { infoL.textContent = `唯一合法步 ${moveName(res.move)},无需搜索`; return; }
      const tail = ` · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}${fmtNps(res)}`;
      if (res.warm) { // 残局前置中层搜索:只为完全求解排序
        infoL.textContent = `残局预热 深度 ${res.depth}/${res.depthMax} · 最佳 ${moveName(res.move)} · 评估 ${sc(res.score)}${tail}`;
        return;
      }
      if (res.endgame) {
        if (res.pending) { infoL.textContent = `残局完全求解中…(${res.empties} 空) · 先行着法 ${moveName(res.move)}`; return; }
        const d = Math.round((res.score || 0) / 100);
        const verdict = d > 0 ? `${me}胜 ${d} 子` : d < 0 ? `${opp}胜 ${-d} 子` : '和棋';
        infoL.textContent = `残局完全求解(${res.empties}空):${verdict} · 最佳 ${moveName(res.move)}${tail}`;
      } else {
        infoL.textContent = `${done ? '' : '搜索中… '}深度 ${res.depth}/${res.depthMax} · 最佳 ${moveName(res.move)} · 评估 ${sc(res.score)}${tail}`;
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
          else if (isHint && (!vsAI || turn === humanColor)) cell.append(el('div', { class: 'rv-hint-dot' }));
          boardEl.append(cell);
        }
      }
      const n = counts(board);
      blackCount.textContent = String(n.black);
      whiteCount.textContent = String(n.white);
    }

    function updateStatus() {
      statusL.textContent = gameOver ? '终局' : `${sideName(turn)}行棋`;
      setTitle('黑白棋');
    }

    function finish() {
      const { black, white } = counts(board);
      gameOver = true;
      const reason = black + white === 64 ? '棋盘已满' : '双方无棋';
      let title, msg = `黑 ${black} : 白 ${white}`, line;
      if (black === white) {
        title = '平局';
        line = `${reason} — 和棋`;
      } else {
        const winner = black > white ? '黑方' : '白方';
        line = `${reason} — ${winner}胜`;
        title = vsAI
          ? (winner === sideName(humanColor) ? '🎉 你赢了!' : 'AI 获胜')
          : `🎉 ${winner}获胜`;
      }
      dialogs.info({ title, message: msg });
      statusL.textContent = line;
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
      if (vsAI && turn === aiColor() && !gameOver) setTimeout(aiMove, 260);
    }

    function humanMove(r, c) {
      if (gameOver || (vsAI && turn !== humanColor)) return;
      const color = turn;
      const flips = flipsFor(board, r, c, color);
      if (!flips.length) return;
      const { board: nb, flipped } = applyMove(board, r, c, color);
      board = nb;
      moves.push({ color, r, c, flips: flipped });
      lastMove = [r, c];
      turn = other(color);
      advance();
    }

    async function aiMove() {
      const color = aiColor();
      if (gameOver || !vsAI || turn !== color) return;
      if (!root.isConnected) { searchGen++; return; }
      if (thinking) { setTimeout(aiMove, 260); return; } // 上一轮搜索尚未结束,稍后重试
      thinking = true;
      const gen = searchGen;
      try {
        const res = await think(board, color, LEVELS[levelIdx], showSearch, () => gen !== searchGen);
        if (!res || gen !== searchGen || gameOver || !root.isConnected) return;
        const r = res.move >> 3, c = res.move & 7;
        const { board: nb, flipped } = applyMove(board, r, c, color);
        board = nb;
        moves.push({ color, r, c, flips: flipped });
        lastMove = [r, c];
        turn = other(color);
        advance();
      } finally {
        thinking = false;
      }
    }

    /** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手(对方应手 + 自己那手),
     * 人人撤一手;AI 想棋中悔棋先作废在途搜索;终局后悔棋可复活对局。
     * 历史条目自带行棋方,跳过回合不会打乱还原(轮到谁由条目颜色决定)。 */
    function doUndo() {
      if (!moves.length) return;
      searchGen++;                       // 掐掉在途搜索,过期结果回来直接作废
      let n = 1;
      if (vsAI && turn === humanColor && moves.length >= 2) n = 2;
      while (n-- > 0 && moves.length) {
        const m = moves.pop();
        board[m.r][m.c] = null;
        for (const [fr, fc] of m.flips) board[fr][fc] = other(m.color);
        turn = m.color;
      }
      const last = moves[moves.length - 1];
      lastMove = last ? [last.r, last.c] : null;
      gameOver = false;
      infoL.textContent = '';
      renderBoard();
      if (vsAI && turn === aiColor()) setTimeout(aiMove, 260);   // 撤完轮到 AI(如执白方在起点悔棋)就让它重想
      else updateStatus();
    }

    /** 换边:与 AI 互换执子方。棋盘上下对称,无需转向;中途换边作废在途搜索并立即
     * 接手/交出;终局后换边只改偏好,下局(含新对局)生效。双人模式下按钮禁用。 */
    function switchSide() {
      searchGen++;
      humanColor = other(humanColor);
      renderBoard();                     // 提示点跟「轮到的是不是人」走,执子方变了要重画
      if (!gameOver && turn === aiColor()) setTimeout(aiMove, 260);
      else if (!gameOver) updateStatus();   // 终局后换边只改偏好,保留终局文案
    }

    /* 工具栏(样式与结构对齐 chess:图标按钮 + 难度下拉 + 人机/换边/悔棋) */
    const newBtn = el('button', { class: 'btn primary', title: '重新开始一局', onClick: () => {
      searchGen++; // 打断进行中的搜索
      board = initBoard(); turn = 'b'; gameOver = false; lastMove = null; moves = [];
      infoL.textContent = '';
      renderBoard(); updateStatus();
      if (vsAI && turn === aiColor()) setTimeout(aiMove, 260);   // 玩家执白时 AI 执黑先行
    } }, icon('refresh', 13), '新对局');
    /* 难度档:原生 <select>(同 chess 的下拉形态,比循环按钮少点几下、状态一眼可见)。
     * 换档时若 AI 正在想棋就掐掉重想 —— 否则要等旧档位的结果回来才生效。 */
    const levelSel = el('select', {
      class: 'select rv-level',
      title: 'AI 难度:初级 / 中级 / 高级',
      'aria-label': 'AI 难度',
      onChange: (e) => {
        searchGen++;
        levelIdx = Number(e.currentTarget.value) || 0;
        infoL.textContent = '';
        // 若切换发生在 AI 思考中,重新调度被打断的 AI
        if (vsAI && turn === aiColor() && !gameOver) setTimeout(aiMove, 260);
      },
    }, ...LEVELS.map((lv, i) => el('option', { value: String(i) }, lv.name)));
    levelSel.value = String(levelIdx);            // 默认「高级」
    const aiBtn = el('button', {
      class: 'btn', title: '切换人机 / 双人对战',
      onClick: (e) => {
        searchGen++;
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机' : '双人';
        sideBtn.disabled = !vsAI;                                 // 换边只对人机模式有意义
        if (!vsAI) { infoL.textContent = ''; renderBoard(); updateStatus(); }
        else if (!gameOver) advance();
        else updateStatus();
      },
    }, '人机');
    const sideBtn = el('button', {
      class: 'btn', title: '换边:与 AI 互换执子方',
      onClick: switchSide,
    }, '换边');
    const undoBtn = el('button', {
      class: 'btn', title: '悔棋:人机模式连 AI 的应手一起撤,人人模式撤一手',
      onClick: doUndo,
    }, icon('reply', 13), '悔棋');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn,
        el('label', { class: 'rv-level-wrap', title: 'AI 难度' },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '难度'), levelSel),
        aiBtn, sideBtn, undoBtn,
        el('span', { class: 'grow' }),
        el('span', { class: 'row' }, blackCount, el('span', { class: 'dim' }, ':'), whiteCount)),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        infoL)));

    renderBoard();
    updateStatus();
  },
});
