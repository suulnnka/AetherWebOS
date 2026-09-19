/* ============================================================
 * 应用:黑白棋(Reversi / Othello)
 * 8×8 棋盘;完整规则:夹翻、无合法棋自动跳过、双方无棋终局;
 * 合法位置提示;人机对弈,支持换边(与 AI 互换执子方)与悔棋。
 *
 * AI 引擎在独立子项目 vendor/AetherOthello(github.com/suulnnka/AetherOthello):
 * 位棋盘 + PVS/置换表 + 残局完全求解,测试与基准都在该仓库。
 * **对弈走 zig 通道**:引擎编译成 othello.wasm(原生 u64 位棋盘),跑在 Worker 里;
 * 本文件一行搜索代码都没有,只有「8×8 棋盘 ↔ 两个 u32 位板」的转换。
 * 主分支的 src/engine.js(纯 JS 版)仍在仓库里当参照实现给探针用,对弈路径不再用它。
 * 搜索过程(深度/最佳步/评分/节点数/耗时)实时写入状态栏右侧(样式同 chess)。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './reversi.css';
import { dialogs } from '../../core/dialogs.js';

/* 难度表**不 import**:两套实现(JS 参照 / Zig→wasm)的搜索算法不同,档位参数
 * 根本不通用,所以那张表住在引擎层,由 Worker 用 {type:'levels'} 自报(见
 * vendor/AetherOthello/docs/WORKER-PROTOCOL.md)。这里开局问一次,按回包建下拉、
 * 按回包的 default 定初值 —— 于是「调难度」只需改引擎仓库,不用动 webos。 */

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

/** 棋盘 + 行棋方 → 位板的两半(lo = 第 1–4 行,hi = 第 5–8 行)。
 *  wasm 的 i64 在 JS 侧是 BigInt,边界上容易写错,所以 ABI 统一拆两个 u32;
 *  这里直接按位拼,不经过 BigInt —— 每半 32 位刚好是 4 行,`>>> 0` 把符号位掰回来。 */
