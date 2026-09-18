/* ============================================================
 * 应用:中国象棋(Xiangqi)
 * 10 行 × 9 列棋盘;玩家执红先行,AI 执黑。完整规则:马蹩腿、象塞眼、
 * 炮翻山、九宫限制、兵过河可横走、将帅对脸判非法;无棋可走(将死/困毙)判负。
 *
 * AI 引擎在独立子项目 vendor/AetherXiangqi(github.com/suulnnka/AetherXiangqi):
 * 规则、评估、搜索都在 src/engine.js(单文件,零依赖),搜索跑在 src/worker.js 里。
 * 主线程只 import 规则部分(判合法、记谱),搜索代码由 Vite 打进 worker chunk。
 *
 * 走法编码只有一套:from<<7 | to。UI 把**走法序列**发给 Worker,
 * Worker 自己从初始局面重演 —— 结构化克隆最省,也不存在两份规则实现。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './xiangqi.css';
import { dialogs } from '../../core/dialogs.js';
import {
  RED, BLACK, K, LEVELS, DEFAULT_LEVEL,
  newBoard, genLegal, hasMove, make, unmake, mkMove, mFrom, mTo, inCheck, moveToText,
} from '../../../vendor/AetherXiangqi/src/engine.js';

/* 格距(px)。与 xiangqi.css 里的 --cs 必须一致 */
const CS = 54;
const X = (c) => CS / 2 + c * CS;
const Y = (r) => CS / 2 + r * CS;
const BW = 9 * CS, BH = 10 * CS;

const GLYPH_R = ['', '帅', '仕', '相', '马', '车', '炮', '兵'];
const GLYPH_B = ['', '将', '士', '象', '马', '车', '炮', '卒'];

const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));
/** 搜索分是「AI(黑)视角」:正 = 黑优 */
const fmtScore = (s) => (s >= 0 ? `黑 +${s}` : `红 +${-s}`);

