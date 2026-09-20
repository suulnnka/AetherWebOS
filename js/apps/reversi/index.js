/* ============================================================
 * 应用:黑白棋(Reversi / Othello)
 * 8×8 棋盘;完整规则:夹翻、无合法棋自动跳过、双方无棋终局;
 * 合法位置提示;人机对弈,支持换边(与 AI 互换执子方)与悔棋。
 *
 * AI 引擎在独立子项目 vendor/AetherOthello(github.com/suulnnka/AetherOthello):
 * 位棋盘 + PVS/置换表 + 残局完全求解,测试与基准都在该仓库。
 * **对弈走 zig 通道**:引擎编译成 othello.wasm(原生 u64 位棋盘),跑在 Worker 里。
 * 本文件一行搜索/规则代码都没有:合法落点与翻转子、对方有无棋、双方子数、
 * 空格数、终局(满盘/双方无棋)与胜者,全部经 {type:'state'} 消息问 Worker ——
 * UI 只把回包的翻子写到自己的 8×8 数组上(纯数据变换)。
 * 主分支的 src/engine.js(纯 JS 版)仍在仓库里当参照实现给探针用,对弈路径不再用它。
 * 搜索过程(深度/最佳步/评分/节点数/耗时)实时写入状态栏右侧(样式同 chess);
 * 开局书命中的手显示「开局书 · 估值」(回包 book 字段,样式同 chess 的
 * 「开局库 · 族名」—— 黑白棋的书无族名,有名字时会替估值显示名字)。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './reversi.css';
import { dialogs } from '../../core/dialogs.js';

/* 难度表、局面规则**都不 import**:表是引擎的实现细节({type:'levels'} 自报),
 * 合法性 / 翻子 / 数子 / 终局 / 胜者是规则({type:'state'} 查询)——
 * UI 只按回包画界面,见 vendor/AetherOthello/docs/WORKER-PROTOCOL.md。 */

/* ==================== 应用 UI ==================== */

const other = (p) => (p === 'b' ? 'w' : 'b');

