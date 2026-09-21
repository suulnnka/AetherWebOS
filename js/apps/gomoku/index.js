/* ============================================================
 * 应用:五子棋(Gomoku / Renju)15×15
 * 玩家执黑先行(可换边),AI 执白。双规则:
 *   无禁(自由):任一方连成 ≥5 子即胜(长连也算);
 *   有禁(连珠):黑方恰好五连才胜,长连/双四/双活三为禁手 ——
 *     禁手点在盘上标 × 且不可落子(黑方无合法点判负);白方不受限。
 *
 * AI 引擎在独立子项目 vendor/AetherRenju(github.com/suulnnka/AetherRenju)。
 * 本文件**一行引擎代码都不 import**:难度表、棋盘事实(禁手点 / 胜负连线 /
 * 禁手封盘)全部经 Worker 消息问引擎(见该仓库 src/worker.js 的
 * levels / state / think 契约)—— 规则只有引擎一份,UI 只是渲染层。
 *
 * UI 持有的唯一对局状态是**落点序列**(交叉点 0..224):落子 / 悔棋 /
 * 新对局都只是改序列再向 Worker 要一次 state 回包,拿回棋盘与禁手重画。
 *
 * 顶栏/底栏沿用象棋/围棋应用的做法:顶栏一组对局级按钮,
 * 底栏**只有一条** —— 左边行棋状态、右边等宽字体的引擎搜索信息。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './gomoku.css';
import { icon } from '../../core/icons.js';
import { reportBoardMin } from '../../core/wm.js';

/* 协议常量(worker 契约的一部分,不是引擎导出):黑先白后,黑白交替 */
const BLACK = 0, WHITE = 1;
const FREE = 0, RENJU = 1;                 // 规则模式:无禁 / 有禁(连珠)

/* 格距(px)。与 gomoku.css 里的 --cs / --pad 必须一致 */
const CS = 34, PAD = 22;
const T = PAD * 2 + CS * 14;
const X = (c) => PAD + c * CS;
const Y = (r) => PAD + r * CS;
const COLS = 'ABCDEFGHIJKLMNO';
const sideName = (s) => (s === BLACK ? '黑方' : '白方');
const coordText = (i) => COLS[i % 15] + (15 - ((i / 15) | 0));

/** 引擎评分(窗分,行棋方视角)→ 给人看的字符串。±20000 以上是杀棋分,只标 M */
const fmtScore = (s) => {
  if (Math.abs(s) >= 20000) return s > 0 ? '+M' : '-M';
  return (s >= 0 ? '+' : '') + s;
};

/** 棋盘线(SVG):15×15 线 + 天元与四星 + 边缘坐标(下 A~O、左 15~1) */
function boardSvg() {
  const d = [];
  for (let i = 0; i < 15; i++) {
    d.push(`M${X(0)} ${Y(i)}H${X(14)}`);
    d.push(`M${X(i)} ${Y(0)}V${X(14)}`);
  }
  const stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]
    .map(([r, c]) => `<circle class="gk-star" cx="${X(c)}" cy="${Y(r)}" r="3"/>`)
    .join('');
  const coords = [];
  for (let c = 0; c < 15; c++) {
    coords.push(`<text class="gk-coord" x="${X(c)}" y="${T - PAD / 2}">${COLS[c]}</text>`);
    if (c < 15) coords.push(`<text class="gk-coord" x="${PAD / 2}" y="${Y(c)}">${15 - c}</text>`);
  }
  return `<svg class="gk-lines" viewBox="0 0 ${T} ${T}" aria-hidden="true">`
    + `<path class="gk-line" d="${d.join(' ')}"/>${stars}${coords.join('')}</svg>`;
}

