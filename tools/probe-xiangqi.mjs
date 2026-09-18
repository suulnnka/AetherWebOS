/* 中国象棋应用探针:在真实浏览器里把 UI 与引擎走一遍
 *   1. 棋盘 90 个交叉点 / 32 个棋子
 *   2. 顶栏按钮组 + 底栏只有一条(状态 + 等宽搜索信息,没有第二条)
 *   3. 选中红兵 → 出现合法落点提示 → 点击落点真的走子
 *   4. AI(黑方)应答:plies 变 2,底栏右侧有引擎信息
 *   5. 难度下拉 4 档 + 初值同步
 *   6. 悔棋把人机对战撤 2 步
 *   7. 换边:玩家执黑、棋盘翻过来、AI 执红先行
 *   8. 无控制台报错
 *
 * 用法:先起 `vite preview --port 4173`,再 node tools/probe-xiangqi.mjs
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

/* ---------- 1. 棋盘结构 ---------- */
const shape = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  if (!w) return { noWin: true };
  return {
    pts: w.querySelectorAll('.xq-pt').length,
    pieces: w.querySelectorAll('.xq-piece').length,
    red: w.querySelectorAll('.xq-piece.red').length,
    black: w.querySelectorAll('.xq-piece.black').length,
    lines: !!w.querySelector('.xq-lines'),
    river: w.querySelector('.xq-river')?.textContent,
    stats: window.__xiangqi?.stats(),
    bars: w.querySelectorAll('.app-status').length,
    oldBar: w.querySelectorAll('.xq-search').length,
    buttons: [...w.querySelectorAll('.app-toolbar .btn')].map((b) => b.textContent.trim()),
    levelLabel: w.querySelector('.xq-level-wrap span')?.textContent,
    status: w.querySelector('.app-status span')?.textContent,
    info: w.querySelector('.app-status .mono')?.textContent,
  };
})()`);
check('窗口打开了', !shape.noWin, shape.noWin ? '没找到 .win[data-app=xiangqi]' : '');
check('棋盘 90 个交叉点', shape.pts === 90, String(shape.pts));
check('棋子 32 个(红黑各 16)', shape.pieces === 32 && shape.red === 16 && shape.black === 16,
  `${shape.pieces} = 红${shape.red} + 黑${shape.black}`);
check('棋盘线 + 河界文字已渲染', shape.lines && shape.river === '楚河', `河界:"${shape.river}"`);
check('初始状态:红先、0 手', shape.stats?.plies === 0 && shape.stats?.turn === 0, JSON.stringify(shape.stats));

/* ---------- 2. 顶栏 / 底栏(与国际象棋应用同款) ---------- */
check('底栏只有一条(没有第二条搜索行)', shape.bars === 1 && shape.oldBar === 0,
  `.app-status=${shape.bars} .xq-search=${shape.oldBar}`);
check('顶栏按钮组:新对局 / 人机 / 换边 / 悔棋',
  shape.buttons.join('|') === '新对局|人机|换边|悔棋', shape.buttons.join(' | '));
check('难度下拉带「难度」文字标签', shape.levelLabel === '难度', shape.levelLabel);
check('底栏左边是行棋状态', shape.status === '红方行棋', shape.status);

/* ---------- 3. 选中与落子 ---------- */
const sel = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  w.querySelector('.xq-pt[data-i="56"]').click();     // 红兵 (6,2)
  return { mv: w.querySelectorAll('.xq-pt.mv').length, cap: w.querySelectorAll('.xq-pt.cap').length,
           sel: w.querySelectorAll('.xq-pt.sel').length };
})()`);
check('点红兵出现 1 个可走位置(未过河只能直进)', sel.mv === 1 && sel.sel === 1, JSON.stringify(sel));

