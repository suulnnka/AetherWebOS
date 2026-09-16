/* ============================================================
 * SMS —— 虚拟短信服务
 *
 * 面向玩家:短信应用(会话式,持久化,验证码一键复制)
 * 面向游戏作者:
 *   sms.deliver({ from, fromName, text })            立即送达
 *   sms.deliverLater(spec, ms)                       定时短信(剧情节奏)
 *   sms.onSend(fn)  玩家发短信钩子:fn({to,text}) 返回 spec 即自动回信
 * 事件:sms:new(总线);新短信触发系统通知。
 * ============================================================ */
import { publish } from './bus.js';

const KEY = 'webos.sms.v1';
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.chats)) return s;
  } catch { /* 忽略 */ }
  return { chats: [] };
}
let t;
const persist = () => {
  clearTimeout(t);
  t = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('[sms] 持久化失败', e); }
  }, 200);
};

/** 按联系人归并的会话(最近活跃在前) */
function chatFor(addr, name) {
  let c = state.chats.find(x => x.addr === addr);
  if (!c) {
    c = { addr, name: name || addr, msgs: [], unread: 0 };
    state.chats.push(c);
  }
  if (name) c.name = name;
  return c;
}

/** 送达一条短信(from=联系人地址) */
export function deliver(spec = {}) {
  const addr = String(spec.from || 'unknown').trim();
  const c = chatFor(addr, spec.fromName);
  const msg = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    dir: 'in',
    text: String(spec.text || ''),
    date: spec.date || Date.now(),
    read: false,
  };
  c.msgs.push(msg);
  c.unread++;
  c.msgs.sort((a, b) => a.date - b.date);
  // 最近活跃的会话排前
  state.chats.sort((a, b) => lastTs(b) - lastTs(a));
  persist();
  publish('sms:new', { from: 'sms', type: 'new', payload: { addr, fromName: c.name, text: msg.text } });
  publish('sys:notify', {
    from: 'sms', type: 'notify',
    payload: { title: `短信 · ${c.name}`, body: msg.text.slice(0, 60) },
  });
  return msg;
}

const lastTs = (c) => c.msgs.length ? c.msgs[c.msgs.length - 1].date : 0;

export function deliverLater(spec, ms = 1500) {
  const id = setTimeout(() => deliver(spec), ms);
  return () => clearTimeout(id);
}

/** 玩家发送短信(to=联系人地址;触发作者钩子,可自动回信) */
export function send(to, text) {
  const c = chatFor(String(to).trim());
  const msg = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), dir: 'out', text, date: Date.now(), read: true };
  c.msgs.push(msg);
  persist();
  publish('sms:changed', { from: 'sms', type: 'sent', payload: { addr: c.addr, text } });
  for (const fn of [...sendHooks]) {
    try {
      const reply = fn({ to: c.addr, text });
      if (reply) deliverLater({ from: c.addr, fromName: reply.fromName || c.addr, text: reply.text }, reply.delay ?? 1200);
    } catch (e) { console.error('[sms] onSend 钩子异常', e); }
  }
  return msg;
}

const sendHooks = [];
export function onSend(fn) { sendHooks.push(fn); }

export const chats = () => state.chats;
export const chat = (addr) => state.chats.find(x => x.addr === addr);
export function markRead(addr) {
  const c = chat(addr); if (!c || !c.unread) return;
  c.unread = 0;
  c.msgs.forEach(m => m.read = true);
  persist();
}
export function removeChat(addr) {
  state.chats = state.chats.filter(x => x.addr !== addr);
  persist();
}
export const unreadTotal = () => state.chats.reduce((s, c) => s + c.unread, 0);
export const stats = () => ({
  chats: state.chats.length,
  msgs: state.chats.reduce((s, c) => s + c.msgs.length, 0),
  unread: unreadTotal(),
});

export const sms = { deliver, deliverLater, send, onSend, chats, chat, markRead, removeChat, unreadTotal, stats };
export default sms;
