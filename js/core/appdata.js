/* ============================================================
 * AppData —— 应用数据落盘:/home/<user>/appdata/<app>.awdb
 *
 * · 物理位置:虚拟文件系统路径 `/home/<user>/appdata/<app>.awdb`
 * · 存储引擎:AetherWebDatabase;**不直连 OPFS**,经 VFS 字符串文件后端
 * · 整库文件以 `AWDBVFS1:<base64>` 写入 VFS;页级 AES-GCM 加密
 * · 密钥:每用户随机口令,存 `webos.appdata.key::<user>`(与库文件分离)
 *
 * API:
 *   openAppData(app, user?) → Promise<Database>
 *   loadState(app) / saveState(app, data)  单文档状态读写
 * ============================================================ */

import { open, createFileBackend, FILE_MAGIC } from '../../vendor/AetherWebDatabase/src/index.js';
import fs, { fsReady } from './fs.js';
import { accounts } from './accounts.js';

const KEY_PREFIX = 'webos.appdata.key::';
const EXT = '.awdb';

const u8ToB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

/* ---------- 路径 ---------- */

/** `/home/<user>/appdata/<app>.awdb` */
export function appDataPath(app, user = accounts.current()) {
  if (!user) return null;
  const base = String(app).endsWith(EXT) ? String(app).slice(0, -EXT.length) : String(app);
  return `/home/${user}/appdata/${base}${EXT}`;
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

/* ---------- VFS 文件后端(单例) ---------- */

/** path → backend 单例(同文件同实例,配合 open 句柄单例) */
const backends = new Map();

function getBackend(path, user) {
  let b = backends.get(path);
  if (!b) {
    b = createFileBackend(fs, path, {
      as: user,
      owner: user,
      mode: 'rw-------',
    });
    backends.set(path, b);
  }
  return b;
}

/* ---------- 打开库 ---------- */

/**
 * 打开(或创建)应用库,页加密,落在 /home/<user>/appdata/<app>.awdb。
 * @param {string} app  应用 id(如 'sms' / 'todo');可带或不带 .awdb
 * @param {string} [user] 默认当前登录用户
 * @returns {Promise<import('../../vendor/AetherWebDatabase/src/database.js').Database>}
 */
export async function openAppData(app, user = accounts.current()) {
  if (!user) throw new Error('未登录,无法打开应用数据');
  await fsReady();
  if (!ensureAppDataDir(user)) throw new Error('无法创建 appdata 目录');
  const path = appDataPath(app, user);
  const backend = getBackend(path, user);
  const handleName = String(app).endsWith(EXT)
    ? String(app).slice(0, -EXT.length)
    : String(app);
  return open(handleName, {
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
}

export { FILE_MAGIC };

export default {
  appDataPath,
  openAppData,
  loadState,
  saveState,
  migrateFromLocalStorage,
  FILE_MAGIC,
};
