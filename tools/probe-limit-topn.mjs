/* ============================================================
 * LIMIT 短路 / top-N / 单键原值键 A/B 探针(问答用,不入构建)。
 * 对照跑法:子模块 git stash push -- src/sql.js 前后各跑一次。
 * 运行:node --expose-gc tools/probe-limit-topn.mjs
 * ============================================================ */
import { open, createMemoryBackend } from '../vendor/AetherWebDatabase/src/index.js';

const MB = 1 << 20;
const gc2 = () => { if (global.gc) { global.gc(); global.gc(); } };

/** 报告一次查询:行数 / 5 次中位耗时 / 堆增量(未 GC,≈峰值) */
async function bench(db, label, sql) {
  await db.sql(sql);   // 预热
  const ts = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    await db.sql(sql);
    ts.push(performance.now() - s);
  }
  ts.sort((a, b) => a - b);
  gc2();
  const h0 = process.memoryUsage().heapUsed;
  const r = await db.sql(sql);
  const h1 = process.memoryUsage().heapUsed;
  console.log(`${label.padEnd(34)} rows=${String(r.length).padStart(8)}  median=${ts[2].toFixed(1).padStart(8)} ms  heap +${((h1 - h0) / MB).toFixed(1).padStart(6)} MB`);
}

/* ---- 场景 1:低基数键 join + LIMIT(无 ORDER BY,短路救场)---- */
{
  const db = await open('p1', { storage: createMemoryBackend() });
  const K = 200, N2 = 20_000;
  const a2 = Array.from({ length: N2 }, (_, i) => ({ k: 'K' + (i % K), v: i }));
  const b2 = Array.from({ length: N2 }, (_, i) => ({ k: 'K' + (i % K), w: i }));
  await db.collection('a').insertMany(a2);
  await db.collection('b').insertMany(b2);
  a2.length = b2.length = 0;
  await db.sql('SELECT t.k FROM a t LIMIT 1');
  await db.sql('SELECT j.k FROM b j LIMIT 1');
  await bench(db, '低基数 join + LIMIT 100(短路)', 'SELECT t.v, j.w FROM a t INNER JOIN b j ON t.k = j.k LIMIT 100');
  await bench(db, '低基数 join + LIMIT 100 + WHERE', "SELECT t.v, j.w FROM a t INNER JOIN b j ON t.k = j.k WHERE t.v > 5 LIMIT 100");
  await db.close();
}

/* ---- 场景 2/3:10w 行 top-N 与单键 join ---- */
{
  const N = 100_000;
  const db = await open('p2', { storage: createMemoryBackend() });
  const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '重庆', '西安'];
  const users = Array.from({ length: N }, (_, i) => ({
    uid: 'U' + (1000000 + i), name: '用户' + i, city: CITIES[i % 10], score: (i * 7919) % 100000,
  }));
  const orders = Array.from({ length: N }, (_, i) => ({ oid: 'O' + (2000000 + i), uid: 'U' + (1000000 + i), amount: (i % 997) * 13.7 }));
  await db.collection('users').insertMany(users);
  await db.collection('orders').insertMany(orders);
  users.length = orders.length = 0;
  await db.sql('SELECT uid FROM users LIMIT 1');
  await db.sql('SELECT oid FROM orders LIMIT 1');

  await bench(db, 'ORDER BY + LIMIT 100(top-N)', 'SELECT uid, name, score FROM users ORDER BY score DESC LIMIT 100');
  await bench(db, 'ORDER BY 全量排序(对照)', 'SELECT uid, name, score FROM users ORDER BY score DESC');
  await bench(db, '单键 join 10w×10w(原值键)', 'SELECT t.uid, j.oid FROM users t INNER JOIN orders j ON t.uid = j.uid');
  await db.close();
}
console.log('\n(对照:低基数 join 无 LIMIT 全量产出约 200 万行,见 tools/probe-join-mem.mjs)');
