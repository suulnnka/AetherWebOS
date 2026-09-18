#!/usr/bin/env node
/* ============================================================
 * 引擎体积闸门
 *
 * 约束:chess3d 的引擎 worker chunk(rules.js + ai.js + ai-worker.js)
 *       gzip 后必须 ≤ 35 KB。
 *
 * 为什么卡 gzip 而不是 raw:线上走的是压缩传输,gzip 体积才等于用户
 * 真正要下载的字节数;raw 体积受标识符长度影响,压缩后会大幅缩水,看它没意义。
 *
 * 定位方式:worker 里有个 ENGINE_TAG 字符串('chess-engine-v2')。
 * 字符串字面量不会被压缩器改名,所以哪怕 chunk 文件名带 hash 也能认出来;
 * 顺带能查出「引擎被误打进主包」这种回归 —— 那时标记会出现在多个 chunk 里。
 *
 * 用法:node tools/check-size.mjs [--dir dist] [--budget 35]
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
const BUDGET_KB = Number(argOf('--budget', '35'));
const BUDGET = Math.round(BUDGET_KB * 1024);

/** 引擎 chunk 的指纹:worker 里的 ENGINE_TAG */
const TAG = 'chess-engine-v2';
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
const engines = [];
for (const f of jsFiles) {
  const p = path.join(assets, f);
  const src = fs.readFileSync(p);
  if (src.includes(TAG)) engines.push({ name: f, src });
}

if (!engines.length) {
  console.error(`✗ 在 ${assets} 里没找到引擎 chunk(缺少标记 "${TAG}")`);
  console.error('  可能原因:vite.config.js 的 worker 配置被改动,或 ai-worker.js 没被引用');
  process.exit(1);
}

let failed = false;

/* 引擎必须只存在一份:多份说明 rules/ai 被静态打进主包,
 * worker 与主线程各持一份,WASM 化时会变成两个真相 */
if (engines.length > 1) {
  console.error(`✗ 引擎 chunk 出现 ${engines.length} 份,应当只有 1 份:`);
  for (const e of engines) console.error(`    - ${e.name}`);
  failed = true;
}

console.log(`引擎 chunk 体积闸门(预算 ${BUDGET_KB} KB gzip)\n`);

for (const e of engines) {
  const raw = e.src.length;
  const gzs = gz(e.src);
  const ratio = (gzs / raw) * 100;
  const pct = ((gzs / BUDGET) * 100).toFixed(1);
  const over = gzs > BUDGET;
  console.log(`  ${over ? '✗' : '✓'} ${e.name}`);
  console.log(`      raw  ${String(raw).padStart(8)} B   ${kb(raw)}`);
  console.log(`      gzip ${String(gzs).padStart(8)} B   ${kb(gzs)}  (压缩率 ${ratio.toFixed(1)}%,占预算 ${pct}%)`);
  if (over) {
    console.error(`      → 超出预算 ${kb(gzs - BUDGET)}!`);
    failed = true;
  }
  for (const bad of FORBIDDEN) {
    if (e.src.includes(bad)) {
      console.error(`      ✗ 引擎里出现了渲染侧代码("${bad}")—— 检查是否有 ogl/DOM 依赖漏进来了`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\n✗ 引擎体积检查未通过');
  process.exit(1);
}
console.log('\n✓ 引擎体积检查通过');
