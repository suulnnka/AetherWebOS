/* ============================================================
 * AppLink —— 应用快捷方式(.app 文件)
 *
 * 快捷方式就是一个内容为应用 ID 的普通文本文件(如「国际象棋.app」
 * 内容为 chess3d),可以像普通文件一样被复制、移动、重命名,放在
 * 任意文件夹(含桌面目录 ~/desktop)里。桌面、文件管家、终端
 * 都按扩展名识别并以应用磁贴的外观渲染,双击即启动目标应用。
 *
 * 桌面目录随当前用户变化:/home/<user>/desktop。
 * ============================================================ */

import fs, { desktopPath } from './fs.js';
import { publish, subscribe } from './bus.js';
import { get, list, prefetchOnHover } from './registry.js';
import { accounts } from './accounts.js';

export const APPEXT = '.app';

/**
 * 桌面目录(随会话用户变化)。未登录返回 null。
 * @deprecated 请优先用 desktopDir() —— 保留常量名兼容旧引用时需改为函数调用。
 */
export function desktopDir(user = accounts.current()) {
  return desktopPath(user);
}

/** 文件名是否为应用快捷方式 */
export const isAppLink = (name) => String(name).toLowerCase().endsWith(APPEXT);

/** 快捷方式的显示名(隐藏 .app 扩展名,像 .lnk 一样) */
export const displayName = (name) => String(name).replace(/\.app$/i, '');

/** 读快捷方式指向的应用清单;文件缺失/内容无效时返回 null */
export function appLinkApp(path) {
  const content = fs.read(path) ?? fs.readRaw(path);
  if (content == null) return null;
  return get(content.trim()) || null;
}

/** 从应用彩色渐变里取第一个 hex(files 列表用单色渲染图标) */
export function flatColor(manifest, fallback = '#4f9cf9') {
  const m = /#[0-9a-f]{3,8}/i.exec(manifest?.color || '');
  return m ? m[0] : fallback;
}

/** 在 dir 下创建「<应用名>.app」快捷方式,重名自动追加序号;返回路径或 null */
export function createAppLink(dir, appId, opts = {}) {
  const app = get(appId);
  if (!app || !fs.isDir(dir)) return null;
  let name = app.name + APPEXT;
  for (let i = 2; fs.exists(fs.joinPath(dir, name)); i++) {
    name = `${app.name} (${i})${APPEXT}`;
  }
  const p = fs.joinPath(dir, name);
  return fs.write(p, appId, opts) ? p : null;
}

/** 「发送到桌面」:把应用快捷方式放到桌面并弹系统通知(重名自动追加序号) */
export function sendAppToDesktop(appId) {
  const app = get(appId);
  const dir = desktopDir();
  if (!dir) return null;
  const p = createAppLink(dir, appId);
  if (p && app) {
    publish('sys:notify', { from: 'applink', type: 'notify', payload: { title: '已发送到桌面', body: displayName(fs.basename(p)) } });
  }
  return p;
}

/** 「新建应用快捷方式」的应用选择菜单项(配合 showMenu 使用) */
export function appLinkMenuItems(onPick) {
  return list()
    .filter(a => a.desktop !== false)
    .map(a => ({ label: a.name, icon: a.icon, fn: () => onPick(a) }));
}

/** 快捷方式与应用图标一样是启动入口:悬停即预读目标应用 chunk */
export function hoverPrefetch(node, appId) {
  node.addEventListener('mouseenter', () => prefetchOnHover(appId));
}

/* ---------- 桌面快捷方式播种(幂等:缺什么补什么) ---------- */
/* 棋类应用 desktopIcon:false,统一收进「棋类游戏」文件夹 */
const CHESS_APPS = {
  chess3d: '国际象棋',
  xiangqi: '中国象棋',
  go: '围棋',
  gomoku: '五子棋',
  reversi: '黑白棋',
};

/**
 * 确保 user 的桌面拥有全部应用快捷方式(幂等)。
 * - 普通应用 → ~/desktop/<名>.app
 * - 棋类(desktopIcon:false)→ ~/desktop/棋类游戏/<名>.app
 * 用户删掉的也会在下次登录/播种时补回(系统保证入口齐全)。
 * 未登录或无桌面目录时返回 0。
 */
export function ensureDesktopShortcuts(user = accounts.current()) {
  const desk = desktopPath(user);
  if (!desk || !user) return 0;
  if (!fs.isDir(desk)) {
    fs.ensureUserHome(user);
    if (!fs.isDir(desk)) return 0;
  }
  const opts = { as: user, owner: user };
  let n = 0;
  for (const a of list()) {
    if (a.desktop === false || a.desktopIcon === false) continue;
    const p = fs.joinPath(desk, a.name + APPEXT);
    if (!fs.exists(p) && fs.write(p, a.id, opts)) n++;
  }
  // 棋类文件夹
  const chessDir = fs.joinPath(desk, '棋类游戏');
  if (!fs.isDir(chessDir)) {
    fs.mkdir(chessDir, { silent: true, ...opts });
  }
  for (const [id, name] of Object.entries(CHESS_APPS)) {
    if (!get(id)) continue;
    const p = fs.joinPath(chessDir, name + APPEXT);
    if (!fs.exists(p) && fs.write(p, id, opts)) n++;
  }
  if (n) {
    publish('sys:fs-changed', { from: 'applink', type: 'fs-changed', payload: { action: 'seed-shortcuts', path: desk } });
  }
  return n;
}

/* 登录 / 注册 / 建号 → 家目录就绪后立刻补桌面快捷方式 */
subscribe('accounts:changed', (payload, msg) => {
  const t = msg?.type;
  const u = payload?.user || accounts.current();
  if ((t === 'login' || t === 'register') && u) ensureDesktopShortcuts(u);
  // 仅 createUser(未切会话)时也预播种,避免首次登录桌面空白
  if (t === 'created' && u) ensureDesktopShortcuts(u);
});
