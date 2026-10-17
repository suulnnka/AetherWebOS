import { $, el, clamp } from '../core/utils.js';
import { icon, paintTile } from '../core/icons.js';
import { subscribe } from '../core/bus.js';
import { settings, wallpaperCss, wallpaperMotion } from '../core/store.js';
import fs, { desktopPath } from '../core/fs.js';
import * as wm from '../core/wm.js';
import { showMenu } from '../core/menu.js';
import { dialogs } from '../core/dialogs.js';
import { isAppLink, appLinkApp, createAppLink, appLinkMenuItems, hoverPrefetch, desktopDir, ensureDesktopShortcuts } from '../core/applink.js';
import { inplaceRename } from '../core/rename.js';
import { renderPinned, pinnedApps, togglePin } from './taskbar.js';
import { accounts } from '../core/accounts.js';
import { moveToTrash, trashCount, emptyTrash } from '../core/trash.js';
import * as clip from '../core/clipboard.js';
import { openFs, askOpenWith } from '../core/openwith.js';
import { startFileDrag, registerTarget, movePaths, trashPaths } from '../core/dragdrop.js';
import { appNames, appName } from '../core/registry.js';
import { t } from '../core/i18n.js';

/** 桌面标签显示名:隐藏 .app 后缀(macOS 桌面式,仅桌面渲染使用;
 * 文件管家、终端与重命名编辑的仍是真实文件名)。
 * .app 快捷方式:文件名(恒为 zh 规范名)去后缀后等于目标应用任一语言
 * 默认名 = 未被用户改名 → 显示当前语言的 appName(docs/i18n.md §7) */
const displayName = (name, path) => {
  const base = String(name).replace(/\.app$/i, '');
  if (path && isAppLink(name)) {
    const app = appLinkApp(path);
    if (app && appNames(app.id).includes(base)) return appName(app.id);
  }
  return base;
};

/* 桌面:壁纸 + 图标(桌面即 ~/desktop = /home/<user>/desktop:
 * 文件、文件夹与 .app 快捷方式;应用入口以快捷方式文件存在)*/
/* ============ 桌面壁纸 ============ */
export function applyWallpaper() {
  const wp = $('#wallpaper');
  wp.style.background = wallpaperCss();   // 先用 shorthand 整体重置,再按需补 size/position
  const motion = wallpaperMotion();
  wp.dataset.motion = motion;
  // 流动型壁纸:光斑画布放大到 220%,给 wpFlow 的 background-position 流动留出余量
  wp.style.backgroundSize = motion === 'flow' ? '220% 220%' : '';
  wp.style.backgroundPosition = motion === 'flow' ? '50% 50%' : '';
}
subscribe('sys:settings-changed', (p) => {
  if (p?.changed?.some(k => ['wallpaperType', 'wallpaperStatic', 'wallpaperDynamic', 'wallpaperUrl'].includes(k))) applyWallpaper();
  // 风格皮肤切换会改变任务栏高度等布局度量,需重排
  if (p?.changed?.includes('style')) { wm.relayout(); renderDesktopIcons(); }
});

/* ============ 桌面 = ~/desktop(/home/<user>/desktop):随会话用户切换 ============ */
const ICON_KEY = 'webos.iconpos.v1';
/** 当前桌面目录(未登录为 null) */
const DESKTOP_DIR = () => desktopDir() || desktopPath();
const GRID = { x: 92, y: 104, mx: 12, my: 10 };
const iconPos = (() => {
  try { return JSON.parse(localStorage.getItem(ICON_KEY)) || {}; } catch { return {}; }
})();
const saveIconPos = () => {
  try { localStorage.setItem(ICON_KEY, JSON.stringify(iconPos)); } catch { /* 忽略 */ }
};

