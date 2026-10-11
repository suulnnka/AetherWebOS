/* ============================================================
 * SQL 查询 Worker —— AetherWebDatabase 引擎的执行宿
 * ------------------------------------------------------------
 * webos 的 SQL 引擎(vendor/AetherWebDatabase)物化执行是同步的,
 * 直接跑在主线程会冻结整个桌面 —— 引擎只进本 Worker 的打包图
 * (与 ascript-worker 同款通道),查询在 Worker 里物化执行,
 * 结果行(纯数据对象)结构化克隆回传。
 *
 * 打开语义:宿主把整个 .awdb 文件字节读好传入(快照),Worker 内
 * 以缓冲后端打开 —— 只读查询零回写;唯一的写路径是对明文库传入
 * 密码触发的「升级加密」,落进缓冲后关闭时把脏字节带回宿主写回。
 *
 * 协议(结构化克隆,永不 reject,失败以 {ok:false,message} 回):
 *   → {id, type:'open', bytes, password}   快照开库 → {handle, encrypted}
 *   → {id, handle, type:'sql', text, params}          → 行数组
 *   → {id, handle, type:'collections'}                → 集合名数组
 *   → {id, handle, type:'count', name}                → 行数
 *   → {id, handle, type:'close'}                      → {dirty, bytes?}
 * ============================================================ */
import { open } from '../../vendor/AetherWebDatabase/src/index.js';
import { PAGE_SIZE } from '../../vendor/AetherWebDatabase/src/page.js';

/* 平台级 worker 标签:本 worker 由 core(平台)引用、数据库应用消费,
 * 不进任何单个应用包 —— tools/apps-manifest.mjs 靠这个字符串把产物
 * chunk 归因为平台(压缩不丢字符串字面量)。 */
const PLATFORM_WORKER_TAG = 'dbsql-worker-v1';
self.__dbsqlWorker = PLATFORM_WORKER_TAG;

/* ---------- 缓冲后端:快照字节按页切片;写仅进内存,关库时带走 ---------- */

function bufferBackend(bytes0) {
  let buf = bytes0;
  let dirty = false;
  return {
    kind: 'buffer',
    isDirty: () => dirty,
    snapshot: () => buf,
    async readPage(no) {
      const off = no * PAGE_SIZE;
      const out = new Uint8Array(PAGE_SIZE);
      if (off < buf.length) out.set(buf.subarray(off, Math.min(off + PAGE_SIZE, buf.length)));
      return out;
    },
    async writePages(startNo, chunks) {
      const need = (startNo + chunks.length) * PAGE_SIZE;
      let next;
      if (need > buf.length) {
        next = new Uint8Array(need);
        next.set(buf);
      } else next = buf;
      for (let i = 0; i < chunks.length; i++) {
        const off = (startNo + i) * PAGE_SIZE;
        next.fill(0, off, off + PAGE_SIZE);
        next.set(chunks[i].subarray(0, PAGE_SIZE), off);
      }
      buf = next;
      dirty = true;
    },
    async pageCount() { return Math.ceil(buf.length / PAGE_SIZE) || 0; },
    async close() {},
  };
}

/** 旧版整库字符串文件(“AWDBVFS1:<base64>”)读取兼容:解出真实页字节 */
function decodeSnapshot(bytes) {
  if (bytes.length < 9) return bytes;
  if (new TextDecoder().decode(bytes.subarray(0, 9)) !== 'AWDBVFS1:') return bytes;
  try {
    const b64 = new TextDecoder().decode(bytes.subarray(9)).trim();
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return bytes;
  }
}

/* ---------- 会话表 ---------- */

const handles = new Map();   // handle id → { db, be }
let nextHandle = 0;

self.onmessage = async (e) => {
  const m = e.data;
  if (!m || typeof m.type !== 'string') return;
  try {
    if (m.type === 'open') {
      const be = bufferBackend(decodeSnapshot(new Uint8Array(m.bytes)));
      const db = await open(`dbv-worker-${++nextHandle}`, {
        storage: be,
        password: m.password || undefined,
      });
      handles.set(nextHandle, { db, be });
      postMessage({ id: m.id, ok: true, value: { handle: nextHandle, encrypted: !!db.encrypted } });
      return;
    }
    const h = handles.get(m.handle);
    if (!h) throw new Error('数据库未打开(可能已关闭)');
    if (m.type === 'sql') {
      /* collation:''(码点序)要显式传,不能用 || 兜成缺省 */
      postMessage({ id: m.id, ok: true, value: await h.db.sql(m.text, m.params ?? [], { collation: m.collation ?? 'zh' }) });
    } else if (m.type === 'collections') {
      postMessage({ id: m.id, ok: true, value: await h.db.listCollections() });
    } else if (m.type === 'count') {
      postMessage({ id: m.id, ok: true, value: await h.db.collection(m.name).count() });
    } else if (m.type === 'close') {
      handles.delete(m.handle);
      h.db.close();
      postMessage({
        id: m.id,
        ok: true,
        value: h.be.isDirty() ? { dirty: true, bytes: h.be.snapshot() } : { dirty: false },
      });
    } else {
      throw new Error(`未知操作: ${m.type}`);
    }
  } catch (err) {
    postMessage({ id: m.id, ok: false, message: String(err?.message ?? err) });
  }
};
