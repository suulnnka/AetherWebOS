/* ============================================================
 * Mail —— 虚拟邮件服务
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
import { uuid } from './utils.js';

const KEY = 'webos.mail.v1';
let activeUser = null;          // 由 mail 应用登录后设置(setUser)
let state = null;

/** 登录后由应用调用:切换用户数据空间 */
const seedHooks = [];
/** 注册"新用户空间首次使用"钩子(用于播种初始邮件) */
export function onFirstUse(fn) { seedHooks.push(fn); }
export function setUser(name) {
  if (activeUser === name && state) return;
  activeUser = name;
  const wasNew = !localStorage.getItem(storageKey());
  state = load();
  if (wasNew) for (const fn of [...seedHooks]) {
    try { fn(); } catch (e) { console.error('[mail] seed hook error', e); }
  }
}

function storageKey() {
  return activeUser ? `${KEY}::${activeUser}` : `${KEY}::default`;
}
function ensure() {
  if (!state) state = load();
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(storageKey()));
    if (s && Array.isArray(s.mails)) return s;
  } catch { /* 忽略 */ }
  return { seq: 1, mails: [] };
}
let t;
function persist() {
  clearTimeout(t);
  t = setTimeout(() => {
    try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch (e) { console.warn('[mail] 持久化失败', e); }
  }, 200);
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
  persist();
  publish('mail:new', { from: 'mail', type: 'new', payload: { id: msg.id, fromName: msg.fromName, subject: msg.subject, folder: msg.folder } });
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
    } catch (e) { console.error('[mail] onSend 钩子异常', e); }
  }
  return msg;
}

/** 游戏作者注册发信钩子 */
export function onSend(fn) { sendHooks.push(fn); }

export const listBy = (folder) => { ensure(); return state.mails.filter(m => m.folder === folder); };
export const get = (id) => { ensure(); return state.mails.find(m => m.id === id); };
export function markRead(id, val = true) {
  const m = get(id); if (!m) return;
  m.read = val; persist();
  publish('mail:changed', { from: 'mail', type: 'changed', payload: { id, read: val } });
}
export function toggleStar(id) {
  const m = get(id); if (!m) return false;
  m.starred = !m.starred; persist();
  publish('mail:changed', { from: 'mail', type: 'changed', payload: { id, starred: m.starred } });
  return m.starred;
}
export function move(id, folder) {
  const m = get(id); if (!m) return;
  if (folder === 'trash' && m.folder === 'trash') {
    // 垃圾箱内再删除 = 彻底删除
    state.mails = state.mails.filter(x => x.id !== id);
  } else m.folder = folder;
  persist();
  publish('mail:changed', { from: 'mail', type: 'changed', payload: { id, folder } });
}
export const stats = () => {
  ensure();
  return {
    total: state.mails.length,
    unread: state.mails.filter(m => m.folder === 'inbox' && !m.read).length,
    inbox: listBy('inbox').length,
    sent: listBy('sent').length,
    drafts: listBy('drafts').length,
    trash: listBy('trash').length,
  };
};

export const mail = { deliver, deliverLater, send, onSend, listBy, get, markRead, toggleStar, move, stats, setUser, onFirstUse };
export default mail;
