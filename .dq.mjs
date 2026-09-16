import { launch } from './tools/cdp.mjs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const c = await launch('http://localhost:8080/');
const ev = (x) => c.evaluate(x);
await sleep(1800);
await ev(`WebOS.wm.open('qq')`);
await sleep(500);
await ev(`document.querySelector('.qq-login-btn').click()`);
await sleep(500);
await ev(`(() => { const i = document.querySelector('.qq-input'); i.value = '测试消息'; return !!i; })()`);
await ev(`(() => { [...document.querySelectorAll('.win[data-app=qq] .btn')].find(b => b.textContent.includes('发送')).click(); return true; })()`);
await sleep(1000);
console.log('storage:', await ev(`(localStorage.getItem('webos.qq.v1') || 'NULL').slice(0, 80)`));
await c.goto('http://localhost:8080/');
await sleep(2000);
await ev(`WebOS.wm.open('qq')`);
await sleep(700);
console.log(JSON.stringify(await ev(`({
  saved: (localStorage.getItem('webos.qq.v1') || 'NULL').slice(0, 60),
  login: !!document.querySelector('.qq-login'),
  top: !!document.querySelector('.qq-top'),
  me: document.querySelector('.qq-top b')?.textContent,
  winErr: document.querySelector('.win[data-app=qq] .win-error')?.textContent.slice(0, 100),
})`), null, 2));
await c.close();
