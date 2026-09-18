/* 围棋应用探针:在真实浏览器里把 UI 与引擎走一遍
 *   1. 棋盘 81 个交叉点 / SVG 线 + 星位 + 坐标
 *   2. 顶栏按钮组 + 底栏只有一条(状态 + 等宽搜索信息)
 *   3. 点天元落子 → 黑子出现 → AI(白方)应答,底栏有引擎信息
 *   4. 难度下拉 4 档 + 初值同步
 *   5. 停一手后 AI 应答
 *   6. 悔棋把人机对战撤 2 步
 *   7. 换边:玩家执白、AI 执黑先行
 *   8. 无控制台报错
 *
 * 用法:先起 `vite preview --port 4173`,再 node tools/probe-go.mjs
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

const W = '.win[data-app=go]';
await c.evaluate(`WebOS.wm.open('go')`);
await sleep(1200);

/* ---------- 1. 棋盘结构 ---------- */
const shape = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  if (!w) return { noWin: true };
  return {
    pts: w.querySelectorAll('.go-pt').length,
    stones: w.querySelectorAll('.go-stone').length,
    lines: !!w.querySelector('.go-lines'),
    stars: w.querySelectorAll('.go-star').length,
    coords: w.querySelectorAll('.go-coord').length,
    stats: window.__go?.stats(),
    bars: w.querySelectorAll('.app-status').length,
    buttons: [...w.querySelectorAll('.app-toolbar .btn')].map((b) => b.textContent.trim()),
    levelLabel: w.querySelector('.go-level-wrap span')?.textContent,
    status: w.querySelector('.app-status span')?.textContent,
    info: w.querySelector('.app-status .mono')?.textContent,
  };
})()`);
check('窗口打开了', !shape.noWin, shape.noWin ? '没找到 .win[data-app=go]' : '');
check('棋盘 81 个交叉点', shape.pts === 81, String(shape.pts));
check('初始无子', shape.stones === 0, String(shape.stones));
check('棋盘线 + 5 星位 + 18 个坐标', shape.lines && shape.stars === 5 && shape.coords === 18,
  `星位 ${shape.stars} 坐标 ${shape.coords}`);
check('初始状态:黑先、0 手', shape.stats?.plies === 0 && shape.stats?.turn === 0, JSON.stringify(shape.stats));

/* ---------- 2. 顶栏 / 底栏(与象棋应用同款) ---------- */
check('底栏只有一条', shape.bars === 1, `.app-status=${shape.bars}`);
check('顶栏按钮组:新对局 / 停一手 / 人机 / 换边 / 悔棋',
  shape.buttons.join('|') === '新对局|停一手|人机|换边|悔棋', shape.buttons.join(' | '));
check('难度下拉带「难度」文字标签', shape.levelLabel === '难度', shape.levelLabel);
check('底栏左边是行棋状态', shape.status === '黑方行棋 · 黑提 0 · 白提 0', shape.status);

/* ---------- 3. 落子与 AI 应答 ---------- */
const moved = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  w.querySelector('.go-pt[data-i="40"]').click();    // 天元 (4,4)
  return {
    stone: !!w.querySelector('.go-pt[data-i="40"] .go-stone.black'),
    stats: window.__go.stats(),
    last: window.__go.lastText(),
  };
})()`);
check('点天元真的落子了(黑)', moved.stone, JSON.stringify(moved));
check('记谱正确(E5)', moved.last === 'E5', moved.last);
check('轮到 AI:搜索已发起', moved.stats.plies === 1 && moved.stats.turn === 1, JSON.stringify(moved.stats));

let ai = null;
for (let i = 0; i < 80; i++) {
  ai = await c.evaluate(`({ stats: window.__go.stats(), last: window.__go.lastText(),
    search: document.querySelector('${W} .app-status .mono')?.textContent,
    status: document.querySelector('${W} .app-status span')?.textContent })`);
  if (ai.stats.plies === 2 && !ai.stats.searching) break;
  await sleep(250);
}
check('AI(白方)应答,回到黑方回合', ai.stats.plies === 2 && ai.stats.turn === 0, JSON.stringify(ai.stats));
check('AI 的应答是合法记谱(坐标或停一手)', /^([A-HJ][1-9]|停一手)$/.test(ai.last), ai.last);
check('底栏右侧有引擎信息(档位·演棋·耗时·胜率)',
  /^.+ · [\d.]+k? 演棋 · \d+ms · 胜率 \d+%$/.test(ai.search), ai.search);
check('底栏左边回到黑方行棋(含提子数)', /^黑方行棋 · 黑提 0 · 白提 [0-9]+$/.test(ai.status), ai.status);
console.log(`      AI 这一手:${ai.last} · ${ai.search}`);

/* ---------- 4. 难度下拉 ---------- */
const lv = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const s = w.querySelector('select.go-level');
  const opts = [...s.options].map(o => o.value + ':' + o.textContent);
  const initial = s.value + ':' + s.selectedOptions[0].textContent + '|' + window.__go.level();
  window.__go.setLevel(0);
  return { opts, initial, level: window.__go.level() };
})()`);
check('难度下拉 4 档,setLevel 同步', lv.opts.length === 4 && lv.level === 'easy', lv.opts.join(' / ') + ' → ' + lv.level);
check('下拉初值与引擎档位一致(默认高级)', lv.initial === '2:高级|hard', lv.initial);

/* ---------- 5. 停一手(初级档,AI 应得快) ---------- */
await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const btn = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '停一手');
  btn.click();
  return window.__go.stats();
})()`);
let pass = null;
for (let i = 0; i < 80; i++) {
  pass = await c.evaluate(`({ stats: window.__go.stats(), last: window.__go.lastText() })`);
  if (pass.stats.plies === 4 && !pass.stats.searching) break;
  await sleep(250);
}
check('停一手后 AI 应答(plies=4,黑方回合)', pass.stats.plies === 4 && pass.stats.turn === 0, JSON.stringify(pass.stats));

/* ---------- 6. 悔棋 ---------- */
const undo = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '悔棋').click();
  return { stats: window.__go.stats(), stone40: !!w.querySelector('.go-pt[data-i="40"] .go-stone') };
})()`);
check('悔棋一次撤 2 步(人机:自己的 + AI 的)',
  undo.stats.plies === 2 && undo.stone40, JSON.stringify(undo.stats));

/* ---------- 7. 换边:玩家执白 + AI 执黑先行 ---------- */
const sw = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '换边').click();
  return { stats: window.__go.stats() };
})()`);
check('换边后玩家执白', sw.stats.human === 1, JSON.stringify(sw.stats));
let first = null;
for (let i = 0; i < 80; i++) {
  first = await c.evaluate(`({ stats: window.__go.stats(), last: window.__go.lastText() })`);
  if (first.stats.plies >= 3 && !first.stats.searching) break;
  await sleep(250);
}
check('AI 执黑接手,走完轮到玩家(白)', first.stats.plies >= 3 && first.stats.turn === 1, JSON.stringify(first.stats));

/* ---------- 8. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
