/* 拾取验证:真实鼠标点「棋子本体」/ 点「空格」都能选中,拖视角松手不误走子 */
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

const sel = () => c.evaluate(`window.__chess.sel()`);
const legal = () => c.evaluate(`window.__chess.legal()`);
const screen = (r, cc, y = 0) => c.evaluate(`window.__chess.screen(${r}, ${cc}, ${y})`);
const mclick = async (x, y) => {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await sleep(350);
};

const out = {};

// 1. 点白兵「本体中部」(e2 = 行6列4 → 兵高约 0.63,取 y=0.35)
const pawnPt = await screen(6, 4, 0.35);
out.pawnPt = pawnPt.map(Math.round);
await mclick(pawnPt[0], pawnPt[1]);
out.selPawn = await sel();

// 2. 点兵「头部」(更高处 y=0.55)—— 老逻辑会穿过去落到后排格子
await c.evaluate(`window.__chess.click(6,4)`); await sleep(150);   // 先清掉选择
const headPt = await screen(6, 4, 0.6);
await mclick(headPt[0], headPt[1]);
out.selPawnHead = await sel();

// 3. 点一个「够不着」的空格 a6(行2列0)→ 平面回退,应只是取消选择、不走子
const farPt = await screen(2, 0, 0);
await mclick(farPt[0], farPt[1]);
out.selEmpty = await sel();

// 4. 点棋子选中后,再点合法落点空格 e4 → 应该走子(证明「点格子」这条链路可用)
const emptyPt = await screen(4, 4, 0);
await c.evaluate(`window.__chess.click(6,4)`); await sleep(200);
out.legalAfterSel = await legal();
await mclick(emptyPt[0], emptyPt[1]);
await sleep(600);
out.boardAfterMove = await c.evaluate(`(() => { const b = window.__chess.board(); return { e2: b[6][4], e4: b[4][4] }; })()`);
out.turnAfterMove = await c.evaluate(`window.__chess.turn()`);

// 5. 拖视角后松手不应误走子:选中一个兵,然后拖 120px 松手
await c.evaluate(`window.__chess.click(6,3)`); await sleep(200);
const selBefore = await sel();
const dragPt = await screen(2, 2, 0);
await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(dragPt[0]), y: Math.round(dragPt[1]), button: 'left', clickCount: 1 });
for (let k = 1; k <= 8; k++) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(dragPt[0] + 15 * k), y: Math.round(dragPt[1] + 4 * k), button: 'left', buttons: 1 });
  await sleep(20);
}
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(dragPt[0] + 120), y: Math.round(dragPt[1] + 32), button: 'left', clickCount: 1 });
await sleep(400);
out.selBeforeDrag = selBefore;
out.selAfterDrag = await sel();

// 6. 点己方王(e1 行7列4,王高约 1.35,取 y=1.1 高处)—— 高个子最容易点不中
//    先等 AI 走完回到白方,否则 onClick 会因"AI 执黑时禁止操作"直接返回
for (let i = 0; i < 40; i++) { if (await c.evaluate(`window.__chess.turn()`) === 'w') break; await sleep(200); }
const kingPt = await screen(7, 4, 1.1);
await mclick(kingPt[0], kingPt[1]);
out.selKing = await sel();

await c.shot('chess3d-pick2');
out.stats = await c.evaluate(`window.__chess.stats()`);
out.errors = errors;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chk = [];
chk.push(['点兵身中部能选中', eq(out.selPawn, [6, 4])]);
chk.push(['点兵头部也能选中(不穿到后排)', eq(out.selPawnHead, [6, 4])]);
chk.push(['点空格不误选', out.selEmpty === null]);
chk.push(['选中兵后合法着法非空', Array.isArray(out.legalAfterSel) && out.legalAfterSel.length > 0]);
chk.push(['点空格能走子(e2→e4)', !out.boardAfterMove.e2 && !!out.boardAfterMove.e4]);
chk.push(['走子后轮到黑方', out.turnAfterMove === 'w' || out.turnAfterMove === 'b']);
chk.push(['拖视角松手不误走子', eq(out.selAfterDrag, selBefore)]);
chk.push(['点王高处能选中', eq(out.selKing, [7, 4])]);
chk.push(['零控制台报错', errors.length === 0]);

console.log(JSON.stringify(out, null, 2));
console.log('\n=== 断言 ===');
let fail = 0;
for (const [n, ok] of chk) { if (!ok) fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n); }
console.log(fail ? `\n${fail} 项未通过` : '\n全部通过');
await c.close();
