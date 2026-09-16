import { launch } from './tools/cdp.mjs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const c = await launch('http://localhost:8080/');
const ev = (x) => c.evaluate(x);
await sleep(2200);
for (let i = 0; i < 10 && !(await ev(`WebOS.apps.list().some(a => a.id === 'sokoban')`)); i++) await sleep(400);
await ev(`WebOS.wm.open('sokoban')`);
await sleep(700);
console.log(JSON.stringify(await ev(`(() => ({
  cells: document.querySelectorAll('.soko-cell').length,
  status: document.querySelector('.win[data-app=sokoban] .app-status span').textContent,
  boxes: document.querySelectorAll('.soko-cell.box').length,
  goals: document.querySelectorAll('.soko-cell.goal').length,
  errs: window.__errs.length,
}))()`)));
// 方向键移动测试:玩家在 (3,2),目标箱在 (2,2)。向上推一格
await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }))`);
await sleep(300);
const moved = await ev(`(() => ({
  playerPos: [...document.querySelectorAll('.soko-cell')].findIndex(c => c.classList.contains('player')),
  pushes: document.querySelector('.win[data-app=sokoban] .app-status .mono')?.textContent,
}))()`);
console.log('推箱后:', JSON.stringify(moved));
await c.close();
