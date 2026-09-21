/* 中国象棋终局探针:终局结算的时序与缓冲期回归
 *   1. 切双人模式,按一条合作将死线(炮八进二/车1进1/炮八平七/士6进5/炮七进五)点完 5 手
 *   2. 最后一手落地瞬间:棋盘已画上终局画面(送杀炮在目标格、起点空、最后一手
 *      高亮、被将死的黑将带将军高亮),结算弹窗**还没**弹(600ms 缓冲)
 *   3. 缓冲期内点「新对局」→ 弹窗被取消,永不出现,对局干净重开
 *   4. 再打一遍将死、不打扰缓冲期 → 弹窗如期出现,内容与棋盘终局画面都正确
 *
 * 用法:先起 `vite preview --port 4173`,再 node tools/probe-xiangqi-mate.mjs
 */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'http://localhost:4173/?e2e=1';

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

const W = '.win[data-app=xiangqi]';
await c.evaluate(`WebOS.wm.open('xiangqi')`);
await sleep(1500);

/* 切双人:双方都由探针点,合作将死线才可控 */
await c.evaluate(`[...document.querySelector('${W}').querySelectorAll('.app-toolbar .btn')]
  .find(b => b.textContent === '人机').click()`);
await sleep(120);

/* 合作将死线(引擎 DFS 搜索得出):from → to */
const LINE = [[64, 46], [0, 9], [46, 47], [5, 13], [47, 2]];
const TEXTS = ['炮八进二', '车1进1', '炮八平七', '士6进5', '炮七进五'];

/** 打一遍将死线;返回最后一手的记谱是否如期落地 */
async function playMateLine() {
  for (let k = 0; k < LINE.length; k++) {
    const [from, to] = LINE[k];
    await c.evaluate(`document.querySelector('${W} .xq-pt[data-i="${from}"]').click()`);
    await c.evaluate(`document.querySelector('${W} .xq-pt[data-i="${to}"]').click()`);
    /* hist.push 是同步的,plies 立刻变;记谱回填才是 state 回包落地的信号 */
    let landed = false;
    for (let i = 0; i < 40; i++) {
      const last = await c.evaluate(`window.__xiangqi.lastText()`);
      if (last === TEXTS[k]) { landed = true; break; }
      await sleep(50);
    }
    if (!landed) return false;
  }
  return true;
}

/** 终局画面的 DOM 断言(弹窗是否打开由调用方另行断言) */
const FINALS_JS = `(() => {
  const w = document.querySelector('${W}');
  const dlg = document.querySelector('.win[data-app=sysdialog]');
  return {
    gameOver: window.__xiangqi.stats().gameOver,
    dlgOpen: !!dlg,
    dlgTitle: dlg?.querySelector('.dlg-title')?.textContent,
    dlgMsg: dlg?.querySelector('.dlg-msg')?.textContent,
    toPiece: w.querySelector('.xq-pt[data-i="2"] .xq-piece')?.textContent,
    fromEmpty: !w.querySelector('.xq-pt[data-i="47"] .xq-piece'),
    lastCls: w.querySelector('.xq-pt[data-i="2"]')?.className,
    mateKingChk: w.querySelector('.xq-pt[data-i="4"] .xq-piece')?.className,
    status: w.querySelector('.app-status span')?.textContent,
  };
})()`;

/* ---------- 第 1 局:将死后立刻点新对局,结算弹窗必须被取消 ---------- */
check('第 1 局将死线走完', await playMateLine());

const fin1 = await c.evaluate(FINALS_JS);
check('终局置位;棋盘已画上最后一手(炮在目标格、起点空了)',
  fin1.gameOver && fin1.toPiece === '炮' && fin1.fromEmpty,
  JSON.stringify({ gameOver: fin1.gameOver, toPiece: fin1.toPiece, fromEmpty: fin1.fromEmpty }));
check('目标格带最后一手高亮 + 被将死的黑将带将军高亮',
  /last/.test(fin1.lastCls || '') && /chk/.test(fin1.mateKingChk || ''),
  `${fin1.lastCls} / ${fin1.mateKingChk}`);
check('结算弹窗没有立刻弹(有缓冲期)', !fin1.dlgOpen);

/* 缓冲期内点新对局:弹窗要被取消,不能在新对局上蹦出上一局的结算框 */
await c.evaluate(`[...document.querySelector('${W}').querySelectorAll('.app-toolbar .btn')]
  .find(b => b.textContent === '新对局').click()`);
await sleep(1200);   // 远超 600ms 缓冲:弹窗要是没取消,现在早就弹出来了
const fin2 = await c.evaluate(`({
  stats: window.__xiangqi.stats(), dlgOpen: !!document.querySelector('.win[data-app=sysdialog]') })`);
check('缓冲期内新对局 → 结算弹窗被取消', !fin2.dlgOpen && !fin2.stats.gameOver && fin2.stats.plies === 0,
  JSON.stringify(fin2));

/* ---------- 第 2 局:将死后不打扰,弹窗如期出现 ---------- */
check('第 2 局将死线走完', await playMateLine());
let fin3 = null;
for (let i = 0; i < 30; i++) {          // 等缓冲期(600ms)内弹窗出现
  fin3 = await c.evaluate(FINALS_JS);
  if (fin3.dlgOpen) break;
  await sleep(50);
}
check('结算弹窗在缓冲期后出现,标题「将死」、报红方获胜',
  fin3.dlgOpen && fin3.dlgTitle === '将死' && /红方.*获胜/.test(fin3.dlgMsg || ''),
  JSON.stringify({ dlgTitle: fin3.dlgTitle, dlgMsg: fin3.dlgMsg }));
check('弹窗下棋盘仍是终局画面(炮在目标格、起点空了、状态栏终局文案)',
  fin3.toPiece === '炮' && fin3.fromEmpty && /将死 — 红方胜/.test(fin3.status || ''),
  JSON.stringify({ toPiece: fin3.toPiece, fromEmpty: fin3.fromEmpty, status: fin3.status }));

/* 收尾:关掉弹窗,别给后续用例留模态 */
await c.evaluate(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')]
  .find(b => b.textContent === '确定')?.click()`);
await sleep(120);

check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