/** 桌面文件图标外观(.app 快捷方式渲染为目标应用的磁贴) */
function fsTileMeta(name, isDir, path) {
  if (isDir) return { icon: 'folder', color: 'linear-gradient(135deg,#3b82f6,#1d4ed8)' };
  if (isAppLink(name)) {
    const app = appLinkApp(path);
    return app
      ? { icon: app.icon, color: app.color || 'var(--accent)', link: true, app }
      : { icon: 'file', color: 'linear-gradient(135deg,#94a3b8,#64748b)', link: true };
  }
  const ext = name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return { icon: 'image', color: 'linear-gradient(135deg,#a78bfa,#7c3aed)' };
  if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return { icon: 'film', color: 'linear-gradient(135deg,#f472b6,#db2777)' };
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return { icon: 'music', color: 'linear-gradient(135deg,#34d399,#059669)' };
  if (ext === 'pdf') return { icon: 'fileText', color: 'linear-gradient(135deg,#f87171,#dc2626)' };
  return { icon: 'fileText', color: 'linear-gradient(135deg,#94a3b8,#64748b)' };
}

/** 桌面条目:即 ~/desktop 的内容(应用入口也是 .app 快捷方式文件),
 *  外加一个常驻虚拟图标:回收站(删除进筒 / 拖拽入筒 / 打开回收站窗口) */
function desktopItems() {
  const dir = DESKTOP_DIR();
  if (!dir) return [];
  return (fs.list(dir) || [])
    .map(f => ({ kind: 'fs', key: 'fs:' + f.path, path: f.path, name: f.name, dir: f.dir,
      label: displayName(f.name, f.path),
      ...fsTileMeta(f.name, f.dir, f.path) }));
}

function openFsItem(item) {
  if (item.dir) return wm.open('files', { params: { path: item.path } });
  if (isAppLink(item.name)) {
    const app = appLinkApp(item.path);
    if (app) return wm.open(app.id);
    dialogs.error({ title: t('快捷方式失效'), message: t('「{name}」指向的应用不存在。', { name: item.name }) });
    return;
  }
  openFs(item.path);   // 打开方式路由:用户默认关联 > 内置默认(md/代码/预览/记事本)
}

/** 选中项(当前 .selected 的桌面条目) */
function selectedItems() {
  return [...document.querySelectorAll('.dicon.selected')].map(n =>
    desktopItems().find(it => it.key === n.dataset.key)).filter(Boolean);
}

async function desktopNew(kind) {
  const dir = DESKTOP_DIR();
  if (!dir) return;
  const name = await dialogs.prompt({
    title: kind === 'dir' ? t('新建文件夹') : t('新建文本文档'),
    message: t('名称:'), value: kind === 'dir' ? '新建文件夹' : '新建文档.txt',
  });
  if (name == null || !name.trim()) return;
  const p = fs.joinPath(dir, name.trim());
  if (kind === 'dir') fs.mkdir(p); else fs.write(p, '');
}

/** 就地重命名(Mac 式):直接在图标标签上编辑。
 * .app 快捷方式编辑显示名(后缀已隐藏),提交时自动补回,保持快捷方式语义。 */
function desktopRename(item) {
  const label = document.querySelector(`.dicon[data-key="${CSS.escape(item.key)}"] .label`);
  if (!label) return;
  inplaceRename(label, displayName(item.name, item.path), (next) => {
    let name = next;
    if (isAppLink(item.name) && !/\.app$/i.test(name)) name += '.app';
    if (name === item.name) return;
    fs.rename(item.path, fs.joinPath(fs.parentPath(item.path), name));
  });
}

/** 删除 = 移入回收站(可逆,免确认;彻底删除在回收站窗口里做) */
function desktopDelete(paths) {
  const n = moveToTrash(paths);
  if (!n) {
    dialogs.error({ title: t('无法删除'), message: t('项目可能已被移动,或你没有删除它的权限。') });
    return;
  }
  for (const p of paths) delete iconPos['fs:' + p];   // 位置簿记随条目清理
  saveIconPos();
}

/* ---- 拖放目标(系统文件拖放协议,见 core/dragdrop.js) ----
 * 悬停解析走 elementFromPoint:被窗口盖住的图标物理上收不到投放,
 * 与真实层叠一致;空会话(纯重排,如拖回收站图标)不接受任何目标 */
