/* 黑白棋应用探针:在真实浏览器里把 UI 与 wasm 引擎走一遍
 *   1. 棋盘 64 格 / 初始 4 子(2:2)
 *   2. 顶栏按钮组 + 底栏只有一条(状态 + 等宽搜索信息)
 *   3. ping Worker:浏览器真的取到了 othello.wasm、engineInit 成功、权重书元信息对得上
 *   4. 点击提示点落子 → 真的翻子 → AI 用 wasm 应答 → 底栏右侧有引擎信息
 *   5. 难度下拉:选项与初值都来自引擎自报的 {type:'levels'}(断言 UI 与引擎一致)
 *   6. 悔棋把人机对战撤 2 步(且撤回的子颜色正确)
 *   7. 双人模式回放一条确定性「必跳过」线:一方无合法棋被跳过,行棋方真交给
 *      对方(状态栏/turn 更新、弹系统通知、对方能继续落子 —— 卡死过)
 *   8. 无控制台报错
 *
 * 为什么这条必须跑真浏览器:check-size 只量字节,probe-wasm.mjs 在 Node 里
 * 直接读 zig-out 的文件 —— 而线上的路径是
 * 「Vite 把 wasm 发成 assets/othello-<hash>.wasm → Worker 里 new URL + fetch」,
 * 中间任何一环(资源没进产物、MIME、URL 重写)断掉,Node 侧那套全都不会报警。
 *
 * 用法:先起 `npx vite preview --port 4173`,再 node tools/probe-reversi.mjs
 * 注意本机 preview 只监听 [::1]:4173,用 localhost 而不是 127.0.0.1
 */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'http://localhost:4173/?e2e=1';

const c = await launch(URL);
const errors = [];
c.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    errors.push(m.params.type + ': ' + m.params.args.map((a) => a.description || a.value).join(' '));
  }
});
await c.send('Log.enable').catch(() => {});

for (let i = 0; i < 100; i++) {
  const r = await c.evaluate(`({ boot: !!document.getElementById('boot'), os: !!window.WebOS })`);
  if (r.os && !r.boot) break;
  await sleep(150);
}

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const W = '.win[data-app=reversi]';
await c.evaluate(`WebOS.wm.open('reversi')`);
await sleep(1200);

