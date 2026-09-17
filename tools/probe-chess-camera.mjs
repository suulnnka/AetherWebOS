/* 视角控制验证:标准俯角初始姿态 / 归正按钮 / 换边后保留朝向 / 触控板捏合 / 双指旋转+捏合 */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const c = await launch('http://localhost:4173/?e2e=1');
const errors = [];
c.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    errors.push(m.params.type + ': ' + m.params.args.map(a => a.description || a.value).join(' '));
  }
});
await c.send('Log.enable').catch(() => {});

for (let i = 0; i < 100; i++) {
  const r = await c.evaluate(`({ boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.dicon').length, os: !!window.WebOS })`);
  if (r.os && !r.boot && r.icons > 0) break;
  await sleep(150);
}
await c.evaluate(`WebOS.wm.open('chess3d')`);
await sleep(3000);

const view = () => c.evaluate(`window.__chess.home()`);
const clickBtn = (label) => c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.win[data-app=chess3d] .app-toolbar button')];
  const b = btns.find(x => x.textContent.includes('${label}'));
  if (!b) throw new Error('按钮未找到: ${label}');
  b.click(); return true;
})()`);

// 页面里注入的辅助:合成拖拽 / 双指 / ctrl+wheel
const HELPERS = `
  window.__g = {
    canvas: () => document.querySelector('.win[data-app=chess3d] canvas'),
    center() { const r = this.canvas().getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; },
    ev(id, x, y, type, target) {
      target.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: id === 1, buttons: type === 'pointerup' ? 0 : 1 }));
    },
    async drag(dx, dy) {
      const [cx, cy] = this.center(), cv = this.canvas();
      this.ev(1, cx, cy, 'pointerdown', cv);
      for (let k = 1; k <= 10; k++) { this.ev(1, cx + dx*k/10, cy + dy*k/10, 'pointermove', window); await new Promise(r => setTimeout(r, 16)); }
      this.ev(1, cx + dx, cy + dy, 'pointerup', window);
    },
    async pinchRotate(rotDeg, ratio) {
      const [cx, cy] = this.center(), cv = this.canvas();
      const R = 60;
      this.ev(1, cx - R, cy, 'pointerdown', cv);
      this.ev(2, cx + R, cy, 'pointerdown', cv);
      await new Promise(r => setTimeout(r, 40));
      const steps = 12;
      for (let k = 1; k <= steps; k++) {
        const a = (rotDeg * Math.PI / 180) * k / steps;
        const d = R * (1 + (ratio - 1) * k / steps);
        this.ev(1, cx - d*Math.cos(a), cy - d*Math.sin(a), 'pointermove', window);
        this.ev(2, cx + d*Math.cos(a), cy + d*Math.sin(a), 'pointermove', window);
        await new Promise(r => setTimeout(r, 16));
      }
      const out = window.__chess.home();
      const a = rotDeg * Math.PI / 180, d = R * ratio;
      this.ev(1, cx - d*Math.cos(a), cy - d*Math.sin(a), 'pointerup', window);
      this.ev(2, cx + d*Math.cos(a), cy + d*Math.sin(a), 'pointerup', window);
      return out;
    },
    wheel(dy, ctrl) {
      const [cx, cy] = this.center();
      this.canvas().dispatchEvent(new WheelEvent('wheel', { clientX: cx, clientY: cy, deltaY: dy, ctrlKey: ctrl, bubbles: true, cancelable: true }));
      return window.__chess.home();
    },
  };
  true;
