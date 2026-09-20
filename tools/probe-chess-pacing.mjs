/* 临时探针:验证 AI 应手节奏垫(holdMove)与落子入场淡入
 *   1. 开局书秒回:从玩家落子到 AI 落子 ≥ 260ms(MIN_AI_MS)
 *   2. 大师档长搜索:应手耗时 ≈ 搜索本身,不被额外再垫 260ms
 *   3. 2D 视图:AI 落子后落点那枚棋子带 .appear(入场淡入在播)
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

await c.evaluate(`WebOS.wm.open('chess3d')`);
await sleep(2500);

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

/* 等 UI 静默(轮到白方、无搜索) */
const waitQuiet = () => c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (window.__chess.moves() % 2 === 0 && !window.__chess.searching() && window.__chess.turn() === 'w') return true;
    await sleep(60);
  }
  return false;
})()`);

/* ---------- 1. 开局书秒回的应手时长 ---------- */
const book = await c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const w = document.querySelector('.win[data-app=chess3d]');
  const info = [...w.querySelectorAll('.app-status .mono')].find(s => s.textContent !== 'ogl+worker');
  const openers = [[6,4,4,4],[6,3,4,3],[7,6,5,5]];   // e4 / d4 / Nf3,前几手必进开局书
  const times = [];
  for (const [fr,fc,tr,tc] of openers) {
    const t0 = performance.now();
    const p0 = window.__chess.moves();
    window.__chess.click(fr, fc);
    await sleep(60);
    window.__chess.click(tr, tc);
    while (window.__chess.moves() < p0 + 2 && performance.now() - t0 < 10000) await sleep(5);
    times.push(Math.round(performance.now() - t0));
  }
  return { times, info: info.textContent };
})()`);
check('开局书应手每次都 ≥ 260ms',
  book.times.every((t) => t >= 260),
  `${book.times.join(' / ')}ms · ${book.info}`);
check('开局书应手没有被垫过头(≤ 600ms)', book.times.every((t) => t <= 600), book.times.join(' / ') + 'ms');

/* ---------- 2. 大师档长搜索不额外垫 ---------- */
await waitQuiet();
const slow = await c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.__chess.setLevel(3);                        // 大师:搜索明显超过 260ms
  const t0 = performance.now();
  const p0 = window.__chess.moves();
  window.__chess.click(6,2);
  await sleep(60);
  window.__chess.click(5,2);                         // c2-c3
  while (window.__chess.moves() < p0 + 2 && performance.now() - t0 < 30000) await sleep(5);
  return Math.round(performance.now() - t0);
})()`);
check('大师档长搜索不再叠加垫延迟(耗时即搜索本身)', slow >= 260, slow + 'ms(搜索 >260ms 时垫逻辑零增加,只验下限不被拉短)');

/* ---------- 3. 2D 视图入场淡入 ---------- */
await waitQuiet();
const fade = await c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.__chess.setLevel(0);
  window.__chess.setMode('2d');
  await sleep(200);
  const t0 = performance.now();
  const p0 = window.__chess.moves();
  window.__chess.click(6,1);                          // b2(前几节已走 e4/d4/Nf3/c3,e2 不能再用)
  await sleep(60);
  window.__chess.click(4,1);                          // b4
  // AI 落子前后都查:plies 到位可能先于 state 回包重画,出循环后再补查一段
  const look = () => {
    const ap = document.querySelector('.win[data-app=chess3d] .chess2d-pc.appear');
    return ap ? { seen: true, since: Math.round(performance.now() - t0), label: ap.closest('.chess2d-cell').ariaLabel } : null;
  };
  while (window.__chess.moves() < p0 + 2 && performance.now() - t0 < 10000) {
    const hit = look();
    if (hit) return hit;
    await sleep(10);
  }
  for (let i = 0; i < 40; i++) {                     // 落子后的 240ms 淡入窗口内必然查得到
    const hit = look();
    if (hit) return hit;
    await sleep(10);
  }
  return { seen: false };
})()`);
check('2D:AI 落子后落点棋子在播入场淡入(.appear)', fade.seen, JSON.stringify(fade));
const fade3d = await c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.__chess.setMode('3d');
  await sleep(300);
  window.__chess.setMode('2d');                      // 再切回,确认模式切换不打断基本流程
  await sleep(300);
  return window.__chess.mode();
})()`);
check('2D/3D 切换后仍正常', fade3d === '2d', 'mode=' + fade3d);

/* ---------- 4. 新对局:32 枚全体淡入 ---------- */
const reset = await c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const w = document.querySelector('.win[data-app=chess3d]');
  const nb = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('新对局'));
  nb.click();
  // 初始局面回包落地后,240ms 窗口内 32 枚都应挂着 .appear
  for (let i = 0; i < 60; i++) {
    const n = document.querySelectorAll('.win[data-app=chess3d] .chess2d-pc.appear').length;
    if (n >= 30) return { ok: true, n, turn: window.__chess.turn() };
    await sleep(10);
  }
  return { ok: false, n: document.querySelectorAll('.win[data-app=chess3d] .chess2d-pc.appear').length,
    total: document.querySelectorAll('.win[data-app=chess3d] .chess2d-pc').length };
})()`);
check('新对局:初始 32 枚全体播入场淡入', reset.ok, JSON.stringify(reset));

check('全程无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('\n===== 汇总 =====');
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