function halfs(b, color) {
  let lo = 0, hi = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (b[r][c] !== color) continue;
      const i = r * 8 + c;
      if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32);
    }
  }
  return [lo >>> 0, hi >>> 0];
}

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
    let searchGen = 0;       // 搜索代数:作废在途搜索用的请求号(见 killWorker)
    let thinking = false;
    /* 难度表由**引擎自报**(协议里的 {type:'levels'}):levels 存表,levelIdx 是当前
     * 下标,初值取引擎给的 default —— 「哪一档算默认体验」是引擎的判断,UI 不猜。
     * levelsP 是「表已到手」的闸门:AI 第一次想棋之前一定先等它,免得表还没到就
     * 按 levelIdx=0 跑(界面显示初级、引擎却在别的档,象棋那边踩过这类不一致)。 */
    let levels = [];
    let levelIdx = 0;
    let levelsP = null;      // 在 mount 末尾赋值,见那里的说明
    const aiColor = () => other(humanColor);
    const lvName = () => levels[levelIdx]?.name ?? '—';

    const statusL = el('span', {}, '');
    const infoL = el('span', {
      class: 'mono', style: { fontSize: '11px', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, '');
    const boardEl = el('div', { class: 'rv-board' });
    const blackCount = el('span', { class: 'rv-count black' }, '2');
    const whiteCount = el('span', { class: 'rv-count white' }, '2');

    /** 把搜索结果写入状态栏右侧(样式同 chess 的 infoL:mono 11px)。
     *  wasm 通道是一锤子买卖:没有逐层/预热/待定那些中间态,只有最后一轮的结果 ——
     *  所以这里看不到「深度一层层涨」,但每个数字都是真的跑完了的。 */
    function showSearch(res) {
      const me = sideName(aiColor()), opp = sideName(other(aiColor()));
      const sc = (s) => (s >= 0 ? `${me} +${s.toFixed(1)}` : `${opp} +${(-s).toFixed(1)}`);
      if (res.only) { infoL.textContent = `唯一合法步 ${moveName(res.move)},无需搜索`; return; }
      const tail = ` · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}${fmtNps(res)}`;
      if (res.greedy) {
        infoL.textContent = `初级 贪心选点 ${moveName(res.move)} · 评估 ${sc(res.score)}${tail}`;
        return;
      }
      if (res.exact) {
        const d = Math.round(res.score);
        const verdict = d > 0 ? `${me}胜 ${d} 子` : d < 0 ? `${opp}胜 ${-d} 子` : '和棋';
        infoL.textContent = `残局完全求解(${res.empties} 空):${verdict} · 最佳 ${moveName(res.move)}${tail}`;
        return;
      }
      /* 进了完全求解的空格区间却没跑完(节点预算截断):明说,别把前置中层
       * 迭代的启发式估值当成终局判决报出去 —— 那会显示一场凭空的胜负。 */
      const head = res.partial ? `残局求解未跑完(${res.empties} 空)` : `深度 ${res.depth}/${res.depthMax}`;
      infoL.textContent = `${head} · 最佳 ${moveName(res.move)} · 评估 ${sc(res.score)}${tail}`;
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

    /* ---------- AI:搜索跑在 Worker 里(zig → wasm 通道)----------
     * 传位板而不是棋盘:结构化克隆最省(4 个 number),而且 Worker 里根本不需要
     * 规则 —— 引擎自己就是规则。UI 与引擎各持一套规则的风险被压到最小:UI 只用
     * 自己那套画界面/翻子,引擎只负责「给一手」,最后仍由 UI 判合法性兜底。
     *
     * 搜索在 Worker 里同步跑:一个 engineThink 跑完才返回,中间没有进度可报。
     * 要真中断(新对局/悔棋/换难度/换边)只能 terminate() 再造一个 —— 光丢弃
     * 结果的话它还会白算到结束(大师档一手可能几秒)。 */
    let worker = null;
    let pending = null;          // 在途请求 { id, resolve, only }
    let reqId = 0;               // 请求号 —— **必须与 searchGen 分开**:
                                 // searchGen 是「作废代数」(killWorker 自增),
                                 // 若拿它当请求号,requestThink 里的自增会让调用方
                                 // 手上一份的 gen 立刻"过期",AI 就永远不落子(踩过)。

    function killWorker() {
      if (worker) { worker.terminate(); worker = null; }
      thinking = false;
      searchGen++;               // 让已经进了主线程队列的旧结果作废
      if (pending) { const p = pending; pending = null; p.resolve(null); }
    }

    function ensureWorker() {
      if (worker) return worker;
      try {
        worker = new Worker(new URL('../../../vendor/AetherOthello/src/worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        console.error('[reversi] 无法创建 AI Worker:', err);
        worker = null;
        statusL.textContent = 'AI 不可用(Worker 创建失败)';
        return null;
      }
      worker.onmessage = onEngineMsg;
      worker.onerror = (ev) => {
        console.warn('[reversi] AI Worker 异常:', ev.message || ev);
        killWorker();
        statusL.textContent = 'AI 出错,已跳过本步';
      };
      return worker;
    }

    function onEngineMsg(e) {
      const d = e.data;
      if (!d || !pending || d.id !== pending.id) return;      // 过期结果直接丢
      const p = pending;
      pending = null;
      if (d.error) {
        console.warn('[reversi] 引擎异常:', d.error);
        statusL.textContent = '引擎异常:' + d.error;
        p.resolve(null);
        return;
      }
      const lv = levels[levelIdx];       // 引擎自报的表;没到就退回「不算截断」
      p.resolve({
        ...d,
        only: p.only,
        greedy: d.depth === 0 && !d.exact,
        // 进了完全求解的空格区间却没给出精确解 = 被节点预算截断
        partial: lv ? d.empties <= lv.end && !d.exact : false,
        depthMax: d.depthMax ?? lv?.depth ?? 0,
      });
    }

    /** 问引擎要难度表({type:'levels'})。表是**实现细节**,只有引擎自己知道,
     *  所以这里不能 import 引擎仓库的文件 —— 走 Worker 才换实现不换上层。
     *  实现上临时换掉 onmessage(与下面 ping 钩子同一套路):levels 回包不带 id,
     *  塞进按 id 过滤的 onEngineMsg 只会更难读。 */
    function fetchLevels(timeoutMs = 5000) {
      return new Promise((resolve) => {
        if (!ensureWorker()) { resolve(null); return; }
        const w = worker;
        const prev = w.onmessage;
        let done = false;
        const finish = (v) => { if (done) return; done = true; w.onmessage = prev; resolve(v); };
        w.onmessage = (e) => {
          const d = e.data;
          if (d && d.type === 'levels') finish(d);
          else if (prev) prev(e);
        };
        w.postMessage({ type: 'levels' });
        setTimeout(() => finish(null), timeoutMs);
      });
    }

    /** 向 Worker 要一手;返回结果对象,请求被作废时返回 null */
    async function requestThink() {
      /* 先等表:表没到手就发 think,worker 会按它自己的 default 跑,而 UI 显示的
       * 还是 levelIdx=0 —— 这种「界面一个档、引擎另一个档」正是要避免的。 */
      if (levelsP) await levelsP;
      return new Promise((resolve) => {
        if (typeof Worker === 'undefined') {
          statusL.textContent = '当前环境不支持 Web Worker,AI 不可用';
          resolve(null); return;
        }
        if (!ensureWorker()) { resolve(null); return; }
        const n = counts(board);
        pending = { id: ++reqId, resolve, only: legalMoves(board, turn).length === 1 };
        worker.postMessage({
          type: 'think', id: pending.id,
          own: halfs(board, turn), opp: halfs(board, other(turn)),
          level: levelIdx, empties: 64 - n.black - n.white,
        });
        infoL.textContent = `搜索中…(${lvName()})`;
      });
    }

    async function aiMove() {
      const color = aiColor();
      if (gameOver || !vsAI || turn !== color) return;
      if (!root.isConnected) { killWorker(); return; }
      if (thinking) { setTimeout(aiMove, 260); return; } // 上一轮搜索尚未结束,稍后重试
      thinking = true;
      const gen = searchGen;
      try {
        const res = await requestThink();
        if (!res || gen !== searchGen || gameOver || !root.isConnected) return;
        if (res.move < 0) {                 // 引擎说无棋可走:交给 advance 走「跳过回合」那条路
          turn = other(color);
          advance();
          return;
        }
        const r = res.move >> 3, c = res.move & 7;
        const flips = flipsFor(board, r, c, color);
        if (!flips.length) {                // 兜底:宁可跳过也不能往盘上落一手脏子
          console.warn('[reversi] 引擎返回非法着法', res.move);
          statusL.textContent = '引擎返回非法着法,已跳过本步';
          turn = other(color);
          advance();
          return;
        }
        board = applyMove(board, r, c, color).board;
        moves.push({ color, r, c, flips });
        lastMove = [r, c];
        turn = other(color);
        showSearch(res);
        advance();
      } finally {
        if (gen === searchGen) thinking = false;
      }
    }

    /** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手(对方应手 + 自己那手),
     * 人人撤一手;AI 想棋中悔棋先作废在途搜索;终局后悔棋可复活对局。
     * 历史条目自带行棋方,跳过回合不会打乱还原(轮到谁由条目颜色决定)。 */
    function doUndo() {
      if (!moves.length) return;
      killWorker();                      // 掐掉在途搜索:terminate 才真停得住 CPU 白烧
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
      killWorker();
      humanColor = other(humanColor);
      renderBoard();                     // 提示点跟「轮到的是不是人」走,执子方变了要重画
      if (!gameOver && turn === aiColor()) setTimeout(aiMove, 260);
      else if (!gameOver) updateStatus();   // 终局后换边只改偏好,保留终局文案
    }

    /* 工具栏(样式与结构对齐 chess:图标按钮 + 难度下拉 + 人机/换边/悔棋) */
    const newBtn = el('button', { class: 'btn primary', title: '重新开始一局', onClick: () => {
      killWorker(); // 打断进行中的搜索
      board = initBoard(); turn = 'b'; gameOver = false; lastMove = null; moves = [];
      infoL.textContent = '';
      renderBoard(); updateStatus();
      if (vsAI && turn === aiColor()) setTimeout(aiMove, 260);   // 玩家执白时 AI 执黑先行
    } }, icon('refresh', 13), '新对局');
    /* 难度档:原生 <select>(同 chess 的下拉形态,比循环按钮少点几下、状态一眼可见)。
     * 选项**等引擎报表之后再填**(见下面的 loadLevels)—— 档位名与参数都是引擎的
     * 实现细节,UI 硬编码只会造成「表改了但界面没跟着」;空表时禁用,不给假下拉。
     * 换档时若 AI 正在想棋就掐掉重想 —— 否则要等旧档位的结果回来才生效。 */
    const levelSel = el('select', {
      class: 'select rv-level',
      title: 'AI 难度(等引擎上报)',
      'aria-label': 'AI 难度',
      disabled: true,
      onChange: (e) => {
        killWorker();
        levelIdx = Number(e.currentTarget.value) || 0;
        infoL.textContent = '';
        // 若切换发生在 AI 思考中,重新调度被打断的 AI
        if (vsAI && turn === aiColor() && !gameOver) setTimeout(aiMove, 260);
      },
    });

    /** 开局问一次引擎的难度表,拿到才填下拉 —— UI 与引擎的档位认知就此对齐。
     *  回包很快(worker 报表不等 wasm 加载),所以下拉几乎立刻就绪。 */
    async function loadLevels() {
      const r = await fetchLevels();
      const table = r && Array.isArray(r.levels)
        ? r.levels.filter((lv) => lv && typeof lv.name === 'string' && lv.name) : [];
      if (!table.length) {
        /* 引擎没报表(Worker 建不起来 / 回包坏了):下拉保持禁用。
         * 具体原因由 ensureWorker / onEngineMsg 那条路写到状态栏,这里不抢着写。 */
        levelSel.title = 'AI 难度不可用(引擎未上报)';
        return;
      }
      levels = table;
      const def = Number.isInteger(r.default) && r.default >= 0 && r.default < table.length ? r.default : 0;
      levelIdx = def;
      levelSel.append(...table.map((lv, i) => el('option', { value: String(i) }, lv.name)));
      levelSel.value = String(def);      // 初值必须显式同步,否则显示第一档而引擎按 default 跑
      levelSel.disabled = false;
      levelSel.title = 'AI 难度:' + table.map((lv) => lv.name).join(' / ');
    }
    const aiBtn = el('button', {
      class: 'btn', title: '切换人机 / 双人对战',
      onClick: (e) => {
        killWorker();
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
    /* 问引擎要难度表 —— 放在 DOM 挂好之后、钩子之前,探针一进来就能看到表。
     * 故意不 await:mount 不该为一个消息往返卡住,下拉自己会从禁用变可用。 */
    levelsP = loadLevels();

    /* 浏览器探针(tools/probe-reversi.mjs)用的钩子。
     * ping() 是唯一能证明「浏览器真的取到了 wasm 并初始化成功」的手段:
     * 它走的是与对弈完全相同的 Worker/资源路径,回包里带着权重书的元信息。 */
    window.__reversi = {
      stats: () => ({
        level: levelIdx, levelName: lvName(), vsAI, thinking, plies: moves.length, turn,
        human: humanColor, gameOver, hasWorker: !!worker,
        counts: counts(board),
      }),
      info: () => infoL.textContent,
      status: () => statusL.textContent,
      /* 引擎自报的难度表 —— 探针拿它断言「下拉是按引擎的表建的」,
       * 而不是背下名字来对比(那就又变成硬编码了)。 */
      levels: () => levels.map((lv) => ({ name: lv.name, depth: lv.depth, end: lv.end, budget: lv.budget })),
      levelSel: () => {
        const o = levelSel.selectedOptions[0];
        return levelSel.value + ':' + (o ? o.textContent : '');
      },
      setLevel: (i) => {
        if (i < 0 || i >= levels.length) return;
        levelSel.value = String(i);
        levelSel.dispatchEvent(new Event('change', { bubbles: true }));
      },
      ping: () => new Promise((resolve) => {
        if (!ensureWorker()) { resolve({ error: 'no-worker' }); return; }
        const prev = worker.onmessage;
        const done = (d) => { worker.onmessage = prev; resolve(d); };
        worker.onmessage = (e) => {
          const d = e.data;
          if (d && d.type === 'pong') done(d); else prev(e);
        };
        worker.postMessage({ type: 'ping' });
        setTimeout(() => done({ error: 'timeout' }), 5000);
      }),
    };

    return {
      onClose() {
        killWorker();
        delete window.__reversi;
      },
    };
  },
});
