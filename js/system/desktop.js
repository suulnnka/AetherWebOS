import { $, el, clamp } from '../core/utils.js';
import { icon, paintTile } from '../core/icons.js';
import { subscribe } from '../core/bus.js';
import { settings, wallpaperCss, wallpaperMotion } from '../core/store.js';
import fs from '../core/fs.js';
import * as wm from '../core/wm.js';
import { showMenu } from '../core/menu.js';
import { dialogs } from '../core/dialogs.js';
import { isAppLink, displayName, appLinkApp, createAppLink, appLinkMenuItems, hoverPrefetch } from '../core/applink.js';
import { renderPinned, pinnedApps, togglePin } from './taskbar.js';

/* 桌面:壁纸 + 图标(桌面即 /home/desktop 目录:文件、文件夹与 .app 应用快捷方式,
 * 系统不为应用自动生成图标;自动生成的应用列表在开始菜单)*/
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

/* ============ 桌面 = /home/desktop:文件、文件夹与 .app 快捷方式(像操作系统一样可操作) ============ */
const ICON_KEY = 'webos.iconpos.v1';
const DESKTOP_DIR = '/home/desktop';
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

/** 桌面条目:即 /home/desktop 的内容(应用入口也是 .app 快捷方式文件,
 *  系统不为应用自动生成桌面图标;完整应用列表在开始菜单) */
function desktopItems() {
  return (fs.list(DESKTOP_DIR) || [])
    .map(f => ({ kind: 'fs', key: 'fs:' + f.path, path: f.path, name: f.name, dir: f.dir,
      label: displayName(f.name),
      ...fsTileMeta(f.name, f.dir, f.path) }));
}

function openFsItem(item) {
  if (item.dir) return wm.open('files', { params: { path: item.path } });
  if (isAppLink(item.name)) {
    const app = appLinkApp(item.path);
    if (app) return wm.open(app.id);
    dialogs.error({ title: '快捷方式失效', message: `「${displayName(item.name)}」指向的应用不存在。` });
    return;
  }
  wm.open('notes', { params: { path: item.path } });
}

/** 选中项(当前 .selected 的桌面条目) */
function selectedItems() {
  return [...document.querySelectorAll('.dicon.selected')].map(n =>
    desktopItems().find(it => it.key === n.dataset.key)).filter(Boolean);
}

async function desktopNew(kind) {
  const name = await dialogs.prompt({
    title: kind === 'dir' ? '新建文件夹' : '新建文本文档',
    message: '名称:', value: kind === 'dir' ? '新建文件夹' : '新建文档.txt',
  });
  if (name == null || !name.trim()) return;
  const p = fs.joinPath(DESKTOP_DIR, name.trim());
  if (kind === 'dir') fs.mkdir(p); else fs.write(p, '');
}

async function desktopRename(path) {
  const name = await dialogs.prompt({ title: '重命名', message: '新名称:', value: fs.basename(path) });
  if (name == null || !name.trim() || name.trim() === fs.basename(path)) return;
  fs.rename(path, fs.joinPath(fs.parentPath(path), name.trim()));
}

async function desktopDelete(paths) {
  const one = paths.length === 1 ? `「${fs.basename(paths[0])}」` : `${paths.length} 个项目`;
  const ok = await dialogs.confirm({
    title: '删除', message: `确定删除 ${one} 吗?`, danger: true, okText: '删除',
  });
  if (!ok) return;
  paths.forEach(p => fs.rm(p));
}

/* ---- 拖动图标放入文件夹 ---- */
/** 光标处的文件夹图标(排除被拖动的与已选中的) */
function dropTargetAt(x, y, draggedNode) {
  const sel = new Set(document.querySelectorAll('.dicon.selected'));
  for (const n of document.querySelectorAll('.dicon[data-dir="1"]')) {
    if (n === draggedNode || sel.has(n)) continue;
    const r = n.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return n;
  }
  return null;
}

/** 把当前选中的桌面文件(含 .app 快捷方式)移入目标文件夹 */
function moveToFolder(targetNode) {
  const dir = targetNode.dataset.key.slice('fs:'.length);
  const items = selectedItems().filter(s => s.kind === 'fs'
    && s.path !== dir && fs.parentPath(s.path) !== dir);
  let n = 0;
  for (const it of items) {
    const dest = fs.joinPath(dir, it.name);
    if (fs.exists(dest)) continue;             // 目标重名时跳过,不做覆盖
    if (fs.rename(it.path, dest)) { delete iconPos[it.key]; n++; }
  }
  saveIconPos();
  return n;                                    // rename 触发 fs-changed → 自动重渲染
}

