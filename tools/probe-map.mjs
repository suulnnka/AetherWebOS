/* ============================================================
 * 地图内核探针:在真实浏览器里验证自研 minimap(js/lib/minimap.js)
 *   1. 内核挂载:瓦片层 / 缩放控件 / 比例尺 / 版权
 *   2. Mercator 正反算自洽:latLng → 容器像素 → latLng 往返误差
 *   3. 瓦片 URL 真的发出去了(URL 模板展开正确)
 *   4. 缩放:+ 按钮让级别真的 +1,比例尺随级别更新
 *   5. 点击地图 → popup 显示 WGS-84 坐标
 *   6. 测距:两次打点 → polyline + 圆点 + 距离 tooltip
 *   7. 底图切换:新瓦片层挂载,版权文字跟着换
 *   8. 无控制台报错
 *
 * 为什么必须跑真浏览器:投影与瓦片拼接在 Node 里没法验证「画出来对不对」,
 * 而点击这类合成事件只有真实派发才能走到内核的 pointer/click 分支。
 *
 * 用法:先起 `node node_modules/vite/bin/vite.js preview`,再 node tools/probe-map.mjs
 * 注意本机 preview 只监听 [::1],要用 localhost 而不是 127.0.0.1
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

const W = '.win[data-app=map]';
await c.evaluate(`WebOS.wm.open('map')`);
await sleep(1500);

/* ---------- 1. 内核挂载 ---------- */
const dom = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  if (!w) return { noWin: true };
  return {
    container: !!w.querySelector('.mm-container'),
    tileLayer: !!w.querySelector('.mm-tile-layer'),
    svg: !!w.querySelector('.mm-svg'),
    zoom: w.querySelectorAll('.mm-zoom-btn').length,
    scale: (w.querySelector('.mm-scale-label')?.textContent || '').trim(),
    attrib: w.querySelector('.mm-attrib')?.textContent || '',
    tiles: w.querySelectorAll('.mm-tile').length,
    html: w.innerHTML.slice(0, 400),
  };
})()`);
if (dom.noWin || !dom.container) {
  console.log('DEBUG 控制台:', errors.slice(0, 5));
  console.log('DEBUG 窗口内容:', dom.html);
}
check('地图窗口打开了', !dom.noWin, dom.noWin ? '没找到 .win[data-app=map]' : '');
check('内核挂载:容器 / 瓦片层 / 矢量层都在',
  dom.container && dom.tileLayer && dom.svg, JSON.stringify(dom));
check('缩放控件 2 个按钮(+ / −)', dom.zoom === 2, String(dom.zoom));
check('比例尺有米制读数', /^\d+(\.\d+)?\s*(米|公里)$/.test(dom.scale), dom.scale);
check('版权控件带上了底图来源', dom.attrib.length > 0, dom.attrib);

/* ---------- 2. Mercator 正反算自洽 ---------- */
const geo = await c.evaluate(`(() => {
  const m = window.__map;
  m.setView([39.909, 116.397], 11);
  const c0 = m.getCenter();
  const p = m.latLngToContainer({ lat: 39.909, lng: 116.397 });
  const back = m.containerPointToLatLng(p.x, p.y);
  const sz = m.getSize();
  const centerBack = m.containerPointToLatLng(sz.x / 2, sz.y / 2);
  return {
    dLat: Math.abs(back.lat - 39.909), dLng: Math.abs(back.lng - 116.397),
    cLat: Math.abs(c0.lat - 39.909), cLng: Math.abs(c0.lng - 116.397),
    mLat: Math.abs(centerBack.lat - c0.lat), mLng: Math.abs(centerBack.lng - c0.lng),
    zoom: m.getZoom(),
  };
})()`);
check('投影往返自洽(latLng → 像素 → latLng,误差 < 1e-6)',
  geo.dLat < 1e-6 && geo.dLng < 1e-6, `Δlat=${geo.dLat.toExponential(2)} Δlng=${geo.dLng.toExponential(2)}`);
check('setView 后中心回到指定经纬度', geo.cLat < 1e-9 && geo.cLng < 1e-9,
  `Δ=${geo.cLat.toExponential(2)}, ${geo.cLng.toExponential(2)}`);
check('容器中心点反算 = 地图中心', geo.mLat < 1e-6 && geo.mLng < 1e-6,
  `Δ=${geo.mLat.toExponential(2)}, ${geo.mLng.toExponential(2)}`);

/* ---------- 3. 瓦片请求真的发出去了 ---------- */
await sleep(1200);
const tiles = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const urls = performance.getEntriesByType('resource').map(e => e.name).filter(n => /\\/\\d+\\/\\d+\\/\\d+(@2x)?\\.png/.test(n));
  return { count: w.querySelectorAll('.mm-tile').length, first: urls[0] || '', total: urls.length };
})()`);
check('瓦片 URL 按 {z}/{x}/{y} 展开并发出了请求',
  tiles.total > 0, `${tiles.total} 个请求,例:${tiles.first || '(无)'}`);
