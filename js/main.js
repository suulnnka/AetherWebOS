/* ============================================================
 * WebOS 启动入口 —— 桌面外壳
 * 负责:壁纸、桌面图标、任务栏、开始菜单、托盘(音量/通知/时钟)、
 *       通知吐司、右键菜单、开关机画面、全局快捷键。
 * ============================================================ */

import './apps/files.js';
import './apps/localfiles.js';
import './apps/viewer.js';
import './apps/mail.js';
import './apps/todo.js';
import './apps/smsapp.js';
import './apps/notes.js';
import './apps/settings.js';
import './apps/calc.js';
import './apps/terminal.js';
import './apps/bash.js';
import './apps/monitor.js';
import './apps/music.js';
import './apps/browser.js';
import './game/index.js';   // 示例游戏《赛博档案》:注册虚拟 DNS/站点/SSH 服务器
import { dialogs } from './core/dialogs.js';   // 系统对话框服务(注册 sysdialog 应用)

import { $, el, clamp, fmtDate, fmtTime } from './core/utils.js';
import { icon, svg } from './core/icons.js';
import { subscribe, publish } from './core/bus.js';
import { settings, wallpaperCss, applyAll as applyAllSettings } from './core/store.js';
import fs from './core/fs.js';
import vnet from './core/vnet.js';
import mailSvc from './core/mail.js';
import smsSvc from './core/sms.js';
import { list as listApps } from './core/registry.js';
import * as wm from './core/wm.js';
import { showMenu, hideMenu } from './core/menu.js';
import { WebOS as SYS } from './core/exports.js';

/* ============ 桌面壁纸 ============ */
function applyWallpaper() {
  $('#wallpaper').style.background = wallpaperCss();
}
subscribe('sys:settings-changed', (p) => {
  if (p?.changed?.some(k => ['wallpaper', 'wallpaperUrl'].includes(k))) applyWallpaper();
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

function renderDesktopIcons() {
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
    tile.style.background = item.color;
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

/* ============ 任务栏:固定按钮(可动态固定/取消) ============ */
const DEFAULT_PINNED = ['files', 'notes', 'terminal'];
const pinnedApps = () => settings.get('pinnedApps') || DEFAULT_PINNED;

function togglePin(id) {
  const cur = pinnedApps();
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
  settings.set({ pinnedApps: next });
}
subscribe('sys:settings-changed', (p) => {
  if (p?.changed?.includes('pinnedApps')) renderPinned();
});

function renderPinned() {
  const box = $('#tb-pinned');
  box.innerHTML = '';
  for (const id of pinnedApps()) {
    const app = listApps().find(a => a.id === id);
    if (!app) continue;
    const b = el('button', {
      class: 'tbtn', title: app.name,
      onClick: () => {
        // 已在运行:聚焦;否则启动
        const open = wm.taskList().filter(w => w.appId === id);
        if (open.length) {
          const active = open.find(w => w.state !== 'min');
          if (active) { if (active.id === focusedId) wm.minimize(active.id); else wm.focus(active.id); }
          else wm.restoreWin(open[0].id);
        } else wm.open(id);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: `打开 ${app.name}`, icon: 'chevronR', fn: () => wm.open(app.id) },
          { sep: true },
          { label: '从任务栏取消固定', icon: 'close', danger: true, fn: () => togglePin(app.id) },
        ]);
      },
    }, (() => { const t = el('span', { class: 't-ico' }); t.style.background = app.color; t.append(icon(app.icon, 14)); return t; })());
    // 应用专属霓虹色(任务栏芯片灯条消费)
    if (app.neon?.a) b.style.setProperty('--neon-a', app.neon.a);
    if (app.neon?.b) b.style.setProperty('--neon-b', app.neon.b);
    box.append(b);
  }
}

let focusedId = null;
const tasksBox = $('#tb-tasks');