registerTarget({
  cls: 'drop-target',
  accepts: (hit, s) => {
    if (!s?.paths?.length) return null;
    const n = hit.closest('.dicon[data-dir="1"]');
    return n && !s.originEls.includes(n) ? n : null;   // 被拖动/选中的图标不作目标
  },
  drop: (n, s) => movePaths(s.paths, n.dataset.key.slice('fs:'.length), s.user),   // 拖入 = 移动
});
registerTarget({
  cls: 'drop-target',
  accepts: (hit, s) => {
    if (!s?.paths?.length) return null;
    const n = hit.closest('.dicon[data-trash="1"]');
    return n && !s.originEls.includes(n) ? n : null;
  },
  drop: (n, s) => trashPaths(s.paths, s.user),          // 拖进回收站 = 删除(可还原)
});
registerTarget({
  cls: null,   // 空白桌面不加高亮
  accepts: (hit) => {
    const id = hit.id;
    return id === 'wallpaper' || id === 'desktop' || id === 'icons' ? hit : null;
  },
  drop: (el, s, x, y) => {
    if (s.onBlankDesktop) s.onBlankDesktop(x, y);          // 桌面源:原位重排
    else movePaths(s.paths, DESKTOP_DIR(), s.user);        // 其他源:收进桌面目录(同目录会报错)
  },
});

/* 桌面图标说明框:不用浏览器原生 title —— 悬停后出现在鼠标旁并跟随移动 */
let tipEl = null;
let tipTimer = 0;
let tipXY = { x: 0, y: 0 };

function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) tipEl.hidden = true;
}

function placeTip() {
  if (!tipEl || tipEl.hidden) return;
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  // 默认在光标右下;贴边则翻到左侧/上方
  let left = tipXY.x + 14;
  let top = tipXY.y + 18;
  if (left + tw > innerWidth - 8) left = tipXY.x - tw - 12;
  if (top + th > innerHeight - 8) top = tipXY.y - th - 12;
  tipEl.style.left = clamp(left, 8, innerWidth - tw - 8) + 'px';
  tipEl.style.top = clamp(top, 8, innerHeight - th - 8) + 'px';
}

function showTipFor(text, x, y) {
  if (!text) return;
  if (!tipEl) {
    tipEl = el('div', { id: 'tip', hidden: true });
    document.body.append(tipEl);
  }
  tipEl.textContent = text;
  tipEl.hidden = false;
  tipXY = { x, y };
  placeTip();
}

function bindIconTip(node, text) {
  node.addEventListener('pointerenter', (e) => {
    tipXY = { x: e.clientX, y: e.clientY };
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTipFor(text, tipXY.x, tipXY.y), 450);
  });
  node.addEventListener('pointermove', (e) => {
    tipXY = { x: e.clientX, y: e.clientY };
    if (tipEl && !tipEl.hidden) placeTip();
  });
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('pointerdown', hideTip);
}

