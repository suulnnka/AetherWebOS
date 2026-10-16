/* ============================================================
 * SessionSave —— 会话恢复(网页伪 OS 的「重启后还原会话」)
 *
 * 窗口清单(app id + 参数)按用户存 localStorage,开/关窗时防抖记录;
 * 刷新 / 重开浏览器后由 boot 调 restoreIfSaved() 把窗口一个个开回来。
 * 语义对齐真实 OS 的意外重启:
 *   · 刷新(会话仍在)→ 恢复上次窗口
 *   · 注销(显式结束会话)→ 丢弃该用户的清单,下次登录从干净桌面开始
 *   · 锁屏态刷新 → 登录成功那一刻恢复
 * 对话框 / 弹窗不记录;参数须可 JSON 序列化(File 对象等随窗口消失,
 * 记不下来的窗口按无参打开)。设置里可整体关闭(sessionRestore)。
 * ============================================================ */
import { E2E } from '../core/utils.js';
import { subscribe, publish } from '../core/bus.js';
import * as wm from '../core/wm.js';
import { get as getApp } from '../core/registry.js';
import { accounts } from '../core/accounts.js';
import { settings } from '../core/store.js';
import { isInstalled } from '../core/install.js';

const KEY = 'webos.session.windows.v1';
const MAX_WINDOWS = 8;          // 恢复上限:防意外开出几十个窗口
const SAVE_DEBOUNCE = 400;

function loadAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function saveAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* 忽略 */ }
}

/** 最近一次有会话的用户(logout 事件不带用户名,靠此回溯) */
let lastUser = accounts.current();

/** 记录当前用户的窗口清单(对话框与 popup 不记;参数须可序列化) */
function snapshot() {
  const user = accounts.current();
  if (!user) return;
  lastUser = user;
  const all = loadAll();
  const list = [];
  const seen = new Set();
  for (const t of wm.taskList()) {
    const w = wm.get(t.id);
    if (!w) continue;
    if (w.app?.dialog || w.appId === 'popup') continue;   // 对话框/临时弹窗不记
    if (seen.has(w.appId) && w.app?.singleton !== false) continue;   // 单实例只记一份;多实例(任务便签)逐窗记录(带 params)
    seen.add(w.appId);
    let params = null;
    try { params = w.ctx?.params ? JSON.parse(JSON.stringify(w.ctx.params)) : null; }
    catch { params = null; }   // 含 File 等不可序列化值:按无参恢复
    list.push({ app: w.appId, params });
    if (list.length >= MAX_WINDOWS) break;
  }
  all[user] = list;
  saveAll(all);
}

let timer = 0;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(snapshot, SAVE_DEBOUNCE);
};

/* 开 / 关窗即记录(关最后一个窗也记:空清单 = 桌面本来就没有窗口) */
subscribe('sys:win-open', schedule);
subscribe('sys:win-close', schedule);

/* 注销 = 显式结束会话:丢弃该用户的清单,下次登录不恢复 */
subscribe('accounts:changed', (_p, msg) => {
  if (msg?.type === 'logout') {
    const all = loadAll();
    if (lastUser && all[lastUser]) {
      delete all[lastUser];
      saveAll(all);
    }
  }
});

/** 恢复某用户保存的窗口;返回恢复个数 */
async function doRestore(user) {
  const list = Array.isArray(loadAll()[user]) ? loadAll()[user] : [];
  let n = 0;
  for (const it of list) {
    if (!it?.app || !getApp(it.app)) continue;
    if (!isInstalled(it.app)) continue;               // 已卸载的应用跳过
    const r = await wm.open(it.app, it.params ? { params: it.params } : undefined);
    if (r) n++;
    await new Promise(res => setTimeout(res, 60));    // 级联错开一点,别全叠在一起
  }
  return n;
}

let restoredThisBoot = false;

/** boot 后调用:已登录(非锁屏)则恢复;锁屏态留给登录事件接力 */
export async function restoreIfSaved() {
  if (E2E) { restoredThisBoot = true; return 0; }     // 测试模式要干净桌面
  const user = accounts.current();
  if (!user || document.getElementById('session')) return 0;   // 锁屏/未登录:接力给登录事件
  restoredThisBoot = true;
  if (!settings.get().sessionRestore) return 0;
  const n = await doRestore(user);
  if (n > 0) {
    publish('sys:notify', { from: 'sessionsave', type: 'notify', payload: { title: '已恢复上次会话', body: `重新打开了 ${n} 个窗口` } });
  }
  return n;
}

/* 锁屏态刷新:登录成功那一刻恢复(仅一次) */
subscribe('accounts:changed', async (p, msg) => {
  if (msg?.type !== 'login' || restoredThisBoot || E2E) return;
  restoredThisBoot = true;
  const user = p?.user || accounts.current();
  if (!user || !settings.get().sessionRestore) return;
  const n = await doRestore(user);
  if (n > 0) {
    publish('sys:notify', { from: 'sessionsave', type: 'notify', payload: { title: '已恢复上次会话', body: `重新打开了 ${n} 个窗口` } });
  }
});

export default { restoreIfSaved };
