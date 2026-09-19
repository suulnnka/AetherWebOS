#!/usr/bin/env node
/* ============================================================
 * 引擎体积闸门
 *
 * 约束:各棋类的引擎 worker chunk gzip 后必须 ≤ 预算
 *   预算统一 50 KB(2026-09 定;wasm 通道的引擎为「.wasm + 胶水」求和计费):
 *   国际象棋 / 中国象棋 / 围棋 / 五子棋 / 黑白棋    ≤ 50 KB
 *
 * 为什么卡 gzip 而不是 raw:线上走的是压缩传输,gzip 体积才等于用户
 * 真正要下载的字节数;raw 体积受标识符长度影响,压缩后会大幅缩水,看它没意义。
 *
 * 定位方式:每个 worker 里各有一个 ENGINE_TAG 字符串('chess-engine-v2' /
 * 'xiangqi-engine-v1' / 'go-engine-v1' / 'othello-engine-v1')。字符串字面量不会被压缩器改名,所以哪怕 chunk 文件名带
 * hash 也能认出来;顺带能查出「引擎被误打进主包」这种回归 —— 那时同一个标记
 * 会出现在多个 chunk 里。
 *
 * 走 wasm 的引擎(引擎逻辑/数据都在 .wasm 里,worker chunk 只剩加载胶水)
 * 各多一条:必须能找到一个 .wasm 资源,且**把两者 gzip 求和**再比预算 ——
 * 用户下载的字节数就是这两块加一起。注意 .wasm 里的 int8 权重书是高熵数据,
 * gzip 几乎压不动:

 * 那是这块预算里躲不掉的成本,别指望靠改代码省出来。
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
  /* wasm 通道(2026-09 zig 移植):规则/评估/搜索/开局谱库二进制全在 chess.wasm
   * (~44KB gzip,其中谱库 blob ~17KB),worker 胶水 ~1KB,合计 ~45KB。
   * 旧 JS 引擎时代是 35KB(纯 JS chunk);谱库从 JS 文本搬进 wasm 后总量略增,
   * 换来同节点预算下约 2.4× 的搜索速度。 */
  { name: '国际象棋', tag: 'chess-engine-v2', kb: 50, wasm: 'chess' },
  { name: '中国象棋', tag: 'xiangqi-engine-v1', kb: 50 },
  { name: '围棋', tag: 'go-engine-v1', kb: 50 },
  { name: '五子棋', tag: 'renju-engine-v1', kb: 50 },
  /* wasm 通道:wasm 字段是资源名里的可辨识片段(dist 里叫 othello-<hash>.wasm)。
   * 权重书 2026-09 定格 3 相位(监督拟合 Egaroucid lv.17 数据;3×9475B int8,
   * gzip 后 wasm 约 27.8 KB),加胶水合计 ~29.3KB。P3 与 P4 实测等强(200 盘
   * 平手),取 3 档省 9.5KB;4 档要 33KB,50KB 预算内也放得下。 */
  { name: '黑白棋', tag: 'othello-engine-v1', kb: 50, wasm: 'othello' },
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
  let total = 0;
  for (const [f, src] of hits) {
    const raw = src.length, gzs = gz(src);
    total += gzs;
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

  /* wasm 通道:预算覆盖「worker 胶水 + wasm」两块,所以要单独找资源并求和 */
  if (eng.wasm) {
    const wf = fs.readdirSync(assets).filter((f) => f.endsWith('.wasm') && f.includes(eng.wasm));
    if (wf.length !== 1) {
      console.error(`✗ 期望恰好 1 份「${eng.name}」wasm 资源,实际找到 ${wf.length} 份` +
        (wf.length ? ':' + wf.map((x) => ' ' + x).join('') : ''));
      console.error('  可能原因:vendor 里的 wasm 产物没入库(引擎仓库跑 node tools/build-wasm.mjs),或 worker 没引用它');
      failed = true;
    } else {
      const buf = fs.readFileSync(path.join(assets, wf[0]));
      const gzs = gz(buf);
      total += gzs;
      console.log(`  ✓ ${wf[0]}`);
      console.log(`      raw  ${String(buf.length).padStart(8)} B   ${kb(buf.length)}`);
      console.log(`      gzip ${String(gzs).padStart(8)} B   ${kb(gzs)}  (int8 权重高熵,压缩率低是正常的)`);
    }
    const pct = ((total / budget) * 100).toFixed(1);
    console.log(`  ${total > budget ? '✗' : '✓'} 计费合计 gzip ${kb(total)} · 占预算 ${pct}%`);
    if (total > budget) {
      console.error(`      → 胶水 + wasm 合计超出预算 ${kb(total - budget)}!`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\n✗ 引擎体积检查未通过');
  process.exit(1);
}
console.log('\n✓ 引擎体积检查通过');
