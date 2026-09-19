/* ============================================================
 * 图寻探针:在真实浏览器里验证图寻应用(自研 minimap 的第二个使用方)
 *   1. 猜测小地图挂载:容器 / 瓦片 / 缩放控件
 *   2. 开局 → 真实鼠标点击小地图放置猜测 → 提交
 *   3. 结算图:双 tooltip 标签(真实位置 / 你的猜测)+ 连线 + 底图存活
 *   4. 下一轮流转正常
 *   5. 与地图应用同时打开:地图端真实鼠标点缩放按钮(+)/ 拖拽打断
 *      缩放动画不卡死;回到图寻仍能点选猜测 —— 双向互不干扰
 *   6. 无控制台报错
 *
 * 为什么点选/缩放必须走 CDP 真实鼠标事件:内核用 setPointerCapture 处理
 * 拖拽,合成 el.click() 绕过了 capture 路径,测不出「控件点击被容器抢走」
 * 这类问题(probe-map 的注释同理)。
 *
 * 用法:先起 `node node_modules/vite/bin/vite.js preview`,再 node tools/probe-tuxun.mjs
 * ============================================================ */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'http://localhost:8080/?e2e=1';

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

/* 真实鼠标事件(CDP Input):会走 pointerdown/up → setPointerCapture → click 全链路 */
const rectOf = (sel) => c.evaluate(`(() => {
  const r = document.querySelector('${sel}')?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`);
const mouseClick = async (x, y) => {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const mouseDrag = async (x, y, dx, dy) => {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 5, y: y + (dy * i) / 5, button: 'left' });
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
};
const wheelAt = (x, y, deltaY) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
const btnClick = (sel) => c.evaluate(`[...document.querySelectorAll('${sel}')].find(b => !b.hidden)?.click()`);

/* ---------- 1. 图寻打开,猜测小地图挂载 ---------- */
const T = '.win[data-app=tuxun]';
await c.evaluate(`WebOS.wm.open('tuxun')`);
await sleep(1500);
/* 注意:mm-container 加在 tx-gm-canvas 同一个元素上,要用 .a.b 而不是 .a .b */
const gm = await c.evaluate(`(() => {
  const w = document.querySelector('${T}');
  if (!w) return { noWin: true };
  return {
    container: !!w.querySelector('.tx-gm-canvas.mm-container'),
    tiles: w.querySelectorAll('.tx-gm-canvas .mm-tile').length,
    zoom: w.querySelectorAll('.tx-gm-canvas .mm-zoom-btn').length,
    html: w.innerHTML.slice(0, 200),
  };
})()`);
if (gm.noWin || !gm.container) {
  console.log('DEBUG 控制台:', errors.slice(0, 5));
  console.log('DEBUG 窗口内容:', gm.html);
}
check('图寻窗口打开了', !gm.noWin, gm.noWin ? '没找到 .win[data-app=tuxun]' : '');
check('猜测小地图挂载:容器 / 缩放控件都在', gm.container && gm.zoom === 2, JSON.stringify(gm).slice(0, 120));

/* ---------- 2. 开局 → 真实鼠标点选猜测 ---------- */
await c.evaluate(`document.querySelector('${T} .tx-overlay:not([hidden]) .tx-panel .btn.primary')?.click()`);
await sleep(300);
const badge1 = await c.evaluate(`document.querySelector('${T} .badge-pill')?.textContent || ''`);
check('开局进入第 1 轮', /第 1\/5 轮/.test(badge1), badge1);

const gmRect = await rectOf(`${T} .tx-gm-canvas.mm-container`);
await mouseClick(gmRect.x, gmRect.y);
await sleep(200);
const guess = await c.evaluate(`(() => {
  const w = document.querySelector('${T}');
  return {
    marker: w.querySelectorAll('.tx-gm-canvas .mm-svg circle').length,
    submitEnabled: !w.querySelector('.tx-submit').disabled,
  };
})()`);
check('真实点击小地图放上了猜测点', guess.marker >= 1 && guess.submitEnabled, JSON.stringify(guess));