export function renderDesktopIcons() {
  const box = $('#icons');
  box.innerHTML = '';
  hideTip();
  const items = desktopItems();
  // 位置簿记随条目清理(拖走/删除后不残留;未登录时桌面列表恒空,不背锅)
  if (DESKTOP_DIR()) {
    const live = new Set(items.map(it => it.key));
    let pruned = false;
    for (const k of Object.keys(iconPos)) {
      if (k.startsWith('fs:') && !live.has(k)) { delete iconPos[k]; pruned = true; }
    }
    if (pruned) saveIconPos();
  }
  // 回收站常驻图标:排在最后,默认钉在最后一列的底部(Windows 式右下角)
  items.push({ kind: 'trash', key: 'trash', name: '回收站', label: t('回收站'),
    icon: 'trash', color: 'linear-gradient(135deg,#64748b,#475569)' });
  const trashN = trashCount();
  const areaW = box.clientWidth, areaH = box.clientHeight;
  const rows = Math.max(1, Math.floor((areaH - GRID.my) / GRID.y));
  const snap = (v, g, m) => Math.round((v - m) / g) * g + m;

  items.forEach((item, i) => {
    const def = item.kind === 'trash'
      ? { x: GRID.mx + Math.floor(i / rows) * GRID.x, y: GRID.my + (rows - 1) * GRID.y }
      : { x: GRID.mx + Math.floor(i / rows) * GRID.x, y: GRID.my + (i % rows) * GRID.y };
    const pos = iconPos[item.key] || def;

    const tile = el('div', { class: 'tile' });
    paintTile(tile, item);
    tile.append(icon(item.icon, Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tile') || 48) * 0.52) || 24));
    if (item.link) tile.append(el('span', { class: 'lnk-badge' }, icon('external', 9)));
    if (item.kind === 'trash' && trashN > 0) {
      tile.append(el('span', { class: 'trash-badge' }, trashN > 99 ? '99+' : String(trashN)));
    }

    const tipText = item.kind === 'trash' ? t('回收站:删除的文件先进这里,可还原') : item.name;   // 悬停提示始终给真实文件名(含 .app)
    const node = el('button', {
      class: 'dicon' + (item.kind === 'fs' && clip.isCut(item.path) ? ' cut' : ''),
      dataset: { key: item.key, kind: item.kind, ...(item.dir ? { dir: '1' } : {}), ...(item.kind === 'trash' ? { trash: '1' } : {}) },
      style: { left: pos.x + 'px', top: pos.y + 'px' },
    }, tile, el('span', { class: 'label' }, item.label || item.name));
    bindIconTip(node, tipText);

    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.ctrlKey || e.metaKey) node.classList.toggle('selected');
      else {
        if (!node.classList.contains('selected')) {
          box.querySelectorAll('.dicon').forEach(d => d.classList.remove('selected'));
        }
        node.classList.add('selected');
      }
      // 系统拖放协议:过 5px 阈值起拖 —— 原图标原地淡显,幽灵浮于窗口之上,
      // 放置目标(文件夹/回收站图标、文件管家窗口、空白桌面)由 dragdrop 统一裁决
      const offX = e.clientX - pos.x, offY = e.clientY - pos.y;
      startFileDrag(e, () => {
        const items = selectedItems().filter(s => s.kind === 'fs');
        // 非文件图标(回收站)也可拖:空会话纯重排,任何放置目标都不接受
        return {
          paths: items.map(s => s.path),
          originEls: [...box.querySelectorAll('.dicon.selected')],
          ghost: items.length
            ? { icon: items[0].icon, color: items[0].color, label: items[0].label || items[0].name }
            : { icon: item.icon, color: item.color, label: item.label || item.name },
          // 空白桌面 = 原位重排:抓取的图标吸附到松手点网格
          onBlankDesktop: (x, y) => {
            pos.x = clamp(snap(x - offX, GRID.x, GRID.mx), 0, areaW - 84);
            pos.y = clamp(snap(y - offY, GRID.y, GRID.my), 0, areaH - 96);
            node.style.left = pos.x + 'px';
            node.style.top = pos.y + 'px';
            iconPos[item.key] = { ...pos };
            saveIconPos();
          },
        };
      });
    });

    node.addEventListener('dblclick', () => {
      // 打开即取消选中:双击启动/打开后图标不应停留在选中态
      box.querySelectorAll('.dicon.selected').forEach(d => d.classList.remove('selected'));
      if (item.kind === 'trash') return wm.open('trash');
      openFsItem(item);
    });

    // 悬停预读 chunk:.app 快捷方式也是启动入口(item.app 来自 applink)
    if (item.app) hoverPrefetch(node, item.app.id);

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (item.kind === 'trash') {
        showMenu(e.clientX, e.clientY, [
          { label: t('打开回收站'), icon: 'trash', fn: () => wm.open('trash') },
          ...(trashN > 0 ? [{ label: t('清空回收站({n})', { n: trashN }), icon: 'close', danger: true, fn: async () => {
            const ok = await dialogs.confirm({
              title: t('清空回收站'), danger: true, okText: t('清空'),
              message: t('将彻底删除回收站中的 {n} 个项目,此操作不可恢复。确定继续吗?', { n: trashN }),
            });
            if (ok) emptyTrash();
          } }] : []),
        ]);
        return;
      }
      if (!node.classList.contains('selected')) {
        box.querySelectorAll('.dicon').forEach(d => d.classList.remove('selected'));
        node.classList.add('selected');
      }
      const linkApp = !item.dir && isAppLink(item.name) ? appLinkApp(item.path) : null;
      const pinned = linkApp && pinnedApps().includes(linkApp.id);
      const selPaths = selectedItems().filter(s => s.kind === 'fs').map(s => s.path);
      showMenu(e.clientX, e.clientY, [
        { label: item.dir ? t('打开') : linkApp ? t('打开「{name}」', { name: appName(linkApp.id) }) : t('用记事本打开'),
          icon: item.dir ? 'folderOpen' : linkApp ? linkApp.icon : 'fileText', fn: () => openFsItem(item) },
        ...(item.dir ? [{ label: t('在文件管家中打开'), icon: 'folder', fn: () => wm.open('files', { params: { path: item.path } }) }] : []),
        ...(linkApp ? [{ label: pinned ? t('从任务栏取消固定') : t('固定到任务栏'), icon: 'check', fn: () => togglePin(linkApp.id) }] : []),
        ...(!item.dir && !linkApp ? [{ label: t('打开方式…'), icon: 'external', fn: () => askOpenWith(item.path) }] : []),
        { sep: true },
        { label: t('复制(Ctrl+C)'), icon: 'copy', fn: () => clip.setFiles('copy', selPaths) },
        { label: t('剪切(Ctrl+X)'), icon: 'scissors', fn: () => clip.setFiles('cut', selPaths) },
        { sep: true },
        { label: t('重命名(F2)'), icon: 'pencil', fn: () => desktopRename(item) },
        { label: t('删除(Del)'), icon: 'trash', danger: true, fn: () => desktopDelete(selectedItems().map(s => s.path)) },
      ]);
    });

    box.append(node);
  });
}

