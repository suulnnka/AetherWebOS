/* ============================================================
 * 应用:中国象棋(Xiangqi)
 * 10 行 × 9 列棋盘;玩家执红先行(可换边),AI 执黑。完整规则:马蹩腿、象塞眼、
 * 炮翻山、九宫限制、兵过河可横走、将帅对脸判非法;无棋可走(将死/困毙)判负。
 *
 * AI 引擎在独立子项目 vendor/AetherXiangqi(github.com/suulnnka/AetherXiangqi)。
 * 本文件**一行引擎代码都不 import**:难度表、棋盘事实(合法着法 / 将军态 /
 * 将死困毙 / 中文记谱)全部经 Worker 消息问引擎(见该仓库 src/worker.js 的
 * levels / state / think 契约)—— 规则只有引擎一份,UI 只是渲染层。
 *
 * UI 持有的唯一对局状态是**走法序列**(from<<7|to):走子 / 悔棋 /
 * 新对局都只是改序列再向 Worker 要一次 state 回包,拿回棋盘与合法着法重画。
 *
 * 顶栏/底栏沿用国际象棋应用的做法:顶栏一组带图标的对局级按钮,
 * 底栏**只有一条** —— 左边行棋状态、右边等宽字体的引擎搜索信息。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './xiangqi.css';
import { icon } from '../../core/icons.js';
import { reportBoardMin } from '../../core/wm.js';

/* 协议常量与走法位操作(worker 契约的一部分,不是引擎导出) */
const RED = 0, BLACK = 1;
const K = 1;                                  // 帅/将的型值(将军高亮只看它)
const mFrom = (m) => m >> 7;
const mTo = (m) => m & 127;

/* 格距(px)。与 xiangqi.css 里的 --cs 必须一致 */
const CS = 54;
const X = (c) => CS / 2 + c * CS;
const Y = (r) => CS / 2 + r * CS;
const BW = 9 * CS, BH = 10 * CS;