/* ---------- 1. 棋盘结构 ---------- */
const shape = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  if (!w) return { noWin: true };
  return {
    cells: w.querySelectorAll('.rv-cell').length,
    pieces: w.querySelectorAll('.rv-piece').length,
    black: w.querySelectorAll('.rv-piece.b').length,
    white: w.querySelectorAll('.rv-piece.w').length,
    hints: w.querySelectorAll('.rv-cell.hint').length,
    bars: w.querySelectorAll('.app-status').length,
    buttons: [...w.querySelectorAll('.app-toolbar .btn')].map((b) => b.textContent.trim()),
    levelLabel: w.querySelector('.rv-level-wrap span')?.textContent,
    status: w.querySelector('.app-status span')?.textContent,
    stats: window.__reversi?.stats(),
  };
})()`);
check('窗口打开了', !shape.noWin, shape.noWin ? '没找到 .win[data-app=reversi]' : '');
check('棋盘 64 格 · 初始 4 子(黑 2 白 2)', shape.cells === 64 && shape.pieces === 4 && shape.black === 2 && shape.white === 2,
  `${shape.cells} 格 / ${shape.pieces} 子 = 黑${shape.black} 白${shape.white}`);
check('黑方 4 个开局提示点', shape.hints === 4, String(shape.hints));
check('底栏只有一条(状态 + 搜索信息)', shape.bars === 1, String(shape.bars));
check('顶栏按钮组:新对局 / 人机 / 换边 / 悔棋',
  shape.buttons.join('|') === '新对局|人机|换边|悔棋', shape.buttons.join(' | '));
check('难度下拉带「难度」文字标签', shape.levelLabel === '难度', shape.levelLabel);
check('初始状态:黑先、0 手', shape.stats?.turn === 'b' && shape.stats?.plies === 0, JSON.stringify(shape.stats));

/* ---------- 2. Worker + wasm(这条是本次接线的核心) ---------- */
const pong = await c.evaluate(`window.__reversi.ping()`);
check('Worker 回 pong 且 tag 正确', pong?.tag === 'othello-engine-v1', JSON.stringify(pong));
check('浏览器里 wasm 初始化成功(engineInit 返回 0 → 无 error 字段)', !pong?.error, pong?.error || '');
// ⚠ 28449 = 24 字节头(v3:相位数由头声明)+ 3 × 9475 int8(P3 定格)。
//   旧值 18970 是 v2 双相位时代的断言,权重书改 3 相位后没跟上(失效多时)。
//   权重书格式升到 v2 后头从 16 涨到 20 字节,这里是唯一写死字节数的地方。
check('权重书元信息对得上:9475 轨道 / 28449 字节 / scale>0',
  pong?.orbits === 9475 && pong?.weightBytes === 28449 && pong?.scale > 0,
  `orbits=${pong?.orbits} weightBytes=${pong?.weightBytes} scale=${pong?.scale}`);

/* ---------- 3. 落子 → AI 用 wasm 应答 ---------- */
const clickAt = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  // 点一个提示点(e6 = 第 5 行第 4 列,按 dataset 找)
  const cell = w.querySelector('.rv-cell.hint[data-r="5"][data-c="4"]') || w.querySelector('.rv-cell.hint');
  const rc = cell.dataset.r + ',' + cell.dataset.c;
  cell.click();
  return { rc };
})()`);
/* 落子经 Worker 的 legal 往回确认(~ms 级),轮询等盘面更新,别立即断言 */
let moved = null;
for (let i = 0; i < 40; i++) {
  moved = await c.evaluate(`(() => ({
    piecesAfter: document.querySelectorAll('${W} .rv-piece').length,
    counts: window.__reversi.stats().counts,
    stats: window.__reversi.stats(),
    hints: document.querySelectorAll('${W} .rv-cell.hint').length,
  }))()`);
  if (moved.stats.plies === 1 && moved.counts.black === 4) break;   // 等 state 级联收敛(数子落地)
  await sleep(50);
}
// 落一手 = 盘上多 1 子(翻面不改总数),所以 4 → 5;同时吃 1 子:黑 2+1落+1翻 = 4,白 2-1 = 1
check('点提示点后落子(4 → 5 子,黑吃到 4:1)', moved.piecesAfter === 5 && moved.counts.black === 4 && moved.counts.white === 1,
  `${clickAt.rc} 之后 ${moved.piecesAfter} 子 = 黑${moved.counts.black}:白${moved.counts.white}`);
check('轮到 AI:搜索已发起', moved.stats.plies === 1 && moved.stats.turn === 'w', JSON.stringify(moved.stats));

let ai = null;
for (let i = 0; i < 80; i++) {
  ai = await c.evaluate(`({ stats: window.__reversi.stats(), info: window.__reversi.info(),
    status: window.__reversi.status(), pieces: document.querySelectorAll('${W} .rv-piece').length,
    counts: window.__reversi.stats().counts })`);
  if (ai.stats.plies === 2 && !ai.stats.thinking) break;
  await sleep(250);
}
check('AI 用 wasm 应答,回到黑方回合', ai.stats.plies === 2 && ai.stats.turn === 'b', JSON.stringify(ai.stats));
check('AI 落子后盘上子数涨到 6 以上', ai.pieces >= 6, `${ai.pieces} 子`);
check('底栏右侧有引擎信息(两种文案:开局库行 / 评估行,无着法描述)',
  (/^开局库( · .+)? · [黑白]方 [+-]/.test(ai.info) || /评估 [黑白]方 [+-]/.test(ai.info))
    && (ai.info.startsWith('开局库') || /节点/.test(ai.info))
    && !/^(最佳|唯一合法步) /.test(ai.info), ai.info);
check('底栏左边回到「黑方行棋」', ai.status === '黑方行棋', ai.status);
const sum = ai.counts.black + ai.counts.white;
check('黑白计数 UI 与盘上子数一致', sum === ai.pieces, `${ai.counts.black}:${ai.counts.white} vs ${ai.pieces}`);
console.log(`      AI 这一手 · ${ai.info}`);
/* 默认档(宗师 d12 ≥ 书的 4 层门槛)且 ≤14 子 ⇒ 必走书,书着确定(rng 未播种);
 * 这条把「开局库来源显示」整个链路(zig book 标志 → worker book/name 字段 →
 * UI 行)钉住。首手后的 5 子局面必带名(Diagonal/Parallel/Perpendicular 三条
 * 命名开局换位汇成),名字段透传到行里才算数 */