export function renderDesktopIcons() {
  const box = $('#icons');
  box.innerHTML = '';
  const items = desktopItems();
  const areaW = box.clientWidth, areaH = box.clientHeight;
  const rows = Math.max(1, Math.floor((areaH - GRID.my) / GRID.y));
  const snap = (v, g, m) => Math.round((v - m) / g) * g + m;

  items.forEach((item, i) => {
    const def = { x: GRID.mx + Math.floor(i / rows) * GRID.x, y: GRID.my + (i % rows) * GRID.y };
    const pos = iconPos[item.key] || def;

    const tile = el('div', { class: 'tile' });
    paintTile(tile, item);
    tile.append(icon(item.icon, Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tile') || 48) * 0.52) || 24));
    if (item.link) tile.append(el('span', { class: 'lnk-badge', title: '应用快捷方式' }, icon('external', 9)));

    const node = el('button', {
      class: 'dicon',
      dataset: { key: item.key, kind: item.kind, ...(item.dir ? { dir: '1' } : {}) },
      style: { left: pos.x + 'px', top: pos.y + 'px' },
      title: item.label || item.name,
    }, tile, el('span', { class: 'label' }, item.label || item.name));

    const clearDropHover = () =>
      box.querySelectorAll('.dicon.drop-target').forEach(d => d.classList.remove('drop-target'));

    let moved = false;
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      moved = false;
      if (e.ctrlKey || e.metaKey) node.classList.toggle('selected');
      else {
        if (!node.classList.contains('selected')) {
          box.querySelectorAll('.dicon').forEach(d => d.classList.remove('selected'));
        }
        node.classList.add('selected');
      }
      const sx = e.clientX - pos.x, sy = e.clientY - pos.y;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
        moved = true;
        node.classList.add('dragging');
        pos.x = clamp(ev.clientX - sx, 0, areaW - 84);
        pos.y = clamp(ev.clientY - sy, 0, areaH - 96);
        node.style.left = pos.x + 'px';
        node.style.top = pos.y + 'px';
        // 悬停在某文件夹图标上时高亮,提示松手即移入
        clearDropHover();
        dropTargetAt(ev.clientX, ev.clientY, node)?.classList.add('drop-target');
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        clearDropHover();
        if (moved) {
          const target = dropTargetAt(ev.clientX, ev.clientY, node);
          if (target && moveToFolder(target)) return;   // 移入成功:fs-changed 触发重渲染
          // 网格吸附
          pos.x = clamp(snap(pos.x, GRID.x, GRID.mx), 0, areaW - 84);
          pos.y = clamp(snap(pos.y, GRID.y, GRID.my), 0, areaH - 96);
          node.style.left = pos.x + 'px';
          node.style.top = pos.y + 'px';
          iconPos[item.key] = { ...pos };
          saveIconPos();
        }
        node.classList.remove('dragging');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    node.addEventListener('dblclick', () => openFsItem(item));

    // 悬停预读 chunk:.app 快捷方式也是启动入口(item.app 来自 applink)
    if (item.app) hoverPrefetch(node, item.app.id);

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!node.classList.contains('selected')) {
        box.querySelectorAll('.dicon').forEach(d => d.classList.remove('selected'));
        node.classList.add('selected');
      }
      const linkApp = !item.dir && isAppLink(item.name) ? appLinkApp(item.path) : null;
      const pinned = linkApp && pinnedApps().includes(linkApp.id);
      showMenu(e.clientX, e.clientY, [
        { label: item.dir ? '打开' : linkApp ? `打开「${linkApp.name}」` : '用记事本打开',
          icon: item.dir ? 'folderOpen' : linkApp ? linkApp.icon : 'fileText', fn: () => openFsItem(item) },
        ...(item.dir ? [{ label: '在文件管家中打开', icon: 'folder', fn: () => wm.open('files', { params: { path: item.path } }) }] : []),
        ...(linkApp ? [{ label: pinned ? '从任务栏取消固定' : '固定到任务栏', icon: 'check', fn: () => togglePin(linkApp.id) }] : []),
        { sep: true },
        { label: '重命名(F2)', icon: 'pencil', fn: () => desktopRename(item.path) },
        { label: '删除(Del)', icon: 'trash', danger: true, fn: () => desktopDelete(selectedItems().map(s => s.path)) },
      ]);
    });

    box.append(node);
  });
}

/* ---- 桌面文件系统联动:任何应用改写 /home/desktop 都实时刷新 ---- */
subscribe('sys:fs-changed', (p) => {
  if (String(p?.path || '').startsWith(DESKTOP_DIR)) renderDesktopIcons();
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
  showMenu(cx, cy, [
    { label: '新建文本文档', icon: 'filePlus', fn: () => desktopNew('file') },
    { label: '新建文件夹', icon: 'folderPlus', fn: () => desktopNew('dir') },
    { label: '新建应用快捷方式', icon: 'star',
      fn: () => showMenu(cx, cy, appLinkMenuItems((a) => createAppLink(DESKTOP_DIR, a.id))) },
    { sep: true },
    {
      label: '排列图标', icon: 'grid', fn: () => {
        for (const it of desktopItems()) delete iconPos[it.key];
        saveIconPos();
        renderDesktopIcons();
      },
    },
    { label: '刷新', icon: 'refresh', fn: () => { renderDesktopIcons(); applyWallpaper(); } },
    { sep: true },
    { label: '更换壁纸', icon: 'image', fn: () => wm.open('settings', { params: { section: 'wallpaper' } }) },
    { label: '显示设置', icon: 'monitor', fn: () => wm.open('settings', { params: { section: 'display' } }) },
    { sep: true },
    { label: '打开终端', icon: 'terminal', fn: () => wm.open('terminal') },
    { label: '在此处打开文件管家', icon: 'folder', fn: () => wm.open('files', { params: { path: DESKTOP_DIR } }) },
  ]);
});

/* ---- 桌面键盘操作:F2 重命名 / Delete 删除 / Enter 打开 / Ctrl+A 全选 ---- */
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
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
    desktopRename(sel[0].path);
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
  }
});