/** 棋盘线(SVG):横线 10 条、竖线外侧贯通内侧断在河界、九宫斜线、炮兵位十字标 */
function boardSvg() {
  const d = [];
  for (let r = 0; r < 10; r++) d.push(`M${X(0)} ${Y(r)}H${X(8)}`);
  for (let c = 0; c < 9; c++) {
    if (c === 0 || c === 8) d.push(`M${X(c)} ${Y(0)}V${Y(9)}`);
    else d.push(`M${X(c)} ${Y(0)}V${Y(4)}`, `M${X(c)} ${Y(5)}V${Y(9)}`);
  }
  d.push(`M${X(3)} ${Y(0)}L${X(5)} ${Y(2)}`, `M${X(5)} ${Y(0)}L${X(3)} ${Y(2)}`);
  d.push(`M${X(3)} ${Y(7)}L${X(5)} ${Y(9)}`, `M${X(5)} ${Y(7)}L${X(3)} ${Y(9)}`);

  /* 炮位(2 个/方)与兵位(5 个/方)的十字标,四个象限各画一个小 L */
  const marks = [[2, 1], [2, 7], [7, 1], [7, 7],
                 [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
                 [6, 0], [6, 2], [6, 4], [6, 6], [6, 8]];
  const mk = [];
  for (const [r, c] of marks) {
    const x = X(c), y = Y(r), o = 4, L = 8;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (c === 0 && sx < 0) continue;            // 最左列没有左侧的标
      if (c === 8 && sx > 0) continue;
      mk.push(`M${x + sx * o} ${y + sy * (o + L)}V${y + sy * o}H${x + sx * (o + L)}`);
    }
  }
  const midY = (Y(4) + Y(5)) / 2 + 9;
  return `<svg class="xq-lines" viewBox="0 0 ${BW} ${BH}" aria-hidden="true">`
    + `<path class="xq-line" d="${d.join(' ')}"/>`
    + `<path class="xq-mark" d="${mk.join(' ')}"/>`
    + `<text class="xq-river" x="${X(2)}" y="${midY}">楚河</text>`
    + `<text class="xq-river" x="${X(6)}" y="${midY}">漢界</text>`
    + `</svg>`;
}

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let bd = newBoard();
    let turn = RED;            // 红先;玩家执红
    let hist = [];             // { mv, cap, text } —— 走法序列,也给 Worker 重演用
    let sel = -1;              // 选中的格子
    let tgts = new Map();      // 选中子能去的格子 → 是否吃子
    let lastMove = null;
    let gameOver = false;
    let vsAI = true;
    let levelIdx = DEFAULT_LEVEL;
    let searching = false;

    const statusL = el('span', {}, '');
    const layerEl = el('div', { class: 'xq-layer', html: boardSvg() });
    const boardEl = el('div', { class: 'xq-board' }, layerEl);
    const searchLine = el('div', { class: 'xq-search' }, levelHint());

    function levelHint() {
      const lv = LEVELS[levelIdx];
      return `AI 待命(难度:${lv.name}) · ${lv.desc}`;
    }

    /* ---------- 渲染 ---------- */
    function render() {
      layerEl.querySelectorAll('.xq-pt').forEach((n) => n.remove());
      tgts = new Map();
      if (sel >= 0) {
        for (const mv of genLegal(bd, turn)) {
          if (mFrom(mv) === sel) tgts.set(mTo(mv), bd[mTo(mv)] !== 0);
        }
      }
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
          const i = r * 9 + c, p = bd[i];
          const cls = ['xq-pt'];
          if (i === sel) cls.push('sel');
          if (tgts.has(i)) cls.push(tgts.get(i) ? 'cap' : 'mv');
          if (lastMove && (mFrom(lastMove) === i || mTo(lastMove) === i)) cls.push('last');
          const btn = el('button', {
            class: cls.join(' '),
            style: { left: X(c) + 'px', top: Y(r) + 'px' },
            dataset: { i: String(i) },
            onClick: () => onPoint(i),
          });
          if (p) {
            const side = p >> 3, t = p & 7;
            const chk = t === K && inCheck(bd, side);
            btn.append(el('div', {
              class: `xq-piece ${side ? 'black' : 'red'}${chk ? ' chk' : ''}`,
            }, (side ? GLYPH_B : GLYPH_R)[t]));
          } else if (tgts.has(i)) {
            btn.append(el('div', { class: 'xq-dot' }));
          }
          layerEl.append(btn);
        }
      }
      updateStatus();
    }

    function updateStatus(msg) {
      if (msg) statusL.textContent = msg;
      else if (gameOver) statusL.textContent = '终局';
      else {
        const chk = inCheck(bd, turn);
        const who = turn === RED ? (vsAI ? '红方(你)' : '红方') : (vsAI ? '黑方(AI)' : '黑方');
        statusL.textContent =
          `${Math.floor(hist.length / 2) + 1} 回合 · ${who}行棋` +
          (chk ? ' · 将军!' : '') +
          (hist.length ? ` · 上一手 ${hist[hist.length - 1].text}` : '');
      }
      const whose = turn === RED ? (vsAI ? '你的回合' : '红方回合') : (vsAI ? 'AI 回合' : '黑方回合');
      setTitle(`中国象棋 ${Math.floor(hist.length / 2) + 1} 回合 — ${gameOver ? '终局' : whose}`);
    }

    /* ---------- 走子 ---------- */
    function onPoint(i) {
      if (gameOver) return;
      if (vsAI && turn !== RED) return;           // AI 回合/思考中不响应点击
      if (sel >= 0 && tgts.has(i)) { doMove(mkMove(sel, i)); return; }
      const p = bd[i];
      sel = (p && (p >> 3) === turn) ? i : -1;
      render();
    }

    function doMove(mv) {
      const text = moveToText(bd, mv);            // 记谱要在走子之前读 from
      const cap = make(bd, mv);
      hist.push({ mv, cap, text });
      sel = -1; lastMove = mv; turn ^= 1;
      afterMove();
    }

    /** 走子后的公共收尾:判将军、判终局、轮到 AI 就调度 */
    function afterMove() {
      render();
      const chk = inCheck(bd, turn);
      if (!hasMove(bd, turn)) {                   // 将死或困毙,象棋里都算负
        endGame(turn ^ 1, chk);
        return;
      }
      if (chk) bus.notify('中国象棋', `${turn === RED ? '红方' : '黑方'}被将军`);
      if (vsAI && turn === BLACK && !gameOver) setTimeout(thinkAI, 260);
    }

    function endGame(winner, byMate) {
      gameOver = true;
      const who = winner === RED ? '红方' : '黑方';
      const title = winner === RED ? '🎉 你赢了!' : 'AI 获胜';
      const msg = byMate ? `${who}将死对方` : `${who}胜(对方困毙,无棋可走)`;
      dialogs.info({ title, message: msg });
      updateStatus(`${title}(${msg})`);
      bus.notify('中国象棋', `${title} ${msg}`);
    }

    /* ---------- AI:搜索跑在 Worker 里 ----------
     * 传走法序列而不是棋盘(结构化克隆最省,且两边共用同一份规则)。
     * Worker 里搜索是同步的,新消息只会排队 —— 换难度/新对局时直接
     * terminate 再造一个(见 abortEngine)。 */
    let worker = null, reqSeq = 0;

    function killWorker() {
      if (worker) { worker.terminate(); worker = null; }
      searching = false;
      /* 请求号自增:terminate() 拦不住「已经进了主线程消息队列」的那条结果,
       * 新对局/换档后它要是被当成当前结果应用,就会把旧局面的着法落到新局面上 */
      reqSeq++;
    }
    function abortEngine() { killWorker(); }

    function ensureWorker() {
      if (worker) return worker;
      try {
        worker = new Worker(new URL('../../../vendor/AetherXiangqi/src/worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        console.error('[xiangqi] 无法创建 AI Worker:', err);
        worker = null; searching = false;
        searchLine.textContent = 'AI 不可用(Worker 创建失败)';
        return null;
      }
      worker.onmessage = onEngineMsg;
      worker.onerror = (ev) => {
        console.warn('[xiangqi] AI Worker 异常:', ev.message || ev);
        killWorker();
      };
      return worker;
    }

    function thinkAI() {
      if (gameOver || !vsAI || turn !== BLACK) return;
      if (typeof Worker === 'undefined') {
        searchLine.textContent = '当前环境不支持 Web Worker,AI 不可用';
        return;
      }
      if (searching) killWorker();                // 上一轮还没回来:直接重启
      if (!ensureWorker()) return;
      searching = true;
      const lv = LEVELS[levelIdx];
      searchLine.textContent = `AI 思考中…(${lv.name} · ${lv.desc})`;
      worker.postMessage({
        id: ++reqSeq,
        moves: hist.map((h) => h.mv),
        nodes: lv.nodes, ms: lv.ms, depth: lv.depth, jitter: lv.jitter,
      });
    }

    function showSearch(d, doneText) {
      const mvText = doneText ?? (d.move ? moveToText(bd, d.move) : '—');
      searchLine.textContent =
        `${doneText ? '' : '搜索中… '}深度 ${d.depth} · 最佳 ${mvText} · 评估 ${fmtScore(d.score)}` +
        ` · 节点 ${fmtN(d.nodes)} · ${d.ms}ms`;
    }

    function onEngineMsg(e) {
      const d = e.data;
      if (!d || d.id !== reqSeq) return;          // 过期结果(换难度/新对局)直接丢
      if (d.type === 'progress') { showSearch(d); return; }
      searching = false;
      if (d.error) { searchLine.textContent = '引擎异常:' + d.error; return; }
      if (!d.move) { endGame(RED, true); return; } // AI 无棋可走 = 红方将死它
      const text = moveToText(bd, d.move);
      showSearch(d, text);
      const cap = make(bd, d.move);
      hist.push({ mv: d.move, cap, text });
      lastMove = d.move; turn = RED;
      afterMove();
    }

    /* ---------- 工具栏 ---------- */
    function newGame() {
      killWorker();
      bd = newBoard(); turn = RED; hist = []; sel = -1; lastMove = null;
      gameOver = false;
      searchLine.textContent = levelHint();
      render();
    }

    function undo() {
      if (!hist.length) return;
      killWorker();
      /* 人机模式下回到「自己还能走」的状态:红方回合时撤 2 步(AI + 自己),
       * AI 还在思考时只撤 1 步(那一步就是自己刚走的) */
      const n = (vsAI && turn === RED && hist.length >= 2) ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const h = hist.pop();
        unmake(bd, h.mv, h.cap);
        turn ^= 1;
      }
      gameOver = false; sel = -1;
      lastMove = hist.length ? hist[hist.length - 1].mv : null;
      searchLine.textContent = levelHint();
      render();
    }

    const newBtn = el('button', { class: 'btn primary', onClick: newGame }, '新对局');
    const undoBtn = el('button', { class: 'btn', onClick: undo }, '悔棋');
    const aiBtn = el('button', {
      class: 'btn',
      onClick: (e) => {
        killWorker();
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机:开' : '双人';
        searchLine.textContent = vsAI ? levelHint() : '双人模式 · 无 AI 搜索';
        if (vsAI && turn === BLACK && !gameOver) setTimeout(thinkAI, 200);
        updateStatus();
      },
    }, '人机:开');
    const levelSel = el('select', {
      class: 'select xq-level',
      onChange: (e) => {
        levelIdx = Number(e.currentTarget.value);
        killWorker();                              // 旧档位的搜索结果不要了
        searchLine.textContent = levelHint();
        if (vsAI && turn === BLACK && !gameOver) setTimeout(thinkAI, 120);
      },
    }, ...LEVELS.map((lv, i) => el('option', { value: String(i) }, lv.name)));
    /* 下拉初值必须跟 levelIdx 对齐:否则界面显示「初级」而引擎实际在「高级」档,
     * 用户以为换过档了 —— 这种「显示与状态脱节」比功能缺失更难被发现 */
    levelSel.value = String(levelIdx);

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn, undoBtn, aiBtn, levelSel,
        el('span', { class: 'grow' }),
        el('span', { class: 'dim' }, '你执红先行')),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      searchLine,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '点自己的子看可走位置'))));

    /* 供探针/排障:确认窗口活着、引擎档位与对局进度 */
    window.__xiangqi = {
      level: () => LEVELS[levelIdx].id,
      setLevel: (i) => {
        if (i < 0 || i >= LEVELS.length) return;
        levelSel.value = String(i);
        levelSel.dispatchEvent(new Event('change', { bubbles: true }));
      },
      stats: () => ({ level: LEVELS[levelIdx].id, vsAI, searching, plies: hist.length, turn, gameOver }),
      lastText: () => (hist.length ? hist[hist.length - 1].text : ''),
    };

    render();

    return {
      onClose() {
        killWorker();
        delete window.__xiangqi;
      },
    };
  },
});
