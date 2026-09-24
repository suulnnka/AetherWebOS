/* ============================================================
 * AppData —— 应用数据落盘:/home/<user>/appdata/<app>
 *
 * · 物理位置:虚拟文件系统路径 `/home/<user>/appdata/<app>`
 * · 存储引擎:AetherWebDatabase(OPFS 分页模型,此处由 VFS 后端承载)
 * · 整库文件以 `AWDBVFS1:<base64>` 写入 VFS;页级 AES-GCM 加密
 * · 密钥:每用户随机口令,存 `webos.appdata.key::<user>`(与库文件分离)
 *
 * API:
 *   openAppData(app, user?) → Promise<Database>
 *   loadState(app) / saveState(app, data)  单文档状态读写
 * ============================================================ */

import { open, PAGE_SIZE } from '../../vendor/AetherWebDatabase/src/index.js';
import fs, { fsReady } from './fs.js';
import { accounts } from './accounts.js';

const MAGIC = 'AWDBVFS1:';
const KEY_PREFIX = 'webos.appdata.key::';

/* ---------- base64 ↔ bytes ---------- */

const u8ToB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/* ---------- 路径 ---------- */

/** `/home/<user>/appdata/<app>` */
export function appDataPath(app, user = accounts.current()) {
  if (!user) return null;
  return `/home/${user}/appdata/${app}`;
}

/** 确保 /home/<user>/appdata 目录存在(属主 = user,仅本人可进) */
function ensureAppDataDir(user) {
  if (!user) return false;
  fs.ensureUserHome(user);
  const dir = `/home/${user}/appdata`;
  if (!fs.isDir(dir)) {
    fs.mkdir(dir, { as: user, owner: user, mode: 'rwx------' });
  }
  return fs.isDir(dir);
}

/* ---------- 每用户加密口令 ---------- */

function dbPassword(user) {
  const k = KEY_PREFIX + user;
  try {
    const hit = localStorage.getItem(k);
    if (hit) return hit;
  } catch { /* 忽略 */ }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const pass = u8ToB64(raw);
  try { localStorage.setItem(k, pass); } catch { /* 忽略 */ }
  return pass;
}

/* ---------- VFS 分页后端 ---------- */

/** path → backend 单例(同文件同实例,配合 open 句柄单例) */
const backends = new Map();

function createVfsBackend(path, user) {
  /** 整文件缓存;null = 未加载 */
  let buf = null;

  async function ensureLoaded() {
    if (buf) return;
    const raw = fs.read(path, { as: user });
    if (raw && raw.startsWith(MAGIC)) {
      try {
        buf = b64ToU8(raw.slice(MAGIC.length));
      } catch {
        buf = new Uint8Array(0);
      }
    } else {
      buf = new Uint8Array(0);
    }
  }

  async function flush() {
    if (!buf) return;
    const ok = fs.write(path, MAGIC + u8ToB64(buf), {
      as: user,
      owner: user,
      mode: 'rw-------',
    });
    if (!ok) {
      const err = new Error('appdata 写入失败(权限或配额)');
      err.name = 'QuotaExceededError';
      throw err;
    }
  }

  return {
    kind: 'vfs',
    async readPage(no) {
      await ensureLoaded();
      const off = no * PAGE_SIZE;
      const out = new Uint8Array(PAGE_SIZE);
      if (off < buf.length) {
        out.set(buf.subarray(off, Math.min(off + PAGE_SIZE, buf.length)));
      }
      return out;
    },
    async writePages(startNo, chunks) {
      await ensureLoaded();
      const need = (startNo + chunks.length) * PAGE_SIZE;
      if (buf.length < need) {
        const next = new Uint8Array(need);
        next.set(buf);
        buf = next;
      }
      for (let i = 0; i < chunks.length; i++) {
        const off = (startNo + i) * PAGE_SIZE;
        buf.fill(0, off, off + PAGE_SIZE);
        buf.set(chunks[i].subarray(0, PAGE_SIZE), off);
      }
      await flush();
    },
    async pageCount() {
      await ensureLoaded();
      return Math.ceil(buf.length / PAGE_SIZE) || 0;
    },
    async close() {},
  };
}

function getBackend(path, user) {
  let b = backends.get(path);
  if (!b) {
    b = createVfsBackend(path, user);
    backends.set(path, b);
  }
  return b;
}

/* ---------- 打开库 ---------- */

/**
 * 打开(或创建)应用库,页加密,落在 /home/<user>/appdata/<app>。
 * @param {string} app  应用 id(如 'sms' / 'todo')
 * @param {string} [user] 默认当前登录用户
 * @returns {Promise<import('../../vendor/AetherWebDatabase/src/database.js').Database>}
 */
export async function openAppData(app, user = accounts.current()) {
  if (!user) throw new Error('未登录,无法打开应用数据');
  await fsReady();
  if (!ensureAppDataDir(user)) throw new Error('无法创建 appdata 目录');
  const path = appDataPath(app, user);
  const backend = getBackend(path, user);
  return open(app, {
    storage: backend,
    password: dbPassword(user),
  });
}

/* ---------- 单文档状态(应用级 KV) ---------- */

/** 读 `state/main`;无 → null */
export async function loadState(app, user = accounts.current()) {
  const db = await openAppData(app, user);
  const doc = await db.collection('state').get('main');
  return doc?.data ?? null;
}

/** 写 `state/main`(upsert) */
export async function saveState(app, data, user = accounts.current()) {
  const db = await openAppData(app, user);
  const col = db.collection('state');
  const cur = await col.get('main');
  if (cur) await col.update('main', { data });
  else await col.insert({ id: 'main', data });
  return true;
}

/**
 * 一次性迁移:localStorage 旧键 → appdata(库为空时才导入)。
 * @param {string} app
 * @param {string} legacyKey  旧 localStorage 键(可含 ::user)
 * @param {(raw: any) => any} [normalize] 规范化旧数据
 * @returns {Promise<any|null>} 迁移或库中的状态;无数据 null
 */
export async function migrateFromLocalStorage(app, legacyKey, normalize, user = accounts.current()) {
  if (!user) return null;
  const db = await openAppData(app, user);
  const col = db.collection('state');
  const existing = await col.get('main');
  if (existing?.data != null) return existing.data;

  let legacy = null;
  try {
    const raw = localStorage.getItem(legacyKey);
    if (raw) legacy = JSON.parse(raw);
  } catch { /* 忽略 */ }
  if (legacy == null) return null;

  const data = normalize ? normalize(legacy) : legacy;
  await col.insert({ id: 'main', data });
  try { localStorage.removeItem(legacyKey); } catch { /* 忽略 */ }
  return data;
}

/** 关闭当前用户全部 appdata 句柄(注销时) */
export function closeAppData(user = accounts.current()) {
  if (!user) return;
  void user;
  // AetherWebDatabase closeAll 会关掉所有;按需在 accounts logout 调
}

export default {
  appDataPath,
  openAppData,
  loadState,
  saveState,
  migrateFromLocalStorage,
};
