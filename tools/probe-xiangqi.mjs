/* 中国象棋应用探针:在真实浏览器里把 UI 与引擎走一遍
 *   1. 棋盘 90 个交叉点 / 32 个棋子
 *   2. 选中红兵 → 出现合法落点提示 → 点击落点真的走子
 *   3. AI(黑方)应答:plies 变 2,搜索信息行有深度/评分
 *   4. 难度下拉 4 档 + setLevel 同步
 *   5. 悔棋把人机对战撤 2 步
 *   6. 无控制台报错
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
  };
})()`);
check('窗口打开了', !shape.noWin, shape.noWin ? '没找到 .win[data-app=xiangqi]' : '');
check('棋盘 90 个交叉点', shape.pts === 90, String(shape.pts));
check('棋子 32 个(红黑各 16)', shape.pieces === 32 && shape.red === 16 && shape.black === 16,
  `${shape.pieces} = 红${shape.red} + 黑${shape.black}`);
check('棋盘线 + 河界文字已渲染', shape.lines && shape.river === '楚河', `河界:"${shape.river}"`);
check('初始状态:红先、0 手', shape.stats?.plies === 0 && shape.stats?.turn === 0, JSON.stringify(shape.stats));

/* ---------- 2. 选中与落子 ---------- */
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

/* ---------- 3. 等 AI 应答 ---------- */
let ai = null;
for (let i = 0; i < 60; i++) {
  ai = await c.evaluate(`({ stats: window.__xiangqi.stats(), last: window.__xiangqi.lastText(),
    search: document.querySelector('${W} .xq-search')?.textContent })`);
  if (ai.stats.plies === 2 && !ai.stats.searching) break;
  await sleep(250);
}
check('AI(黑方)应答,回到红方回合', ai.stats.plies === 2 && ai.stats.turn === 0, JSON.stringify(ai.stats));
check('AI 走的是中文记谱的一步', /^[前后]?[将士象马车炮卒]/.test(ai.last), ai.last);
check('搜索信息行有深度/评分/节点', /深度\s*\d/.test(ai.search) && /节点/.test(ai.search), ai.search);
console.log(`      AI 这一手:${ai.last} · ${ai.search}`);

/* ---------- 4. 难度下拉 ---------- */
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

/* ---------- 5. 悔棋 ---------- */
const undo = await c.evaluate(`(() => {
  const w = document.querySelector('${W}');
  [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent === '悔棋').click();
  return { stats: window.__xiangqi.stats(), back: !!w.querySelector('.xq-pt[data-i="56"] .xq-piece') };
})()`);
check('悔棋一次撤 2 步(人机:自己的 + AI 的)', undo.stats.plies === 0 && undo.back, JSON.stringify(undo.stats));

/* ---------- 6. 控制台 ---------- */
check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '✗ ' + bad.length + ' 项失败' : '✓ 全部通过'}(${results.length} 项)`);
await c.close?.();
process.exit(bad.length ? 1 : 0);
