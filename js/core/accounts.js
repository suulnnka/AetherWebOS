/* ============================================================
 * Accounts —— 账号系统(注册/登录/会话/每用户数据隔离)
 *
 * 安全模型:
 *  - 密码永不存储明文:PBKDF2-SHA-256(15 万次迭代)+ 随机盐;
 *  - 登录校验 = 用输入密码 + 存储盐重新派生,比对哈希;
 *  - 空密码一律拒绝登录(root 密码为空,故无法登录,仅供系统内部);
 *  - 每个用户的应用数据隔离:数据键 = `${storageKey}::${username}`。
 *
 * 身份模型(全局 uid 表):
 *  - 每个账号除用户名外分配**终身不变的数字 uid**(root 固定 0,其余
 *    从 db.uidSeq 递增;删除不回收);文件属主、改名等以 uid 为准,
 *    用户名只是可变的登录名/显示别名。
 *  - uidOf(name) / nameOf(uid) 双向查询;老库首次 load 自动补发 uid。
 *
 * root 内置账号:
 *  - 启动时确保存在;密码为空、不进入登录用户列表;
 *  - 文件系统等内部操作可用 as:'root' / owner:'root' 使用其身份。
 *
 * API:
 *   accounts.register(username, password)   → { ok } | { ok:false, error }(成功即登录)
 *   accounts.createUser(username, password) → { ok } | { ok:false, error }(仅创建,不切换会话)
 *   accounts.login(username, password)      → { ok, user } | { ok:false, error }
 *   accounts.logout()                       会话清除
 *   accounts.current()                      当前用户名 | null(会话持久化)
 *   accounts.lastUser()                     上次成功登录的用户(注销后仍保留)
 *   accounts.uidOf(name)                    用户名 → uid | null(root=0)
 *   accounts.nameOf(uid)                    uid → 用户名 | null
 *   accounts.rename(old, new, password)     改登录名(uid 不变;校验密码)
 *   accounts.passwordHint(username)         密码提示 | null
 *   accounts.bootstrapIfNeeded()            首启无用户时自动建默认账号并登录
 *   accounts.list()                         [{ name, uid, displayName, created }](不含 root)
 *   accounts.listAll()                      含系统账号
 *   accounts.displayName(username)          显示名 | null
 *   accounts.remove(username, password)     → { ok } | { ok:false, error }(校验密码后删除)
 *   accounts.userKey(storageKey)            该用户的数据键(未登录返回 null)
 *   accounts.onChange(fn)                   登录状态变化订阅 → 返回退订
 * ============================================================ */
import { publish, subscribe } from './bus.js';

const DB_KEY = 'webos.accounts.v1';
const SESSION_KEY = 'webos.account-session.v1';
const LAST_USER_KEY = 'webos.accounts.last-user.v1';
const ITER = 150000;
const te = new TextEncoder();
const SYSTEM_USERS = new Set(['root']);

/** 首启自动创建的默认账号(可登录;提示写入 profile.passwordHint) */
export const BOOTSTRAP_USER = {
  username: 'user',
  password: '1234',
  displayName: '用户',
  passwordHint: '系统初始账号:user / 1234',
};

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function hashPassword(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, 256);
  return b64(bits);
}

/** 系统账号:无密码散列,无法通过登录界面进入;uid 固定 0 */
function rootRecord() {
  return {
    uid: 0,
    salt: '',
    hash: '',
    created: 0,
    profile: { displayName: 'root', system: true },
  };
}

/** 老库补 uid:root=0,其余按创建序从 uidSeq 发号(删除不回收,避免属主串号) */
function ensureUids(db) {
  let dirty = false;
  if (typeof db.uidSeq !== 'number' || db.uidSeq < 1) { db.uidSeq = 1; dirty = true; }
  if (db.users.root && db.users.root.uid !== 0) { db.users.root.uid = 0; dirty = true; }
  for (const [name, u] of Object.entries(db.users)) {
    if (typeof u.uid === 'number') continue;
    u.uid = name === 'root' ? 0 : db.uidSeq++;
    dirty = true;
  }
  // 防御:手工改库撞号时把号推到最大值之后
  let max = 0;
  for (const u of Object.values(db.users)) if (typeof u.uid === 'number' && u.uid > max) max = u.uid;
  if (db.uidSeq <= max) { db.uidSeq = max + 1; dirty = true; }
  return dirty;
}