function renderTasks() {
  tasksBox.innerHTML = '';
  for (const w of wm.taskList()) {
    const b = el('button', {
      class: 'tbtn' + (w.id === focusedId && w.state !== 'min' ? ' active' : ''),
      title: w.title,
      onClick: () => {
        if (w.id === focusedId && w.state !== 'min') wm.minimize(w.id);
        else if (w.state === 'min') wm.restoreWin(w.id);
        else wm.focus(w.id);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        const pinned = pinnedApps().includes(w.appId);
        showMenu(e.clientX, e.clientY, [
          { label: w.state === 'min' ? '还原' : '最小化', icon: 'minus', fn: () => (w.state === 'min' ? wm.restoreWin(w.id) : wm.minimize(w.id)) },
          { label: pinned ? '从任务栏取消固定' : '固定到任务栏', icon: 'check', fn: () => togglePin(w.appId) },
          { sep: true },
          { label: '关闭窗口', icon: 'close', danger: true, fn: () => wm.close(w.id) },
        ]);
      },
    }, (() => { const t = el('span', { class: 't-ico' }); t.style.background = w.color || 'var(--accent)'; t.append(icon(w.icon || 'file', 14)); return t; })(),
      el('span', { class: 't-title' }, w.title));
    if (w.neon?.a) b.style.setProperty('--neon-a', w.neon.a);
    if (w.neon?.b) b.style.setProperty('--neon-b', w.neon.b);
    tasksBox.append(b);
  }
}

for (const ev of ['open', 'close', 'focus', 'min', 'restore', 'max', 'unmax', 'title']) {
  subscribe(`sys:win-${ev}`, (p) => {
    if (ev === 'focus') focusedId = p?.id ?? null;
    renderTasks();
  });
}

/* ============ 开始菜单 ============ */
const startMenu = $('#start-menu');
const smInput = $('#sm-input');
let smOpen = false;

function renderStartMenu() {
  const grid = $('#sm-grid');
  grid.innerHTML = '';
  const apps = listApps().filter(a => a.desktop !== false);
  if (!apps.length) return;
  for (const app of apps) {
    const tile = el('div', { class: 'tile' });
    tile.style.background = app.color || 'var(--accent)';
    tile.append(icon(app.icon, 21));
    const item = el('button', {
      class: 'sm-item', 'data-search': (app.name + ' ' + app.id).toLowerCase(),
      onClick: () => { toggleStartMenu(false); wm.open(app.id); },
    }, tile, el('span', { class: 'name' }, app.name));
    // 开始菜单右键:打开 / 新窗口 / 固定到任务栏
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pinned = pinnedApps().includes(app.id);
      showMenu(e.clientX, e.clientY, [
        { label: '打开', icon: 'chevronR', fn: () => { toggleStartMenu(false); wm.open(app.id); } },
        ...(app.singleton ? [] : [{ label: '打开新窗口', icon: 'plus', fn: () => { toggleStartMenu(false); wm.open(app.id); } }]),
        { sep: true },
        { label: pinned ? '从任务栏取消固定' : '固定到任务栏', icon: 'check', fn: () => togglePin(app.id) },
      ]);
    });
    grid.append(item);
  }
}

function filterStartMenu() {
  const q = smInput.value.trim().toLowerCase();
  let first = null;
  document.querySelectorAll('.sm-item').forEach(n => {
    const hit = !q || n.dataset.search.includes(q);
    n.classList.toggle('hide', !hit);
    if (hit && !first) first = n;
  });
  const empty = $('#sm-empty');
  if (!first && !empty && q) {
    $('#sm-grid').append(el('div', { class: 'sm-empty', id: 'sm-empty' }, `没有找到「${q}」相关应用`));
  } else if (empty && first) empty.remove();
}

function toggleStartMenu(force) {
  smOpen = force ?? !smOpen;
  startMenu.classList.toggle('open', smOpen);
  $('#start-btn').classList.toggle('on', smOpen);
  if (smOpen) {
    smInput.value = '';
    filterStartMenu();
    renderStartUser();
    setTimeout(() => smInput.focus(), 60);
  }
}

$('#start-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleStartMenu(); });
smInput.addEventListener('input', filterStartMenu);
smInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = document.querySelector('.sm-item:not(.hide)');
    if (first) first.click();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (smOpen && !e.target.closest('#start-menu') && !e.target.closest('#start-btn')) toggleStartMenu(false);
});

