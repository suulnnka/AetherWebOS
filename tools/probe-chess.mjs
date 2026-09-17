/* 3D 象棋真实渲染验证:打开窗口 → 断言渲染器在出帧 → 回读画布像素是否真的有内容 */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const URL = 'http://localhost:4173/?e2e=1';

const c = await launch(URL);
const errors = [];
c.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    errors.push(m.params.type + ': ' + m.params.args.map(a => a.description || a.value).join(' '));
  }
});
await c.send('Log.enable').catch(() => {});

// 等桌面就绪
for (let i = 0; i < 100; i++) {
  const r = await c.evaluate(`({ boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.dicon').length, os: !!window.WebOS })`);
  if (r.os && !r.boot && r.icons > 0) break;
  await sleep(150);
}

await c.evaluate(`WebOS.wm.open('chess3d')`);
await sleep(2500);   // SwiftShader 软渲染首帧较慢

const info = await c.evaluate(`(async () => {
  const w = document.querySelector('.win[data-app=chess3d]');
  if (!w) return { err: '窗口未打开' };
  const canvas = w.querySelector('canvas');
  const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
  return {
    hasCanvas: !!canvas,
    canvasSize: canvas ? [canvas.width, canvas.height] : null,
    cssSize: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
    winError: (w.querySelector('.win-error')?.textContent || '').slice(0, 200) || null,
    hasHook: !!window.__chess,
    renderer: gl ? gl.getParameter(gl.RENDERER) : null,
    contextLost: gl ? gl.isContextLost() : null,
    statsBefore: window.__chess?.stats?.() ?? null,
  };
})()`);
await sleep(600);
const statsAfter = await c.evaluate(`window.__chess?.stats?.() ?? null`);

await c.shot('chess3d-fix');

// 回读成品截图里「画布矩形」区域的像素多样性:画面若真的渲染了棋盘+棋子,
// 颜色种类与亮度方差都会显著高于纯背景。
const pixel = await c.evaluate(`(async () => {
  const b64 = ${JSON.stringify((await c.send('Page.captureScreenshot', { format: 'png' })).data)};
  const canvas = document.querySelector('.win[data-app=chess3d] canvas');
  const r = canvas.getBoundingClientRect();
  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const x0 = Math.round(r.left), y0 = Math.round(r.top);
      const w = Math.round(r.width), h = Math.round(r.height);
      const px = g.getImageData(x0, y0, w, h).data;
      const seen = new Set(); let sum = 0, sum2 = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) {
        seen.add((px[i] >> 3) + ',' + (px[i+1] >> 3) + ',' + (px[i+2] >> 3));
        const l = 0.2126*px[i] + 0.7152*px[i+1] + 0.0722*px[i+2];
        sum += l; sum2 += l*l; n++;
      }
      const mean = sum / n;
      resolve({ region: [x0, y0, w, h], distinctColors: seen.size, luminosityMean: +mean.toFixed(1), luminosityStd: +Math.sqrt(sum2/n - mean*mean).toFixed(1) });
    };
    img.src = 'data:image/png;base64,' + b64;
  });
})()`);

// 走一步棋,确认交互链路与重绘都活着
const move = await c.evaluate(`(async () => {
  const before = JSON.stringify(window.__chess.board());
  window.__chess.click(6, 4); await new Promise(r => setTimeout(r, 200));
  window.__chess.click(4, 4); await new Promise(r => setTimeout(r, 1400));
  return { changed: JSON.stringify(window.__chess.board()) !== before, turn: window.__chess.turn(), stats: window.__chess.stats() };
})()`);
await c.shot('chess3d-fix-after-move');

console.log(JSON.stringify({ info, statsAfter, pixel, move, errors }, null, 2));
await c.close();
