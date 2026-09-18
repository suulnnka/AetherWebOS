#!/usr/bin/env node
/* ============================================================
 * 引擎体积闸门
 *
 * 约束:各棋类的引擎 worker chunk gzip 后必须 ≤ 预算
 *   国际象棋(rules.js + ai.js + ai-worker.js)      ≤ 35 KB
 *   中国象棋(engine.js + worker.js,单文件引擎)     ≤ 35 KB
 *   围棋(engine.js + worker.js,MCTS 引擎)          ≤ 35 KB
 *
 * 为什么卡 gzip 而不是 raw:线上走的是压缩传输,gzip 体积才等于用户
 * 真正要下载的字节数;raw 体积受标识符长度影响,压缩后会大幅缩水,看它没意义。
 *
 * 定位方式:每个 worker 里各有一个 ENGINE_TAG 字符串('chess-engine-v2' /
 * 'xiangqi-engine-v1' / 'go-engine-v1')。字符串字面量不会被压缩器改名,所以哪怕 chunk 文件名带
 * hash 也能认出来;顺带能查出「引擎被误打进主包」这种回归 —— 那时同一个标记
 * 会出现在多个 chunk 里。
 *
 * 用法:node tools/check-size.mjs [--dir dist] [--budget 35]
 *      --budget 是全局 override(不常用);缺省用各引擎自己的预算
 * 退出码:0 通过 / 1 超预算或找不到引擎 chunk
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DIR = argOf('--dir', 'dist');
const overrideKB = argOf('--budget', null);

/** 各引擎 chunk 的指纹(worker 里的 ENGINE_TAG)与预算 */
const ENGINES = [
  { name: '国际象棋', tag: 'chess-engine-v2', kb: 35 },
  { name: '中国象棋', tag: 'xiangqi-engine-v1', kb: 35 },
  { name: '围棋', tag: 'go-engine-v1', kb: 35 },
  { name: '五子棋', tag: 'renju-engine-v1', kb: 35 },
];
/** 引擎里绝不该出现的渲染指纹(出现即说明 ogl / 着色器被拖进了 worker) */
const FORBIDDEN = ['gl_FragColor', 'WebGLRenderingContext', 'requestAnimationFrame'];

const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(2) + ' KB';

const assets = path.join(DIR, 'assets');
if (!fs.existsSync(assets)) {
  console.error(`✗ 找不到 ${assets} —— 先执行 vite build(或 npm run build)`);
  process.exit(1);
}

const jsFiles = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
const srcs = jsFiles.map((f) => [f, fs.readFileSync(path.join(assets, f))]);

let failed = false;

for (const eng of ENGINES) {
  const budget = overrideKB ? Math.round(Number(overrideKB) * 1024) : Math.round(eng.kb * 1024);
  const hits = srcs.filter(([, src]) => src.includes(eng.tag));

  if (!hits.length) {
    console.error(`✗ 在 ${assets} 里没找到「${eng.name}」引擎 chunk(缺少标记 "${eng.tag}")`);
    console.error('  可能原因:vite.config.js 的 worker 配置被改动,或 worker 没被应用引用');
    failed = true;
    continue;
  }
  /* 引擎必须只存在一份:多份说明引擎代码被静态打进了主包,
   * worker 与主线程各持一份,WASM 化时会变成两个真相 */
  if (hits.length > 1) {
    console.error(`✗「${eng.name}」引擎 chunk 出现 ${hits.length} 份,应当只有 1 份:`);
    for (const [f] of hits) console.error(`    - ${f}`);
    failed = true;
  }

  console.log(`\n${eng.name}引擎 chunk(预算 ${eng.kb} KB gzip)`);
  for (const [f, src] of hits) {
    const raw = src.length, gzs = gz(src);
    const ratio = (gzs / raw) * 100, pct = ((gzs / budget) * 100).toFixed(1);
    const over = gzs > budget;
    console.log(`  ${over ? '✗' : '✓'} ${f}`);
    console.log(`      raw  ${String(raw).padStart(8)} B   ${kb(raw)}`);
    console.log(`      gzip ${String(gzs).padStart(8)} B   ${kb(gzs)}  (压缩率 ${ratio.toFixed(1)}%,占预算 ${pct}%)`);
    if (over) {
      console.error(`      → 超出预算 ${kb(gzs - budget)}!`);
      failed = true;
    }
    for (const bad of FORBIDDEN) {
      if (src.includes(bad)) {
        console.error(`      ✗ 引擎里出现了渲染侧代码("${bad}")—— 检查是否有 ogl/DOM 依赖漏进来了`);
        failed = true;
      }
    }
  }
}

if (failed) {
  console.error('\n✗ 引擎体积检查未通过');
  process.exit(1);
}
console.log('\n✓ 引擎体积检查通过');
