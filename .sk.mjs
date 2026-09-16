import { launch } from './tools/cdp.mjs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const c = await launch('http://localhost:8080/');
const ev = (x) => c.evaluate(x);
await sleep(2000);
await ev(`WebOS.wm.open('sokoban')`);
await sleep(700);
console.log(JSON.stringify(await ev(`(() => ({
  cells: document.querySelectorAll('.soko-cell').length,
  status: document.querySelector('.win[data-app=sokoban] .app-status span').textContent,
  errs: window.__errs.length,
}))()`)));
await c.close();