/* ---- 桌面文件系统联动:任何应用改写当前用户桌面都实时刷新 ----
 * 普通事件带单个 path;fs.batch 合并事件带 paths 数组(其 path 字段是
 * 公共祖先,过不了桌面前缀判定,必须逐路径判) */
subscribe('sys:fs-changed', (p) => {
  const dir = DESKTOP_DIR();
  const paths = p?.paths || (p?.path ? [p.path] : []);
  if (dir && paths.some((x) => String(x).startsWith(dir))) renderDesktopIcons();
});

/* 回收站变化(删除入筒/还原/清空)刷新桌面:角标计数 + 条目增减 */
subscribe('sys:trash-changed', () => renderDesktopIcons());
/* 剪贴板变化刷新剪切淡显态 */
subscribe('sys:clipboard-changed', () => renderDesktopIcons());

/* 切换用户 → 重建家目录快捷方式并刷新桌面 */
subscribe('accounts:changed', (payload, msg) => {
  if (msg?.type === 'login' || msg?.type === 'register') {
    const u = payload?.user || accounts.current();
    if (u) ensureDesktopShortcuts(u);
    renderDesktopIcons();
  } else if (msg?.type === 'logout' || msg?.type === 'removed') {
    renderDesktopIcons();
  } else if (msg?.type === 'renamed') {
    // 家目录目录名跟随改名:路径变了,重建快捷方式并重绘
    const u = payload?.to || accounts.current();
    if (u) ensureDesktopShortcuts(u);
    renderDesktopIcons();
  }
});

/* ---- 点击桌面 → 取消窗口激活 ----
 * 「操作落在窗口外」:活动窗口失焦(键盘焦点一并收回),与「点击窗口即激活」
 * 相对,构成完整的焦点语义。任务栏/开始菜单是 shell 操作区,不在失焦范围。 */
$('#desktop').addEventListener('pointerdown', (e) => {
  const tgt = e.target;
  if (tgt.id !== 'wallpaper' && tgt.id !== 'desktop' && tgt.id !== 'icons' &&
      !tgt.closest?.('.dicon')) return;
  wm.blur();
});

