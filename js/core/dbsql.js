/* ============================================================
 * SQL 查询宿主 —— 引擎 Worker 的请求路由 + 库文件快照装配
 * ------------------------------------------------------------
 * 大查询在 Worker 里跑(引导见 dbsql-worker.js),桌面不冻结;
 * 打开前由宿主把 .awdb 文件整读为字节快照传入(内存与 OPFS
 * 随机访问文件都经 fileSize/readAt,不绕过 fs 权限)。
 * 协议永不 reject:一切失败以 {ok:false,message} 形状 resolve,
 * 调用方(数据库应用)按需抛出展示。SQL 合法耗时可长(首查物化),
 * 不设超时;Worker 异常退出由惰性重生兜底,未决请求即时失败。
 * ============================================================ */
import fsCore from './fs.js';

let worker = null;
let alive = false;
let seq = 0;
const pending = new Map();      // id → resolve

function kill(message) {
  if (!alive) return;
  alive = false;
  for (const [, resolve] of pending) resolve({ ok: false, message });
  pending.clear();
  const w = worker;
  worker = null;
  try { w.terminate(); } catch { /* 已退出 */ }
}

function spawn() {
  // new URL 必须内联在 new Worker 调用里(同 ascript.js 的 Vite 教训)
  const w = new Worker(new URL('./dbsql-worker.js', import.meta.url), { type: 'module' });
  worker = w;
  alive = true;
  w.onmessage = (e) => {
    if (worker !== w) return;   // 过时实例的迟到消息忽略
    const m = e.data;
    if (!m) return;
    const resolve = pending.get(m.id);
    if (!resolve) return;
    pending.delete(m.id);
    resolve(m.ok ? { ok: true, value: m.value } : { ok: false, message: m.message });
  };
  w.onerror = () => { if (worker === w) kill('SQL Worker 异常退出'); };
}

/** 发起一次 Worker 请求(永不 reject) */
function request(payload) {
  return new Promise((resolve) => {
    if (!alive) spawn();
    const id = ++seq;
    pending.set(id, resolve);
    worker.postMessage({ ...payload, id });
  });
}

/** 整读库文件为字节快照(权限经 fs 校验;OPFS 随机访问文件逐段拼装) */
async function readAllBytes(path, as) {
  const size = await fsCore.fileSize(path, { as });
  if (size == null || size < 0) return null;
  if (size === 0) return new Uint8Array(0);
  const buf = new Uint8Array(size);
  let off = 0;
  while (off < size) {
    const chunk = await fsCore.readAt(path, off, Math.min(1 << 20, size - off), { as });
    if (!chunk || !chunk.length) return null;
    buf.set(chunk, off);
    off += chunk.length;
  }
  return buf;
}

/**
 * 打开库(快照进 Worker)。密码为空按明文打开。
 * @returns {Promise<{ok:true, value:{handle:number, encrypted:boolean}} | {ok:false, message:string}>}
 */
export async function openSql(path, { password = '', as } = {}) {
  const bytes = await readAllBytes(path, as);
  if (!bytes) return { ok: false, message: '无法读取数据库文件(不存在或无权限)' };
  return request({ type: 'open', bytes, password });
}

/**
 * 执行 SELECT(引擎只读;失败带原始报错文案,如「需要密码」)。
 * @param {string} collation ORDER BY 文本键 locale('' = 码点序)
 */
export function sqlQuery(handle, text, params = [], collation) {
  return request({ type: 'sql', handle, text, params, collation });
}

/** 集合(表)名列表 */
export function sqlCollections(handle) {
  return request({ type: 'collections', handle });
}

/** 集合行数(目录键计数,O(1)) */
export function sqlCount(handle, name) {
  return request({ type: 'count', handle, name });
}

/**
 * 关库。明文库升级加密(唯一写路径)会把脏字节带回:
 * 返回 {ok:true, value:{dirty, bytes?}},调用方负责写回原路径。
 */
export function closeSql(handle) {
  return request({ type: 'close', handle });
}
