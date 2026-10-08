#!/usr/bin/env node
/* ============================================================
 * 引擎体积闸门
 *
 * 约束:各棋类的引擎 worker chunk gzip 后必须 ≤ 预算
 *   预算基准 50 KB(2026-09 定;wasm 通道的引擎为「.wasm + 胶水」求和计费):
 *   中国象棋 / 围棋 / 五子棋 / 黑白棋 ≤ 50 KB;
 *   国际象棋 72 KB(AetherChess3 NNUE 网 ~66KB 高熵权重,见下)
 *
 * 为什么卡 gzip 而不是 raw:线上走的是压缩传输,gzip 体积才等于用户
 * 真正要下载的字节数;raw 体积受标识符长度影响,压缩后会大幅缩水,看它没意义。
 *
 * 定位方式:每个 worker 里各有一个 ENGINE_TAG 字符串('aether3-engine-v1' /
 * 'xiangqi-engine-v1' / 'go-engine-nn-v0' / 'renju-engine-v1' / 'othello-engine-v1')。字符串字面量不会被压缩器改名,所以哪怕 chunk 文件名带
 * hash 也能认出来;顺带能查出「引擎被误打进主包」这种回归 —— 那时同一个标记
 * 会出现在多个 chunk 里。
 *
 * 走 wasm 的引擎(引擎逻辑/数据都在 .wasm 里,worker chunk 只剩加载胶水)
 * 各多一条:必须能找到一个 .wasm 资源,且**把两者 gzip 求和**再比预算 ——
 * 用户下载的字节数就是这两块加一起。注意 .wasm 里的 int8 权重书是高熵数据,
 * gzip 几乎压不动:
 *   那是这块预算里躲不掉的成本,别指望靠改代码省出来。
 *
 * 围棋(aethernn,2026-10 大改版)是「JS 引擎 + NN 权重包」的组合:
 * - 引擎 JS 被 Vite 的动态 import 拆成两个 worker chunk(门面+搜索 / WebGPU
 *   内核+解析),从带 TAG 的 chunk 里扒它引用的其它 app-worker-*.js 一并计费;
 * - 模型 models/*.aewn 经应用侧 new URL(..., import.meta.url) 进打包,
 *   权重 zstd 高熵 gzip 压不动,同 wasm 权重书口径按 gzip 实测计费。
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

/** 各引擎 chunk 的指纹(worker 里的 ENGINE_TAG)与预算
 *  bin:引擎自带的二进制资源(权重书/模型包),与 JS chunk 一起 gzip 求和计费 */
const ENGINES = [
  /* wasm 通道(AetherChess3,NNUE):规则/搜索/NNUE 网/开局谱库二进制全在
   * chess.wasm(~66.4KB gzip,其中 NNUE 权重 aether.nnue 高熵 gzip 压不动),
   * worker 胶水 ~1KB,合计 ~67.5KB。前代 AetherChess(HCE)时代是 ~42.5KB;
   * NNUE 升级多花 ~25KB 下载量,棋力显著增强,预算相应从 50KB 提到 72KB。 */
  { name: '国际象棋', tag: 'aether3-engine-v1', kb: 72, bin: { ext: '.wasm', frag: 'chess' } },
  { name: '中国象棋', tag: 'xiangqi-engine-v1', kb: 50 },
  /* aethernn(JS + WebGPU,2026-10 大改版):引擎 JS ~26KB gzip(门面+搜索与
   * WebGPU 内核两个 worker chunk,动态 import 拆分,followChunks 扒齐计费);
   * 模型 b8c96h3tfrs_19.i8.aewn 1.09MB,zstd 权重高熵 gzip 后 ~961KB。
   * 合计 ~987KB,预算取整 1MB(旧 UCT 引擎时代的 50KB 预算随大改版作废)。 */
  { name: '围棋', tag: 'go-engine-nn-v0', kb: 1024, followChunks: true, bin: { ext: '.aewn', frag: 'aewn' } },
  { name: '五子棋', tag: 'renju-engine-v1', kb: 50 },
  /* wasm 通道:wasm 字段是资源名里的可辨识片段(dist 里叫 othello-<hash>.wasm)。
   * 权重书 2026-09 定格 3 相位(监督拟合 Egaroucid lv.17 数据;3×9475B int8,
   * gzip 后 wasm 约 27.8 KB),加胶水合计 ~29.3KB。P3 与 P4 实测等强(200 盘
   * 平手),取 3 档省 9.5KB;4 档要 33KB,50KB 预算内也放得下。 */
  { name: '黑白棋', tag: 'othello-engine-v1', kb: 50, bin: { ext: '.wasm', frag: 'othello' } },
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

  /* 拆出去的 worker 子 chunk(动态 import 把引擎劈成多块,如围棋的 WebGPU 内核):
   * 从带 TAG 的 chunk 里扒它引用的其它 app-worker-*.js,BFS 一并计费 */
  if (eng.followChunks) {
    const byName = new Map(srcs);
    const seen = new Set(hits.map(([f]) => f));
    const queue = hits.map(([, src]) => src);
    while (queue.length) {
      const cur = queue.shift().toString('utf8');
      for (const m of cur.matchAll(/["']([^"']*app-worker-[^"']+\.js)["']/g)) {
        const name = path.basename(m[1]);
        const dep = byName.get(name);
        if (!dep || seen.has(name)) continue;
        seen.add(name);
        const raw = dep.length, gzs = gz(dep);
        total += gzs;
        console.log(`  ✓ ${name}  (引擎拆分的子 chunk)`);
        console.log(`      raw  ${String(raw).padStart(8)} B   ${kb(raw)}`);
        console.log(`      gzip ${String(gzs).padStart(8)} B   ${kb(gzs)}`);
        queue.push(dep);
      }
    }
  }

  /* 自带二进制资源(wasm 权重书 / .aewn 模型包):预算覆盖「JS + 资源」两块,
   * 单独找资源并把 gzip 求和 —— 用户下载的字节数就是这两块加一起 */
  if (eng.bin) {
    const bf = fs.readdirSync(assets).filter((f) => f.endsWith(eng.bin.ext) && f.includes(eng.bin.frag));
    if (bf.length !== 1) {
      console.error(`✗ 期望恰好 1 份「${eng.name}」${eng.bin.ext} 资源,实际找到 ${bf.length} 份` +
        (bf.length ? ':' + bf.map((x) => ' ' + x).join('') : ''));
      console.error(eng.bin.ext === '.wasm'
        ? '  可能原因:vendor 里的 wasm 产物没入库(引擎仓库跑 node tools/build-wasm.mjs),或 worker 没引用它'
        : '  可能原因:模型文件没被应用以 new URL(..., import.meta.url) 引用(没进打包),或子模块未更新');
      failed = true;
    } else {
      const buf = fs.readFileSync(path.join(assets, bf[0]));
      const gzs = gz(buf);
      total += gzs;
      console.log(`  ✓ ${bf[0]}`);
      console.log(`      raw  ${String(buf.length).padStart(8)} B   ${kb(buf.length)}`);
      console.log(`      gzip ${String(gzs).padStart(8)} B   ${kb(gzs)}  (权重高熵,压缩率低是正常的)`);
    }
    const pct = ((total / budget) * 100).toFixed(1);
    console.log(`  ${total > budget ? '✗' : '✓'} 计费合计 gzip ${kb(total)} · 占预算 ${pct}%`);
    if (total > budget) {
      console.error(`      → JS + 资源合计超出预算 ${kb(total - budget)}!`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\n✗ 引擎体积检查未通过');
  process.exit(1);
}
console.log('\n✓ 引擎体积检查通过');