check('视口内挂上了瓦片 img', tiles.count > 0, `${tiles.count} 张`);

/* ---------- 4. 缩放 ---------- */
const zoomed = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const before = window.__map.getZoom();
  const scaleBefore = w.querySelector('.mm-scale-label').textContent;
  w.querySelectorAll('.mm-zoom-btn')[0].click();
  return { before, scaleBefore };
})()`);
await sleep(500);
const after = await c.evaluate(`({ zoom: window.__map.getZoom(), scale: document.querySelector('${W} .mm-scale-label').textContent })`);
check('点 + 按钮后级别 +1', after.zoom === zoomed.before + 1, `${zoomed.before} → ${after.zoom}`);
check('比例尺随级别更新', after.scale !== zoomed.scaleBefore, `${zoomed.scaleBefore} → ${after.scale}`);

/* ---------- 5. 点击取坐标 ---------- */
const clicked = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const box = w.querySelector('.mm-container');
  const r = box.getBoundingClientRect();
  box.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  const pop = w.querySelector('.mm-popup');
  return { has: !!pop, text: pop?.textContent || '' };
})()`);
check('点击地图弹出 WGS-84 坐标气泡',
  clicked.has && /WGS-84/.test(clicked.text) && /\d+\.\d{6}/.test(clicked.text),
  clicked.text.slice(0, 64));

/* ---------- 6. 测距 ---------- */
await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('测距')).click();
})()`);
const pt = await c.evaluate(`(() => {
  const r = document.querySelector('${W} .mm-container').getBoundingClientRect();
  return { x1: r.left + r.width * 0.35, y1: r.top + r.height * 0.4,
           x2: r.left + r.width * 0.6, y2: r.top + r.height * 0.6 };
})()`);
for (const [x, y] of [[pt.x1, pt.y1], [pt.x2, pt.y2]]) {
  await c.evaluate(`(() => {
    document.querySelector('${W} .mm-container')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${x}, clientY: ${y} }));
  })()`);
  await sleep(400);
}
const meas = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  return {
    tip: (w.querySelector('.mm-tooltip')?.textContent || '').trim(),
    pts: (w.querySelector('.mm-svg polyline')?.getAttribute('points') || '').trim().split(/\\s+/).filter(Boolean).length,
    dots: w.querySelectorAll('.mm-svg circle').length,
  };
})()`);
check('测距打点画出折线(2 个端点)', meas.pts === 2, `points=${meas.pts}`);
check('测距 tooltip 显示距离', /\d/.test(meas.tip) && /(米|公里)/.test(meas.tip), meas.tip);

/* ---------- 7. 底图切换 ---------- */
const base = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const before = w.querySelector('.mm-attrib').textContent;
  [...w.querySelectorAll('.mp-seg .seg-btn')].find(b => b.textContent === '卫星').click();
  return { before };
})()`);
await sleep(1200);
const afterBase = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const urls = performance.getEntriesByType('resource').map(e => e.name).filter(n => /arcgisonline/.test(n));
  return { attrib: w.querySelector('.mm-attrib').textContent, esri: urls.length };
})()`);
check('切到卫星图后版权换成 Esri', /Esri/.test(afterBase.attrib) && afterBase.attrib !== base.before, afterBase.attrib);
check('卫星瓦片确实去 Esri 取了', afterBase.esri > 0, `${afterBase.esri} 个请求`);

/* ---------- 8. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
