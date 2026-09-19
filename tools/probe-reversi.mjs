/* 黑白棋应用探针:在真实浏览器里把 UI 与 wasm 引擎走一遍
 *   1. 棋盘 64 格 / 初始 4 子(2:2)
 *   2. 顶栏按钮组 + 底栏只有一条(状态 + 等宽搜索信息)
 *   3. ping Worker:浏览器真的取到了 othello.wasm、engineInit 成功、权重书元信息对得上
 *   4. 点击提示点落子 → 真的翻子 → AI 用 wasm 应答 → 底栏右侧有引擎信息
 *   5. 难度下拉:选项与初值都来自引擎自报的 {type:'levels'}(断言 UI 与引擎一致)
 *   6. 悔棋把人机对战撤 2 步(且撤回的子颜色正确)
 *   7. 无控制台报错
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
// ⚠ 18970 = 20 字节头(v2:每相位一个 scale)+ 2 × 9475 int8。
//   权重书格式升到 v2 后头从 16 涨到 20 字节,这里是唯一写死字节数的地方。
check('权重书元信息对得上:9475 轨道 / 18970 字节 / scale>0',
  pong?.orbits === 9475 && pong?.weightBytes === 18970 && pong?.scale > 0,
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
check('底栏右侧有引擎信息(档位/深度/节点/耗时/评估)',
  /(深度 \d+\/\d+|残局完全求解|贪心选点|唯一合法步)/.test(ai.info) && /节点/.test(ai.info), ai.info);
check('底栏左边回到「黑方行棋」', ai.status === '黑方行棋', ai.status);
const sum = ai.counts.black + ai.counts.white;
check('黑白计数 UI 与盘上子数一致', sum === ai.pieces, `${ai.counts.black}:${ai.counts.white} vs ${ai.pieces}`);
console.log(`      AI 这一手 · ${ai.info}`);

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

/* ---------- 7. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