/* 棋子字形(显示用;引擎棋子编码 p = 颜色<<3 | 型) */
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
  mount(ctx) {
    /* dialogs = ctx.dialogs:应用绑定弹框,默认二级(应用模态,只锁本应用) */
    const { root, setTitle, bus, dialogs } = ctx;
    let board = new Array(90).fill(0);   // 引擎棋盘(state 回包驱动)
    let legalAll = [];                   // 行棋方全部合法着法(state 回包,from<<7|to)
    let checked = [false, false];        // 双方被将军态(state 回包)
    let turn = RED;                      // 红先
    let humanSide = RED;                 // 玩家执子方(换边可改)
    let hist = [];                       // 走法序列 —— UI 持有的唯一对局状态
    let sel = -1;                        // 选中的格子
    let tgts = new Map();                // 选中子能去的格子 → 是否吃子
    let lastMove = null;
    let gameOver = false;
    let vsAI = true;
    let searching = false;
    let levels = [];                     // 难度表由**引擎自报**({type:'levels'})
    let levelIdx = 0;

    const aiSide = () => humanSide ^ 1;
    const lvName = () => levels[levelIdx]?.name ?? '—';
    const flipped = () => humanSide === BLACK;    // 玩家执黑就把整盘翻过来

    const statusL = el('span', {}, '红方行棋');
    const infoL = el('span', {
      class: 'mono', style: { fontSize: '11px' },
      title: '引擎搜索信息(评分是 AI 视角,单位兵;+M / -M 表示算到将杀)',
    }, '');
    const layerEl = el('div', { class: 'xq-layer' });
    const boardEl = el('div', { class: 'xq-board' }, layerEl);

    /* ---------- 渲染(全部基于最近一次 state 回包的缓存) ---------- */
    function render() {
      layerEl.innerHTML = boardSvg(flipped());    // 换边后河界文字要跟着对调
      tgts = new Map();
      if (sel >= 0) {
        for (const mv of legalAll) {
          if (mFrom(mv) === sel) tgts.set(mTo(mv), board[mTo(mv)] !== 0);
        }
      }
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
          const i = r * 9 + c, p = board[i];
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
            const chk = checked[side] && t === K;
            btn.append(el('div', {
              class: `xq-piece ${side ? 'black' : 'red'}${chk && t === 1 ? ' chk' : ''}`,
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
      statusL.textContent = sideName(turn) + '行棋' + (checked[turn] ? ' — 将军!⚠' : '');
      const last = hist.length ? ` · 上一手 ${hist[hist.length - 1].text}` : '';
      setTitle(`中国象棋 — ${sideName(turn)}行棋${checked[turn] ? '(将军)' : ''}${last}`);
    }

    /* ---------- 走子:目标格以缓存 state 的合法着法为准,走子 = 改序列 + 问引擎 ---------- */
    function onPoint(i) {
      if (gameOver || statePending) return;
      if (vsAI && turn !== humanSide) return;     // AI 回合/思考中不响应点击
      if (sel >= 0 && tgts.has(i)) { doMove((sel << 7) | i); return; }
      const p = board[i];
      sel = (p && (p >> 3) === turn) ? i : -1;
      render();
    }

    function doMove(mv) {
      hist.push({ mv, text: '' });                // 记谱由 state 回包回填(lastText)
      sel = -1; lastMove = mv; turn ^= 1;
      fetchState();
    }

    /** state 回包落地:重画 + 记谱回填 + 按回包事实终局 / 调度 AI */
    function applyState(d) {
      board = d.board;
      legalAll = d.legal;
      checked = d.checked;
      turn = d.stm;
      if (hist.length && d.lastText) hist[hist.length - 1].text = d.lastText;
      if (d.over) { endGame(d.winner, checked[d.winner ^ 1]); return; }
      render();
      if (checked[turn]) bus.notify('中国象棋', `${sideName(turn)}被将军`);
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

    /* ---------- Worker:难度表 / 局面事实 / 搜索都经它 ----------
     * Worker 里搜索是同步的,新消息只会排队 —— 需要立刻刹车(新对局 / 换难度 /
     * 关窗)时直接 terminate 再造一个。 */
    let worker = null, reqSeq = 0, stateSeq = 0, statePending = null;

    function killWorker() {
      if (worker) { worker.terminate(); worker = null; }
      searching = false;
      if (statePending) { const p = statePending; statePending = null; p(null); }
      /* 请求号自增:terminate() 拦不住「已经进了主线程消息队列」的那条结果,
       * 新对局/换档后它要是被当成当前结果应用,就会把旧局面的着法落到新对局上 */
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

    function onEngineMsg(e) {
      const d = e.data;
      if (!d) return;
      if (d.type === 'levels') { applyLevels(d); return; }
      if (d.type === 'state') {
        if (!statePending || d.id !== stateSeq) return;   // 过期局面直接丢
        const p = statePending; statePending = null;
        p(d.error ? null : d);
        return;
      }
      /* ---- 以下是搜索回包(progress / 最终结果)---- */
      if (d.id !== reqSeq) return;               // 过期结果(换难度/新对局)直接丢
      if (d.type === 'progress') { showInfo(d); return; }
      searching = false;
      if (d.error) { statusL.textContent = '引擎异常:' + d.error; return; }
      if (!d.move) { endGame(humanSide, true); return; }  // AI 无棋可走 = 玩家将死它
      hist.push({ mv: d.move, text: d.text || '' });
      lastMove = d.move; turn ^= 1;
      showInfo(d);
      fetchState();
    }

    /** 向 Worker 要当前局面的规则事实(state 契约) */
    function fetchState() {
      if (!ensureWorker()) return;
      const id = ++stateSeq;
      statePending = (d) => {
        if (!d) return;                           // 被作废(terminate / 新对局)
        applyState(d);
      };
      worker.postMessage({ type: 'state', id, moves: hist.map((h) => h.mv) });
    }

    /** 开局问一次引擎的难度表,拿到才填下拉 —— UI 与引擎的档位认知就此对齐 */
    function applyLevels(d) {
      const table = Array.isArray(d.levels)
        ? d.levels.filter((lv) => lv && typeof lv.name === 'string' && lv.name) : [];
      if (!table.length) {
        levelSel.title = 'AI 难度不可用(引擎未上报)';
        return;
      }
      levels = table;
      const def = Number.isInteger(d.default) && d.default >= 0 && d.default < table.length ? d.default : 0;
      levelIdx = def;
      levelSel.append(...table.map((lv, i) => el('option', { value: String(i) }, lv.name)));
      levelSel.value = String(def);
      levelSel.disabled = false;
      levelSel.title = 'AI 难度:' + table.map((lv) => lv.name).join(' / ');
    }

    function thinkAI() {
      if (gameOver || searching) return;
      searching = true;
      sel = -1;
      render();
      statusL.textContent = `${sideName(aiSide())}思考中…`;
      setTitle(`中国象棋 — AI 思考中(${lvName()})`);
      infoL.textContent = '';
      if (typeof Worker === 'undefined') {
        searching = false;
        statusL.textContent = '当前环境不支持 Web Worker,AI 不可用';
        return;
      }
      if (!ensureWorker()) return;
      worker.postMessage({ id: ++reqSeq, moves: hist.map((h) => h.mv), level: levelIdx });
    }

    /** 底栏右侧的引擎信息行(等宽字体,与国际象棋应用同一套写法) */
    function showInfo(d) {
      infoL.textContent = `${lvName()} · 深度 ${d.depth} · `
        + `${Math.round(d.nodes / 1000)}k 节点 · ${d.ms}ms · ${fmtScore(d.score)}`;
    }

    /* ---------- 工具栏动作 ---------- */
    function resetGame() {
      abortEngine();
      turn = RED; hist = []; sel = -1; lastMove = null;
      gameOver = false;
      board = new Array(90).fill(0); legalAll = []; checked = [false, false];
      render();
      fetchState();                                // 初始局面事实照问引擎
      if (vsAI && turn === aiSide()) thinkAI();    // 玩家执黑时 AI 执红先行
      else updateStatus();
    }

    /** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手(AI 应手 + 自己那手),
     *  人人撤一手;AI 想棋中悔棋先掐掉在途搜索;终局后悔棋可复活对局。
     *  序列改完问一次 state,棋盘 / 将军 / 终局全部以回包为准。 */
    function doUndo() {
      if (!hist.length) return;
      abortEngine();
      let n = 1;
      if (vsAI && turn === humanSide && hist.length >= 2) n = 2;
      while (n-- > 0 && hist.length) hist.pop();
      turn = hist.length % 2 === 0 ? RED : BLACK;
      gameOver = false; sel = -1;
      lastMove = hist.length ? hist[hist.length - 1].mv : null;
      fetchState();
      if (vsAI && turn === aiSide()) thinkAI();    // 撤完轮到 AI(玩家执黑的起点)就让它重想
      else { render(); updateStatus(); }
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
    /* 难度档:原生 <select>。选项**等引擎报表之后再填**;空表时禁用,不给假下拉。
     * 换档时若 AI 正在想棋就掐掉重想 —— 否则要等旧档位的结果回来才生效。 */
    const levelSel = el('select', {
      class: 'select xq-level',
      title: 'AI 难度(等引擎上报)',
      'aria-label': 'AI 难度',
      disabled: true,
      onChange: (e) => {
        levelIdx = Number(e.currentTarget.value) || 0;
        if (searching) { abortEngine(); thinkAI(); }
      },
    });
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

    const appEl = el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn,
        el('label', { class: 'xq-level-wrap', title: 'AI 难度' },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '难度'), levelSel),
        aiBtn, sideBtn, undoBtn),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        infoL));
    root.append(appEl);
    /* 棋盘是固定像素的(CS 54 × 9/10 路 + 边距),窗口再小它也不缩 —— 按实测棋盘
     * 报最小窗口尺寸给 WM,改 CS 不用回头改清单;520 是工具栏挤不下时的兜底宽。 */
    reportBoardMin(ctx, appEl, boardEl, 520);

    /* 供探针/排障:确认窗口活着、引擎档位与对局进度 */
    window.__xiangqi = {
      level: () => levels[levelIdx]?.id,
      setLevel: (i) => {
        if (i < 0 || i >= levels.length) return;
        levelSel.value = String(i);
        levelSel.dispatchEvent(new Event('change', { bubbles: true }));
      },
      stats: () => ({
        level: levels[levelIdx]?.id, vsAI, searching, plies: hist.length,
        turn, human: humanSide, gameOver,
      }),
      lastText: () => (hist.length ? hist[hist.length - 1].text : ''),
    };

    render();
    updateStatus();
    fetchLevels();
    fetchState();                                  // 初始局面的合法着法等事实也要问引擎

    function fetchLevels() {
      if (!ensureWorker()) return;
      worker.postMessage({ type: 'levels' });      // 回包经 onEngineMsg → applyLevels
    }

    return {
      onClose() {
        killWorker();
        delete window.__xiangqi;
      },
    };
  },
});
