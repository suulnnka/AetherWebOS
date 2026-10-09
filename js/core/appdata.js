/* ============================================================
 * AppData —— 应用数据落盘:/home/<user>/appdata/<app>.awdb
 *
 * · 物理位置:虚拟文件系统路径 `/home/<user>/appdata/<app>.awdb`
 * · 存储引擎:AetherWebDatabase;**不直连 OPFS**,经 VFS 字节文件后端
 * · 整库以**原始字节**写入 VFS(bin:true → fsdata);不再 base64 包装
 *   (旧 AWDBVFS1:<base64> 文件读取时自动解码迁移)
 * · 页级 AES-GCM 加密;**库口令按「用户密钥 × 应用名」派生**
 *   (SHA-256,不同应用互不相同,且都能追溯到用户密钥;库内再做
 *   PBKDF2 派生页密钥)。用户密钥为每用户随机口令,存
 *   webos.appdata.key::<user>;无账号应用(共享库)以设备身份同理派生。
 *   旧方案(整用户一个口令)的库首次打开时自动重加密迁移。
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
    fs.mkdir(dir, { as: user, owner: user, mode: 'rw------' });
  }
  return fs.isDir(dir);
}

/* ---------- 每用户密钥与「用户 × 应用」口令派生 ---------- */

/** 用户(或设备)密钥材料:每用户随机口令,存 localStorage */
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

