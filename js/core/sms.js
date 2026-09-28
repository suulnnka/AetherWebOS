/* ============================================================
 * SMS —— 虚拟短信服务
 *
 * 数据:设备级收件箱(一台设备一份,与系统用户无关),加密页库
 *   /home/shared/appdata/sms.awdb;同步 API 读内存,异步水合/落盘。
 * 旧按用户存储的库与旧键 webos.sms.v1 首次启动自动收养/迁移。
 *
 * 面向玩家:短信应用(会话式,持久化,验证码一键复制)
 * 面向游戏作者:
 *   sms.deliver({ from, fromName, text })            立即送达
 *   sms.deliverLater(spec, ms)                       定时短信(剧情节奏)
 *   sms.onSend(fn)  玩家发短信钩子:fn({to,text}) 返回 spec 即自动回信
 * 事件:sms:new(总线);新短信触发系统通知。
 * ============================================================ */
import { publish } from './bus.js';
import { fsReady } from './fs.js';
import { saveSharedState, adoptSharedState } from './appdata.js';

const KEY = 'webos.sms.v1';
let state = { chats: [] };
let hydrated = false;
let saveTimer = null;
let hydrating = null;   // 进行中的水合(并发去重)

/** 按联系人归并的会话(最近活跃在前) */
function chatFor(addr, name) {
  let c = state.chats.find((x) => x.addr === addr);
  if (!c) {
    c = { addr, name: name || addr, msgs: [], unread: 0 };
    state.chats.push(c);
  }
  if (name) c.name = name;
  return c;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveSharedState('sms', state);
    } catch (e) {
      console.warn('[sms] 持久化失败', e);
    }
  }, 200);
}

/** 从设备库水合(幂等);保留尚未入库的新会话。并发调用共享同一次水合;
 * 种子投递等依赖"数据已就绪"的调用方应 await 本函数。 */
export function hydrate() {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      await fsReady();
      /* 设备库为空时,一次性收养旧"按系统用户存储"的数据量最多的库 */
      let next = await adoptSharedState('sms', (s) =>
        Array.isArray(s?.chats) ? s.chats.reduce((n, c) => n + (c.msgs?.length || 0), 0) : 0);
      if (!next) {
        /* 更旧的 localStorage 键(无用户命名空间)一次性迁入 */
        try {
          const raw = localStorage.getItem(KEY);
          if (raw) {
            const legacy = JSON.parse(raw);
            if (legacy && Array.isArray(legacy.chats)) next = legacy;
            localStorage.removeItem(KEY);
          }
        } catch { /* 坏键忽略 */ }
      }
      if (next && Array.isArray(next.chats)) {
        if (hydrated && state.chats.length) {
          // 已有内存数据:合并本地新会话(按 addr,以内容多的一侧为准)
          const seen = new Set(state.chats.map((c) => c.addr));
          for (const c of next.chats) {
            if (!seen.has(c.addr)) state.chats.push(c);
          }
          state.chats.sort((a, b) => lastTs(b) - lastTs(a));
        } else {
          state = { chats: next.chats };
        }
      } else if (!hydrated && !state.chats.length) {
        state = { chats: [] };
        await saveSharedState('sms', state);
      }
      hydrated = true;
    } catch (e) {
      console.warn('[sms] 水合失败:', e);
    } finally {
      hydrating = null;
    }
  })();
  return hydrating;
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
  state.chats.sort((a, b) => lastTs(b) - lastTs(a));
  scheduleSave();
  publish('sms:new', { from: 'sms', type: 'new', payload: { addr, fromName: c.name, text: msg.text } });
  publish('sys:notify', {
    from: 'sms', type: 'notify',
    payload: { title: `短信 · ${c.name}`, body: msg.text.slice(0, 60) },
  });
  return msg;
}

const lastTs = (c) => (c.msgs.length ? c.msgs[c.msgs.length - 1].date : 0);

export function deliverLater(spec, ms = 1500) {
  const id = setTimeout(() => deliver(spec), ms);
  return () => clearTimeout(id);
}

/** 玩家发送短信(to=联系人地址;触发作者钩子,可自动回信) */
export function send(to, text) {
  const c = chatFor(String(to).trim());
  const msg = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    dir: 'out',
    text,
    date: Date.now(),
    read: true,
  };
  c.msgs.push(msg);
  scheduleSave();
  publish('sms:changed', { from: 'sms', type: 'sent', payload: { addr: c.addr, text } });
  for (const fn of [...sendHooks]) {
    try {
      const reply = fn({ to: c.addr, text });
      if (reply) deliverLater({ from: c.addr, fromName: reply.fromName || c.addr, text: reply.text }, reply.delay ?? 1200);
    } catch (e) {
      console.error('[sms] onSend 钩子异常', e);
    }
  }
  return msg;
}

const sendHooks = [];
export function onSend(fn) {
  sendHooks.push(fn);
}

export const chats = () => state.chats;
export const chat = (addr) => state.chats.find((x) => x.addr === addr);
export function markRead(addr) {
  const c = chat(addr);
  if (!c || !c.unread) return;
  c.unread = 0;
  c.msgs.forEach((m) => { m.read = true; });
  scheduleSave();
}
export function removeChat(addr) {
  state.chats = state.chats.filter((x) => x.addr !== addr);
  scheduleSave();
}
export const unreadTotal = () => state.chats.reduce((s, c) => s + c.unread, 0);
export const stats = () => ({
  chats: state.chats.length,
  msgs: state.chats.reduce((s, c) => s + c.msgs.length, 0),
  unread: unreadTotal(),
});

/* 模块加载:立即水合设备收件箱(不阻塞 import) */
hydrate().catch(() => {});

export const sms = {
  deliver, deliverLater, send, onSend, chats, chat, markRead,
  removeChat, unreadTotal, stats, hydrate,
};
export default sms;
