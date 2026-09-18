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
const code = fs.readFileSync(chunk, 'utf8')
  // 开局库 book.bin 是独立资产,冒烟环境没有它:资产加载替换为拒绝,
  // worker 内部 catch 后自动走"无谱"路径(搜索兜底);import.meta 一并中和
  .replace(/fetch\(new URL\([^)]*\)\)/g, 'Promise.reject(new Error("smoke: no book.bin"))')
  .replace(/import\.meta\.url/g, '"."');

const self = { postMessage: (m) => { self.__last = m; } };
/* URL 影子类:chunk 里的开局库资产解析(new URL)在冒烟环境必然失败,
 * 用不抛错的影子类顶住,让加载失败走 worker 内部的 catch(谱外搜索兜底) */
class ShadowURL {
  constructor(u) { this.href = String(u); }
}
new Function('self', 'URL', code)(self, ShadowURL);

const ask = async (msg) => {                // worker 经 bookReady 微任务分派,异步等回包
  self.__last = null;
  self.onmessage({ data: msg });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  return self.__last;
};

console.log(`引擎 chunk: ${chunk}(${(fs.statSync(chunk).size / 1024).toFixed(1)} KB)\n`);

t('chunk 带引擎标记', self.__engineTag === TAG, `tag=${self.__engineTag}`);

const pong = await ask({ type: 'ping' });
t('ping → pong', !!pong && pong.type === 'pong');

const r1 = await ask({ id: 1, moves: [], nodes: 20000, ms: 200, depth: 24 });
t('开局面:返回着法并迭代加深到 ≥ 5 层',
  !!r1 && !r1.error && r1.move > 0 && r1.depth >= 5,
  r1 && !r1.error ? `${describe(r1.move)} · 深度 ${r1.depth} · ${r1.nodes} 节点 · ${r1.ms}ms · ${r1.score}` : JSON.stringify(r1));

const r2 = await ask({ id: 2, moves: [wire(6, 4, 4, 4)], nodes: 40000, ms: 500, depth: 24 });
t('重演 1.e4 后返回黑方着法',
  !!r2 && !r2.error && r2.move > 0,
  r2 && !r2.error ? `${describe(r2.move)} · 深度 ${r2.depth} · ${r2.nodes} 节点` : JSON.stringify(r2));

const r3 = await ask({ id: 3, moves: [wire(0, 6, 0, 4)], nodes: 5000, ms: 100 });
t('非法走法序列被拒绝(而不是当空局面乱搜)', !!r3 && r3.error === 'illegal-sequence', JSON.stringify(r3));

const r4 = await ask({ id: 4, moves: [], nodes: 30000, ms: 5000, depth: 24 });
t('节点预算是硬上限(不超请求值 30%)', !!r4 && r4.nodes <= 30000 * 1.3, `请求 30000,实用 ${r4 && r4.nodes}`);

/* 大师档:确认高预算下能明显搜得更深 */
const t0 = Date.now();
const r5 = await ask({ id: 5, moves: [], nodes: 1200000, ms: 3500, depth: 24 });
t('大师档节点预算下深度 ≥ 9 层', !!r5 && r5.depth >= 9,
  r5 ? `深度 ${r5.depth} · ${r5.nodes} 节点 · ${r5.ms}ms(墙钟 ${Date.now() - t0}ms)` : JSON.stringify(r5));

console.log(`\n${fail ? '✗' : '✓'} ${pass} 项通过 / ${fail} 项失败`);
process.exit(fail ? 1 : 0);
