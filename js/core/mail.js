/* ============================================================
 * Mail —— 虚拟邮件服务
 *
 * 数据:加密页库 ~/appdata/mail.awdb(AetherWebDatabase):
 *   /home/<user>/appdata/mail.awdb;同步 API 读内存,异步水合/落盘。
 * 旧键 webos.mail.v1::<user> 首次启动自动迁移后删除。
 *
 * 面向玩家:邮件应用(收件箱/已发送/草稿/垃圾箱,持久化)
 * 面向游戏作者:
 *   mail.deliver({ from, fromName, subject, body, attachments })   立即投递
 *   mail.deliverLater(spec, ms)                                    定时来信(剧情节奏)
 *   mail.onSend(fn)   玩家发信钩子:fn(msg) 返回回信 spec 则自动回复
 * 附件: [{ name, kind: 'proxy', url }] → 浏览器路径转换打开
 *       [{ name, kind: 'fs', path }]   → 预览器/记事本打开
 * 事件:mail:new / mail:changed(总线,监视器可观测);新邮件触发系统通知。
 * ============================================================ */
import { publish } from './bus.js';
import { accounts } from './accounts.js';
import { fsReady } from './fs.js';
import { loadState, saveState, migrateFromLocalStorage } from './appdata.js';

const KEY = 'webos.mail.v1';
let activeUser = null;
let state = null;
let saveTimer = null;
let seedHooks = [];

/** 注册"新用户空间首次使用"钩子(用于播种初始邮件) */
export function onFirstUse(fn) {
  seedHooks.push(fn);
}

function emptyState() {
  return { seq: 1, mails: [] };
}

function normalize(raw) {
  if (raw && Array.isArray(raw.mails)) return { seq: raw.seq || 1, mails: raw.mails };
  return emptyState();
}

function scheduleSave() {
  if (!activeUser || !state) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveState('mail', state, activeUser);
    } catch (e) {
      console.warn('[mail] 持久化失败', e);
    }
  }, 200);
}

/**
 * 切换用户数据空间(异步水合)。
 * 返回 Promise;在 resolve 前 listBy/stats 使用内存态(可能为空)。
 */
export async function setUser(name) {
  const user = accounts.current() || name;
  if (!user) return;
  if (activeUser === user && state) return;
  activeUser = user;
  state = emptyState();
  let wasNew = true;
  try {
    await fsReady();
    const data = await migrateFromLocalStorage('mail', `${KEY}::${user}`, normalize, user);
    const next = data ?? (await loadState('mail', user));
    if (next) {
      state = normalize(next);
      wasNew = false;
    }
  } catch (e) {
    console.warn('[mail] 水合失败:', e);
  }
  if (wasNew) {
    for (const fn of [...seedHooks]) {
      try { fn(); } catch (e) { console.error('[mail] seed hook error', e); }
    }
    scheduleSave();
  }
}

function ensure() {
  if (!state) state = emptyState();
}

const sendHooks = [];

/** 投递一封邮件(默认进收件箱,folder 可指定 sent/drafts) */
export function deliver(spec = {}) {
  ensure();
  const msg = {
    id: 'm' + (state.seq++),
    folder: spec.folder || 'inbox',
    from: spec.from || 'system@nexus',
    fromName: spec.fromName || spec.from || '系统',
    to: spec.to || 'me@aetherwebos',
    subject: spec.subject || '(无主题)',
    body: spec.body || '',
    attachments: spec.attachments || [],
    date: spec.date || Date.now(),
    read: !!spec.read,
    starred: !!spec.starred,
  };
  state.mails.unshift(msg);
  scheduleSave();
  publish('mail:new', {
    from: 'mail', type: 'new',
    payload: { id: msg.id, fromName: msg.fromName, subject: msg.subject, folder: msg.folder },
  });
  if (msg.folder === 'inbox') {
    publish('sys:notify', {
      from: 'mail', type: 'notify',
      payload: { title: `新邮件 · ${msg.fromName}`, body: msg.subject },
    });
  }
  return msg;
}

export function deliverLater(spec, ms = 1500) {
  const id = setTimeout(() => deliver(spec), ms);
  return () => clearTimeout(id);
}

/** 玩家发送邮件(进已发送;触发作者钩子,可产生自动回信) */
export function send({ to, subject, body }) {
  const msg = deliver({ folder: 'sent', read: true, from: 'me@aetherwebos', fromName: '我', to, subject, body });
  for (const fn of [...sendHooks]) {
    try {
      const reply = fn(msg);
      if (reply) deliverLater({ from: to, fromName: reply.fromName || to, ...reply }, reply.delay ?? 1200);
    } catch (e) {
      console.error('[mail] onSend 钩子异常', e);
    }
  }
  return msg;
}

/** 游戏作者注册发信钩子 */
export function onSend(fn) {
  sendHooks.push(fn);
}

export const listBy = (folder) => {
  ensure();
  return state.mails.filter((m) => m.folder === folder);
};
export const get = (id) => {
  ensure();
  return state.mails.find((m) => m.id === id);
};
export function markRead(id, val = true) {
  const m = get(id);
  if (!m) return;
  m.read = val;
  scheduleSave();
  publish('mail:changed', { from: 'mail', type: 'changed', payload: { id, read: val } });
}
export function toggleStar(id) {
  const m = get(id);
  if (!m) return false;
  m.starred = !m.starred;
  scheduleSave();
  publish('mail:changed', { from: 'mail', type: 'changed', payload: { id, starred: m.starred } });
  return m.starred;
}
export function move(id, folder) {
  const m = get(id);
  if (!m) return;
  if (folder === 'trash' && m.folder === 'trash') {
    state.mails = state.mails.filter((x) => x.id !== id);
  } else m.folder = folder;
  scheduleSave();
  publish('mail:changed', { from: 'mail', type: 'changed', payload: { id, folder } });
}
export const stats = () => {
  ensure();
  return {
    total: state.mails.length,
    unread: state.mails.filter((m) => m.folder === 'inbox' && !m.read).length,
    inbox: listBy('inbox').length,
    sent: listBy('sent').length,
    drafts: listBy('drafts').length,
    trash: listBy('trash').length,
  };
};

/** 若已登录会话,启动时预水合(游戏/控制台在 mount 前投递) */
if (accounts.current()) {
  setUser(accounts.current()).catch(() => {});
}

export const mail = {
  deliver, deliverLater, send, onSend, listBy, get, markRead,
  toggleStar, move, stats, setUser, onFirstUse,
};
export default mail;