`;
await c.evaluate(HELPERS);

const R2D = 180 / Math.PI;
const out = {};

// 1. 初始姿态应为「65° 俯角」标准视角
out.initial = await view();

// 2. 小幅拖歪之后点「归正」→ 回到 65°(小幅拖拽不会触发翻面判定,应回到白方标准位)
await c.evaluate(`window.__g.drag(60, 40)`);
await sleep(200);
out.afterDrag = await view();
await clickBtn('归正');
await sleep(600);
out.afterHome = await view();

// 3. 双指转 180° 到黑方一侧,再点「归正」→ 俯角/距离复原,但保留黑方朝向
const boardBefore = await c.evaluate(`JSON.stringify(window.__chess.board())`);
await c.evaluate(`window.__g.pinchRotate(180, 1)`);
await sleep(150);
out.blackSide = await view();
await clickBtn('归正');
await sleep(600);
out.blackHome = await view();

// 4. 触控板捏合(ctrl+wheel):放大应拉近,反之拉远
out.pinchOpen = await c.evaluate(`window.__g.wheel(-160, true)`);
out.pinchClose = await c.evaluate(`window.__g.wheel(240, true)`);
await clickBtn('归正'); await sleep(600);

// 5. 双指旋转 + 捏合:转 90° 同时两指张开到 1.3 倍(应拉近)
const before = await view();
out.twoFinger = await c.evaluate(`window.__g.pinchRotate(90, 1.3)`);
out.twoFingerBefore = before;

// 6. 双指手势结束后不应误触发走子(用「手势前」的棋盘快照对比)
await sleep(300);
out.boardUnchanged = JSON.stringify(await c.evaluate(`window.__chess.board()`)) === boardBefore;

await clickBtn('归正'); await sleep(600);
await c.shot('chess3d-home');
out.stats = await c.evaluate(`window.__chess.stats()`);
out.errors = errors;

// 判定
// theta 是可能累加多圈的连续量,比较朝向要先归一化到 [-π, π]
const norm = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const sideOf = (t) => (Math.abs(norm(t - out.initial.theta)) > Math.PI / 2 ? 'black' : 'white');
const chk = [];
const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol;
chk.push(['初始俯角 65°', near(out.initial.俯角, 65, 0.5)]);
chk.push(['初始距离 13', near(out.initial.radius, 13, 0.01)]);
chk.push(['拖拽改变了视角', !near(out.afterDrag.theta, out.initial.theta) && !near(out.afterDrag.俯角, 65, 0.5)]);
chk.push(['归正回到 65°', near(out.afterHome.俯角, 65, 0.5)]);
chk.push(['归正回到默认朝向', sideOf(out.afterHome.theta) === 'white' && near(norm(out.afterHome.theta - out.initial.theta), 0)]);
chk.push(['归正回到默认距离', near(out.afterHome.radius, 13, 0.01)]);
chk.push(['双指转 180° 后是黑方视角', sideOf(out.blackSide.theta) === 'black']);
chk.push(['黑方归正保留朝向', sideOf(out.blackHome.theta) === 'black' && near(Math.abs(norm(out.blackHome.theta - out.initial.theta)), Math.PI, 0.02)]);
chk.push(['黑方归正仍是 65°', near(out.blackHome.俯角, 65, 0.5) && near(out.blackHome.radius, 13, 0.01)]);
chk.push(['捏合张开→拉近', out.pinchOpen.radius < 13 - 0.5]);
chk.push(['捏合收拢→拉远', out.pinchClose.radius > out.pinchOpen.radius + 0.5]);
chk.push(['双指旋转 90°', near((out.twoFinger.theta - out.twoFingerBefore.theta) * R2D, 90, 3)]);
chk.push(['双指张开→拉近', out.twoFinger.radius < out.twoFingerBefore.radius - 0.5]);
chk.push(['手势后未误走子', out.boardUnchanged === true]);
chk.push(['零控制台报错', errors.length === 0]);

const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]));
console.log(JSON.stringify({
  views: Object.fromEntries(Object.entries(out).filter(([k]) => !['stats', 'errors'].includes(k)).map(([k, v]) => [k, typeof v === 'object' && v && 'theta' in v ? round(v) : v])),
  stats: out.stats, errors: out.errors,
}, null, 2));
console.log('\n=== 断言 ===');
let fail = 0;
for (const [name, ok] of chk) { if (!ok) fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); }
console.log(fail ? `\n${fail} 项未通过` : '\n全部通过');
await c.close();
