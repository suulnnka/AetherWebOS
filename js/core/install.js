/* ============================================================
 * Install —— 应用安装(软件商店,按用户)
 *
 * 清单标 store: true 的应用不预装:不出现在开始菜单、不播种桌面
 * 快捷方式、wm.open 被安装门禁拦下,需经软件商店 installApp()
 * 安装后才可用;卸载(uninstallApp)则连同入口一并移除。
 * 其余应用视为预装,所有用户任何时刻都可用。
 *
 * 安装 = **真实资源下载**(core/pkg.js):把应用包(入口 chunk +
 * 引擎 worker + 模型等资产,清单由构建产物扫描生成)下载到
 * /app/<id>/,成功才记安装标志;失败(断网等)不置位可重试。
 * 包资源是设备级缓存:任何用户装过即就位,其他用户安装免下载;
 * 最后一个用户卸载时回收 /app/<id>(应用数据 appdata 始终保留,
 * 重装后原样恢复)。
 *
 * 安装是**按用户**的:每个用户一份已安装清单(localStorage
 * webos.installed.v2 = { 用户名: [应用 id] }),A 装的应用 B 看不到;
 * 新用户从系统预装起步,开始菜单 / 桌面快捷方式 / 打开门禁都以
 * **本人**清单为准。
 *
 * 本模块是**叶子模块**(只依赖 bus/registry/store/fs/accounts/pkg,
 * 不 import applink / wm —— 避免循环依赖;Vite 开发服务器对
 * 环状模块的 HMR 会拆出重复实例,状态就裂成两份)。桌面快捷方式的
 * 播种/清理(applink)与被卸载窗口的关闭(wm)都由 sys:apps-changed
 * 订阅方各自完成。
 * ============================================================ */
import { publish, subscribe } from './bus.js';
import { get, list } from './registry.js';
import { settings } from './store.js';
import { accounts } from './accounts.js';
import fs, { desktopPath } from './fs.js';
import { ensureResources, removeResources, fmtBytes } from './pkg.js';

const KEY = 'webos.installed.v2';
const LEGACY_KEY = 'webos.installed.v1';   // 设备级旧版(数组):启动时一次性按用户拆分

/** 棋类应用(desktopIcon:false)在桌面的收纳文件夹名,applink 播种时消费 */
export const CHESS_FOLDER = '棋类游戏';

const load = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const [u, ids] of Object.entries(v)) {
      if (Array.isArray(ids)) out[u] = new Set(ids.filter(x => typeof x === 'string'));
    }
    return out;
  } catch { return {}; }
};
/** 用户名 → 已安装的商店应用 id 集合 */
let byUser = load();

function persist() {
  const out = {};
  for (const [u, s] of Object.entries(byUser)) {
    if (s.size) out[u] = [...s];   // 空清单不落盘
  }
  try { localStorage.setItem(KEY, JSON.stringify(out)); }
  catch (e) { console.warn('[install] 持久化失败:', e); }
}

/* 一次性迁移:设备级旧版(全机一份数组)→ 每个已有用户各得一份。
 * 旧语义"整机已安装"等价于"每个用户都已安装" */
(() => {
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (!Array.isArray(old) || !old.length) return;
    for (const u of accounts.list()) {
      byUser[u.name] = new Set([...(byUser[u.name] || []), ...old.filter(x => typeof x === 'string')]);
    }
    persist();
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* 忽略 */ }
})();

function notify(title, body) {
  publish('sys:notify', { from: 'install', type: 'notify', payload: { title, body } });
}

/* 广播安装状态变化(带受影响用户):applink 播种/清理该用户的桌面
 * 快捷方式、wm 关闭其窗口、开始菜单与软件商店重绘,都订阅本事件
 * 各自完成 */
function announce(action, id, user) {
  publish('sys:apps-changed', { from: 'install', type: 'apps-changed', payload: { action, id, user } });
}

/** 任务栏固定里不保留本人已卸载的应用(固定表是全局单份:只动当前会话用户) */
function unpin(id) {
  const pinned = settings.get('pinnedApps') || [];
  if (pinned.includes(id)) settings.set({ pinnedApps: pinned.filter(p => p !== id) });
}

/* 安装状态落盘。快捷方式的播种/清理由 applink 订阅方在 announce 的
 * 同步派发里完成,随后显式冲刷元数据——fs 落盘是 250ms 防抖,不冲刷
 * 的话紧接着刷新页面会让 rm/write"复活",卸载就被还原了 */
function settle() {
  fs.flush().catch(() => {});
}

/** 应用是否已安装(默认查当前会话用户;预装应用对所有用户可用) */
export function isInstalled(id, user = accounts.current()) {
  const m = get(id);
  if (!m) return false;
  if (m.store !== true) return true;
  return byUser[user]?.has(id) === true;
}

/** 商店在售目录:全部标记 store:true 的应用(与用户无关) */
export function storeApps() {
  return list().filter(m => m.store === true);
}

/** 进行中的资源下载(id → promise):并发安装(商店按钮 + API)共享同一次 */
const inflight = new Map();