/** 库口令 = SHA-256(用户密钥 :: 应用名):不同应用互不相同,且都源自用户 */
async function appPassword(secret, app) {
  const data = new TextEncoder().encode(`${secret}::${app}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return u8ToB64(digest);
}

/**
 * 打开库并按需迁移:优先新派生口令;打不开且旧口令(整用户一个口令的
 * 历史方案)可开 → setPassword 原地重加密为新口令。两者都失败按原错误抛出。
 */
async function openDerived(name, backend, secret) {
  const modern = await appPassword(secret, name);
  try {
    return await open(name, { storage: backend, password: modern });
  } catch (authErr) {
    let db;
    try {
      db = await open(name, { storage: backend, password: secret });
    } catch { throw authErr; }
    await db.setPassword(modern);
    return db;
  }
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
  const base = String(app).endsWith(EXT) ? String(app).slice(0, -EXT.length) : String(app);
  const backend = getBackend(appDataPath(app, user), user);
  const db = await openDerived(base, backend, dbPassword(user));
  normalizeModes(user, appDataPath(app, user));   // 建库/开库后归一:新建库第一次就被冻结
  return db;
}

/**
 * 遗留模式归一:
 *  · 库文件 —— 收归 **rw----**:属主 rw(应用以用户身份读写照常),
 *    库文件一旦落盘即冻结(无管理位):
 *    rm/rename/chmod 全拒(不然属主一放宽 rw 位,穿越免费的新语义下
 *    其他用户就能读到密文,而设备密钥就在本机,等于隐私开门),
 *    解铃须 root。删用户/恢复出厂走 root 不受影响;应用级读写不经
 *    锁位,照常。
 *  · 目录 —— 同样收归 **rw----**(属主 rw 可建新库,自身无管理位):rm 的
 *    锁检查只看顶层节点,目录不上锁的话 `rm -r ~/appdata` 会把所有
 *    冻结的库文件整棵带走;others 三位全空本就不可达,无需占 x。
 *  · 幂等:模式已对就零写入(置锁后属主改不动,靠 stat 比较防抖,
 *    不会反复撞 chmod 的拒绝)。桌面/文档等用户自管理目录不冻。
 */
function normalizeModes(user, path) {
  const want = 'rw----';
  if (fs.stat(path, { as: user })?.mode6 !== want) {
    fs.chmod(path, want, { as: user });
  }
  const dir = `/home/${user}/appdata`;
  if (fs.stat(dir, { as: user })?.mode6 !== want) {
    fs.chmod(dir, want, { as: user });
  }
}

/* ---------- 无系统用户归属的库 ----------
 * 两类应用的数据不落在任何系统用户家目录,统一在 /home/shared/appdata/
 * (root 属主,经本层以 root 身份访问):
 *  · 设备级库(一台设备一份,如短信收件箱):<app>.awdb
 *  · 身份库(应用自有账号体系,如邮件的邮箱地址、QQ 的号码):
 *    <app>#<身份>.awdb,各身份独立成库,密钥材料按「应用:身份」独立生成
 * 页加密密钥仍按「密钥材料 × 应用名」派生(见 openDerived)。
 */

const SHARED_USER = 'shared';
const ADOPT_FLAG = 'webos.appdata.adopt::';

/** `/home/shared/appdata/<app>.awdb` */
export function sharedAppDataPath(app) {
  const base = String(app).endsWith(EXT) ? String(app).slice(0, -EXT.length) : String(app);
  return `/home/${SHARED_USER}/appdata/${base}${EXT}`;
}

function ensureSharedDir() {
  const dir = `/home/${SHARED_USER}/appdata`;
  if (!fs.isDir(dir)) fs.mkdir(dir, { as: 'root', owner: 'root', mode: 'rw-r--r--' });
  return fs.isDir(dir);
}

export async function openSharedAppData(app) {
  await fsReady();
  if (!ensureSharedDir()) throw new Error('无法创建共享 appdata 目录');
  const base = String(app).endsWith(EXT) ? String(app).slice(0, -EXT.length) : String(app);
  const backend = getBackend(sharedAppDataPath(app), 'root');
  /* 无账号应用:以设备身份(SHARED_USER 的密钥材料)按同一规则派生 */
  const db = await openDerived(base, backend, dbPassword(SHARED_USER));
  /* 遗留归一:早期共享库文件是 rw-r--(others 可读),收紧并冻结为
   * rw----(root 私有 + 无管理位);读写都经 root 后端,不受管理位影响。
   * 放在 open 后:首次建库时文件才落盘,先建后冻一次到位 */
  if (fs.stat(sharedAppDataPath(app), { as: 'root' })?.mode6 !== 'rw----') {
    fs.chmod(sharedAppDataPath(app), 'rw----', { as: 'root' });
  }
  return db;
}

export async function loadSharedState(app) {
  const db = await openSharedAppData(app);
  const doc = await db.collection('state').get('main');
  return doc?.data ?? null;
}

export async function saveSharedState(app, data) {
  const db = await openSharedAppData(app);
  const col = db.collection('state');
  const cur = await col.get('main');
  if (cur) {
    await col.update('main', { data });
    return true;
  }
  try {
    await col.insert({ id: 'main', data });
  } catch (e) {
    if (!/id 已存在/.test(String(e?.message))) throw e;
    await col.update('main', { data });
  }
  return true;
}

/** 共享区里应用的身份库路径:`/home/shared/appdata/<app>#<身份>.awdb` */
export function identityAppDataPath(app, identity) {
  const base = String(app).endsWith(EXT) ? String(app).slice(0, -EXT.length) : String(app);
  return `/home/${SHARED_USER}/appdata/${base}%23${encodeURIComponent(String(identity))}${EXT}`;
}

/** 应用自有账号体系:按应用内身份(邮箱地址/QQ 号码…)独立成库 */
export async function openIdentityAppData(app, identity) {
  await fsReady();
  if (!ensureSharedDir()) throw new Error('无法创建 appdata 目录');
  const base = String(app).endsWith(EXT) ? String(app).slice(0, -EXT.length) : String(app);
  const backend = getBackend(identityAppDataPath(app, identity), 'root');
  /* 密钥材料按「应用:身份」独立生成 —— 不同身份互不可解 */
  return openDerived(base, backend, dbPassword(`${base}:${identity}`));
}

export async function loadIdentityState(app, identity) {
  const db = await openIdentityAppData(app, identity);
  const doc = await db.collection('state').get('main');
  return doc?.data ?? null;
}

export async function saveIdentityState(app, identity, data) {
  const db = await openIdentityAppData(app, identity);
  const col = db.collection('state');
  const cur = await col.get('main');
  if (cur) {
    await col.update('main', { data });
    return true;
  }
  try {
    await col.insert({ id: 'main', data });
  } catch (e) {
    if (!/id 已存在/.test(String(e?.message))) throw e;
    await col.update('main', { data });
  }
  return true;
}

/**
 * 一次性收养:应用从"按用户存储"切换为共享库时,共享库为空则把既有
 * 用户库里数据量最多的一份迁入(score 比较用),避免老数据凭空消失。
 * 无论如何只跑一次(localStorage 旗标),之后不再扫描。
 */
export async function adoptSharedState(app, score = () => 0) {
  const flag = ADOPT_FLAG + app;
  const run = () => { try { localStorage.setItem(flag, '1'); } catch { /* 忽略 */ } };
  const cur = await loadSharedState(app);
  if (cur != null) { run(); return cur; }
  try {
    if (!localStorage.getItem(flag)) {
      let best = null;
      for (const u of fs.list('/home') || []) {
        if (!u.dir || u.name === SHARED_USER) continue;
        /* 只开已存在的库:盲目 open 会给每个用户家目录凭空建空库,
         * 还会与外部清档操作赛跑(刚删的文件被并发 open 重建) */
        if (!fs.stat(appDataPath(app, u.name))) continue;
        try {
          const s = await loadState(app, u.name);
          if (s != null && score(s) > score(best)) best = s;
        } catch { /* 该用户库不可读,跳过 */ }
      }
      if (best != null) await saveSharedState(app, best);
    }
  } catch { /* /home 不可列(权限),跳过收养 */ }
  run();
  return null;
}

/* ---------- 单文档状态(应用级 KV) ---------- */

/** 读 `state/main`;无 → null */
export async function loadState(app, user = accounts.current()) {
  const db = await openAppData(app, user);
  const doc = await db.collection('state').get('main');
  return doc?.data ?? null;
}

/**
 * 写 `state/main`(upsert)。
 * get 与 insert 之间隔 await,并发保存(如短信投递的防抖落盘)可能恰好在
 * 此间提交 → insert 撞「id 已存在」:撞上即转 update(后写覆盖,语义正确)。
 */
export async function saveState(app, data, user = accounts.current()) {
  const db = await openAppData(app, user);
  const col = db.collection('state');
  const cur = await col.get('main');
  if (cur) {
    await col.update('main', { data });
    return true;
  }
  try {
    await col.insert({ id: 'main', data });
  } catch (e) {
    if (!/id 已存在/.test(String(e?.message))) throw e;
    await col.update('main', { data });
  }
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
  try {
    await col.insert({ id: 'main', data });
  } catch (e) {
    if (!/id 已存在/.test(String(e?.message))) throw e;
    await col.update('main', { data });   // 并发初始化已建文档:改为覆盖
  }
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
  sharedAppDataPath,
  openSharedAppData,
  loadSharedState,
  saveSharedState,
  adoptSharedState,
  identityAppDataPath,
  openIdentityAppData,
  loadIdentityState,
  saveIdentityState,
  FILE_MAGIC,
};