const moved = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  w.querySelector('.xq-pt[data-i="47"]').click();     // (5,2)
  return {
    fromEmpty: !w.querySelector('.xq-pt[data-i="56"] .xq-piece'),
    toHas: w.querySelector('.xq-pt[data-i="47"] .xq-piece')?.textContent,
    stats: window.__xiangqi.stats(),
    last: window.__xiangqi.lastText(),
  };
})()`);
check('点落点后真的走子了', moved.fromEmpty && moved.toHas === '兵', JSON.stringify(moved));
check('记谱正确(兵七进一)', moved.last === '兵七进一', moved.last);
check('轮到 AI:搜索已发起', moved.stats.plies === 1 && moved.stats.turn === 1, JSON.stringify(moved.stats));

/* ---------- 4. 等 AI 应答 ---------- */
let ai = null;
for (let i = 0; i < 60; i++) {
  ai = await c.evaluate(`({ stats: window.__xiangqi.stats(), last: window.__xiangqi.lastText(),
    search: document.querySelector('${W} .app-status .mono')?.textContent,
    status: document.querySelector('${W} .app-status span')?.textContent })`);
  if (ai.stats.plies === 2 && !ai.stats.searching) break;
  await sleep(250);
}
check('AI(黑方)应答,回到红方回合', ai.stats.plies === 2 && ai.stats.turn === 0, JSON.stringify(ai.stats));
check('AI 走的是中文记谱的一步', /^[前后]?[将士象马车炮卒]/.test(ai.last), ai.last);
check('底栏右侧有引擎信息(档位·深度·节点·耗时·评分)',
  /^.+ · 深度 \d+ · \d+k 节点 · \d+ms · [+-]/.test(ai.search), ai.search);
check('底栏左边回到「红方行棋」', ai.status === '红方行棋', ai.status);
console.log(`      AI 这一手:${ai.last} · ${ai.search}`);

/* ---------- 5. 难度下拉 ---------- */
const lv = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  const s = w.querySelector('select.xq-level');
  const opts = [...s.options].map(o => o.value + ':' + o.textContent);
  const initial = s.value + ':' + s.selectedOptions[0].textContent + '|' + window.__xiangqi.level();
  window.__xiangqi.setLevel(3);
  return { opts, initial, level: window.__xiangqi.level() };
})()`);
check('难度下拉 4 档,setLevel 同步', lv.opts.length === 4 && lv.level === 'master', lv.opts.join(' / ') + ' → ' + lv.level);
check('下拉初值与引擎档位一致(默认高级)', lv.initial === '2:高级|hard', lv.initial);

/* ---------- 6. 悔棋 ---------- */
const undo = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '悔棋').click();
  return { stats: window.__xiangqi.stats(), back: !!w.querySelector('.xq-pt[data-i="56"] .xq-piece') };
})()`);
check('悔棋一次撤 2 步(人机:自己的 + AI 的)', undo.stats.plies === 0 && undo.back, JSON.stringify(undo.stats));

/* ---------- 7. 换边:玩家执黑 + 棋盘翻转 + AI 执红先行 ---------- */
const before = await c.evaluate(`document.querySelector('${W} .xq-pt[data-i="85"]').style.top`); // 红帅
const sw = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '换边').click();
  return { stats: window.__xiangqi.stats(),
           kingTop: w.querySelector('.xq-pt[data-i="85"]').style.top,
           river: [...w.querySelectorAll('.xq-river')].map(t => t.textContent + '@' + t.getAttribute('x')).join(' ') };
})()`);
check('换边后玩家执黑', sw.stats.human === 1, JSON.stringify(sw.stats));
check('棋盘翻过来了(红帅从底部跑到顶部)', before === '513px' && sw.kingTop === '27px', `${before} → ${sw.kingTop}`);
check('河界文字随翻转对调', /楚河@351/.test(sw.river) && /漢界@135/.test(sw.river), sw.river);

let first = null;
for (let i = 0; i < 60; i++) {
  first = await c.evaluate(`({ stats: window.__xiangqi.stats(), last: window.__xiangqi.lastText() })`);
  if (first.stats.plies >= 1 && !first.stats.searching) break;
  await sleep(250);
}
check('AI 执红先行,走完轮到玩家(黑)', first.stats.plies === 1 && first.stats.turn === 1, JSON.stringify(first.stats));
check('AI 执红时记谱用汉字(红的字)', /^[前后]?[帅仕相马车炮兵]/.test(first.last), first.last);

/* ---------- 8. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
