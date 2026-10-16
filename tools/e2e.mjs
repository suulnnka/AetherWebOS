/* ============================================================
 * AetherWebOS 端到端冒烟测试(入口)
 * 先 npm run dev(Vite 开发服务器,固定 8080;应用裸模块依赖需要 Vite 解析),
 * 再运行本脚本(自动携带 ?e2e=1 进入应用测试模式,见 js/core/utils.js):
 *   node tools/e2e.mjs                  # 全部用例
 *   node tools/e2e.mjs T22 27           # 只跑指定组
 *   node tools/e2e.mjs T1-T5 邮件 天气  # 区间 / 组号 / 标题关键词,可混写
 *   node tools/e2e.mjs --list           # 列出全部用例组
 *   node tools/e2e.mjs --parallel 3     # 3 个浏览器并行跑
 *   node tools/e2e.mjs --keep           # 复用上轮浏览器 profile(默认每轮全新,见下)
 * 输出 PASS/FAIL 清单 + .shots/ 截图
 *
 * 文件布局(原 7800 行单文件按职责拆开,入口路径不变):
 *   tools/e2e.mjs           本文件:CLI 解析、用例筛选、并行调度(工作进程 spawn 的也是本文件)与汇总
 *   tools/e2e-harness.mjs   公共设施:t() 断言收集、group() 注册表、连接 c 与 ev()、fresh() 及各共享助手
 *   tools/e2e-groups/*.mjs  用例组按域分文件(shell / themes / files / net / apps / editors / games),
 *                           文件顶层的 group() 调用即注册;新增用例组放进对应域文件即可,本文件无需改动
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { URL_BASE, TAG, setTag, GROUPS, results, t, fresh, setConn } from './e2e-harness.mjs';

/* 用例组注册:纯 import 副作用(ES 模块保证在下方 CLI 解析之前评估完毕) */
import './e2e-groups/shell.mjs';
import './e2e-groups/themes.mjs';
import './e2e-groups/files.mjs';
import './e2e-groups/net.mjs';
import './e2e-groups/apps.mjs';
import './e2e-groups/editors.mjs';
import './e2e-groups/games.mjs';

/* 注册顺序 = 域文件 import 顺序,这里恢复为编号顺序:--list 展示、无选择器时的
 * 执行顺序、并行轮询分片与结果汇总排序都沿用拆分前的 T1..T64 顺序 */
GROUPS.sort((a, b) => +a.id.slice(1) - +b.id.slice(1));

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
/* 默认每轮全新 profile(原 --clean 内置为默认):浏览器内状态(localStorage +
 * OPFS 文件树)跨运行累积,数轮全量后启动被拖过 waitReady 的 12s 就绪线,
 * 表现为大批组"页面未就绪"雪崩失败;并行度实测与此无关(clean + parallel 6
 * 反而最快)。轮内持久化不受影响 —— 组间 fresh() 仍保留 localStorage,
 * "刷新后数据仍在"类用例照常工作。--keep 复用上轮 profile(调试持久化问题)。 */
let parallel = 6, wantList = false, workerMode = false, clean = true;   // 默认 6 个浏览器并行
const selectors = [];
let workerIds = null, workerOut = null, workerProfile = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list' || a === '-l') wantList = true;
  else if (a === '--worker') workerMode = true;          // 内部:并行工作进程
  else if (a === '--ids') workerIds = argv[++i].split(',');
  else if (a === '--out') workerOut = argv[++i];
  else if (a === '--profile') workerProfile = argv[++i];
  else if (a === '--keep') clean = false;
  else if (a === '--clean') clean = true;   // 兼容旧旗标:现已是默认行为
  else if (a === '--parallel' || a.startsWith('--parallel=')) {
    parallel = a.includes('=') ? Number(a.split('=')[1]) : Number(argv[++i]);
    if (!(parallel >= 1 && parallel <= 16)) { console.error('--parallel 需要 1-16 的数字'); process.exit(2); }
  }
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else selectors.push(a);
}
setTag(workerProfile);   // 工作进程输出前缀([w0] 等),t() 与下方工作进程横幅共用

function printHelp() {
  console.log(`用法: node tools/e2e.mjs [选择器...] [选项]
  选择器: 组号(T22 或 22)、区间(T1-T5)、标题关键词(邮件);逗号分隔可混写
  --list        列出全部用例组
  --parallel N  用 N 个浏览器实例并行跑(默认 6;调试可 --parallel 1 串行)
  --keep        复用上轮浏览器 profile(默认每轮运行前清空,防跨运行累积拖慢启动)`);
}

/* ---------- 用例筛选 ---------- */
function resolveSelection() {
  if (!selectors.length) return GROUPS.map(g => g.id);
  const picked = new Set();
  const unknown = [];
  for (const raw of selectors) {
    for (const tok of raw.split(',')) {
      const s = tok.trim();
      if (!s) continue;
      const range = /^t?(\d+)\s*(?:-|~)\s*t?(\d+)$/i.exec(s);
      if (range) {
        const lo = Math.min(+range[1], +range[2]), hi = Math.max(+range[1], +range[2]);
        for (const g of GROUPS) { const n = +g.id.slice(1); if (n >= lo && n <= hi) picked.add(g.id); }
        continue;
      }
      const num = /^t?(\d+)$/i.exec(s);
      if (num) {
        const hit = GROUPS.find(g => g.id === 'T' + num[1]);
        if (hit) { picked.add(hit.id); continue; }
      }
      const kw = s.toLowerCase();
      const hits = GROUPS.filter(g => g.id.toLowerCase().includes(kw) || g.title.toLowerCase().includes(kw));
      if (hits.length) hits.forEach(g => picked.add(g.id));
      else unknown.push(s);
    }
  }
  if (unknown.length) {
    console.error(`未识别的用例选择器: ${unknown.join(', ')}(用 --list 查看全部组)`);
    process.exit(2);
  }
  return GROUPS.filter(g => picked.has(g.id)).map(g => g.id);
}

