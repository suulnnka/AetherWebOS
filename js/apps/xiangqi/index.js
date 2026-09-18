/* ============================================================
 * 应用:中国象棋(Xiangqi)
 * 10 行 × 9 列棋盘;玩家执红先行(可换边),AI 执黑。完整规则:马蹩腿、象塞眼、
 * 炮翻山、九宫限制、兵过河可横走、将帅对脸判非法;无棋可走(将死/困毙)判负。
 *
 * AI 引擎在独立子项目 vendor/AetherXiangqi(github.com/suulnnka/AetherXiangqi):
 * 规则、评估、搜索都在 src/engine.js(单文件,零依赖),搜索跑在 src/worker.js 里。
 * 主线程只 import 规则部分(判合法、记谱),搜索代码由 Vite 打进 worker chunk。
 *
 * 走法编码只有一套:from<<7 | to。UI 把**走法序列**发给 Worker,
 * Worker 自己从初始局面重演 —— 结构化克隆最省,也不存在两份规则实现。
 *
 * 顶栏/底栏沿用国际象棋应用的做法:顶栏一组带图标的对局级按钮,
 * 底栏**只有一条** —— 左边行棋状态、右边等宽字体的引擎搜索信息。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './xiangqi.css';
import { dialogs } from '../../core/dialogs.js';
import { icon } from '../../core/icons.js';
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
const sideName = (s) => (s === RED ? '红方' : '黑方');

/** 引擎评分(厘兵,行棋方视角)→ 给人看的字符串。±20000 以上是将杀分,只标 M */
const fmtScore = (s) => {
  if (Math.abs(s) >= 20000) return s > 0 ? '+M' : '-M';
  return (s >= 0 ? '+' : '') + (s / 100).toFixed(2);
};

/** 棋盘线(SVG):横线 10 条、竖线外侧贯通内侧断在河界、九宫斜线、炮兵位十字标。
 *  整幅线是 180° 旋转对称的,所以换边(翻盘)时只需把「楚河/漢界」对调。 */
