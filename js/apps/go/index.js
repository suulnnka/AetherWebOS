/* ============================================================
 * 应用:围棋(Go)9×9
 * 玩家执黑先行(可换边),AI 执白。规则:气尽提子、禁自杀、单劫禁回提、
 * 停一手合法,连续两手停即终局,按中国规则数子(黑贴 5.5 目)。
 *
 * AI 引擎在独立子项目 vendor/AetherGo(github.com/suulnnka/AetherGo):
 * 规则、数子、MCTS 都在 src/engine.js(单文件,零依赖),搜索跑在 src/worker.js 里。
 * 主线程只 import 规则部分(判合法、数子、记谱),搜索代码由 Vite 打进 worker chunk。
 *
 * 走法编码只有一套:交叉点 0..80,PASS=81。UI 把**走法序列**发给 Worker,
 * Worker 自己从初始局面重演 —— 结构化克隆最省,也不存在两份规则实现。
 *
 * 顶栏/底栏沿用中国象棋应用的做法:顶栏一组对局级按钮,
 * 底栏**只有一条** —— 左边行棋状态与提子数、右边等宽字体的引擎搜索信息。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './go.css';
import { dialogs } from '../../core/dialogs.js';
import { icon } from '../../core/icons.js';
import {
  BLACK, WHITE, PASS, LEVELS, DEFAULT_LEVEL,
  newBoard, genLegal, isLegal, make, unmake, capturedOf, koPoint,
  scoreGame, moveToText,
} from '../../../vendor/AetherGo/src/engine.js';

/* 格距(px)。与 go.css 里的 --cs / --pad 必须一致 */
const CS = 52, PAD = 26;
const T = PAD * 2 + CS * 8;
const X = (c) => PAD + c * CS;
const Y = (r) => PAD + r * CS;
const COLS = 'ABCDEFGHJ';                     // 列标(跳过 I)
const sideName = (s) => (s === BLACK ? '黑方' : '白方');
const fmtRate = (w) => Math.round(w * 100) + '%';
const fmtVisits = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v));