check('开局库行格式(名字 · 估值,无节点段)',
  /^开局库( · [^·]+)? · [黑白]方 [+-]/.test(ai.info), ai.info);
check('开局库行带开局名(引擎名字池 → 回包 name → UI)',
  /^开局库 · .+ · [黑白]方 [+-]/.test(ai.info), ai.info);

/* ---------- 4. 难度下拉(表由引擎自报,UI 只负责渲染) ---------- */
const lv = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const s = w.querySelector('select.rv-level');
  const table = window.__reversi.levels();          // 引擎自报的表,不是探针背下来的
  const opts = [...s.options].map(o => o.value + ':' + o.textContent);
  const initial = window.__reversi.levelSel();
  window.__reversi.setLevel(0);
  const low = window.__reversi.stats();
  const last = table.length - 1;
  window.__reversi.setLevel(last);
  const high = window.__reversi.stats();
  const sel = s.value + ':' + s.selectedOptions[0].textContent;
  window.__reversi.setLevel(Number(initial.split(':')[0]));   // 收回默认档,别把探针拖慢
  return { table, opts, initial, low: low.level, high: high.level, highName: high.levelName, last, sel };
})()`);
check('难度表来自引擎(非空且字段齐全)',
  lv.table.length >= 2 && lv.table.every((l) => typeof l.name === 'string'
    && typeof l.depth === 'number' && typeof l.end === 'number' && typeof l.budget === 'number'),
  JSON.stringify(lv.table));
check('下拉选项与引擎自报的表逐项一致',
  lv.opts.length === lv.table.length && lv.opts.every((o, i) => o === i + ':' + lv.table[i].name),
  lv.opts.join(' '));
check('下拉初值显式同步到引擎的档位名',
  lv.initial === Number(lv.initial.split(':')[0]) + ':' + lv.table[Number(lv.initial.split(':')[0])]?.name,
  lv.initial);
check('setLevel 生效且下拉跟着动',
  lv.low === 0 && lv.high === lv.last && lv.sel === lv.last + ':' + lv.table[lv.last].name,
  `low=${lv.low} high=${lv.high}(${lv.highName}) sel=${lv.sel}`);
await sleep(400);

/* ---------- 5. 悔棋 ---------- */
const undo = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '悔棋').click();
  return { stats: window.__reversi.stats(), pieces: w.querySelectorAll('.rv-piece').length,
           info: window.__reversi.info() };
})()`);
check('悔棋一次撤 2 步,回到初始 4 子', undo.stats.plies === 0 && undo.pieces === 4,
  `${undo.stats.plies} 手 / ${undo.pieces} 子`);
check('悔棋后清空搜索信息行', undo.info === '', JSON.stringify(undo.info));

/* ---------- 6. 新对局 + 换边(玩家执白时 AI 先手) ---------- */
const side = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '换边').click();
  return window.__reversi.stats();
})()`);
check('换边后玩家执白', side.human === 'w', JSON.stringify(side));
let first = null;
for (let i = 0; i < 80; i++) {
  first = await c.evaluate(`({ stats: window.__reversi.stats(), info: window.__reversi.info() })`);
  if (first.stats.plies >= 1 && !first.stats.thinking) break;
  await sleep(250);
}
check('AI 执黑先行,走完轮到玩家(白)', first.stats.plies === 1 && first.stats.turn === 'w',
  JSON.stringify(first.stats) + ' · ' + first.info);

/* ---------- 7. 跳过回合(双人模式回放确定性「必跳过」线) ----------
 * 从标准开局 BFS 搜出的最短必跳过线(规则事实,不会随引擎变化):
 *   黑d3→白c3→黑b3→白b2→黑f5→白a3→黑a1→白c1 之后黑方无合法棋,该跳过,轮白方。
 * 双人模式两侧落子都由探针驱动,跳过路径确定可达。断言三件事:
 *   a. 行棋方真的交给白方(turn 与状态栏都更新 —— 修复前 turn 停在被跳过的
 *      黑方,白方点不动、也无从推进,棋局卡死);
 *   b. 弹了系统通知「黑白棋 / 黑方无合法棋,跳过回合」;
 *   c. 白方提示点可点,棋局继续推进(第 9 手落得下去)。 */
const PASS_LINE = [
  { color: 'b', r: 2, c: 3 }, { color: 'w', r: 2, c: 2 },   // 黑d3 白c3
  { color: 'b', r: 2, c: 1 }, { color: 'w', r: 1, c: 1 },   // 黑b3 白b2
  { color: 'b', r: 4, c: 5 }, { color: 'w', r: 2, c: 0 },   // 黑f5 白a3
  { color: 'b', r: 0, c: 0 }, { color: 'w', r: 0, c: 2 },   // 黑a1 白c1
];
const passPrep = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const btn = (t) => [...w.querySelectorAll('.app-toolbar .btn')].find((b) => b.textContent === t);
  btn('人机').click();                    // 切到双人:无 AI 参与,回放完全确定
  btn('新对局').click();
  return window.__reversi.stats();
})()`);
check('双人模式新对局回到黑先 0 手', passPrep.vsAI === false && passPrep.turn === 'b' && passPrep.plies === 0, JSON.stringify(passPrep));