/* ---- 橡皮筋框选(空白处拖动) ---- */
$('#desktop').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.id !== 'wallpaper' && e.target.id !== 'desktop' && e.target.id !== 'icons') return;
  const icons = [...document.querySelectorAll('.dicon')];
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  const band = el('div', { id: 'rubber' });
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    moved = true;
    if (!band.isConnected) $('#desktop').append(band);
    const l = Math.min(startX, ev.clientX), t = Math.min(startY, ev.clientY);
    const w = Math.abs(ev.clientX - startX), h = Math.abs(ev.clientY - startY);
    Object.assign(band.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
    for (const n of icons) {
      const r = n.getBoundingClientRect();
      const hit = !(r.right < l || r.left > l + w || r.bottom < t || r.top > t + h);
      n.classList.toggle('selected', hit);
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    band.remove();
    if (!moved) document.querySelectorAll('.dicon.selected').forEach(d => d.classList.remove('selected'));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

/* ---- 桌面右键菜单 ---- */
$('#desktop').addEventListener('contextmenu', (e) => {
  if (e.target.id !== 'wallpaper' && e.target.id !== 'desktop' && e.target.id !== 'icons') return;
  e.preventDefault();
  const cx = e.clientX, cy = e.clientY;
  const dir = DESKTOP_DIR();
  showMenu(cx, cy, [
    { label: t('新建文本文档'), icon: 'filePlus', fn: () => desktopNew('file') },
    { label: t('新建文件夹'), icon: 'folderPlus', fn: () => desktopNew('dir') },
    { label: t('新建应用快捷方式'), icon: 'star',
      fn: () => {
        if (!dir) return;
        showMenu(cx, cy, appLinkMenuItems((a) => createAppLink(dir, a.id)));
      } },
    ...(clip.hasFiles() ? [{ label: t('粘贴(Ctrl+V)'), icon: 'clipboard', fn: () => pasteOnDesktop() }] : []),
    { sep: true },
    {
      label: t('排列图标'), icon: 'grid', fn: () => {
        for (const it of desktopItems()) delete iconPos[it.key];
        saveIconPos();
        renderDesktopIcons();
      },
    },
    { label: t('刷新'), icon: 'refresh', fn: () => { renderDesktopIcons(); applyWallpaper(); } },
    { sep: true },
    { label: t('更换壁纸'), icon: 'image', fn: () => wm.open('settings', { params: { section: 'wallpaper' } }) },
    { label: t('显示设置'), icon: 'monitor', fn: () => wm.open('settings', { params: { section: 'display' } }) },
    { sep: true },
    { label: t('打开终端'), icon: 'terminal', fn: () => wm.open('terminal') },
    { label: t('在此处打开文件管家'), icon: 'folder', fn: () => {
      if (dir) wm.open('files', { params: { path: dir } });
    } },
  ]);
});

/** 桌面粘贴(目标 = 桌面目录,执行用户 = 会话用户) */
async function pasteOnDesktop() {
  const dir = DESKTOP_DIR();
  if (!dir) return;
  const r = await clip.pasteInto(dir, accounts.current());
  if (r.copied + r.moved === 0) dialogs.error({ title: t('粘贴失败'), message: t('剪贴板里的项目可能已被移动或删除。') });
}

/* ---- 桌面键盘操作:F2 重命名 / Delete 删除 / Enter 打开 / Ctrl+A 全选 ---- */
/* 捕获相监听:必须在应用处理器之前判定 —— 应用(如 md 编辑器)可能在
 * keydown 处理中重建 DOM,把事件 target 摘出文档树,使冒泡相的
 * closest('.win') 与 activeElement 双双失效(曾致编辑器内回车反复
 * 打开桌面选中项,弹个不停)。 */
document.addEventListener('keydown', (e) => {
  /* 仅桌面上下文生效:按键源自应用窗口(含 md 编辑器的 contenteditable
   * 活动壳)、弹层或开始菜单时属于应用,不接管桌面选中项。 */
  if (e.target?.closest?.('.win, .modal-mask, .modal-box, #start-menu, #ctx')) return;
  const ae = document.activeElement;
  const tag = ae?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || ae?.isContentEditable) return;
  if (document.querySelector('.modal-shade')) return;
  const sel = selectedItems();
  if (!sel.length) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      document.querySelectorAll('.dicon').forEach(d => d.classList.add('selected'));
    }
    return;
  }
  if (e.key === 'F2' && sel.length === 1) {
    e.preventDefault();
    desktopRename(sel[0]);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    const paths = sel.map(s => s.path);
    if (paths.length) desktopDelete(paths);
  } else if (e.key === 'Enter' && sel.length === 1) {
    e.preventDefault();
    openFsItem(sel[0]);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    document.querySelectorAll('.dicon').forEach(d => d.classList.add('selected'));
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    clip.setFiles('copy', sel.filter(s => s.kind === 'fs').map(s => s.path));
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    clip.setFiles('cut', sel.filter(s => s.kind === 'fs').map(s => s.path));
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pasteOnDesktop();
  }
}, true);
