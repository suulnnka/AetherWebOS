/* 五子棋应用探针:在真实浏览器里把 UI 与引擎走一遍
 *   1. 棋盘 225 个交叉点 / 规则+难度双下拉
 *   2. 点天元落子 → AI(白方)应答 → 底栏引擎信息
 *   3. 双人模式构造双活三 → 禁手点标 × 且拒落
 *   4. 切无禁手重开 / 悔棋 / 换边
 *   5. 无控制台报错
 *
 * 用法:先起 `vite preview --port 4173`,再 node tools/probe-gomoku.mjs
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

const W = '.win[data-app=gomoku]';
await c.evaluate(`WebOS.wm.open('gomoku')`);
await sleep(1200);

/* ---------- 1. 棋盘结构 ---------- */
const shape = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  if (!w) return { noWin: true };
  return {
    pts: w.querySelectorAll('.gk-pt').length,
    stones: w.querySelectorAll('.gk-stone').length,
    lines: !!w.querySelector('.gk-lines'),
    stars: w.querySelectorAll('.gk-star').length,
    stats: window.__gomoku?.stats(),
    bars: w.querySelectorAll('.app-status').length,
    buttons: [...w.querySelectorAll('.app-toolbar .btn')].map((b) => b.textContent.trim()),
    selects: [...w.querySelectorAll('.app-toolbar select')].map((s) => s.selectedOptions[0].textContent),
    status: w.querySelector('.app-status span')?.textContent,
  };
})()`);
check('窗口打开了', !shape.noWin, shape.noWin ? '没找到 .win[data-app=gomoku]' : '');
check('棋盘 225 个交叉点', shape.pts === 225, String(shape.pts));
check('空盘 + 棋盘线 + 5 颗星位', shape.stones === 0 && shape.lines && shape.stars === 5,
  `stones=${shape.stones} stars=${shape.stars}`);
check('初始状态:黑先、0 手、有禁手',
  shape.stats?.plies === 0 && shape.stats?.turn === 0 && shape.stats?.mode === 'renju', JSON.stringify(shape.stats));
check('顶栏按钮组:新对局 / 人机 / 换边 / 悔棋 + 规则/难度下拉',
  shape.buttons.join('|') === '新对局|人机|换边|悔棋' && shape.selects.join('/') === '有禁手/高级',
  shape.buttons.join(' ') + ' | ' + shape.selects.join('/'));
check('底栏只有一条(状态 + 等宽搜索信息)', shape.bars === 1, String(shape.bars));
check('底栏左边是行棋状态', shape.status === '黑方行棋 · 第 1 手', shape.status);

/* ---------- 2. 落子与 AI 应答 ---------- */
await c.evaluate(`document.querySelector('${W} .gk-pt[data-i="112"]').click()`);   // H8 天元
await sleep(400);
const moved = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  return {
    black: w.querySelectorAll('.gk-stone.black').length,
    last: !!w.querySelector('.gk-stone.last'),
    stats: window.__gomoku.stats(),
    lastText: window.__gomoku.lastText(),
  };
})()`);
check('点天元落子(黑子 1 颗,上一手 H8)', moved.black === 1 && moved.last && moved.lastText === 'H8',
  JSON.stringify(moved));

let ai = null;
for (let i = 0; i < 60; i++) {
  ai = await c.evaluate(`({ stats: window.__gomoku.stats(),
    info: document.querySelector('${W} .app-status .mono')?.textContent,
    status: document.querySelector('${W} .app-status span')?.textContent })`);
  if (ai.stats.plies === 2 && !ai.stats.searching) break;
  await sleep(250);
}
check('AI(白方)应答,回到黑方回合', ai.stats.plies === 2 && ai.stats.turn === 0, JSON.stringify(ai.stats));
check('底栏右侧有引擎信息(档位·深度·节点·耗时·评分)',
  /^.+ · 深度 \d+ · \d+k 节点 · \d+ms · [+-]/.test(ai.info), ai.info);
console.log(`      AI 这一手后:${ai.status} · ${ai.info}`);

/* ---------- 3. 双人模式:构造双活三 → 禁手标记 ---------- */
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('${W} .app-toolbar .btn')];
  btns.find(b => b.textContent === '人机').click();     // 切双人
  btns.find(b => b.textContent.includes('新对局')).click();   // 清掉 AI 对局残子,拿一张空盘
  return true;
})()`);
await sleep(350);
//* 黑 (7,6)(7,8)(6,7)(8,7),白 (0,0)(2,0)(4,0)(6,0) 摊开 —— 8 手后轮黑,黑下 (7,7) 即横竖双活三 */
for (const i of [111, 0, 113, 30, 97, 60, 127, 90]) {
  await c.evaluate(`document.querySelector('${W} .gk-pt[data-i="${i}"]').click()`);
  await sleep(120);
}
const bans = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const pt = w.querySelector('.gk-pt[data-i="112"]');
  const before = w.querySelectorAll('.gk-stone').length;
  pt.click();                                   // 点禁手点:应被拒绝
  return {
    before, after: w.querySelectorAll('.gk-stone').length,
    banCls: pt.classList.contains('ban'),
    banMark: !!pt.querySelector('.gk-ban'),
    bans: w.querySelectorAll('.gk-ban').length,
  };
})()`);
check('双活三点标 × 且拒落(点后子数不变)',
  bans.banCls && bans.banMark && bans.bans === 1 &&
  bans.before === 8 && bans.after === 8, JSON.stringify(bans));

/* ---------- 4. 无禁手模式 + 悔棋 + 换边 ---------- */
await c.evaluate(`window.__gomoku.setMode(0)`);
await sleep(400);
const free = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  return {
    stats: window.__gomoku.stats(),
    stones: w.querySelectorAll('.gk-stone').length,
    bans: w.querySelectorAll('.gk-ban').length,
  };
})()`);
check('切无禁手后重开(空盘,无 × 标记)',
  free.stats.mode === 'free' && free.stats.plies === 0 && free.stones === 0 && free.bans === 0,
  JSON.stringify(free));

await c.evaluate(`window.__gomoku.setLevel(3)`);
await sleep(150);
const lv = await c.evaluate(`window.__gomoku.level()`);
check('难度下拉 setLevel 同步(大师)', lv === 'master', lv);

await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  w.querySelector('.gk-pt[data-i="112"]').click();
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('悔棋')).click();
  return true;
})()`);
await sleep(300);
const undo = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  return { stones: w.querySelectorAll('.gk-stone').length, stats: window.__gomoku.stats() };
})()`);
check('双人模式悔棋撤一手回空盘', undo.stones === 0 && undo.stats.plies === 0, JSON.stringify(undo));

const sw = await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('${W} .app-toolbar .btn')];
  btns.find(b => b.textContent === '双人').click();     // 回人机(换边只对人机有意义)
  btns.find(b => b.textContent === '换边').click();
  return window.__gomoku.stats();
})()`);
check('换边后玩家执白', sw.human === 1 && sw.vsAI === true, JSON.stringify(sw));

/* ---------- 5. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