/**
 * 安装应用(按用户,异步):先把应用包真实下载到 /app/<id>/
 * (已就位则免下载),成功才记安装标志。下载失败不置位,
 * 返回 false 可重试。广播 sys:apps-changed(action: install)后,
 * 该用户的桌面快捷方式播种与各处入口由订阅方实时补齐。
 * @param {Function} opts.onProgress ({ loaded, total, file }) 字节级下载进度
 */
export async function installApp(id, opts = {}) {
  const m = get(id);
  if (!m || m.store !== true) return false;
  const user = opts.user || accounts.current();
  if (!user) return false;
  const set = byUser[user] || (byUser[user] = new Set());
  if (set.has(id)) return true;

  /* 真实资源下载:并发调用共享同一次(进度只回报给发起方) */
  let dl = inflight.get(id);
  if (!dl) {
    dl = ensureResources(id, { onProgress: opts.onProgress })
      .finally(() => inflight.delete(id));
    inflight.set(id, dl);
  }
  let res;
  try {
    res = await dl;
  } catch (err) {
    console.warn(`[install] 「${id}」资源下载失败:`, err);
    if (!opts.silent) notify('安装失败', `「${m.name}」资源下载失败,请检查网络后重试`);
    return false;
  }

  set.add(id);
  persist();
  announce('install', id, user);
  settle();
  if (!opts.silent) {
    notify('安装完成', res.cached
      ? `「${m.name}」资源已就位,已添加到开始菜单与桌面`
      : `「${m.name}」已下载 ${fmtBytes(res.bytes)},添加到开始菜单与桌面`);
  }
  return true;
}

/**
 * 卸载应用(按用户)。广播 sys:apps-changed(action: uninstall)后,
 * 订阅方关闭其窗口、移出任务栏固定并删除**该用户**桌面上的快捷方式;
 * 应用数据保留,重新安装后原样恢复。若已没有任何用户装着它,
 * 连设备级的包资源(/app/<id>)一并回收。
 */
export async function uninstallApp(id, opts = {}) {
  const m = get(id);
  const user = opts.user || accounts.current();
  if (!m || !byUser[user]?.has(id)) return false;
  byUser[user].delete(id);
  persist();
  const last = ![...Object.values(byUser)].some((s) => s.has(id));
  if (user === accounts.current()) unpin(id);
  announce('uninstall', id, user);
  settle();
  if (last) removeResources(id);
  if (!opts.silent) {
    notify('已卸载', `「${m.name}」已移出开始菜单与桌面(数据保留${last ? ',包资源已回收' : ''})`);
  }
  return true;
}

/** store 应用在 user 桌面上的候选快捷方式路径(根目录 + 棋类文件夹)。
 * 注意 fs.joinPath 是两参函数,嵌套调用拼三段路径 */
function shortcutCandidates(m, user) {
  const desk = desktopPath(user);
  if (!desk) return [];
  const chessDir = fs.joinPath(desk, CHESS_FOLDER);
  return [
    fs.joinPath(desk, m.name + '.app'),
    fs.joinPath(chessDir, m.name + '.app'),
  ];
}

/**
 * 旧版升级迁移(**按用户**):软件商店出现之前所有应用都会播种桌面
 * 快捷方式。对每个在售应用,只要某用户桌面上还留着它的 .app 快捷方式,
 * 该用户就视为"已安装"——老用户升级后原有入口一个不少,且各用户
 * 互不影响(甲删过天气、乙没删,迁移后就是乙有甲没有)。
 * 开机(fsReady 之后)与登录时调用;幂等,有变化时广播 reconcile
 * 让 applink 补播种。
 */
export function reconcileLegacyShortcuts() {
  let dirty = false;
  const added = [];                 // 本次新认定的安装(需要后台补包资源)
  const valid = new Set(list().map(m => m.id));
  for (const u of accounts.list()) {
    const set = byUser[u.name] || (byUser[u.name] = new Set());
    for (const m of storeApps()) {
      if (set.has(m.id)) continue;
      if (shortcutCandidates(m, u.name).some(p => fs.exists(p))) {
        set.add(m.id);
        added.push(m.id);
        dirty = true;
      }
    }
  }
  // 清理残留:已下架应用的 id、已删除用户的整份清单
  const users = new Set(accounts.list().map(u => u.name));
  for (const [u, set] of Object.entries(byUser)) {
    if (!users.has(u)) { delete byUser[u]; dirty = true; continue; }
    for (const id of [...set]) {
      if (!valid.has(id)) { set.delete(id); dirty = true; }
    }
  }
  if (dirty) {
    persist();
    announce('reconcile', null, accounts.current());
    /* 老用户升级:安装标志先行(入口不能等网络),包资源后台补齐;
     * 失败无碍 —— 打开走部署 chunk,下次安装/重装会再确保资源 */
    for (const id of new Set(added)) {
      ensureResources(id).catch((err) => console.warn(`[install] 迁移补包「${id}」失败:`, err));
    }
  }
  return dirty;
}

/* 登录/注册:把旧版播种过的商店应用迁成"已安装"(在售入口先于播种生效;
 * 迁移结果经 reconcile 广播,applink 会顺势补桌面快捷方式) */
subscribe('accounts:changed', (payload, msg) => {
  const t = msg?.type;
  if (t === 'login' || t === 'register') reconcileLegacyShortcuts();
});