function boardSvg(flip) {
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
  const chu = X(flip ? 6 : 2), han = X(flip ? 2 : 6);
  return `<svg class="xq-lines" viewBox="0 0 ${BW} ${BH}" aria-hidden="true">`
    + `<path class="xq-line" d="${d.join(' ')}"/>`
    + `<path class="xq-mark" d="${mk.join(' ')}"/>`
    + `<text class="xq-river" x="${chu}" y="${midY}">楚河</text>`
    + `<text class="xq-river" x="${han}" y="${midY}">漢界</text>`
    + `</svg>`;
}

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let bd = newBoard();
    let turn = RED;            // 红先
    let humanSide = RED;       // 玩家执子方(换边可改)
    let hist = [];             // { mv, cap, text } —— 走法序列,也给 Worker 重演用
    let sel = -1;              // 选中的格子
    let tgts = new Map();      // 选中子能去的格子 → 是否吃子
    let lastMove = null;
    let gameOver = false;
    let vsAI = true;
    let levelIdx = DEFAULT_LEVEL;
    let searching = false;

    const aiSide = () => humanSide ^ 1;
    const flipped = () => humanSide === BLACK;    // 玩家执黑就把整盘翻过来

    const statusL = el('span', {}, '红方行棋');
    const infoL = el('span', {
      class: 'mono', style: { fontSize: '11px' },
      title: '引擎搜索信息(评分是 AI 视角,单位兵;+M / -M 表示算到将杀)',
    }, '');
    const layerEl = el('div', { class: 'xq-layer' });
    const boardEl = el('div', { class: 'xq-board' }, layerEl);

    /* ---------- 渲染 ---------- */
    function render() {
      layerEl.innerHTML = boardSvg(flipped());    // 换边后河界文字要跟着对调
      tgts = new Map();
      if (sel >= 0) {
        for (const mv of genLegal(bd, turn)) {
          if (mFrom(mv) === sel) tgts.set(mTo(mv), bd[mTo(mv)] !== 0);
        }
      }
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
          const i = r * 9 + c, p = bd[i];
          const dr = flipped() ? 9 - r : r, dc = flipped() ? 8 - c : c;   // 显示坐标
          const cls = ['xq-pt'];
          if (i === sel) cls.push('sel');
          if (tgts.has(i)) cls.push(tgts.get(i) ? 'cap' : 'mv');
          if (lastMove && (mFrom(lastMove) === i || mTo(lastMove) === i)) cls.push('last');
          const btn = el('button', {
            class: cls.join(' '),
            style: { left: X(dc) + 'px', top: Y(dr) + 'px' },
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
    }

    function updateStatus() {
      if (gameOver) return;
      const inC = inCheck(bd, turn);
      statusL.textContent = sideName(turn) + '行棋' + (inC ? ' — 将军!⚠' : '');
      const last = hist.length ? ` · 上一手 ${hist[hist.length - 1].text}` : '';
      setTitle(`中国象棋 — ${sideName(turn)}行棋${inC ? '(将军)' : ''}${last}`);
    }

    /* ---------- 走子 ---------- */
    function onPoint(i) {
      if (gameOver) return;
      if (vsAI && turn !== humanSide) return;     // AI 回合/思考中不响应点击
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
      const inC = inCheck(bd, turn);
      if (!hasMove(bd, turn)) {                   // 将死或困毙,象棋里都算负
        endGame(turn ^ 1, inC);
        return;
      }
      if (inC) bus.notify('中国象棋', `${sideName(turn)}被将军`);
      if (!gameOver && vsAI && turn === aiSide()) setTimeout(thinkAI, 260);
      else updateStatus();
    }

    function endGame(winner, byMate) {
      gameOver = true;
      abortEngine();
      const who = sideName(winner) + (vsAI && winner === aiSide() ? '(AI)' : '');
      const title = byMate ? '将死' : '困毙';
      const line = `${title} — ${sideName(winner)}胜`;   // 状态行不标 (AI),只说哪方胜
      dialogs.info({ title, message: `${who}获胜!` });
      statusL.textContent = line;
      setTitle('中国象棋 — 终局');
      bus.notify('中国象棋', line);
    }

    /* ---------- AI:搜索跑在 Worker 里 ----------
     * 传走法序列而不是棋盘(结构化克隆最省,且两边共用同一份规则)。
     * Worker 里搜索是同步的,新消息只会排队 —— 需要立刻刹车(新对局 / 换难度 /
     * 关窗)时直接 terminate 再造一个。 */
    let worker = null, reqSeq = 0;

    function killWorker() {
      if (worker) { worker.terminate(); worker = null; }
      searching = false;
      /* 请求号自增:terminate() 拦不住「已经进了主线程消息队列」的那条结果,
       * 新对局/换档后它要是被当成当前结果应用,就会把旧局面的着法落到新局面上 */
      reqSeq++;
    }

    /** 作废在途请求(局面已变 / 窗口关闭),免得过期着法落到新对局上 */
    function abortEngine() { killWorker(); infoL.textContent = ''; }

    function ensureWorker() {
      if (worker) return worker;
      try {
        worker = new Worker(new URL('../../../vendor/AetherXiangqi/src/worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        console.error('[xiangqi] 无法创建 AI Worker:', err);
        worker = null; searching = false;
        statusL.textContent = 'AI 不可用(Worker 创建失败)';
        return null;
      }
      worker.onmessage = onEngineMsg;
      worker.onerror = (ev) => {
        console.warn('[xiangqi] AI Worker 异常:', ev.message || ev);
        killWorker();
        statusL.textContent = 'AI 出错,已跳过本步';
      };
      return worker;
    }

    function thinkAI() {
      if (gameOver || searching) return;
      const cfg = LEVELS[levelIdx];
      searching = true;
      sel = -1;
      render();
      statusL.textContent = `${sideName(aiSide())}思考中…`;
      setTitle(`中国象棋 — AI 思考中(${cfg.name})`);
      infoL.textContent = '';
      if (typeof Worker === 'undefined') {
        searching = false;
        statusL.textContent = '当前环境不支持 Web Worker,AI 不可用';
        return;
      }
      if (!ensureWorker()) return;
      worker.postMessage({
        id: ++reqSeq,
        moves: hist.map((h) => h.mv),
        nodes: cfg.nodes, ms: cfg.ms, depth: cfg.depth, jitter: cfg.jitter,
      });
    }

    function onEngineMsg(e) {
      const d = e.data;
      if (!d || d.id !== reqSeq) return;          // 过期结果(换难度/新对局)直接丢
      if (d.type === 'progress') { showInfo(d); return; }
      searching = false;
      if (d.error) { statusL.textContent = '引擎异常:' + d.error; return; }
      if (!d.move) { endGame(humanSide, true); return; }  // AI 无棋可走 = 玩家将死它
      const text = moveToText(bd, d.move);
      const cap = make(bd, d.move);
      hist.push({ mv: d.move, cap, text });
      lastMove = d.move; turn = humanSide;
      showInfo(d);
      afterMove();
    }

    /** 底栏右侧的引擎信息行(等宽字体,与国际象棋应用同一套写法) */
    function showInfo(d) {
      infoL.textContent = `${LEVELS[levelIdx].name} · 深度 ${d.depth} · `
        + `${Math.round(d.nodes / 1000)}k 节点 · ${d.ms}ms · ${fmtScore(d.score)}`;
    }

    /* ---------- 工具栏动作 ---------- */
    function resetGame() {
      abortEngine();
      bd = newBoard(); turn = RED; hist = []; sel = -1; lastMove = null;
      gameOver = false;
      render();
      if (vsAI && turn === aiSide()) thinkAI();   // 玩家执黑时 AI 执红先行
      else updateStatus();
    }

    /** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手(AI 应手 + 自己那手),
     *  人人撤一手;AI 想棋中悔棋先掐掉在途搜索;终局后悔棋可复活对局。 */
    function doUndo() {
      if (!hist.length) return;
      abortEngine();
      let n = 1;
      if (vsAI && turn === humanSide && hist.length >= 2) n = 2;
      while (n-- > 0 && hist.length) {
        const h = hist.pop();
        unmake(bd, h.mv, h.cap);
        turn ^= 1;
      }
      gameOver = false; sel = -1;
      lastMove = hist.length ? hist[hist.length - 1].mv : null;
      render();
      if (vsAI && turn === aiSide()) thinkAI();   // 撤完轮到 AI(玩家执黑的起点)就让它重想
      else updateStatus();
    }

    /** 换边:与 AI 互换执子方,棋盘随之翻转。中途换边作废在途搜索并立即接手。 */
    function switchSide() {
      abortEngine();
      humanSide ^= 1;
      sel = -1;
      render();
      if (!gameOver && vsAI && turn === aiSide()) thinkAI();
      else if (!gameOver) updateStatus();
    }

    /* ---------- 界面 ---------- */
    const newBtn = el('button', { class: 'btn primary', onClick: resetGame }, icon('refresh', 13), '新对局');
    /* 难度档:原生 <select>(比循环按钮少点几下、状态一眼可见)。
     * 换档时若 AI 正在想棋就掐掉重想 —— 否则要等旧档位的结果回来才生效,
     * 用户会以为下拉没反应。 */
    const levelSel = el('select', {
      class: 'select xq-level',
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
        sideBtn.disabled = !vsAI;                                 // 换边只对人机模式有意义
        if (!vsAI) { abortEngine(); updateStatus(); }             // 关掉 AI 要把在途搜索停掉
        else if (!gameOver && turn === aiSide()) thinkAI();       // 轮到 AI 就立刻接手
        else updateStatus();
      },
    }, '人机');
    const sideBtn = el('button', {
      class: 'btn', title: '换边:与 AI 互换执子方,棋盘随之翻转',
      onClick: switchSide,
    }, '换边');
    const undoBtn = el('button', {
      class: 'btn', title: '悔棋:人机模式连 AI 的应手一起撤,人人模式撤一手',
      onClick: doUndo,
    }, icon('reply', 13), '悔棋');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn,
        el('label', { class: 'xq-level-wrap', title: 'AI 难度' },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '难度'), levelSel),
        aiBtn, sideBtn, undoBtn),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        infoL)));

    /* 供探针/排障:确认窗口活着、引擎档位与对局进度 */
    window.__xiangqi = {
      level: () => LEVELS[levelIdx].id,
      setLevel: (i) => {
        if (i < 0 || i >= LEVELS.length) return;
        levelSel.value = String(i);
        levelSel.dispatchEvent(new Event('change', { bubbles: true }));
      },
      stats: () => ({
        level: LEVELS[levelIdx].id, vsAI, searching, plies: hist.length,
        turn, human: humanSide, gameOver,
      }),
      lastText: () => (hist.length ? hist[hist.length - 1].text : ''),
    };

    render();
    updateStatus();

    return {
      onClose() {
        killWorker();
        delete window.__xiangqi;
      },
    };
  },
});