function renderStartUser() {
  const name = settings.get('username');
  $('#sm-username').textContent = name;
  $('#sm-avatar').textContent = (name[0] || 'A').toUpperCase();
}
$('#sm-user').addEventListener('click', () => {
  toggleStartMenu(false);
  wm.open('settings', { params: { section: 'user' } });
});
$('#sm-power').innerHTML = svg('power', 17);
$('#sm-power').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left - 130, r.top - 100, [
    { label: '重启', icon: 'refresh', fn: () => powerAction('reboot') },
    { label: '关机', icon: 'power', danger: true, fn: () => powerAction('shutdown') },
  ]);
});

/* ============ 托盘:弹出面板管理 ============ */
let openPop = null;

function closePopover() {
  if (!openPop) return;
  openPop.pop.remove();
  openPop.anchor.classList.remove('on');
  openPop = null;
}

function togglePopover(name, anchor, build, width) {
  if (openPop?.name === name) return closePopover();
  closePopover();
  const pop = el('div', { class: 'popover', dataset: { pop: name }, style: width ? { width: width + 'px' } : {} }, build());
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  pop.style.right = clamp(innerWidth - r.right - r.width / 2 - pw / 2, 8, innerWidth - pw - 8) + 'px';
  // 感知任务栏位置(Ubuntu 皮肤在顶部):顶栏从上弹出,底栏从下弹出
  const tbRect = document.getElementById('taskbar').getBoundingClientRect();
  if (tbRect.top < innerHeight / 2) {
    pop.style.top = (tbRect.bottom + 10) + 'px';
    pop.style.bottom = 'auto';
  } else {
    pop.style.bottom = 'calc(var(--tb) + 10px)';
    pop.style.top = 'auto';
  }
  anchor.classList.add('on');
  openPop = { name, pop, anchor };
}

document.addEventListener('pointerdown', (e) => {
  if (openPop && !e.target.closest('.popover') && !e.target.closest('.tray-btn')) closePopover();
}, true);

/* ---- 音量面板 ---- */
function volIconName() {
  const s = settings.get();
  if (s.muted || s.volume === 0) return 'volumeX';
  return s.volume < 45 ? 'volume1' : 'volume2';
}

function paintVolIcon() {
  $('#tray-vol').innerHTML = svg(volIconName(), 17);
}

function buildVolumePanel() {
  const s = settings.get();
  const pct = el('span', { class: 'pct' }, s.muted ? '静音' : s.volume + '%');
  const range = el('input', { type: 'range', min: 0, max: 100, value: s.muted ? s.volume : s.volume });
  const paint = () => range.style.setProperty('--fill', range.value + '%');
  paint();
  range.addEventListener('input', () => {
    paint();
    settings.set({ volume: +range.value, muted: false });
    pct.textContent = range.value + '%';
    paintVolIcon();
  });
  const muteBtn = el('button', { class: 'icon-btn' + (s.muted ? ' on' : ''), title: '静音' });
  const paintMute = () => { muteBtn.innerHTML = svg(s.muted ? 'volumeX' : 'volume2', 16); muteBtn.classList.toggle('on', settings.get().muted); };
  paintMute();
  muteBtn.addEventListener('click', () => {
    settings.set({ muted: !settings.get().muted });
    pct.textContent = settings.get().muted ? '静音' : settings.get('volume') + '%';
    paintMute(); paintVolIcon();
  });
  return el('div', { class: 'pop-volume' },
    el('div', { class: 'row' }, el('b', { style: { fontSize: '13px', flex: 1 } }, '音量'), pct),
    el('div', { class: 'row', style: { marginTop: '12px' } }, muteBtn, range));
}

$('#tray-vol').addEventListener('click', (e) => {
  e.stopPropagation();
  togglePopover('volume', e.currentTarget, buildVolumePanel, 264);
});
subscribe('sys:volume-changed', paintVolIcon);
subscribe('sys:settings-changed', (p) => { if (p?.changed?.includes('volume')) paintVolIcon(); });

