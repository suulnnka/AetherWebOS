/* 围棋应用探针:在真实浏览器里把 UI 与引擎走一遍(2026-10 NN 引擎大改版后口径)
 *   1. 棋盘 361 个交叉点 / SVG 线 + 九星位 + 坐标
 *   2. 顶栏按钮组(新对局/停一手/数子/形势/人机/换边/悔棋)+ 底栏只有一条
 *   3. NN 模型懒加载就绪(stats.nnLoaded)
 *   4. 点天元落子 → 黑子出现 → AI(白方)应答,底栏有引擎信息
 *   5. 难度下拉 7 档 + 初值同步(默认「高级」)
 *   6. 形势判断开关(ownership 覆盖层 + 黑胜率信息行)
 *   7. 数子模式(数子窗弹出 + 实时明细 + 退出)
 *   8. 停一手后 AI 应答
 *   9. 悔棋把人机对战撤 2 步
 *  10. 换边:玩家执白、AI 执黑先行
 *  11. 无控制台报错
 *
 * 用法:先起 `vite preview --port 4173`,再 node tools/probe-go.mjs
 */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 用法:node tools/probe-go.mjs [baseURL](缺省 vite preview 的 4173) */
const BASE = process.argv[2] || 'http://localhost:4173';
const URL = BASE.replace(/\/$/, '') + '/?e2e=1';

/* 独立干净 profile:共享 profile 里残留的历史用户数据库会让 sms/mail 在
 * 引导期报「水合失败」,污染第 11 步的控制台检查(与应用本身无关) */
const c = await launch(URL, { profile: 'probe-go' });
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
await c.evaluate(`WebOS.apps.install('go', { silent: true })`);   // 商店应用:先装再开
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
check('棋盘 361 个交叉点', shape.pts === 361, String(shape.pts));
check('初始无子', shape.stones === 0, String(shape.stones));
check('棋盘线 + 9 星位 + 38 个坐标', shape.lines && shape.stars === 9 && shape.coords === 38,
  `星位 ${shape.stars} 坐标 ${shape.coords}`);
check('初始状态:黑先、0 手', shape.stats?.plies === 0 && shape.stats?.turn === 0, JSON.stringify(shape.stats));

/* ---------- 2. 顶栏 / 底栏(与象棋应用同款) ---------- */
check('底栏只有一条', shape.bars === 1, `.app-status=${shape.bars}`);
check('顶栏按钮组:新对局 / 停一手 / 数子 / 形势 / 人机 / 换边 / 悔棋',
  shape.buttons.join('|') === '新对局|停一手|数子|形势|人机|换边|悔棋', shape.buttons.join(' | '));
check('难度下拉带「难度」文字标签', shape.levelLabel === '难度', shape.levelLabel);
check('底栏左边是行棋状态', shape.status === '黑方行棋 · 黑提 0 · 白提 0', shape.status);

/* ---------- 3. NN 模型懒加载 ---------- */
/* Worker 建立即自发 load:WebGPU 初始化 + 1.1MB 模型 + 批校准,首回要几秒 */
let nn = null;
for (let i = 0; i < 150; i++) {
  nn = await c.evaluate(`({ stats: window.__go.stats(),
    info: document.querySelector('${W} .app-status .mono')?.textContent })`);
  if (nn.stats.nnLoaded) break;
  if (nn.info?.includes('加载失败')) break;
  await sleep(300);
}
check('NN 模型加载就绪', nn.stats.nnLoaded === true, JSON.stringify(nn));

/* ---------- 4. 落子与 AI 应答 ---------- */
await c.evaluate(`document.querySelector('${W} .go-pt[data-i="180"]').click()`);   // 天元 (9,9)
/* 落子经 Worker 的 state 往回才落地(~ms 级),轮询等回包重画,别立即断言 */
let moved = null;
for (let i = 0; i < 40; i++) {
  moved = await c.evaluate(`(() => ({
    stone: !!document.querySelector('${W} .go-pt[data-i="180"] .go-stone.black'),
    stats: window.__go.stats(),
    last: window.__go.lastText(),
  }))()`);
  if (moved.stone) break;
  await sleep(50);
}
check('点天元真的落子了(黑)', moved.stone, JSON.stringify(moved));
check('记谱正确(K10)', moved.last === 'K10', moved.last);
check('轮到 AI:搜索已发起', moved.stats.plies === 1 && moved.stats.turn === 1, JSON.stringify(moved.stats));

