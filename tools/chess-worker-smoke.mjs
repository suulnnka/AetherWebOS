#!/usr/bin/env node
/* ============================================================
 * 引擎 worker 冒烟测试(针对 dist 里的真实产物,不是源码)
 *
 * 源码级测试在引擎子项目 vendor/AetherChess 里跑(test/engine-test.mjs),
 * 验证的是「逻辑对不对」。这个脚本验证的是另一件事:
 * 打包 + 压缩之后,那个真正的 worker chunk 还能不能
 *   ① 重演一条走法序列(→ replayMoves 与两套走法编码在产物里没坏)
 *   ② 返回合法着法、迭代加深到位(→ searchBest 没被 tree-shaking 摇掉)
 * 发布形态与源码形态是两回事,这一步接的是「产物级」回归。
 *
 * 用法:node tools/chess-worker-smoke.mjs [worker chunk 路径]
 *      不给路径时自动在 dist/assets 里按 ENGINE_TAG 找。
 * 退出码:0 通过 / 1 失败
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TAG = 'chess-engine-v2';

function findChunk() {
  const given = process.argv[2];
  if (given) return given;
  const assets = path.join('dist', 'assets');
  if (!fs.existsSync(assets)) throw new Error(`找不到 ${assets} —— 先执行 npm run build`);
  const hit = fs.readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(assets, f))
    .filter((p) => fs.readFileSync(p, 'utf8').includes(TAG));
  if (!hit.length) throw new Error(`dist 里找不到带标记 "${TAG}" 的引擎 chunk`);
  if (hit.length > 1) throw new Error(`引擎 chunk 有 ${hit.length} 份,应当只有 1 份:\n  ${hit.join('\n  ')}`);
  return hit[0];
}

/* 两套编码别搞混:
 *   传给 worker 的 moves 是线格式 (from<<6)|to
 *   worker 回的 move 是引擎打包格式 mkMove(from,to,flag,cap),from 在低 6 位 */
const N = (r, c) => r * 8 + c;              // r0 = 第 8 横排,c0 = a 列
const wire = (fr, fc, tr, tc) => (N(fr, fc) << 6) | N(tr, tc);
const sqName = (s) => 'abcdefgh'[s & 7] + (8 - (s >> 3));
const describe = (m) => `${sqName(m & 63)}→${sqName((m >> 6) & 63)}`;

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`);
};

const chunk = findChunk();
/* 以 **ESM 动态导入**执行 chunk:模块 worker 的产物里有 import.meta
 * (wasm 通道用 new URL('../wasm/*.wasm', import.meta.url) 定位资产),
 * 经典脚本(new Function)装不下 —— SyntaxError: Cannot use 'import.meta'。
 * self / fetch 走垫片:worker 顶层取 self,并按 chunk 同目录 fetch .wasm。 */
const self = { postMessage: (m) => { self.__last = m; } };
globalThis.self = self;
globalThis.fetch = async (url) => {
  const u = new URL(String(url), pathToFileURL(chunk).href);
  const data = fs.readFileSync(fileURLToPath(u));
  return { ok: true, status: 200, arrayBuffer: async () => data };
};
await import(pathToFileURL(chunk).href);

const ask = async (msg, timeoutMs = 5000) => {   // wasm 通道 boot 是异步的,轮询等回包
  self.__last = null;
  self.onmessage({ data: msg });
  const end = Date.now() + timeoutMs;
  while (!self.__last && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  return self.__last;
};

console.log(`引擎 chunk: ${chunk}(${(fs.statSync(chunk).size / 1024).toFixed(1)} KB)\n`);

t('chunk 带引擎标记', self.__engineTag === TAG, `tag=${self.__engineTag}`);

const pong = await ask({ type: 'ping' });
t('ping → pong', !!pong && pong.type === 'pong');

const r1 = await ask({ id: 1, moves: [], nodes: 20000, ms: 200, depth: 24 });
t('开局面:开局库命中直接回着(book:true,不进搜索)',
  !!r1 && !r1.error && r1.book === true && r1.move > 0 && typeof r1.name === 'string',
  r1 && !r1.error ? `${describe(r1.move)} · ${r1.name || '(无开局名)'} · 节点 ${r1.nodes}` : JSON.stringify(r1));

const r2 = await ask({ id: 2, moves: [wire(6, 4, 4, 4)], nodes: 40000, ms: 500, depth: 24 });
t('重演 1.e4 后黑方着法仍由开局库应答',
  !!r2 && !r2.error && r2.book === true && r2.move > 0,
  r2 && !r2.error ? `${describe(r2.move)} · ${r2.name || '(无开局名)'}` : JSON.stringify(r2));

const r3 = await ask({ id: 3, moves: [wire(0, 6, 0, 4)], nodes: 5000, ms: 100 });
t('非法走法序列被拒绝(而不是当空局面乱搜)', !!r3 && r3.error === 'illegal-sequence', JSON.stringify(r3));

/* 出谱序列:1.h3 d5 2.g4 —— ECO 谱树里没有这条线,必走搜索 */
const OFF_BOOK = [wire(6, 7, 5, 7), wire(1, 3, 3, 3), wire(6, 6, 4, 6)];

/* think 契约:只传 level 下标,搜索参数由 Worker 按引擎自报的难度表解析。
 * easy(0)=20k 节点 / master(3)=900k 节点 */
const r4 = await ask({ id: 4, moves: OFF_BOOK, level: 0 });
t('出谱后真搜索:初级档节点预算是硬上限(不超请求值 30%)',
  !!r4 && r4.nodes > 0 && r4.nodes <= 20000 * 1.3,
  r4 ? `实用 ${r4.nodes} 节点 · 深度 ${r4.depth}` : JSON.stringify(r4));

/* 大师档:确认高预算下能明显搜得更深(同样用出谱序列) */
const t0 = Date.now();
const r5 = await ask({ id: 5, moves: OFF_BOOK, level: 3 });
t('大师档节点预算下深度 ≥ 9 层', !!r5 && r5.depth >= 9,
  r5 ? `深度 ${r5.depth} · ${r5.nodes} 节点 · ${r5.ms}ms(墙钟 ${Date.now() - t0}ms)` : JSON.stringify(r5));

/* state 契约:开局局面的合法着法应为 20 手 */
const s1 = await ask({ type: 'state', id: 6, moves: [] });
t('state:开局局面 20 手合法着法、白方行棋、未终局',
  !!s1 && !s1.error && s1.legal.length === 20 && s1.stm === 0 && s1.over === false,
  s1 && !s1.error ? `legal ${s1.legal.length} · stm ${s1.stm}` : JSON.stringify(s1));

console.log(`\n${fail ? '✗' : '✓'} ${pass} 项通过 / ${fail} 项失败`);
process.exit(fail ? 1 : 0);