function loadDB() {
  let db = null;
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) db = JSON.parse(raw);
  } catch { /* 忽略 */ }
  if (!db || typeof db.users !== 'object') db = { users: {} };
  // 始终确保存在 root(空密码,仅供系统内部)
  if (!db.users.root) {
    db.users.root = rootRecord();
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch { /* 忽略 */ }
  } else if (!db.users.root.profile?.system) {
    db.users.root.profile = { ...(db.users.root.profile || {}), system: true, displayName: 'root' };
  }
  if (ensureUids(db)) saveDB(db);
  return db;
}
const saveDB = (db) => {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.warn('[accounts] 写入失败', e); }
};

function validateUsername(username) {
  if (!username || username.length < 2) return '用户名至少 2 个字符';
  if (username.length > 20) return '用户名最多 20 个字符';
  if (!/^[\w一-龥.-]+$/.test(username)) return '用户名只能包含字母、数字、汉字、_ - .';
  if (SYSTEM_USERS.has(username)) return '该用户名为系统保留';
  return null;
}
function validatePassword(password) {
  if (!password || password.length < 4) return '密码至少 4 位';
  if (password.length > 64) return '密码最多 64 位';
  return null;
}

/**
 * 把校验后的用户写入数据库,返回用户记录(不落盘)。
 * uid 从调用方传入的 db.uidSeq 发号 —— 调用方随后 saveDB,
 * 避免本函数另开一份 db 写盘把外层未保存的 uidSeq 冲掉。
 */
async function buildUser(name, password, profile = {}, db = loadDB()) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  return {
    uid: db.uidSeq++,
    salt: b64(salt),
    hash,
    created: Date.now(),
    profile: { displayName: profile.displayName || name, ...profile },
  };
}