/* ---- 时钟 + 日历面板 ---- */
let calY, calM;
function buildCalendar() {
  const now = new Date();
  if (calY == null) { calY = now.getFullYear(); calM = now.getMonth(); }
  const box = el('div', { class: 'pop-cal' });
  const redraw = () => {
    const first = new Date(calY, calM, 1);
    const daysIn = new Date(calY, calM + 1, 0).getDate();
    const startWd = (first.getDay() + 6) % 7; // 周一为 0
    const prevDays = new Date(calY, calM, 0).getDate();
    const cells = [];
    for (let i = startWd; i > 0; i--) cells.push({ d: prevDays - i + 1, dim: true }); // 上月
    for (let d = 1; d <= daysIn; d++) cells.push({ d });                               // 本月
    let n = 0;
    while (cells.length % 7 !== 0) cells.push({ d: ++n, dim: true });                   // 下月

    const grid = el('div', { class: 'cal-grid' },
      ...['一', '二', '三', '四', '五', '六', '日'].map(w => el('span', { class: 'wd' }, w)),
      ...cells.map(c => el('span', {
        class: 'day' + (c.dim ? ' dim' : '') +
          (!c.dim && c.d === now.getDate() && calM === now.getMonth() && calY === now.getFullYear() ? ' today' : ''),
      }, String(c.d))));

    box.innerHTML = '';
    box.append(
      el('div', { class: 'cal-head' },
        el('b', { class: 'cal-title' }, `${calY} 年 ${calM + 1} 月`),
        el('span', { class: 'row' },
          el('button', { class: 'icon-btn', onClick: () => { calM--; if (calM < 0) { calM = 11; calY--; } redraw(); } }, icon('chevronL', 15)),
          el('button', { class: 'icon-btn', onClick: () => { calM++; if (calM > 11) { calM = 0; calY++; } redraw(); } }, icon('chevronR', 15)))),
      grid,
      el('div', { class: 'cal-now' },
        el('div', { class: 'n-time' }, fmtTime(now, true)),
        el('div', { class: 'n-date' }, fmtDate(now, true))));
  };
  redraw();
  return box;
}

$('#tray-clock').addEventListener('click', (e) => {
  e.stopPropagation();
  calY = calM = null;
  togglePopover('cal', e.currentTarget, buildCalendar, 272);
});

function tickClock() {
  const now = new Date();
  $('#clock-time').textContent = fmtTime(now, settings.get('clockSeconds'));
  $('#clock-date').textContent = fmtDate(now);
}
setInterval(tickClock, 1000);

/* ---- 通知中心 ============ */
const notifications = [];
let unread = 0;

function paintBell() {
  // 重建时连带 badge(innerHTML 会覆盖旧 badge)
  $('#tray-bell').innerHTML =
    svg('bell', 16) +
    `<span class="badge" ${unread === 0 ? 'hidden' : ''}>${unread > 9 ? '9+' : unread}</span>`;
}