/** 棋盘线(SVG):9×9 线 + 五个星位 + 边缘坐标(下 A~J、左 9~1) */
function boardSvg() {
  const d = [];
  for (let i = 0; i < 9; i++) {
    d.push(`M${X(0)} ${Y(i)}H${X(8)}`);
    d.push(`M${X(i)} ${Y(0)}V${Y(8)}`);
  }
  const stars = [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]]
    .map(([r, c]) => `<circle class="go-star" cx="${X(c)}" cy="${Y(r)}" r="3.2"/>`)
    .join('');
  const coords = [];
  for (let c = 0; c < 9; c++) {
    coords.push(`<text class="go-coord" x="${X(c)}" y="${T - PAD / 2}">${COLS[c]}</text>`);
    coords.push(`<text class="go-coord" x="${PAD / 2}" y="${Y(c)}">${9 - c}</text>`);
  }
  return `<svg class="go-lines" viewBox="0 0 ${T} ${T}" aria-hidden="true">`
    + `<path class="go-line" d="${d.join(' ')}"/>${stars}${coords.join('')}</svg>`;
}

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let bd = newBoard();
    let turn = BLACK;          // 黑先
    let humanSide = BLACK;     // 玩家执子方(换边可改);不翻盘,坐标恒定
    let hist = [];             // { mv, side, tok, text } —— 走法序列,也给 Worker 重演用
    let lastMove = null;
    let gameOver = false;
    let vsAI = true;
    let levelIdx = DEFAULT_LEVEL;
    let searching = false;

    const aiSide = () => humanSide ^ 1;
    const lastIsPass = () => hist.length > 0 && hist[hist.length - 1].mv === PASS;
    const capsOf = (s) => hist.reduce((n, h) => n + (h.side === s ? capturedOf(h.tok) : 0), 0);

    const statusL = el('span', {}, '黑方行棋');
    const infoL = el('span', {
      class: 'mono', style: { fontSize: '11px' },
      title: '引擎搜索信息(胜率是 AI 视角,来自蒙特卡洛演棋)',
    }, '');
    const layerEl = el('div', { class: 'go-layer' });
    const boardEl = el('div', { class: 'go-board' }, layerEl);

    /* ---------- 渲染 ---------- */
    function render() {
      layerEl.innerHTML = boardSvg();
      /* 虚影与可点光标只在「轮到玩家」时出现 */
      const humanTurn = !gameOver && (!vsAI || turn === humanSide);
      boardEl.classList.toggle('turn-b', humanTurn && turn === BLACK);
      boardEl.classList.toggle('turn-w', humanTurn && turn === WHITE);
      const legal = humanTurn ? new Set(genLegal(bd, turn)) : null;
      for (let p = 0; p < 81; p++) {
        const btn = el('button', {
          class: 'go-pt' + (legal && !bd[p] && legal.has(p) ? ' can' : ''),
          style: { left: X(p % 9) + 'px', top: Y((p / 9) | 0) + 'px' },
          dataset: { i: String(p) },
          onClick: () => onPoint(p),
        });
        if (bd[p]) {
          const st = el('div', {
            class: `go-stone ${bd[p] === 1 ? 'black' : 'white'}${p === lastMove ? ' last' : ''}`,
          });
          if (p === lastMove) st.classList.add('drop');
          btn.append(st);
        } else if (legal) {
          btn.append(el('div', { class: 'go-ghost' }));
        }
        layerEl.append(btn);
      }
      passBtn.disabled = !humanTurn;
    }

    function updateStatus() {
      if (gameOver) return;
      const caps = `黑提 ${capsOf(BLACK)} · 白提 ${capsOf(WHITE)}`;
      statusL.textContent = `${sideName(turn)}行棋 · ${caps}`;
      const last = hist.length ? ` · 上一手 ${hist[hist.length - 1].text}` : '';
      setTitle(`围棋 — ${sideName(turn)}行棋${last}`);
    }

    /* ---------- 落子 ---------- */
    function onPoint(p) {
      if (gameOver || bd[p]) return;
      if (vsAI && turn !== humanSide) return;    // AI 回合/思考中不响应点击
      if (!isLegal(bd, turn, p)) {
        bus.notify('围棋', p === koPoint()
          ? '打劫:需先在别处找一手劫材'
          : '禁着点:落子后无气(自杀)');
        return;
      }
      doMove(p);
    }

    function doMove(mv) {
      const text = moveToText(bd, mv);
      const tok = make(bd, mv, turn);
      hist.push({ mv, side: turn, tok, text });
      if (mv !== PASS) lastMove = mv;
      turn ^= 1;
      afterMove();
    }

    /** 落子后的公共收尾:判双停终局、轮到 AI 就调度 */
    function afterMove() {
      render();
      if (hist.length >= 2 && hist[hist.length - 1].mv === PASS && hist[hist.length - 2].mv === PASS) {
        endGame();                               // 连续两手停 = 终局
        return;
      }
      const capN = capturedOf(hist[hist.length - 1].tok);
      if (capN > 0) bus.notify('围棋', `${sideName(turn ^ 1)}提 ${capN} 子`);
      if (!gameOver && vsAI && turn === aiSide()) setTimeout(thinkAI, 260);
      else updateStatus();
    }

    function endGame() {
      gameOver = true;
      abortEngine();
      const s = scoreGame(bd);
      const win = s.margin > 0 ? '黑胜' : s.margin < 0 ? '白胜' : '和棋';
      const diff = Math.abs(s.margin).toFixed(1);
      const line = `终局 · ${win === '和棋' ? win : win + ' ' + diff + ' 目'}`;
      dialogs.info({
        title: '终局(双停)',
        message: `黑 ${s.black} · 白 ${s.white} —— ${win === '和棋' ? '和棋' : win + ' ' + diff + ' 目'}`,
      });
      statusL.textContent = line;
      setTitle('围棋 — 终局');
      bus.notify('围棋', line);
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
        worker = new Worker(new URL('../../../vendor/AetherGo/src/worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        console.error('[go] 无法创建 AI Worker:', err);
        worker = null; searching = false;
        statusL.textContent = 'AI 不可用(Worker 创建失败)';
        return null;
      }
      worker.onmessage = onEngineMsg;
      worker.onerror = (ev) => {
        console.warn('[go] AI Worker 异常:', ev.message || ev);
        killWorker();
        statusL.textContent = 'AI 出错,已跳过本步';
      };
      return worker;
    }

    function thinkAI() {
      if (gameOver || searching) return;
      const cfg = LEVELS[levelIdx];
      searching = true;
      render();
      statusL.textContent = `${sideName(aiSide())}思考中…`;
      setTitle(`围棋 — AI 思考中(${cfg.name})`);
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
        playouts: cfg.playouts, ms: cfg.ms, jitter: cfg.jitter,
      });
    }

    function onEngineMsg(e) {
      const d = e.data;
      if (!d || d.id !== reqSeq) return;          // 过期结果(换难度/新对局)直接丢
      if (d.type === 'progress') { showInfo(d); return; }
      searching = false;
      if (d.error) { statusL.textContent = '引擎异常:' + d.error; return; }
      if (!d.move && d.move !== 0) { endGame(); return; }   // AI 无着法 = 引擎判终局
      const text = moveToText(bd, d.move);
      const tok = make(bd, d.move, aiSide());
      hist.push({ mv: d.move, side: aiSide(), tok, text });
      if (d.move !== PASS) lastMove = d.move;
      turn = humanSide;
      showInfo(d);
      afterMove();
    }

    /** 底栏右侧的引擎信息行(等宽字体,与象棋应用同一套写法) */
    function showInfo(d) {
      infoL.textContent = `${LEVELS[levelIdx].name} · ${fmtVisits(d.visits)} 演棋 · ${d.ms}ms · 胜率 ${fmtRate(d.winRate)}`;
    }

    /* ---------- 工具栏动作 ---------- */
    function resetGame() {
      abortEngine();
      bd = newBoard(); turn = BLACK; hist = []; lastMove = null;
      gameOver = false;
      render();
      if (vsAI && turn === aiSide()) thinkAI();   // 玩家执白时 AI 执黑先行
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
        unmake(bd, h.mv, h.tok);
        turn = h.side;
      }
      gameOver = false;
      lastMove = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].mv !== PASS) { lastMove = hist[i].mv; break; }
      }
      render();
      if (vsAI && turn === aiSide()) thinkAI();   // 撤完轮到 AI(玩家执黑的起点)就让它重想
      else updateStatus();
    }

    /** 换边:与 AI 互换执子方。围棋不翻盘(坐标恒定),中途换边作废在途搜索并立即接手。 */
    function switchSide() {
      abortEngine();
      humanSide ^= 1;
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
      class: 'select go-level',
      title: 'AI 难度:初级 / 中级 / 高级 / 大师',
      'aria-label': 'AI 难度',
      onChange: (e) => {
        levelIdx = Number(e.currentTarget.value) || 0;
        if (searching) { abortEngine(); thinkAI(); }
      },
    }, ...LEVELS.map((lv, i) => el('option', { value: String(i) }, lv.name)));
    levelSel.value = String(levelIdx);            // 默认「高级」
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
      class: 'btn', title: '换边:与 AI 互换执子方(棋盘不翻转)',
      onClick: switchSide,
    }, '换边');
    const passBtn = el('button', {
      class: 'btn', title: '停一手:双方连续停一手即终局数子',
      onClick: () => { if (!gameOver && (!vsAI || turn === humanSide)) doMove(PASS); },
    }, '停一手');
    const undoBtn = el('button', {
      class: 'btn', title: '悔棋:人机模式连 AI 的应手一起撤,人人模式撤一手',
      onClick: doUndo,
    }, icon('reply', 13), '悔棋');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn,
        el('label', { class: 'go-level-wrap', title: 'AI 难度' },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '难度'), levelSel),
        passBtn, aiBtn, sideBtn, undoBtn),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        infoL)));

    /* 供探针/排障:确认窗口活着、引擎档位与对局进度 */
    window.__go = {
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
        delete window.__go;
      },
    };
  },
});
