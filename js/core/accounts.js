/* ============================================================
 * Accounts —— 账号系统(注册/登录/会话/每用户数据隔离)
 *
 * 安全模型:
 *  - 密码永不存储明文:PBKDF2-SHA-256(15 万次迭代)+ 随机盐,
 *    只保存 { salt, hash }(与 core/crypto.js 同一套派生方案);
 *  - 登录校验 = 用输入密码 + 存储盐重新派生,比对哈希;
 *  - 每个用户的应用数据隔离:数据键 = `${storageKey}::${username}`,
 *    通过 userKey(storageKey, username) 获取。
 *
 * API:
 *   accounts.register(username, password)   → { ok } | { ok:false, error }
 *   accounts.login(username, password)      → { ok, user } | { ok:false, error }
 *   accounts.logout()                       会话清除
 *   accounts.current()                      当前用户名 | null(会话持久化)
 *   accounts.userKey(storageKey)            该用户的数据键(未登录返回 null)
 *   accounts.onChange(fn)                   登录状态变化订阅 → 返回退订
 * ============================================================ */
import { publish } from './bus.js';

const DB_KEY = 'webos.accounts.v1';
const SESSION_KEY = 'webos.account-session.v1';
const ITER = 150000;
const te = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function hashPassword(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, 256);
  return b64(bits);
}

function loadDB() {
  try {
    const db = JSON.parse(localStorage.getItem(DB_KEY));
    if (db && typeof db.users === 'object') return db;
  } catch { /* 忽略 */ }
  return { users: {} };
}
const saveDB = (db) => {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.warn('[accounts] 写入失败', e); }
};

function validateUsername(username) {
  if (!username || username.length < 2) return '用户名至少 2 个字符';
  if (username.length > 20) return '用户名最多 20 个字符';
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(username)) return '用户名只能包含字母、数字、汉字、_ - .';
  return null;
}
function validatePassword(password) {
  if (!password || password.length < 4) return '密码至少 4 位';
  if (password.length > 64) return '密码最多 64 位';
  return null;
}

const accounts = {
  /** 注册:成功即自动登录 */
  async register(username, password, profile = {}) {
    const name = String(username || '').trim();
    const errU = validateUsername(name);
    if (errU) return { ok: false, error: errU };
    const errP = validatePassword(password);
    if (errP) return { ok: false, error: errP };
    const db = loadDB();
    if (db.users[name]) return { ok: false, error: '该用户名已被注册' };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await hashPassword(password, salt);
    db.users[name] = {
      salt: b64(salt),
      hash,
      created: Date.now(),
      profile: { displayName: profile.displayName || name, ...profile },
    };
    saveDB(db);
    this._startSession(name);
    publish('accounts:changed', { from: 'accounts', type: 'login', payload: { user: name } });
    return { ok: true, user: name };
  },

  /** 登录 */
  async login(username, password) {
    const name = String(username || '').trim();
    const db = loadDB();
    const rec = db.users[name];
    if (!rec) return { ok: false, error: '用户不存在' };
    const salt = new Uint8Array(atob(rec.salt).split('').map(c => c.charCodeAt(0)));
    const hash = await hashPassword(password || '', salt);
    if (hash !== rec.hash) return { ok: false, error: '密码错误' };
    this._startSession(name);
    publish('accounts:changed', { from: 'accounts', type: 'login', payload: { user: name } });
    return { ok: true, user: name };
  },

  _startSession(name) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ user: name, at: Date.now() })); } catch { /* 忽略 */ }
  },

  logout() {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* 忽略 */ }
    publish('accounts:changed', { from: 'accounts', type: 'logout' });
  },

  /** 当前登录用户(会话持久化:刷新后仍在) */
  current() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      return s?.user || null;
    } catch { return null; }
  },

  /** 校验用户密码(用于敏感操作二次确认) */
  async verify(username, password) {
    const db = loadDB();
    const rec = db.users[username];
    if (!rec) return false;
    const salt = new Uint8Array(atob(rec.salt).split('').map(c => c.charCodeAt(0)));
    return (await hashPassword(password || '', salt)) === rec.hash;
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
    return subscribe('accounts:changed', (p) => fn(p?.payload));
  },
};

export { accounts, accounts as default };
