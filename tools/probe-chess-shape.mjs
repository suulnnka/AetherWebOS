/* 棋子造型近距离检查:打开窗口 → 缩放+旋转视角 → 多角度截图 */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const URL = 'http://localhost:4173/?e2e=1';

const c = await launch(URL);
await c.send('Runtime.enable').catch(() => {});

for (let i = 0; i < 100; i++) {
  const r = await c.evaluate(`({ boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.dicon').length, os: !!window.WebOS })`);
  if (r.os && !r.boot && r.icons > 0) break;
  await sleep(150);
}

await c.evaluate(`WebOS.wm.open('chess3d')`);
await sleep(3000);

// 视角拖拽辅助:在画布上做 pointer 拖动
const drag = async (dx, dy) => {
  await c.evaluate(`(async () => {
    const canvas = document.querySelector('.win[data-app=chess3d] canvas');
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = ${dx}, dy = ${dy};
    const opts = (x, y, type) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true, buttons: 1 });
    canvas.dispatchEvent(opts(cx, cy, 'pointerdown'));
    for (let k = 1; k <= 8; k++) {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: cx + dx * k / 8, clientY: cy + dy * k / 8, bubbles: true, pointerId: 1, isPrimary: true, buttons: 1 }));
      await new Promise(r => setTimeout(r, 30));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })()`);
  await sleep(500);
};

// 滚轮缩放
const zoom = async (dy) => {
  await c.evaluate(`( () => {
    const canvas = document.querySelector('.win[data-app=chess3d] canvas');
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width/2, clientY: r.top + r.height/2, deltaY: ${dy}, bubbles: true, cancelable: true }));
  })()`);
  await sleep(400);
};

// 1. 缩近白方棋子,低角度侧视
await zoom(-900); await zoom(-900); await zoom(-900);
await drag(0, 260);          // 压低视角
await c.shot('chess3d-shape-side');
// 2. 转到侧面看马头轮廓
await drag(-500, 0);
await c.shot('chess3d-shape-side2');
// 3. 高角度俯视整体
await drag(300, -300);
await c.shot('chess3d-shape-top');

console.log('done');
await c.close();