register({
  ...manifest,
  mount(ctx) {
    /* dialogs = ctx.dialogs:应用绑定弹框,默认二级(应用模态,只锁本应用) */
    const { root, setTitle, bus, dialogs } = ctx;
    let board = new Array(225).fill(0);   // 由 Worker 的 state 回包驱动(0 空 / 1 黑 / 2 白)
    let bans = new Set();                 // 当前局面的黑方禁手点(state 回包)
    let turn = BLACK;                     // 黑先
    let humanSide = BLACK;                // 玩家执子方(换边可改);棋盘对称,不翻转
    let mode = RENJU;                     // FREE 无禁 / RENJU 有禁
    let hist = [];                        // 落点序列 —— UI 持有的唯一对局状态
    let lastMove = null;
    let winLine = null;                   // 胜利连线(高亮)
    let gameOver = false;
    let vsAI = true;
    let searching = false;
    /* 难度表由**引擎自报**({type:'levels'}):levels 存表,levelIdx 是当前下标,
     * 初值取引擎给的 default。「哪一档算默认体验」是引擎的判断,UI 不猜。 */
    let levels = [];
    let levelIdx = 0;

    const aiSide = () => humanSide ^ 1;
    const lvName = () => levels[levelIdx]?.name ?? '—';

    const statusL = el('span', {}, '黑方行棋');
    const infoL = el('span', {
      class: 'mono', style: { fontSize: '11px' },
      title: '引擎搜索信息(评分是 AI 视角,单位窗分;+M / -M 表示算到杀棋)',
    }, '');
    const layerEl = el('div', { class: 'gk-layer' });
    const boardEl = el('div', { class: 'gk-board' }, layerEl);

    /* ---------- 渲染(全部基于最近一次 state 回包的缓存) ---------- */
    function render() {
      layerEl.innerHTML = boardSvg();
      /* 虚影与可点光标只在「轮到玩家」时出现;禁手点标 × 且永远不可落 */
      const humanTurn = !gameOver && (!vsAI || turn === humanSide);
      boardEl.classList.toggle('turn-b', humanTurn && turn === BLACK);
      boardEl.classList.toggle('turn-w', humanTurn && turn === WHITE);
      for (let i = 0; i < 225; i++) {
        const btn = el('button', {
          class: 'gk-pt'
            + (!gameOver && !board[i] && !(bans.has(i)) ? ' can' : '')
            + (bans.has(i) ? ' ban' : '')
            + (winLine && winLine.includes(i) ? ' gk-win' : ''),
          style: { left: X(i % 15) + 'px', top: Y((i / 15) | 0) + 'px' },
          dataset: { i: String(i) },
          onClick: () => onPoint(i),
        });
        if (board[i]) {
          const st = el('div', {
            class: `gk-stone ${board[i] === 1 ? 'black' : 'white'}${i === lastMove ? ' last' : ''}`,
          });
          if (i === lastMove) st.classList.add('drop');
          btn.append(st);
        } else if (humanTurn) {
          btn.append(el('div', { class: 'gk-ghost' }));
        }
        if (bans.has(i) && !board[i]) btn.append(el('div', { class: 'gk-ban' }));
        layerEl.append(btn);
      }
    }

    function updateStatus() {
      if (gameOver) return;
      const banNote = mode === RENJU && turn === BLACK && bans.size
        ? ' · ×为禁手' : '';
      statusL.textContent = `${sideName(turn)}行棋 · 第 ${hist.length + 1} 手${banNote}`;
      const last = hist.length ? ` · 上一手 ${coordText(hist[hist.length - 1])}` : '';
      setTitle(`五子棋 — ${sideName(turn)}行棋${last}`);
    }

    /* ---------- 落子:合法性以缓存 state 为准,走子 = 改序列 + 再问一次引擎 ---------- */
    function onPoint(i) {
      if (gameOver || board[i] || statePending) return;
      if (vsAI && turn !== humanSide) return;     // AI 回合/思考中不响应点击
      if (mode === RENJU && turn === BLACK && bans.has(i)) {
        bus.notify('五子棋', `落点 ${coordText(i)} 是黑方禁手(三三 / 四四 / 长连)`);
        return;
      }
      doMove(i);
    }

    function doMove(cell) {
      hist.push(cell);
      lastMove = cell;
      turn ^= 1;
      fetchState();
    }

    /** state 回包落地:重画 + 按回包事实终局 / 调度 AI */
    function applyState(d) {
      board = d.board;
      bans = new Set(d.forbidden);
      turn = d.stm;
      if (d.over) {
        if (d.reason === 'full') endDraw();
        else if (d.reason === 'no-legal') endGame(d.winner, null, 'no-legal');
        else endGame(d.winner, d.cells);
        return;
      }
      render();
      if (!gameOver && vsAI && turn === aiSide()) setTimeout(thinkAI, 260);
      else updateStatus();
    }

    function endGame(winner, line, whyOverride) {
      gameOver = true;
      winLine = line;
      abortEngine();
      render();
      const why = whyOverride === 'no-legal' ? '禁手封盘' : (line && line.length > 5 ? '长连' : '五连');
      const who = sideName(winner) + (vsAI && winner === aiSide() ? '(AI)' : '');
      const line2 = `${why} — ${sideName(winner)}胜`;   // 状态行不标 (AI),只说哪方胜
      const detail = whyOverride === 'no-legal'
        ? `${who}获胜!(对方无合法落点)`
        : `${who} ${why}获胜!(${line.length} 子连线)`;
      dialogs.info({ title: '终局', message: detail });
      statusL.textContent = line2;
      setTitle('五子棋 — 终局');
      bus.notify('五子棋', line2);
    }

    function endDraw() {
      gameOver = true;
      abortEngine();
      statusL.textContent = '满盘 — 和棋';
      setTitle('五子棋 — 终局');
      dialogs.info({ title: '终局', message: '棋盘已满,和棋' });
      bus.notify('五子棋', '五子棋:满盘和棋');
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
        worker = new Worker(new URL('../../../vendor/AetherRenju/src/worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        console.error('[gomoku] 无法创建 AI Worker:', err);
        worker = null; searching = false;
        statusL.textContent = 'AI 不可用(Worker 创建失败)';
        return null;
      }
      worker.onmessage = onEngineMsg;
      worker.onerror = (ev) => {
        console.warn('[gomoku] AI Worker 异常:', ev.message || ev);
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
      if (d.id !== reqSeq) return;                // 过期结果(换难度/新对局)直接丢
      if (d.type === 'progress') { showInfo(d); return; }
      searching = false;
      if (d.error) { statusL.textContent = '引擎异常:' + d.error; return; }
      if (d.move < 0) {
        /* AI 无合法落点:满盘 = 和棋;有禁黑被封盘 = 玩家胜(无连线,不高亮)。
         * 这些事实以 state 回包为准 —— 补一次查询,别在 UI 里复判规则 */
        fetchState();
        return;
      }
      hist.push(d.move);
      lastMove = d.move;
      turn ^= 1;
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
      worker.postMessage({ type: 'state', id, moves: hist.slice(), mode });
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

    function fetchLevels(timeoutMs = 5000) {
      return new Promise((resolve) => {
        if (!ensureWorker()) { resolve(null); return; }
        worker.postMessage({ type: 'levels' });
        setTimeout(() => resolve(null), timeoutMs);
      });
    }

    function thinkAI() {
      if (gameOver || searching) return;
      searching = true;
      render();
      statusL.textContent = `${sideName(aiSide())}思考中…`;
      setTitle(`五子棋 — AI 思考中(${lvName()})`);
      infoL.textContent = '';
      if (typeof Worker === 'undefined') {
        searching = false;
        statusL.textContent = '当前环境不支持 Web Worker,AI 不可用';
        return;
      }
      if (!ensureWorker()) return;
      worker.postMessage({ id: ++reqSeq, moves: hist.slice(), mode, level: levelIdx });
    }

    /** 底栏右侧的引擎信息行(等宽字体,与象棋应用同一套写法) */
    function showInfo(d) {
      infoL.textContent = `${lvName()} · 深度 ${d.depth} · `
        + `${Math.round(d.nodes / 1000)}k 节点 · ${d.ms}ms · ${fmtScore(d.score)}`;
    }

    /* ---------- 工具栏动作 ---------- */
    function resetGame() {
      abortEngine();
      turn = BLACK; hist = []; lastMove = null;
      winLine = null; gameOver = false;
      bans = new Set();
      board = new Array(225).fill(0);
      render();
      fetchState();                                // 初始局面的禁手等事实也要问引擎
      if (vsAI && turn === aiSide()) thinkAI();    // 玩家执白时 AI 执黑先行
      else updateStatus();
    }

    /** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手(AI 应手 + 自己那手),
     *  人人撤一手;AI 想棋中悔棋先掐掉在途搜索;终局后悔棋可复活对局。
     *  序列改完问一次 state,棋盘 / 禁手 / 胜负全部以回包为准。 */
    function doUndo() {
      if (!hist.length) return;
      abortEngine();
      let n = 1;
      if (vsAI && turn === humanSide && hist.length >= 2) n = 2;
      while (n-- > 0 && hist.length) hist.pop();
      turn = hist.length % 2 === 0 ? BLACK : WHITE;
      gameOver = false;
      winLine = null;
      lastMove = hist.length ? hist[hist.length - 1] : null;
      fetchState();
      if (vsAI && turn === aiSide()) thinkAI();    // 撤完轮到 AI(玩家执黑的起点)就让它重想
      else { render(); updateStatus(); }
    }

    /** 换边:与 AI 互换执子方。棋盘对称不翻转,中途换边作废在途搜索并立即接手。 */
    function switchSide() {
      abortEngine();
      humanSide ^= 1;
      render();
      if (!gameOver && vsAI && turn === aiSide()) thinkAI();
      else if (!gameOver) updateStatus();
    }

    /* ---------- 界面 ---------- */
    const newBtn = el('button', { class: 'btn primary', onClick: resetGame }, icon('refresh', 13), '新对局');
    /* 规则档:无禁(自由)/ 有禁(连珠)。切规则即开新对局 —— 禁手影响合法性,
     * 中途切换容易让「刚才还能走的点」变得走不得,重开最干净。 */
    const modeSel = el('select', {
      class: 'select gk-mode',
      title: '规则:无禁手 = 长连也算胜;有禁手 = 黑方三三/四四/长连判负',
      'aria-label': '规则',
      onChange: (e) => {
        const next = Number(e.currentTarget.value);
        if (next === mode) return;
        mode = next;
        if (hist.length) bus.notify('五子棋', '规则已切换,开新对局');
        resetGame();
      },
    },
      el('option', { value: String(RENJU) }, '有禁手'),
      el('option', { value: String(FREE) }, '无禁手'));
    modeSel.value = String(mode);                 // 默认「有禁手」
    /* 难度档:原生 <select>。选项**等引擎报表之后再填** —— 档位名与参数都是
     * 引擎的实现细节,UI 硬编码只会造成「表改了但界面没跟着」;空表时禁用。
     * 换档时若 AI 正在想棋就掐掉重想 —— 否则要等旧档位的结果回来才生效。 */
    const levelSel = el('select', {
      class: 'select gk-level',
      title: 'AI 难度(等引擎上报)',
      'aria-label': 'AI 难度',
      disabled: true,
      onChange: (e) => {
        levelIdx = Number(e.currentTarget.value) || 0;
        if (searching) { abortEngine(); thinkAI(); }
      },
    });
    const aiBtn = el('button', {
      class: 'btn', title: '切换人机 / 双人对弈',
      onClick: (e) => {
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机' : '双人';
        sideBtn.disabled = !vsAI;                                 // 换边只对人机模式有意义
        if (!vsAI) { abortEngine(); render(); updateStatus(); }   // 关掉 AI 要把在途搜索停掉
        else if (!gameOver && turn === aiSide()) thinkAI();       // 轮到 AI 就立刻接手
        else updateStatus();
      },
    }, '人机');
    const sideBtn = el('button', {
      class: 'btn', title: '换边:与 AI 互换执子方(棋盘对称,不翻转)',
      onClick: switchSide,
    }, '换边');
    const undoBtn = el('button', {
      class: 'btn', title: '悔棋:人机模式连 AI 的应手一起撤,人人模式撤一手',
      onClick: doUndo,
    }, icon('reply', 13), '悔棋');

    const appEl = el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn,
        el('label', { class: 'gk-mode-wrap', title: '规则' },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '规则'), modeSel),
        el('label', { class: 'gk-level-wrap', title: 'AI 难度' },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '难度'), levelSel),
        aiBtn, sideBtn, undoBtn),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        infoL));
    root.append(appEl);
    /* 棋盘是固定像素的(CS 34 × 15 路 + 边距),窗口再小它也不缩 —— 按实测棋盘报
     * 最小窗口尺寸给 WM;560 是工具栏(规则 + 难度两个下拉)挤不下时的兜底宽。 */
    reportBoardMin(ctx, appEl, boardEl, 560);

    /* 供探针/排障:确认窗口活着、引擎档位与对局进度 */
    window.__gomoku = {
      level: () => levels[levelIdx]?.id,
      setLevel: (i) => {
        if (i < 0 || i >= levels.length) return;
        levelSel.value = String(i);
        levelSel.dispatchEvent(new Event('change', { bubbles: true }));
      },
      mode: () => (mode === RENJU ? 'renju' : 'free'),
      setMode: (m) => {
        modeSel.value = String(m);
        modeSel.dispatchEvent(new Event('change', { bubbles: true }));
      },
      stats: () => ({
        level: levels[levelIdx]?.id, mode: mode === RENJU ? 'renju' : 'free',
        vsAI, searching, plies: hist.length,
        turn, human: humanSide, gameOver,
      }),
      lastText: () => (hist.length ? coordText(hist[hist.length - 1]) : ''),
    };

    render();
    updateStatus();
    /* 问引擎要难度表与初始局面:放在 DOM 挂好之后,探针一进来就能看到表。
     * 故意不 await:mount 不该为一个消息往返卡住,下拉自己会从禁用变可用。 */
    fetchLevels();
    fetchState();

    return {
      onClose() {
        killWorker();
        delete window.__gomoku;
      },
    };
  },
});
