/* ============================================================
 * Bus —— 系统消息总线(进程间通信 / IPC)
 *
 * 消息信封(Message Envelope):
 *   { id, ts, topic, from, to, type, payload, replyTopic? }
 *
 * 频道(Topic)约定:
 *   app:<appId>   —— 某个应用的收件箱(点对点)
 *   app:*         —— 广播(所有应用)
 *   sys:<name>    —— 系统事件(主题切换/音量变化/文件系统变化/通知…)
 *   reply:<uuid>  —— request/response 模式的临时回复频道
 *
 * 应用代码请使用 createAppBus(appId) 返回的封装,
 * 系统代码(窗口管理器/任务栏等)可直接使用底层 subscribe/publish。
 * ============================================================ */

import { uuid } from './utils.js';

const listeners = new Map(); // topic -> Set<fn>

/** 消息日志(环形缓冲,系统监视器展示用) */
export const msgLog = [];
const LOG_MAX = 400;

function safeSize(v) {
  try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; }
}

/** 订阅频道,返回取消订阅函数。topic 为 '*' 时监听所有消息 */
export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

/**
 * 发布消息到频道。
 * fields: { from, to, type, payload, replyTopic }
 */
export function publish(topic, fields = {}) {
  const msg = {
    id: uuid(),
    ts: Date.now(),
    topic,
    from: fields.from ?? 'system',
    to: fields.to ?? (topic.startsWith('app:') ? topic.slice(4) : '*'),
    type: fields.type ?? topic.split(':').pop(),
    payload: fields.payload ?? null,
    replyTopic: fields.replyTopic ?? null,
  };
  msgLog.push({ id: msg.id, ts: msg.ts, topic, from: msg.from, to: msg.to, type: msg.type, bytes: safeSize(msg.payload) });
  if (msgLog.length > LOG_MAX) msgLog.shift();

  const targets = [...(listeners.get(topic) ?? []), ...(listeners.get('*') ?? [])];
  for (const fn of targets) {
    try { fn(msg.payload, msg); }
    catch (e) { console.error('[bus] handler error:', e); }
  }
  return msg;
}

/** 点对点发送(异步,无返回值) */
export function send(from, to, type, payload, extra = {}) {
  return publish(`app:${to}`, { from, to, type, payload, ...extra });
}

/**
 * 请求-响应模式:向目标应用发送请求,返回 Promise。
 * 目标应用在收到消息的 msg.reply(payload) 中回传数据。
 */
export function request(from, to, type, payload = null, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const rid = 'reply:' + uuid();
    let settled = false;
    const off = subscribe(rid, (p, m) => {
      if (settled) return;
      settled = true; clearTimeout(timer); off();
      m.payload?.__error ? reject(new Error(m.payload.__error)) : resolve(p);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; off();
      reject(new Error(`无响应(应用 "${to}" 可能未打开): ${type}`));
    }, timeout);
    send(from, to, type, payload, { replyTopic: rid });
  });
}

/**
 * 为应用创建绑定了自己身份的消息总线封装。
 * 应用内可用:
 *   bus.on(type, fn)              收消息(fn(payload, msg),type='*' 收全部)
 *   bus.send(to, type, payload)   发消息
 *   bus.request(to, type, data)   请求并等待 Promise
 *   bus.broadcast(type, payload)  广播给所有应用
 *   bus.onSys(type, fn)           监听系统事件
 *   bus.sys(type, payload)        发布系统事件
 *   bus.notify(title, body)       弹出系统通知
 */
export function createAppBus(appId) {
  const unsubs = [];
  const decorate = (m) => ({
    ...m,
    /** 仅在请求消息上可用:回复请求方 */
    reply: (payload) => m.replyTopic ? publish(m.replyTopic, { from: appId, to: m.from, type: m.type + ':reply', payload }) : null,
  });
  const bus = {
    id: appId,
    on(type, fn) {
      const off = subscribe(`app:${appId}`, (p, m) => {
        if (type === '*' || m.type === type) fn(p, decorate(m));
      });
      unsubs.push(off);
      return off;
    },
    send: (to, type, payload) => send(appId, to, type, payload),
    request: (to, type, payload, timeout) => request(appId, to, type, payload, timeout),
    broadcast: (type, payload) => publish('app:*', { from: appId, to: '*', type, payload }),
    onSys(type, fn) {
      const off = subscribe(`sys:${type}`, (p, m) => fn(p, m));
      unsubs.push(off);
      return off;
    },
    sys: (type, payload) => publish(`sys:${type}`, { from: appId, type, payload }),
    notify: (title, body = '') => publish('sys:notify', { from: appId, type: 'notify', payload: { title, body } }),
    dispose: () => { unsubs.splice(0).forEach(u => u()); },
  };
  return bus;
}
