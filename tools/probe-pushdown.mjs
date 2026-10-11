/* ============================================================
 * 谓词下推 A/B 探针(问答用,不入构建):10w×10w INNER JOIN,
 * 两侧各带选择率 ~1/10 与 ~2/3 的 WHERE,量 join 相位的时间与堆。
 * 对照跑法:git stash -- vendor/AetherWebDatabase/src/sql.js 前后各跑一次。
 * 运行:node --expose-gc tools/probe-pushdown.mjs
 * ============================================================ */
import { open, createMemoryBackend } from '../vendor/AetherWebDatabase/src/index.js';

const MB = 1 << 20;
const N = 100_000;
const gc2 = () => { if (global.gc) { global.gc(); global.gc(); } };

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
users.length = orders.length = 0;

/* 预物化,使后续测量只含 join 相位 */
await db.sql('SELECT t.uid FROM users t LIMIT 1');
await db.sql('SELECT j.oid FROM orders j LIMIT 1');
gc2();
console.log('物化完成,join 相位测量:\n');

const SELECTIVE = "SELECT t.uid, t.name, j.oid, j.amount FROM users t INNER JOIN orders j ON t.uid = j.uid WHERE t.city = '北京' AND j.status = 'paid'";
const PLAIN = 'SELECT t.uid, t.name, j.oid, j.amount FROM users t INNER JOIN orders j ON t.uid = j.uid';

for (const [label, sql] of [['选择性 WHERE(两侧谓词)', SELECTIVE], ['无 WHERE(对照)', PLAIN]]) {
  /* 预热一次(JIT/桶结构),再取 5 次中位耗时 */
  const r0 = await db.sql(sql);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    await db.sql(sql);
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  gc2();
  const h0 = process.memoryUsage().heapUsed;
  await db.sql(sql);
  const h1 = process.memoryUsage().heapUsed;   // 未 GC:含瞬时峰值 + 结果
  console.log(`${label}`);
  console.log(`  行数 ${r0.length}  中位耗时 ${times[2].toFixed(1)} ms  join 相位堆增量 +${((h1 - h0) / MB).toFixed(1)} MB\n`);
}
await db.close();