let ai = null;
for (let i = 0; i < 120; i++) {
  ai = await c.evaluate(`({ stats: window.__go.stats(), last: window.__go.lastText(),
    search: document.querySelector('${W} .app-status .mono')?.textContent,
    status: document.querySelector('${W} .app-status span')?.textContent })`);
  if (ai.stats.plies === 2 && !ai.stats.searching) break;
  await sleep(250);
}
check('AI(白方)应答,回到黑方回合', ai.stats.plies === 2 && ai.stats.turn === 0, JSON.stringify(ai.stats));
check('AI 的应答是合法记谱(坐标或停)', /^([A-HJ-NP-T][1-9][0-9]?|停)$/.test(ai.last), ai.last);
check('底栏右侧有引擎信息(档位·访问·耗时·胜率,目差可有)',
  /^NN·.+ · [\d.]+k? 访问 · \d+ms · 胜率 \d+%( · 目差 [+-][\d.]+)?$/.test(ai.search), ai.search);
check('底栏左边回到黑方行棋(含提子数)', /^黑方行棋 · 黑提 0 · 白提 [0-9]+$/.test(ai.status), ai.status);
console.log(`      AI 这一手:${ai.last} · ${ai.search}`);

/* ---------- 5. 难度下拉 ---------- */
const lv = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const s = w.querySelector('select.go-level');
  const opts = [...s.options].map(o => o.value + ':' + o.textContent);
  const initial = s.value + ':' + s.selectedOptions[0].textContent + '|' + window.__go.level();
  window.__go.setLevel(0);
  return { opts, initial, level: window.__go.level() };
})()`);
check('难度下拉 7 档,setLevel 同步', lv.opts.length === 7 && lv.level === 'beginner',
  lv.opts.join(' / ') + ' → ' + lv.level);
check('下拉初值与引擎档位一致(默认高级)', lv.initial === '3:高级|hard', lv.initial);

/* ---------- 6. 形势判断(初级档模型已就绪,单次推理很快) ---------- */
await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '形势').click();
  return window.__go.stats();
})()`);
let est = null;
for (let i = 0; i < 60; i++) {
  est = await c.evaluate(`({ stats: window.__go.stats(),
    info: document.querySelector('${W} .app-status .mono')?.textContent,
    owns: document.querySelectorAll('${W} .go-own').length })`);
  if (est.info?.startsWith('形势:黑胜率')) break;
  await sleep(150);
}
check('形势判断出图(覆盖层 + 黑胜率)',
  est.stats.estimateOn === true && est.owns > 0 && /^形势:黑胜率 \d+%/.test(est.info),
  JSON.stringify({ owns: est.owns, info: est.info }));
await c.evaluate(`[...document.querySelectorAll('${W} .app-toolbar .btn')].find(b => b.textContent === '形势').click()`);

/* ---------- 7. 数子模式(点棋子切死/活的窗) ---------- */
await c.evaluate(`[...document.querySelectorAll('${W} .app-toolbar .btn')].find(b => b.textContent === '数子').click()`);
let cnt = null;
for (let i = 0; i < 60; i++) {
  cnt = await c.evaluate(`({ stats: window.__go.stats(),
    open: !!document.querySelector('${W} .go-count.open'),
    msg: document.querySelector('${W} .go-count-msg')?.textContent,
    status: document.querySelector('${W} .app-status span')?.textContent })`);
  if (cnt.open && cnt.msg) break;
  await sleep(150);
}
check('数子窗弹出且明细落地(子/空/贴 + 死子自动判定)',
  cnt.stats.countMode === true && cnt.open && /黑:子 \d+ \+ 空 \d+ = \d+/.test(cnt.msg || ''),
  JSON.stringify({ open: cnt.open, msg: cnt.msg?.split('\n')[0], status: cnt.status }));
await c.evaluate(`[...document.querySelectorAll('${W} .go-count-foot .btn')].find(b => b.textContent === '继续对局').click()`);
const cntExit = await c.evaluate(`({ stats: window.__go.stats(),
  open: !!document.querySelector('${W} .go-count.open') })`);
check('退出数子回到对局(棋盘窗关闭)', cntExit.stats.countMode === false && !cntExit.open, JSON.stringify(cntExit));

/* ---------- 8. 停一手(初级档,AI 应得快) ---------- */
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

/* ---------- 9. 悔棋 ---------- */
const undo = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '悔棋').click();
  return { stats: window.__go.stats(), stone180: !!w.querySelector('.go-pt[data-i="180"] .go-stone') };
})()`);
check('悔棋一次撤 2 步(人机:自己的 + AI 的)',
  undo.stats.plies === 2 && undo.stone180, JSON.stringify(undo.stats));

/* ---------- 10. 换边:玩家执白 + AI 执黑先行 ---------- */
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

/* ---------- 11. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
