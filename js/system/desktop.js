import { $, el, clamp } from '../core/utils.js';
import { icon, paintTile } from '../core/icons.js';
import { subscribe } from '../core/bus.js';
import { settings, wallpaperCss, wallpaperMotion } from '../core/store.js';
import fs from '../core/fs.js';
import { list as listApps } from '../core/registry.js';
import * as wm from '../core/wm.js';
import { showMenu } from '../core/menu.js';
import { dialogs } from '../core/dialogs.js';
import { renderPinned } from './taskbar.js';

/* 桌面:壁纸 + 图标(应用快捷方式与 /home/desktop 文件)*/
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

/* ============ 桌面:应用快捷方式 + 桌面文件(像操作系统一样可操作) ============ */
const ICON_KEY = 'webos.iconpos.v1';
const DESKTOP_DIR = '/home/desktop';
const GRID = { x: 92, y: 104, mx: 12, my: 10 };
const iconPos = (() => {
  try { return JSON.parse(localStorage.getItem(ICON_KEY)) || {}; } catch { return {}; }
})();
const saveIconPos = () => {
  try { localStorage.setItem(ICON_KEY, JSON.stringify(iconPos)); } catch { /* 忽略 */ }
};

/** 桌面文件图标外观 */
function fsTileMeta(name, isDir) {
  if (isDir) return { icon: 'folder', color: 'linear-gradient(135deg,#3b82f6,#1d4ed8)' };
  const ext = name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return { icon: 'image', color: 'linear-gradient(135deg,#a78bfa,#7c3aed)' };
  if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return { icon: 'film', color: 'linear-gradient(135deg,#f472b6,#db2777)' };
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return { icon: 'music', color: 'linear-gradient(135deg,#34d399,#059669)' };
  if (ext === 'pdf') return { icon: 'fileText', color: 'linear-gradient(135deg,#f87171,#dc2626)' };
  return { icon: 'fileText', color: 'linear-gradient(135deg,#94a3b8,#64748b)' };
}

/** 桌面条目:应用快捷方式 + /home/desktop 下的文件 */
function desktopItems() {
  const apps = listApps().filter(a => a.desktop !== false)
    .map(a => ({ kind: 'app', key: 'app:' + a.id, app: a, name: a.name, icon: a.icon, color: a.color || 'var(--accent)' }));
  const files = (fs.list(DESKTOP_DIR) || [])
    .map(f => ({ kind: 'fs', key: 'fs:' + f.path, path: f.path, name: f.name, dir: f.dir,
      ...fsTileMeta(f.name, f.dir) }));
  return [...apps, ...files];
}

function openFsItem(item) {
  if (item.dir) wm.open('files', { params: { path: item.path } });
  else wm.open('notes', { params: { path: item.path } });
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

    const node = el('button', {
      class: 'dicon',
      dataset: { key: item.key, kind: item.kind },
      style: { left: pos.x + 'px', top: pos.y + 'px' },
      title: item.name,
    }, tile, el('span', { class: 'label' }, item.name));

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
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) {
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

    node.addEventListener('dblclick', () => (item.kind === 'app' ? wm.open(item.app.id) : openFsItem(item)));

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!node.classList.contains('selected')) {
        box.querySelectorAll('.dicon').forEach(d => d.classList.remove('selected'));
        node.classList.add('selected');
      }
      if (item.kind === 'app') {
        const pinned = pinnedApps().includes(item.app.id);
        showMenu(e.clientX, e.clientY, [
          { label: '打开', icon: 'chevronR', fn: () => wm.open(item.app.id) },
          ...(item.app.singleton ? [] : [{ label: '打开新窗口', icon: 'plus', fn: () => wm.open(item.app.id) }]),
          { sep: true },
          { label: pinned ? '从任务栏取消固定' : '固定到任务栏', icon: 'check', fn: () => togglePin(item.app.id) },
        ]);
      } else {
        showMenu(e.clientX, e.clientY, [
          { label: item.dir ? '打开' : '用记事本打开', icon: item.dir ? 'folderOpen' : 'fileText', fn: () => openFsItem(item) },
          ...(item.dir ? [{ label: '在文件管家中打开', icon: 'folder', fn: () => wm.open('files', { params: { path: item.path } }) }] : []),
          { sep: true },
          { label: '重命名(F2)', icon: 'pencil', fn: () => desktopRename(item.path) },
          { label: '删除(Del)', icon: 'trash', danger: true, fn: () => desktopDelete(selectedItems().filter(s => s.kind === 'fs').map(s => s.path).concat([])) },
        ]);
      }
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
  showMenu(e.clientX, e.clientY, [
    { label: '新建文本文档', icon: 'filePlus', fn: () => desktopNew('file') },
    { label: '新建文件夹', icon: 'folderPlus', fn: () => desktopNew('dir') },
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
  if (e.key === 'F2' && sel.length === 1 && sel[0].kind === 'fs') {
    e.preventDefault();
    desktopRename(sel[0].path);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    const paths = sel.filter(s => s.kind === 'fs').map(s => s.path);
    if (paths.length) desktopDelete(paths);
  } else if (e.key === 'Enter' && sel.length === 1) {
    e.preventDefault();
    sel[0].kind === 'app' ? wm.open(sel[0].app.id) : openFsItem(sel[0]);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    document.querySelectorAll('.dicon').forEach(d => d.classList.add('selected'));
  }
});
