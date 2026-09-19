/* 临时深度探针:在真实浏览器里把引擎接好之后的 UI 走一遍
 *   1. 难度按钮循环 + 标签同步
 *   2. 连续走多步(白方走子 → 等 AI 应答 → 回合回到白方)
 *   3. 状态栏搜索信息(深度/节点/评分)真的有内容
 *   4. AI 思考时画面仍在出帧(不卡 UI)
 *   5. 新对局把 plies 归零
 *   6. 关掉人机后黑方不再自动应答
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
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

/* ---------- 1. 难度下拉 ---------- */
const lv = await c.evaluate(`(async () => {
  const w = document.querySelector('.win[data-app=chess3d]');
  const sel = w.querySelector('.app-toolbar select.chess3d-level');
  if (!sel) return { noSelect: [...w.querySelectorAll('.app-toolbar *')].map(n => n.tagName + '.' + n.className).join(' | ') };
  const options = [...sel.options].map(o => o.value + ':' + o.textContent);
  const initial = sel.value + '|' + sel.selectedOptions[0].textContent + '|' + window.__chess.level();
  const seen = [];
  for (const v of ['0', '2', '3', '1']) {          // 乱序切,验证不是"循环按钮"的伪装
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    seen.push(sel.value + ':' + sel.selectedOptions[0].textContent + '|' + window.__chess.level());
  }
  window.__chess.setLevel(2);                       // 引擎侧改档位也要把下拉同步过去
  await new Promise(r => setTimeout(r, 40));
  return { options, initial, seen, synced: sel.value + '|' + sel.selectedOptions[0].textContent, level: window.__chess.level() };
})()`);
check('工具栏有难度下拉,4 个选项齐全',
  !lv.noSelect && lv.options.join(',') === '0:初级,1:中级,2:高级,3:大师',
  lv.noSelect ? '没找到 select:' + lv.noSelect : lv.options.join(' / '));
check('下拉初始选中默认「高级」', lv.initial === '2|高级|hard', lv.initial);
check('下拉可任意跳到指定档位(标签 + 引擎同步)',
  lv.seen.join(',') === '0:初级|easy,2:高级|hard,3:大师|master,1:中级|normal',
  lv.seen.join(' / '));
check('setLevel 会把下拉同步过去', lv.synced === '2|高级' && lv.level === 'hard', lv.synced + ' level=' + lv.level);

/* ---------- 2/3/4. 走子 + AI 应答 + 搜索信息 + 不卡帧 ---------- */
const waitIdle = async (ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await c.evaluate(`window.__chess.searching()`))) return Date.now() - t0;
    await sleep(80);
  }
  return -1;
};

const play = await c.evaluate(`(async () => {
  const w = document.querySelector('.win[data-app=chess3d]');
  const info = [...w.querySelectorAll('.app-status .mono')].find(s => s.textContent !== 'ogl+worker');
  const openers = [[6,4,4,4],[6,3,4,3],[7,6,5,5]];   // e4 / d4 / Nf3
  const trace = [];
  for (const [fr,fc,tr,tc] of openers) {
    window.__chess.click(fr, fc);
    await new Promise(r => setTimeout(r, 120));
    window.__chess.click(tr, tc);
    // 等本回合彻底结束:人机各一手(plies +2)、搜索收尾、轮回白方。
    // 人走子 → state 回包 → thinkAI 有异步间隙,只等 !searching 会在间隙里误判。
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (window.__chess.moves() % 2 === 0 && !window.__chess.searching() && window.__chess.turn() === 'w') break;
      await new Promise(r => setTimeout(r, 80));
    }
    trace.push({ turn: window.__chess.turn(), plies: window.__chess.moves(), info: info.textContent });
  }
  return { trace, stats: window.__chess.stats() };
})()`);
check('连续 3 步白方走子后都回到白方行棋', play.trace.every((r) => r.turn === 'w'), JSON.stringify(play.trace.map((r) => r.turn + '/' + r.plies)));
check('每步后 plies 递增 2', play.trace.map((r) => r.plies).join(',') === '2,4,6', play.trace.map((r) => r.plies).join(','));
/* 状态栏两种合法显示:引擎搜索(深度/节点/评分)或开局库命中(开局名,
 * 见 index.js 的 infoL 两处赋值;库几乎必然覆盖前几步,只认搜索会稳定误报) */
check('状态栏有 AI 信息(搜索数据或开局库命中)',
  play.trace.every((r) => /深度 \d+ · \d+k 节点 · \d+ms · [+-]/.test(r.info) || /开局库/.test(r.info)),
  play.trace[0].info);

/* ---------- 4. 大师档思考时画面仍在出帧 ----------
 * 只统计「searching 为 true 期间的 rAF 回调数」:搜索若跑在主线程,这个数会≈0。 */