const accounts = {
  /** 注册:成功即自动登录(并触发文件系统准备 /home/<user>) */
  async register(username, password, profile = {}) {
    const name = String(username || '').trim();
    const errU = validateUsername(name);
    if (errU) return { ok: false, error: errU };
    const errP = validatePassword(password);
    if (errP) return { ok: false, error: errP };
    const db = loadDB();
    if (db.users[name]) return { ok: false, error: '该用户名已被注册' };
    db.users[name] = await buildUser(name, password, profile, db);
    saveDB(db);
    this._startSession(name);
    publish('accounts:changed', { from: 'accounts', type: 'login', payload: { user: name } });
    return { ok: true, user: name };
  },

  /** 系统添加用户:只创建账号,不切换当前会话 */
  async createUser(username, password, profile = {}) {
    const name = String(username || '').trim();
    const errU = validateUsername(name);
    if (errU) return { ok: false, error: errU };
    const errP = validatePassword(password);
    if (errP) return { ok: false, error: errP };
    const db = loadDB();
    if (db.users[name]) return { ok: false, error: '该用户名已被注册' };
    db.users[name] = await buildUser(name, password, profile, db);
    saveDB(db);
    publish('accounts:changed', { from: 'accounts', type: 'created', payload: { user: name } });
    return { ok: true, user: name };
  },

  /**
   * 首启引导:系统里还没有任何可登录用户时,创建默认账号并登录。
   * 已有用户时直接返回 null。返回 { ok, user } | null。
   */
  async bootstrapIfNeeded() {
    if (this.list().length > 0) return null;
    const b = BOOTSTRAP_USER;
    const r = await this.register(b.username, b.password, {
      displayName: b.displayName,
      passwordHint: b.passwordHint,
    });
    return r.ok ? r : null;
  },

  /** 上次成功登录的用户名(注销/锁屏后仍可读,用于锁屏默认选中) */
  lastUser() {
    try {
      const u = localStorage.getItem(LAST_USER_KEY);
      return u || null;
    } catch { return null; }
  },

  /** 密码提示(注册时写入 profile.passwordHint) */
  passwordHint(username = this.current()) {
    if (!username) return null;
    const hint = loadDB().users[username]?.profile?.passwordHint;
    return hint ? String(hint) : null;
  },

  /** 登录:空密码 / 系统账号 / 口令不符一律失败 */
  async login(username, password) {
    const name = String(username || '').trim();
    if (!password) return { ok: false, error: '密码不能为空' };
    if (SYSTEM_USERS.has(name)) return { ok: false, error: '该账号仅供系统使用,无法登录' };
    const db = loadDB();
    const rec = db.users[name];
    if (!rec || rec.profile?.system) return { ok: false, error: '用户不存在' };
    if (!rec.salt || !rec.hash) return { ok: false, error: '该账号仅供系统使用,无法登录' };
    const salt = new Uint8Array(atob(rec.salt).split('').map(c => c.charCodeAt(0)));
    const hash = await hashPassword(password, salt);
    if (hash !== rec.hash) return { ok: false, error: '密码错误' };
    this._startSession(name);
    publish('accounts:changed', { from: 'accounts', type: 'login', payload: { user: name } });
    return { ok: true, user: name };
  },

  _startSession(name) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ user: name, at: Date.now() }));
      // 上次登录用户:注销后锁屏仍默认选中(不随 logout 清除)
      localStorage.setItem(LAST_USER_KEY, name);
    } catch { /* 忽略 */ }
  },

  logout() {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* 忽略 */ }
    publish('accounts:changed', { from: 'accounts', type: 'logout' });
  },

  /** 当前登录用户(会话持久化:刷新后仍在;不含无法登录的 root) */
  current() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      const u = s?.user || null;
      if (u && SYSTEM_USERS.has(u)) return null;   // root 不进入用户会话
      return u;
    } catch { return null; }
  },

  /** 可登录用户列表(不含系统账号 root),按创建时间排序 */
  list() {
    return this.listAll().filter(u => !u.system);
  },

  /** 全部账号(含 root,供设置/诊断);含终身 uid */
  listAll() {
    const db = loadDB();
    return Object.entries(db.users)
      .map(([name, u]) => ({
        name,
        uid: typeof u.uid === 'number' ? u.uid : null,
        displayName: u.profile?.displayName || name,
        created: u.created || 0,
        system: !!u.profile?.system || SYSTEM_USERS.has(name),
        passwordHint: u.profile?.passwordHint || null,
      }))
      .sort((a, b) => a.created - b.created);
  },

  /** 用户名 → 终身 uid(root=0;不存在 null) */
  uidOf(name) {
    if (!name) return null;
    if (name === 'root') return 0;
    const u = loadDB().users[name];
    return typeof u?.uid === 'number' ? u.uid : null;
  },

  /** uid → 用户名(root=0;已删除/不存在 null) */
  nameOf(uid) {
    if (typeof uid !== 'number') return null;
    if (uid === 0) return 'root';
    const db = loadDB();
    for (const [name, u] of Object.entries(db.users)) {
      if (u.uid === uid) return name;
    }
    return null;
  },

  /**
   * 改登录名:uid 不变,文件属主/家目录随之改名。
   * 校验新名合法性与占用、原密码;同步会话/上次登录、
   * localStorage 后缀键(`::旧名`)与按用户名分键的清单(installed)。
   * 返回 { ok, user } | { ok:false, error }。
   */
  async rename(oldName, newName, password) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from) return { ok: false, error: '缺少原用户名' };
    if (from === to) return { ok: false, error: '新用户名与当前相同' };
    const errU = validateUsername(to);
    if (errU) return { ok: false, error: errU };
    const db = loadDB();
    const rec = db.users[from];
    if (!rec) return { ok: false, error: '用户不存在' };
    if (db.users[to]) return { ok: false, error: '该用户名已被注册' };
    if (!(await this.verify(from, password))) {
      return { ok: false, error: password ? '密码错误' : '请输入密码以确认改名' };
    }

    // 1) 账号表换键(uid 留在 rec 上不动)
    delete db.users[from];
    db.users[to] = rec;
    // 显示名默认跟随新登录名(用户没改过显示名时避免留下旧名)
    if (rec.profile?.displayName === from) rec.profile.displayName = to;
    saveDB(db);

    // 2) 会话 / 上次登录
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (s?.user === from) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, user: to }));
      }
      if (localStorage.getItem(LAST_USER_KEY) === from) {
        localStorage.setItem(LAST_USER_KEY, to);
      }
    } catch { /* 忽略 */ }

    // 3) 以 `::用户名` 结尾的散键(userKey / appdata 密钥 / 迁移旗标…)
    try {
      const suffix = '::' + from;
      const moves = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.endsWith(suffix)) moves.push(k);
      }
      for (const k of moves) {
        const v = localStorage.getItem(k);
        const nk = k.slice(0, -from.length) + to;
        if (v != null && localStorage.getItem(nk) == null) localStorage.setItem(nk, v);
        localStorage.removeItem(k);
      }
    } catch { /* 忽略 */ }

    // 4) 按用户名作对象键的清单(已安装应用)
    try {
      const raw = localStorage.getItem('webos.installed.v2');
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj[from] != null && obj[to] == null) {
          obj[to] = obj[from];
          delete obj[from];
          localStorage.setItem('webos.installed.v2', JSON.stringify(obj));
        }
      }
    } catch { /* 忽略 */ }

    publish('accounts:changed', { from: 'accounts', type: 'renamed', payload: { from, to, user: to, uid: rec.uid } });
    return { ok: true, user: to, uid: rec.uid };
  },

  /** 用户显示名(未登录/不存在返回 null) */
  displayName(username = this.current()) {
    if (!username) return null;
    return loadDB().users[username]?.profile?.displayName || username;
  },

  /** 修改显示名;可选同时更新密码提示 profile.passwordHint */
  setDisplayName(username, displayName) {
    const db = loadDB();
    const rec = db.users[username];
    if (!rec) return { ok: false, error: '用户不存在' };
    const name = String(displayName || '').trim() || username;
    rec.profile = { ...(rec.profile || {}), displayName: name };
    saveDB(db);
    publish('accounts:changed', { from: 'accounts', type: 'profile', payload: { user: username } });
    return { ok: true, displayName: name };
  },

  /** 设置密码提示(登录页展示;不超过 80 字) */
  setPasswordHint(username, hint) {
    const db = loadDB();
    const rec = db.users[username];
    if (!rec) return { ok: false, error: '用户不存在' };
    const text = String(hint || '').trim().slice(0, 80);
    rec.profile = { ...(rec.profile || {}), passwordHint: text };
    saveDB(db);
    publish('accounts:changed', { from: 'accounts', type: 'profile', payload: { user: username } });
    return { ok: true, passwordHint: text };
  },

  /** 删除用户:需校验该用户密码;系统账号不可删;删当前用户时同时注销 */
  async remove(username, password) {
    if (SYSTEM_USERS.has(username)) return { ok: false, error: '系统账号不可删除' };
    const db = loadDB();
    if (!db.users[username]) return { ok: false, error: '用户不存在' };
    if (!(await this.verify(username, password))) return { ok: false, error: '密码错误' };
    delete db.users[username];
    saveDB(db);
    const wasCurrent = this.current() === username;
    if (wasCurrent) this.logout();
    try {
      if (this.lastUser() === username) localStorage.removeItem(LAST_USER_KEY);
    } catch { /* 忽略 */ }
    publish('accounts:changed', { from: 'accounts', type: 'removed', payload: { user: username, wasCurrent } });
    return { ok: true, wasCurrent };
  },

  /** 校验用户密码(用于敏感操作二次确认);空密码 / 系统账号恒为 false */
  async verify(username, password) {
    if (!password || SYSTEM_USERS.has(username)) return false;
    const db = loadDB();
    const rec = db.users[username];
    if (!rec || !rec.salt || !rec.hash) return false;
    const salt = new Uint8Array(atob(rec.salt).split('').map(c => c.charCodeAt(0)));
    return (await hashPassword(password, salt)) === rec.hash;
  },

  /**
   * 每用户数据键:不同用户的数据互不可见。
   * storageKey 为应用自己的基础键(如 'webos.todo.v1')。
   */
  userKey(storageKey, username = this.current()) {
    if (!username) return null;
    return `${storageKey}::${username}`;
  },

  onChange(fn) {
    // bus 回调首参是 payload,第二参是完整信封 { type, ... }
    return subscribe('accounts:changed', (payload, msg) => fn(payload, msg));
  },
};

// 启动即确保 root 存在
loadDB();

export { accounts, accounts as default };