function toast(payload) {
  const { title, body = '', from } = payload || {};
  const icoBox = el('span', { class: 'ni-ico', style: { background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' } },
    icon('bell', 14));
  const t = el('div', { class: 'toast' }, icoBox,
    el('div', { style: { flex: 1, minWidth: 0 } },
      el('div', { class: 'ni-title' }, title || '通知'),
      body ? el('div', { class: 'ni-body' }, body) : null));
  const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.addEventListener('click', kill);
  $('#toasts').append(t);
  setTimeout(kill, 4500);
}

subscribe('sys:notify', (p) => {
  notifications.unshift({ ...(p || {}), ts: Date.now() });
  if (notifications.length > 30) notifications.pop();
  unread++;
  paintBell();
  toast(p);
});

function buildNotiPanel() {
  unread = 0;
  paintBell();
  const list = el('div', { class: 'pn-list' });
  if (!notifications.length) {
    list.append(el('div', { class: 'pn-empty' }, '暂无新通知'));
  } else {
    for (const n of notifications) {
      list.append(el('div', { class: 'noti-item' },
        el('span', { class: 'ni-ico', style: { background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' } }, icon('bell', 13)),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { class: 'ni-title' }, n.title || '通知'),
          n.body ? el('div', { class: 'ni-body' }, n.body) : null),
        el('span', { class: 'ni-time' }, fmtTime(new Date(n.ts)))));
    }
  }
  return el('div', { class: 'pop-noti' },
    el('div', { class: 'pn-head' },
      el('b', {}, '通知中心'),
      el('button', {
        class: 'btn', style: { height: '26px', padding: '0 10px', fontSize: '12px' },
        onClick: () => { notifications.length = 0; closePopover(); },
      }, '全部清除')),
    list);
}

$('#tray-bell').addEventListener('click', (e) => {
  e.stopPropagation();
  togglePopover('noti', e.currentTarget, buildNotiPanel, 324);
});

/* ============ 显示桌面 ============ */
$('#show-desk').addEventListener('click', () => wm.toggleShowDesktop());

/* ============ 开关机 ============ */
function powerAction(mode) {
  toggleStartMenu(false);
  closePopover();
  const sd = $('#shutdown');
  const center = $('#sd-center');
  sd.hidden = false;
  center.innerHTML = '';
  if (mode === 'reboot') {
    center.append(
      el('div', { class: 'spinner' }),
      el('div', { class: 'sd-text' }, '正在重启…'));
    setTimeout(() => location.reload(), 1100);
  } else {
    center.append(
      el('div', { class: 'sd-ico', style: { color: '#5b6cff' } }, icon('power', 40, 1.6)),
      el('div', { class: 'sd-text' }, '系统已关机'),
      el('button', { class: 'sd-btn', onClick: () => location.reload() }, '开机'));
  }
}

/* ============ 多窗口模式:布局按钮 + Alt+Q 切换活动窗口 ============ */
function setupLayoutButton() {
  const btn = el('button', { class: 'tray-btn', title: '窗口布局', id: 'tb-layout' }, icon('grid', 16));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const on = settings.get('singleActive');
    showMenu(r.left - 150, r.top - 170, [
      { label: '网格平铺全部窗口', icon: 'grid', fn: () => wm.tile() },
      { label: '层叠排列', icon: 'restore', fn: () => wm.cascade() },
      { label: '切换活动窗口(Alt+Q)', icon: 'refresh', fn: () => wm.focusCycle() },
      { sep: true },
      {
        label: on ? '✓ 单活动窗口模式' : '单活动窗口模式',
        icon: 'check', fn: () => settings.set({ singleActive: !on }),
      },
    ]);
  });
  document.getElementById('tray').before(btn);
}

/* ============ 全局快捷键 ============ */
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'q' || e.key === 'Q')) {
    e.preventDefault();
    wm.focusCycle();
    return;
  }
  if (e.key === 'Escape') {
    if (smOpen) toggleStartMenu(false);
    closePopover();
    hideMenu();
  }
  if (e.key === 'F5' && !e.ctrlKey) { e.preventDefault(); renderDesktopIcons(); }
});
window.addEventListener('resize', () => { wm.relayout(); renderDesktopIcons(); });

/* ============ 启动 ============ */
function boot() {
  applyAllSettings();   // 主题 / 强调色 / 动效 / 亮度 / 图标尺寸
  $('#start-btn').innerHTML = svg('grid', 19);
  setupLayoutButton();
  applyWallpaper();
  paintVolIcon();
  paintBell();
  renderPinned();
  renderTasks();
  renderStartMenu();
  renderStartUser();
  renderDesktopIcons();
  tickClock();

  // 调试 / 自动化接口
  Object.assign(SYS, {
    bus: { subscribe, publish, send: (from, to, type, payload) => publish(`app:${to}`, { from, to, type, payload }) },
    wm, settings, fs, vnet, dialogs, mail: mailSvc, sms: smsSvc,
    apps: { list: listApps },
  });
  window.WebOS = SYS;

  // 开机画面淡出
  setTimeout(() => $('#boot').classList.add('hide'), 1000);
  setTimeout(() => $('#boot').remove(), 1500);

  console.log('%cWebOS 1.0 已启动 %c— 全局对象:WebOS',
    'color:#5b6cff;font-weight:bold', 'color:#888');
}

boot();