/** 标准开局四位(通用常数,与坐标表同类;不含任何可变规则) */
function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  b[3][3] = 'w'; b[3][4] = 'b'; b[4][3] = 'b'; b[4][4] = 'w';
  return b;
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
    let searchGen = 0;       // 搜索代数:作废在途请求用的请求号(见 killWorker)
    let thinking = false;
    /* 每局种子:开局书容差选着(值好多占)+ 根同分随机化都吃它(0 = 引擎完全
     * 确定,别用)。2^47 < 2^53,JS number 精确;新对局重掷 —— 同一局内悔棋/
     * 换边不换种子,AI 重想同局面仍可复现(种子随 think 消息传 worker,不落
     * 引擎状态,worker 缺省/无 seed 字段时引擎自动回到确定模式)。 */
    let gameSeed = 1 + Math.floor(Math.random() * 2 ** 47);
    /* 局面缓存(全部来自最近一次 state 回包,按当前行棋方查询):
     * legalNow = { cell → flips[[r,c],...] };countsCache 双方子数;empties 空格数 */
    let legalNow = new Map();
    let countsCache = { black: 2, white: 2 };
    let empties = 60;
    /* 难度表由**引擎自报**(协议里的 {type:'levels'}):levels 存表,levelIdx 是当前
     * 下标,初值取引擎给的 default —— 「哪一档算默认体验」是引擎的判断,UI 不猜。
     * levelsP 是「表已到手」的闸门:AI 第一次想棋之前一定先等它,免得表还没到就
     * 按 levelIdx=0 跑(界面显示初级、引擎却在别的档,象棋那边踩过这类不一致)。 */
    let levels = [];
    let levelIdx = 0;
    let levelsP = null;
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
      /* 开局书命中:没搜索(depth=0、nodes=0),来源只能信回包的 book 字段 ——
       * 书着与贪心在 depth 上同形,显示上别混(参照 chess 的开局库行)。书有
       * 名字显示名字(回包多带的字段经 ...d 自动透传),黑白棋的书无族名,显示估值 */
      if (res.book) { infoL.textContent = res.name ? `开局书 · ${res.name}` : `开局书 · ${sc(res.score)}`; return; }
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
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const piece = board[r][c];
          const isHint = !gameOver && piece === null && legalNow.has(r * 8 + c);
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
      blackCount.textContent = String(countsCache.black);
      whiteCount.textContent = String(countsCache.white);
    }

    function updateStatus() {
      statusL.textContent = gameOver ? '终局' : `${sideName(turn)}行棋`;
      setTitle('黑白棋');
    }

    /** 终局:胜负与原因都是 state 回包的引擎事实(winner 相对方,按查询侧映射) */
    function finish(st) {
      gameOver = true;
      const winnerAbs = st.winner === null ? null : st.winner === 'own' ? st.side : other(st.side);
      const reason = st.reason === 'full' ? '棋盘已满' : '双方无棋';
      const { black, white } = countsCache;
      let title, msg = `黑 ${black} : 白 ${white}`, line;
      if (winnerAbs === null) {
        title = '平局';
        line = `${reason} — 和棋`;
      } else {
        const winner = sideName(winnerAbs);
        line = `${reason} — ${winner}胜`;
        title = vsAI
          ? (winnerAbs === humanColor ? '🎉 你赢了!' : 'AI 获胜')
          : `🎉 ${winner}获胜`;
      }
      dialogs.info({ title, message: msg });
      statusL.textContent = line;
    }

    /** 用引擎给的翻子落子(纯数据变换,不含任何规则判断) */
    function applyWithFlips(r, c, color, flips) {
      board[r][c] = color;
      for (const bit of flips) board[bit >> 3][bit & 7] = color;
      moves.push({ color, r, c, flips: flips.map((bit) => [bit >> 3, bit & 7]) });
      lastMove = [r, c];
    }

    /** state 回包落地:缓存合法表 / 子数 / 空格,终局直接以回包为准 */
    function applyState(st) {
      legalNow = new Map(st.moves.map((cell, i) => [cell, st.flips[i]]));
      countsCache = st.side === 'b' ? { black: st.ownCount, white: st.oppCount } : { black: st.oppCount, white: st.ownCount };
      empties = st.empties;
      if (st.over) { finish(st); renderBoard(); return; }
      renderBoard();
      updateStatus();
      if (vsAI && turn === aiColor() && !gameOver) setTimeout(aiMove, 260);
    }

    /* ---------- 回合推进:向 Worker 要当前方的局面事实 ----------
     * moves 为空且 over=false → 对方有棋,跳过(再查一次对方);over=true → 终局。
     * 跳过必须把 turn 真正翻给对方:状态栏、提示点归属、applyState 里的 AI 调度
     * 全都读 turn,不翻就是「缓存按新方、行棋方停在旧方」—— 轮到谁谁点不动,
     * 该 AI 接手时又没人调度,棋局直接卡死(踩过)。
     * gen 守卫:级联途中若发生新对局/悔棋/换边(killWorker 会推进 searchGen),
     * 本轮级联立即作废 —— 否则旧级联的空回包会把新对局误判成终局。
     * turn 翻在第二次查询之前:即使级联被作废中断,「旧方无棋」已是既成事实,
     * 翻过的 turn 恰是新对局/换边想要的真实行棋方。 */
    async function refresh() {
      const gen = searchGen;
      renderBoard();
      updateStatus();
      if (gameOver) return;
      const st = await fetchState(turn);
      if (gen !== searchGen || !st) return;
      if (st.moves.length === 0 && !st.over) {
        const skipped = turn;
        turn = other(turn);
        const otherSt = await fetchState(turn);
        if (gen !== searchGen || !otherSt) return;
        applyState({ ...otherSt, side: turn });
        bus.notify('黑白棋', `${sideName(skipped)}无合法棋,跳过回合`);
        return;
      }
      applyState({ ...st, side: turn });
    }

    /** 落子裁决:现场向 Worker 要一次新鲜局面。缓存只管提示渲染,不承担
     *  裁决 —— 悔棋/新对局的 race 可能留下旧局面的缓存,拿它判子会落脏子。 */
    async function humanMove(r, c) {
      if (gameOver || (vsAI && turn !== humanColor)) return;
      /* 按下的瞬间就撤提示点:裁决要等 state 回包(首手还含引擎冷启动),旧提示
       * 点会一直亮到回包落地,看着像还能同时落别处。只对提示格生效 —— 误点非法
       * 格时提示点随后照常回来,不闪断。 */
      if (legalNow.has(r * 8 + c)) {
        for (const cell of boardEl.querySelectorAll('.rv-cell.hint')) cell.classList.remove('hint');
        for (const dot of boardEl.querySelectorAll('.rv-hint-dot')) dot.remove();
      }
      const color = turn;
      const gen = searchGen;
      const st = await fetchState(color);
      /* turn 复查:await 期间若另一手已落地(连点两格,两次裁决都带着旧盘面),
       * 这一次必须作废 —— 否则同一方能连落两手脏子。gen 只盯新对局/悔棋/换边。 */
      if (gen !== searchGen || turn !== color) return;
      applyState({ ...st, side: color });          // 顺手把提示/子数缓存校准
      const flip = st.flips[st.moves.indexOf(r * 8 + c)];
      if (!flip) return;                           // 非法落点(界面此时已按新缓存重画)
      applyWithFlips(r, c, color, flip);
      turn = other(turn);
      refresh();
    }

    /* ---------- AI:搜索跑在 Worker 里(zig → wasm 通道)----------
     * 传位板而不是棋盘:结构化克隆最省(4 个 number)。搜索在 Worker 里同步跑,
     * 要真中断(新对局/悔棋/换难度/换边)只能 terminate() 再造一个。 */
    let worker = null;
    let pending = null;          // 在途搜索请求 { id, resolve, only }
    let statePending = new Map();// 在途 state 请求 id → resolve
    let reqId = 0;               // 请求号 —— **必须与 searchGen 分开**:
                                 // searchGen 是「作废代数」(killWorker 自增),
                                 // 若拿它当请求号,requestThink 里的自增会让调用方
                                 // 手上一份的 gen 立刻"过期",AI 就永远不落子(踩过)。

    function killWorker() {
      if (worker) { worker.terminate(); worker = null; }
      thinking = false;
      searchGen++;               // 让已经进了主线程队列的旧结果作废
      if (pending) { const p = pending; pending = null; p.resolve(null); }
      for (const res of statePending.values()) res(null);
      statePending.clear();
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
      if (!d) return;
      if (d.type === 'levels') { applyLevels(d); return; }
      if (d.type === 'state') {
        const res = statePending.get(d.id);
        if (!res) return;                       // 过期(已被 killWorker 兜底)
        statePending.delete(d.id);
        res(d.error ? null : d);
        return;
      }
      if (!pending || d.id !== pending.id) return;      // 过期结果直接丢
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
        greedy: d.depth === 0 && !d.exact && !d.book,
        // 进了完全求解的空格区间却没给出精确解 = 被节点预算截断
        partial: lv ? d.empties <= lv.end && !d.exact : false,
        depthMax: d.depthMax ?? lv?.depth ?? 0,
      });
    }

    /** 开局问一次引擎的难度表,拿到才填下拉、解开 levelsP 闸门 */
    function applyLevels(d) {
      const table = Array.isArray(d.levels)
        ? d.levels.filter((lv) => lv && typeof lv.name === 'string' && lv.name) : [];
      if (!table.length) {
        levelSel.title = 'AI 难度不可用(引擎未上报)';
        levelsResolve?.();
        return;
      }
      levels = table;
      const def = Number.isInteger(d.default) && d.default >= 0 && d.default < table.length ? d.default : 0;
      levelIdx = def;
      levelSel.append(...table.map((lv, i) => el('option', { value: String(i) }, lv.name)));
      levelSel.value = String(def);
      levelSel.disabled = false;
      levelSel.title = 'AI 难度:' + table.map((lv) => lv.name).join(' / ');
      levelsResolve?.();
    }
    let levelsResolve = null;

    function fetchLevels(timeoutMs = 5000) {
      if (!ensureWorker()) { levelsResolve?.(); return; }
      worker.postMessage({ type: 'levels' });      // 回包经 onEngineMsg → applyLevels
      setTimeout(() => levelsResolve?.(), timeoutMs);  // 超时也放行,别让 AI 永远等表
    }

    /** 问引擎要某方的局面事实({type:'state'},含合法落点/翻子/子数/空格/终局) */
    function fetchState(side) {
      return new Promise((resolve) => {
        if (!ensureWorker()) { resolve(null); return; }
        const id = ++reqId;
        statePending.set(id, resolve);
        worker.postMessage({ type: 'state', id, own: halfs(board, side), opp: halfs(board, other(side)) });
      }).then((d) => (d ? { ...d, side } : null));
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
        pending = { id: ++reqId, resolve, only: legalNow.size === 1 };
        worker.postMessage({
          type: 'think', id: pending.id,
          own: halfs(board, turn), opp: halfs(board, other(turn)),
          level: levelIdx, empties, seed: gameSeed,
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
        if (res.book) {   // 书着秒回:垫点延迟让节奏像「想了一下」(同 chess),期间作废靠 gen 失配
          await new Promise((ok) => setTimeout(ok, 350 + Math.random() * 450));
          if (gen !== searchGen || gameOver || !root.isConnected) return;
        }
        /* AI 的手也按新鲜局面裁决 —— 悔棋/新对局的 race 可能留下旧缓存 */
        const st = await fetchState(color);
        if (!st || gen !== searchGen || gameOver || !root.isConnected) return;
        applyState({ ...st, side: color });
        if (res.move < 0) {                 // 引擎说无棋可走:交给 refresh 走「跳过回合」那条路
          turn = other(color);
          refresh();
          return;
        }
        const r = res.move >> 3, c = res.move & 7;
        const flips = st.flips[st.moves.indexOf(res.move)];
        if (!flips) {                       // 兜底:宁可跳过也不能往盘上落一手脏子
          console.warn('[reversi] 引擎返回非法着法', res.move);
          statusL.textContent = '引擎返回非法着法,已跳过本步';
          turn = other(color);
          refresh();
          return;
        }
        applyWithFlips(r, c, color, flips);
        turn = other(color);
        showSearch(res);
        refresh();
      } finally {
        if (gen === searchGen) thinking = false;
      }
    }

    /** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手(对方应手 + 自己那手),
     * 人人撤一手;AI 想棋中悔棋先作废在途搜索;终局后悔棋可复活对局。
     * 历史条目自带行棋方与翻转子(回包数据),跳过回合不会打乱还原。 */
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
      else refresh();
    }

    /** 换边:与 AI 互换执子方。棋盘上下对称,无需转向;中途换边作废在途搜索并立即
     * 接手/交出;终局后换边只改偏好,下局(含新对局)生效。双人模式下按钮禁用。 */
    function switchSide() {
      killWorker();
      humanColor = other(humanColor);
      renderBoard();                     // 提示点跟「轮到的是不是人」走,执子方变了要重画
      if (!gameOver && turn === aiColor()) setTimeout(aiMove, 260);
      else if (!gameOver) refresh();
    }

    /* 工具栏(样式与结构对齐 chess:图标按钮 + 难度下拉 + 人机/换边/悔棋) */
    const newBtn = el('button', { class: 'btn primary', title: '重新开始一局', onClick: () => {
      killWorker(); // 打断进行中的搜索
      gameSeed = 1 + Math.floor(Math.random() * 2 ** 47); // 换一局换一套开局变化
      board = initBoard(); turn = 'b'; gameOver = false; lastMove = null; moves = [];
      infoL.textContent = '';
      refresh();
      if (vsAI && turn === aiColor()) setTimeout(aiMove, 260);   // 玩家执白时 AI 执黑先行
    } }, icon('refresh', 13), '新对局');
    /* 难度档:原生 <select>(同 chess 的下拉形态,比循环按钮少点几下、状态一眼可见)。
     * 选项**等引擎报表之后再填** —— 档位名与参数都是引擎的实现细节;空表时禁用。 */
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
    const aiBtn = el('button', {
      class: 'btn', title: '切换人机 / 双人对战',
      onClick: (e) => {
        killWorker();
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机' : '双人';
        sideBtn.disabled = !vsAI;                                 // 换边只对人机模式有意义
        if (!vsAI) { infoL.textContent = ''; refresh(); }
        else if (!gameOver) refresh();
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

    /* 问引擎要难度表与初始局面:放在 DOM 挂好之后、钩子之前,探针一进来
     * 就能看到。故意不 await:mount 不该为一个消息往返卡住,界面自己会就绪。 */
    levelsP = new Promise((res) => { levelsResolve = res; });
    fetchLevels();
    refresh();

    /* 供探针(tools/probe-reversi.mjs)用的钩子。
     * ping() 是唯一能证明「浏览器真的取到了 wasm 并初始化成功」的手段。 */
    window.__reversi = {
      stats: () => ({
        level: levelIdx, levelName: lvName(), vsAI, thinking, plies: moves.length, turn,
        human: humanColor, gameOver, hasWorker: !!worker,
        counts: countsCache,
      }),
      info: () => infoL.textContent,
      status: () => statusL.textContent,
      levels: () => levels.map((lv) => ({ name: lv.name, depth: lv.depth, end: lv.end, budget: lv.budget })),
      /* 排障用:当前缓存的合法落点 */
      dbg: () => ({ legalKeys: [...legalNow.keys()].sort((a, b) => a - b), levelIdx, searchGen }),
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
