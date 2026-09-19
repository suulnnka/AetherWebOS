/* ============================================================
 * AppLink —— 应用快捷方式(.app 文件)
 *
 * 快捷方式就是一个内容为应用 ID 的普通文本文件(如「国际象棋.app」
 * 内容为 chess3d),可以像普通文件一样被复制、移动、重命名,放在
 * 任意文件夹(含桌面目录 /home/desktop)里。桌面、文件管家、终端
 * 都按扩展名识别并以应用磁贴的外观渲染,双击即启动目标应用。
 * ============================================================ */

import fs from './fs.js';
import { get, list, prefetchOnHover } from './registry.js';

export const APPEXT = '.app';

/** 文件名是否为应用快捷方式 */
export const isAppLink = (name) => String(name).toLowerCase().endsWith(APPEXT);

/** 快捷方式的显示名(隐藏 .app 扩展名,像 .lnk 一样) */
export const displayName = (name) => String(name).replace(/\.app$/i, '');

/** 读快捷方式指向的应用清单;文件缺失/内容无效时返回 null */
export function appLinkApp(path) {
  const content = fs.read(path);
  if (content == null) return null;
  return get(content.trim()) || null;
}

/** 从应用彩色渐变里取第一个 hex(files 列表用单色渲染图标) */
export function flatColor(manifest, fallback = '#4f9cf9') {
  const m = /#[0-9a-f]{3,8}/i.exec(manifest?.color || '');
  return m ? m[0] : fallback;
}

/** 在 dir 下创建「<应用名>.app」快捷方式,重名自动追加序号;返回路径或 null */
export function createAppLink(dir, appId) {
  const app = get(appId);
  if (!app || !fs.isDir(dir)) return null;
  let name = app.name + APPEXT;
  for (let i = 2; fs.exists(fs.joinPath(dir, name)); i++) {
    name = `${app.name} (${i})${APPEXT}`;
  }
  const p = fs.joinPath(dir, name);
  return fs.write(p, appId) ? p : null;
}

/** 「新建应用快捷方式」的应用选择菜单项(配合 showMenu 使用) */
export function appLinkMenuItems(onPick) {
  return list()
    .filter(a => a.desktop !== false)
    .map(a => ({ label: a.name, icon: a.icon, fn: () => onPick(a) }));
}

/** 快捷方式与应用图标一样是启动入口:悬停即预读目标应用 chunk,
 *  无论快捷方式在桌面还是某个文件夹里(围棋等 hoverPrefetch: false 的应用内部跳过) */
export function hoverPrefetch(node, appId) {
  node.addEventListener('mouseenter', () => prefetchOnHover(appId));
}
