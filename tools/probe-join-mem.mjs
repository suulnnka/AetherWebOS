/* ============================================================
 * 内连接内存探针(问答用,不入构建):两个 10w 行集合做
 * INNER JOIN,分阶段量 heapUsed,回答"需要多少内存"。
 * 运行:node --expose-gc tools/probe-join-mem.mjs
 * ============================================================ */
import { open, createMemoryBackend } from '../vendor/AetherWebDatabase/src/index.js';

const MB = 1 << 20;
const N = 100_000;
const gc2 = () => { if (global.gc) { global.gc(); global.gc(); } };
let last = 0;
function snap(label) {
  gc2();
  const { heapUsed, rss } = process.memoryUsage();
  const d = (heapUsed - last) / MB;
  last = heapUsed;
  console.log(`${label.padEnd(30)} heap=${(heapUsed / MB).toFixed(1).padStart(7)} MB   +${d.toFixed(1).padStart(6)} MB   rss=${(rss / MB).toFixed(0)} MB`);
  return heapUsed;
}
function snapNoGC(label) {
  const { heapUsed } = process.memoryUsage();
  const d = (heapUsed - last) / MB;
  console.log(`${label.padEnd(30)} heap=${(heapUsed / MB).toFixed(1).padStart(7)} MB   +${d.toFixed(1).padStart(6)} MB   (未 GC,≈峰值)`);
  return heapUsed;
}

/* 典型业务行:6~7 个字段,短字符串/数字,join 键唯一(1:1 命中) */
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '重庆', '西安'];
const users = Array.from({ length: N }, (_, i) => ({
  uid: 'U' + (1000000 + i), name: '用户' + i, city: CITIES[i % 10],
  score: (i % 100) + 0.5, vip: i % 7 === 0, ts: 1728000000000 + i * 60000,
}));
const orders = Array.from({ length: N }, (_, i) => ({
  oid: 'O' + (2000000 + i), uid: 'U' + (1000000 + i),
  amount: (i % 997) * 13.7, status: i % 3 ? 'paid' : 'pending',
  note: '备注' + (i % 50), ts: 1728000000000 + i * 30000,
}));

const db = await open('probe', { storage: createMemoryBackend() });
await db.collection('users').insertMany(users);
await db.collection('orders').insertMany(orders);
users.length = orders.length = 0;   // 释放构造源数组

snap('基线(落库页字节+目录)');

let t = performance.now();
await db.sql('SELECT t.uid FROM users t LIMIT 1');   // 触发 users 物化(loadAll)
snap(`物化 users ${N} 行 ${(performance.now() - t).toFixed(0)}ms`);

t = performance.now();
await db.sql('SELECT j.oid FROM orders j LIMIT 1');
snap(`物化 orders ${N} 行 ${(performance.now() - t).toFixed(0)}ms`);

/* 全列内连接(查询生成器产出的同款 SQL) */
t = performance.now();
let r = await db.sql('SELECT t.*, j.* FROM users t INNER JOIN orders j ON t.uid = j.uid');
console.log(`\n全列 join:${r.length} 行,${(performance.now() - t).toFixed(0)} ms`);
console.log('示例行:', JSON.stringify(r[0]));
snapNoGC('join 完成,未 GC');
snap('join 完成,已 GC(结果常驻)');

r = null; gc2(); snap('释放结果后');

/* 精简投影:证明投影列数对结果段的影响 */
t = performance.now();
r = await db.sql('SELECT t.uid, j.oid FROM users t INNER JOIN orders j ON t.uid = j.uid');
console.log(`\n精简投影 join:${r.length} 行,${(performance.now() - t).toFixed(0)} ms`);
snapNoGC('精简投影完成,未 GC');
snap('精简投影完成,已 GC');
r = null;

/* ---------- 低基数键外推:2w×2w / 200 个键 → 200w 行,按行成本推 10w ---------- */
await db.close();
const db2 = await open('probe2', { storage: createMemoryBackend() });
const K = 200, N2 = 20_000;
const a2 = Array.from({ length: N2 }, (_, i) => ({ k: 'K' + (i % K), v: i }));
const b2 = Array.from({ length: N2 }, (_, i) => ({ k: 'K' + (i % K), w: i }));
await db2.collection('a').insertMany(a2);
await db2.collection('b').insertMany(b2);
a2.length = b2.length = 0;
gc2(); last = 0;
snap('低基数基线(2w×2w 页字节)');
t = performance.now();
const r2 = await db2.sql('SELECT t.k, t.v, j.w FROM a t INNER JOIN b j ON t.k = j.k');
console.log(`\n低基数 join:${r2.length} 行(期望 ${N2 * N2 / K}),${(performance.now() - t).toFixed(0)} ms`);
snapNoGC('低基数完成,未 GC');
const before = last;                        // snap() 会先刷新 last,须先取
snap('低基数完成,已 GC');
const perRow = (last - before) / r2.length; // 结果段/行(常驻口径)
console.log(`\n结果常驻约 ${perRow.toFixed(0)} B/行 → 外推 10w×10w/1000键=1000w 行 ≈ ${(perRow * 10e6 / 1024 / 1024 / 1024).toFixed(1)} GB 常驻(必炸)`);
const peakRow = 480.1 * MB / r2.length;     // 未 GC 峰值段/行(上面实测 480.1MB)
console.log(`峰值段约 ${peakRow.toFixed(0)} B/行 → 同场景峰值 ≈ ${(peakRow * 10e6 / 1024 / 1024 / 1024).toFixed(1)} GB`);
await db2.close();