/* ---------- 3. 提交 → 结算图 ---------- */
await btnClick(`${T} .tx-submit`);
await sleep(1200);
const rm = await c.evaluate(`(() => {
  const w = document.querySelector('${T}');
  const r = w.querySelector('.tx-rmap');
  const tips = [...r.querySelectorAll('.mm-tooltip')].map(t => t.textContent.trim());
  return {
    visible: !!r && !w.querySelectorAll('.tx-overlay')[1].hidden,
    line: r.querySelectorAll('.mm-svg polyline').length,
    tips,
    tiles: r.querySelectorAll('.mm-tile').length,
    zoom: r.querySelectorAll('.mm-zoom-btn').length,
  };
})()`);
check('提交后结算浮层带小地图', rm.visible, '');
check('结算图画出真实点↔猜测点连线', rm.line === 1, `polyline=${rm.line}`);
check('结算图双标签都在(真实位置 / 你的猜测)',
  rm.tips.some(t => t.includes('真实位置')) && rm.tips.some(t => t.includes('你的猜测')), rm.tips.join(' | '));
check('结算图底图存活(addTo 返回值修好后不会被 eachLayer 清掉)', rm.tiles > 0 && rm.zoom === 2,
  `tiles=${rm.tiles} zoomBtn=${rm.zoom}`);

/* ---------- 4. 下一轮 ---------- */
await btnClick(`${T} .tx-actions .btn.primary`);
await sleep(300);
const badge2 = await c.evaluate(`document.querySelector('${T} .badge-pill')?.textContent || ''`);
check('进入第 2 轮,结算浮层收起', /第 2\/5 轮/.test(badge2), badge2);

/* ---------- 5. 与地图应用共存:双向互不干扰 ---------- */
await c.evaluate(`WebOS.wm.open('map')`);
await sleep(1500);
const coexist = await c.evaluate(`(() => ({
  mapWin: !!document.querySelector('.win[data-app=map] .mm-container'),
  tuxunTiles: document.querySelectorAll('${T} .tx-gm-canvas .mm-tile').length,
}))()`);
check('地图应用与图寻同时在场', coexist.mapWin && coexist.tuxunTiles > 0, JSON.stringify(coexist));

/* 真实鼠标点地图应用的缩放按钮:验证控件事件隔离(pointer capture 不再抢 click) */
const zb = await rectOf('.win[data-app=map] .mm-zoom-btn');
const zBefore = await c.evaluate(`window.__map.getZoom()`);
await mouseClick(zb.x, zb.y);
await sleep(500);
const zAfter = await c.evaluate(`window.__map.getZoom()`);
check('真实鼠标点击 + 按钮级别 +1(事件隔离生效)', zAfter === zBefore + 1, `${zBefore} → ${zAfter}`);

/* 滚轮起缩放动画,动画中途真实拖拽:应落到终态且地图不卡死 */
const mc = await rectOf('.win[data-app=map] .mm-container');
await wheelAt(mc.x, mc.y, -120);
await mouseDrag(mc.x, mc.y, -60, -40);
await sleep(450);
const zSnap = await c.evaluate(`window.__map.getZoom()`);
check('拖拽打断缩放动画:级别落到目标值', zSnap === zBefore + 2, `${zBefore + 1} → ${zSnap}`);
await wheelAt(mc.x, mc.y, -120);
await sleep(500);
const zNext = await c.evaluate(`window.__map.getZoom()`);
check('打断后滚轮缩放依旧响应(没有卡死)', zNext === zSnap + 1, `${zSnap} → ${zNext}`);

/* 切回图寻再点一次猜测:地图端的 pointer 活动不影响图寻的地图 */
await c.evaluate(`WebOS.wm.open('tuxun')`);
await sleep(300);
const gmRect2 = await rectOf(`${T} .tx-gm-canvas.mm-container`);
await mouseClick(gmRect2.x, gmRect2.y - 30);
await sleep(200);
const guess2 = await c.evaluate(`document.querySelectorAll('${T} .tx-gm-canvas .mm-svg circle').length`);
check('共存后图寻仍能正常点选猜测', guess2 >= 1, `marker=${guess2}`);

/* ---------- 6. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