const frames = await c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  /* 先等上一节的对局静默(plies 偶数、白方回合、无搜索),否则点击会被锁盘丢掉 */
  let q0 = Date.now();
  while (Date.now() - q0 < 8000) {
    if (window.__chess.moves() % 2 === 0 && !window.__chess.searching() && window.__chess.turn() === 'w') break;
    await sleep(80);
  }
  window.__chess.setLevel(3);                      // 大师:节点多,思考久
  const p0 = window.__chess.moves();
  let during = 0;
  const tick = () => { if (window.__chess.searching()) during++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__chess.click(6,2);                       // c2
  await sleep(120);
  window.__chess.click(5,2);                       // c3
  const moved = window.__chess.moves() > p0;
  /* 人走子 → state 回包 → thinkAI 有异步间隙:先等搜索真起来,再等它结束 */
  let t0 = Date.now();
  while (!window.__chess.searching() && Date.now() - t0 < 5000) await sleep(50);
  let sawSearching = false;
  t0 = Date.now();
  while (window.__chess.searching() && Date.now() - t0 < 20000) { sawSearching = true; await sleep(50); }
  while (window.__chess.turn() !== 'w' && Date.now() - t0 < 5000) await sleep(50);
  return { moved, sawSearching, during, ms: Date.now() - t0, turn: window.__chess.turn(), stats: window.__chess.stats() };
})()`);
check('大师档:走子触发了 AI 搜索且搜索期间主线程仍在出帧',
  frames.moved && frames.sawSearching && frames.during >= 8 && frames.turn === 'w',
  `走子=${frames.moved} 搜索中=${frames.sawSearching} rAF 回调 ${frames.during} 次 / ${frames.ms}ms turn=${frames.turn}`);

/* ---------- 4b. 思考时真的能拖拽转视角 / 滚轮缩放(计划 §五 阶段四验收) ----------
 * 发真实 pointer 事件驱动相机,断言:①在 searching 期间完成了拖拽 ②相机参数确实变了
 * ③相机有"自己动起来"(tick 里 stepTween 在跑),即渲染循环没被搜索堵死。 */
const drag = await c.evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const w = document.querySelector('.win[data-app=chess3d]');
  const cv = w.querySelector('canvas');
  const r = cv.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const pe = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra,
  }));

  window.__chess.setLevel(3);
  /* 先等对局静默,再走 a2-a3;人走子 → state → thinkAI 有异步间隙,轮询等搜索起来 */
  let qs = Date.now();
  while (Date.now() - qs < 8000) {
    if (window.__chess.moves() % 2 === 0 && !window.__chess.searching() && window.__chess.turn() === 'w') break;
    await sleep(80);
  }
  const before = window.__chess.home();
  window.__chess.click(6,0);                       // a2
  await sleep(120);
  window.__chess.click(5,0);                       // a3,触发大师档搜索
  let sw = Date.now();
  while (!window.__chess.searching() && Date.now() - sw < 5000) await sleep(50);
  if (!window.__chess.searching()) return { noSearch: true };

  // 在搜索进行中拖拽(横向→改 theta)+ 滚轮(→改 radius)
  const framesMid = [];
  const grab = () => framesMid.push(window.__chess.stats().frames);
  pe('pointerdown', cx, cy);
  for (let i = 1; i <= 10; i++) { pe('pointermove', cx + i * 12, cy - i * 3); await sleep(20); grab(); }
  pe('pointerup', cx + 120, cy - 30);
  cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -160 }));
  await sleep(120);
  const searchingDuringDrag = window.__chess.searching();
  const after = window.__chess.home();

  const t0 = Date.now();
  while (window.__chess.searching() && Date.now() - t0 < 20000) await sleep(50);
  const f = window.__chess.stats().frames;
  return {
    searchingDuringDrag, before, after, framesMid, framesEnd: f,
    renderAlive: framesMid.length >= 8 && f - framesMid[0] >= 5,
    turn: window.__chess.turn(),
  };
})()`);
check('AI 思考期间拖拽改视角 + 滚轮缩放都生效',
  !drag.noSearch && drag.searchingDuringDrag &&
  (Math.abs(drag.after.theta - drag.before.theta) > 0.15) && (drag.after.radius < drag.before.radius - 0.2),
  drag.noSearch ? '搜索没起来' : `theta ${drag.before.theta.toFixed(2)}→${drag.after.theta.toFixed(2)}, radius ${drag.before.radius.toFixed(1)}→${drag.after.radius.toFixed(1)}`);
check('拖拽/缩放期间渲染循环持续出帧(没掉帧)',
  drag.renderAlive && drag.turn === 'w',
  `拖拽中采样 ${drag.framesMid.length} 次,帧数 ${drag.framesMid[0]}→${drag.framesEnd}`);

/* ---------- 5. 新对局 ---------- */
const reset = await c.evaluate(`(async () => {
  const w = document.querySelector('.win[data-app=chess3d]');
  const nb = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('新对局'));
  nb.click();
  await new Promise(r => setTimeout(r, 300));
  const b = window.__chess.board();
  const pieces = b.flat().filter(Boolean).length;
  return { plies: window.__chess.moves(), turn: window.__chess.turn(), pieces, searching: window.__chess.searching(), board: JSON.stringify(b).length };
})()`);
check('新对局回到 32 子 / 0 步 / 白方行棋', reset.pieces === 32 && reset.plies === 0 && reset.turn === 'w' && !reset.searching, JSON.stringify(reset));

/* ---------- 6. 关掉人机后黑方不自动应答 ---------- */
const noai = await c.evaluate(`(async () => {
  const w = document.querySelector('.win[data-app=chess3d]');
  const ab = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('人机'));
  ab.click();                                  // 人机 → 人人
  await new Promise(r => setTimeout(r, 100));
  window.__chess.click(6,4); await new Promise(r => setTimeout(r, 100));
  window.__chess.click(4,4);                   // e4
  await new Promise(r => setTimeout(r, 2500));  // 等人机时代里足够 AI 想完的时间
  return { label: ab.textContent, turn: window.__chess.turn(), plies: window.__chess.moves() };
})()`);
check('人人对战:黑方不自动走子', noai.turn === 'b' && noai.plies === 1, JSON.stringify(noai));

check('全程无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('\n===== 汇总 =====');
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
