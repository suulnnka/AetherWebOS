/* 真实鼠标点击拾取验证:点击白棋 → 应出现青色选中环 */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const c = await launch('http://localhost:4173/?e2e=1');

for (let i = 0; i < 100; i++) {
  const r = await c.evaluate(`({ boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.dicon').length, os: !!window.WebOS })`);
  if (r.os && !r.boot && r.icons > 0) break;
  await sleep(150);
}
await c.evaluate(`WebOS.wm.open('chess3d')`);
await sleep(2500);

const rect = await c.evaluate(`(() => { const r = document.querySelector('.win[data-app=chess3d] canvas').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
const [L, T, W, H] = rect;
// 画面下方中央的白王大约在窗口 (462, 408) —— 相对画布归一化 (0.343, 0.58)
const px = Math.round(L + W * 0.343), py = Math.round(T + H * 0.58);
console.log('canvas rect:', rect, 'click at', px, py);

// 真实鼠标:按下 → 抬起(click 事件)
await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
await sleep(600);

const sel = await c.evaluate(`(() => {
  const w = document.querySelector('.win[data-app=chess3d]');
  const stats = window.__chess.stats();
  return { stats, turn: window.__chess.turn() };
})()`);
await c.shot('chess3d-pick');
console.log(JSON.stringify(sel, null, 2));
await c.close();