/* ---------- 运行一批用例组(每组先重置到初始桌面,互不依赖) ---------- */
async function runGroups(ids) {
  const c = await launch(URL_BASE, { profile: workerProfile || 'main' });
  setConn(c);   // 注入 harness,各用例组经 ev() / c.shot / c.send 使用
  const summaries = [];
  try {
    for (const id of ids) {
      const g = GROUPS.find(x => x.id === id);
      const mark = results.length;
      const t0 = Date.now();
      let crashed = false;
      try { await fresh(); await g.fn(); }
      catch (e) { crashed = true; t(`${id} 用例组中断`, false, String(e?.message || e).split('\n')[0].slice(0, 220)); }
      const sub = results.slice(mark);
      summaries.push({
        id, title: g.title, ms: Date.now() - t0, n: sub.length,
        pass: !crashed && sub.length > 0 && sub.every(r => r.ok),
      });
    }
  } finally { await c.close(); }
  return summaries;
}

/* ---------- 入口 ---------- */
if (workerMode) {
  console.log(`${TAG}---- 工作进程跑: ${workerIds.join(', ')}`);
  const summaries = await runGroups(workerIds);
  writeFileSync(workerOut, JSON.stringify(summaries));
  process.exit(summaries.every(s => s.pass) ? 0 : 1);
}

if (wantList) {
  console.log('可用用例组(每组可独立运行,自动重置到初始桌面):');
  for (const g of GROUPS) console.log(`  ${g.id.padEnd(4)}  ${g.title}`);
  console.log(`\n选择示例: node tools/e2e.mjs T22 27   /   node tools/e2e.mjs T1-T5 邮件`);
  process.exit(0);
}

const ids = resolveSelection();
if (!ids.length) { console.error('选择器没有匹配到任何用例组(用 --list 查看全部组)'); process.exit(2); }

/* 服务器预检:必须由 Vite 开发服务(解析应用裸模块依赖)提供页面 */
try {
  const pong = await fetch(URL_BASE, { signal: AbortSignal.timeout(3000) });
  if (!pong.ok) throw new Error('HTTP ' + pong.status);
} catch {
  console.error('开发服务器未就绪:先运行 npm run dev(端口 8080),再跑 e2e');
  process.exit(2);
}

const scope = ids.length === GROUPS.length ? '全部' : ids.join(', ');
console.log(`====== AetherWebOS E2E:${scope}(${ids.length}/${GROUPS.length} 组,parallel=${parallel}${clean ? '' : ',keep'})======`);
const T0 = Date.now();

if (clean) {
  // 清扫全部 webos-cdp-profile-*(含历史并行度遗留的 worker 目录),而非只清本轮要用的:
  // 跨运行累积的 OPFS/localStorage 全在这些目录里,留着只会拖慢后续每一轮
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith('webos-cdp-profile-')) {
        try { rmSync(join(tmpdir(), name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch { /* tmpdir 不可读:跳过清理,本轮照跑 */ }
}

let all = [];
if (parallel === 1) {
  all = await runGroups(ids);
} else {
  // 轮询分组,每个工作进程一个独立 Chrome(独立调试端口 + 独立 profile)
  const chunks = Array.from({ length: parallel }, () => []);
  ids.forEach((id, i) => chunks[i % parallel].push(id));
  const outs = [], kids = [];
  for (let i = 0; i < parallel; i++) {
    if (!chunks[i].length) continue;
    const out = join(tmpdir(), `webos-e2e-w${i}-${process.pid}.json`);
    outs.push(out);
    kids.push(new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker',
        '--ids', chunks[i].join(','), '--out', out, '--profile', 'w' + i], { stdio: 'inherit' });
      p.on('close', resolve);
    }));
  }
  await Promise.all(kids);
  for (const out of outs) {
    try { all.push(...JSON.parse(readFileSync(out, 'utf8'))); rmSync(out, { force: true }); }
    catch (e) { console.error(`工作进程结果丢失: ${out}(${e.message})`); }
  }
  all.sort((a, b) => GROUPS.findIndex(g => g.id === a.id) - GROUPS.findIndex(g => g.id === b.id));
}

/* ---------- 汇总 ---------- */
console.log('\n====== 分组结果 ======');
for (const s of all) {
  console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.id.padEnd(4)} ${s.title}  (${(s.ms / 1000).toFixed(1)}s, ${s.n} 项)`);
}
const failGroups = all.filter(s => !s.pass);
const wall = ((Date.now() - T0) / 1000).toFixed(1);
console.log(`\n====== 结果: ${all.length - failGroups.length}/${all.length} 组通过,耗时 ${wall}s ======`);
process.exit(failGroups.length ? 1 : 0);