let replayed = null;
for (let i = 0; i < PASS_LINE.length; i++) {
  const m = PASS_LINE[i];
  // 等该手提示点出现(state 回包落地),再点
  let ok = false;
  for (let t = 0; t < 40 && !ok; t++) {
    ok = await c.evaluate(`!!document.querySelector('${W} .rv-cell.hint[data-r="${m.r}"][data-c="${m.c}"]')`);
    if (!ok) await sleep(50);
  }
  if (!ok) break;
  await c.evaluate(`document.querySelector('${W} .rv-cell[data-r="${m.r}"][data-c="${m.c}"]').click()`);
  for (let t = 0; t < 40; t++) {
    replayed = await c.evaluate(`window.__reversi.stats()`);
    if (replayed.plies >= i + 1) break;
    await sleep(50);
  }
  if (replayed?.plies < i + 1) break;
}
check('必跳过线回放完成(8 手全落)', replayed?.plies === PASS_LINE.length, `plies=${replayed?.plies}`);

/* 第 8 手(白 c1)之后黑方被跳过:轮询等跳过级联完全收敛。
 * 注意不能只等 turn:修复后 turn 在最终 state 回包落地前就翻过去了,
 * 只等 turn 会抓到级联中途的快照(状态栏/toast 还没落地)。 */
let pass = null;
for (let t = 0; t < 100; t++) {
  pass = await c.evaluate(`(() => ({
    stats: window.__reversi.stats(), status: window.__reversi.status(),
    toasts: [...document.querySelectorAll('#toasts .toast')].map((n) =>
      (n.querySelector('.ni-title')?.textContent || '') + '|' + (n.querySelector('.ni-body')?.textContent || '')),
    hints: document.querySelectorAll('${W} .rv-cell.hint').length,
  }))()`);
  if (pass.stats.turn === 'w' && pass.status === '白方行棋'
    && pass.toasts.some((s) => s === '黑白棋|黑方无合法棋,跳过回合')) break;
  await sleep(50);
}
check('黑方被跳过,行棋方交给白方(turn 更新)', pass.stats.turn === 'w', JSON.stringify(pass.stats));
check('状态栏显示「白方行棋」', pass.status === '白方行棋', pass.status);
check('弹了跳过系统通知', pass.toasts.some((s) => s === '黑白棋|黑方无合法棋,跳过回合'), JSON.stringify(pass.toasts));
check('白方有提示点可走', pass.hints > 0, String(pass.hints));
const resume = await c.evaluate(`(() => {
  document.querySelector('${W} .rv-cell.hint').click();
  return window.__reversi.stats();
})()`);
let after = null;
for (let t = 0; t < 40; t++) {
  after = await c.evaluate(`({ stats: window.__reversi.stats(), pieces: document.querySelectorAll('${W} .rv-piece').length })`);
  if (after.stats.plies >= 9) break;
  await sleep(50);
}
check('跳过后白方能继续落子(第 9 手推进,棋局未卡死)', after.stats.plies === 9 && after.pieces === 13,
  `plies=${after.stats.plies} / ${after.pieces} 子`);

/* ---------- 8. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
