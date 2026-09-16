import { launch } from './tools/cdp.mjs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const c = await launch('http://localhost:8080/');
const ev = (x) => c.evaluate(x);
await sleep(2200);
console.log(JSON.stringify(await ev(`(() => ({
  errs: window.__errs.slice(0, 3),
  icons: document.querySelectorAll('.dicon').length,
  apps: WebOS.apps.list().map(a => a.id).filter(id => ['minesweeper','chess3d'].includes(id)),
}))()`)));
// 打开扫雷检查棋盘
await ev(`WebOS.wm.open('minesweeper')`);
await sleep(600);
console.log('minesweeper cells:', await ev(`document.querySelectorAll('.ms-cell').length`));
// 打开 3D 象棋检查 canvas
await ev(`WebOS.wm.open('chess3d')`);
await sleep(1500);
console.log('chess canvas:', await ev(`!!document.querySelector('.win[data-app=chess3d] canvas')`));
console.log('errs2:', await ev(`window.__errs.length`));
await c.close();
