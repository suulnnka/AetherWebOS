/* 读取 --cpu-prof 产物,按「自身耗时」聚合输出热点函数(仅调试用) */
import { readFileSync, readdirSync } from 'node:fs';

const dir = process.argv[2] || '.prof';
const file = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile'))[0];
const prof = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));

const INTERVAL_MS = 0.2; // --cpu-prof-interval=200 (微秒)
const total = prof.nodes.reduce((s, n) => s + (n.hitCount || 0), 0);
const byFn = new Map();

for (const n of prof.nodes) {
  const hits = n.hitCount || 0;
  if (!hits) continue;
  const f = n.callFrame || {};
  const name = f.functionName || '(anonymous)';
  const url = (f.url || '').split(/[\\/]/).slice(-1)[0] || '';
  const isEngine = url === 'reversi-bench.mjs';
  const key = `${isEngine ? 'ENGINE' : 'other'} :: ${name}${isEngine ? '' : ' @ ' + (url || 'native')}`;
  byFn.set(key, (byFn.get(key) || 0) + hits);
}

const rows = [...byFn.entries()].sort((a, b) => b[1] - a[1]);
console.log(`总采样 ${total} 个 (~${(total * INTERVAL_MS).toFixed(0)}ms CPU)\n`);
for (const [k, hits] of rows.slice(0, 26)) {
  const pct = (hits / total * 100).toFixed(1).padStart(5);
  const bar = '█'.repeat(Math.max(1, Math.round(hits / total * 60)));
  console.log(`${pct}%  ${bar}  ${k}`);
}
