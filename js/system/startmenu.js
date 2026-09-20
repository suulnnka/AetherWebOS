import { $, el } from '../core/utils.js';
import { icon, svg, paintTile } from '../core/icons.js';
import { subscribe } from '../core/bus.js';
import { settings } from '../core/store.js';
import { accounts } from '../core/accounts.js';
import { list as listApps, prefetchOnHover } from '../core/registry.js';
import { sendAppToDesktop } from '../core/applink.js';
import * as wm from '../core/wm.js';
import { showMenu } from '../core/menu.js';
import { logoutSession } from './session.js';
import { powerAction } from './tray.js';
import { togglePin, pinnedApps } from './taskbar.js';

/* 开始菜单 */
/* ============ 开始菜单 ============ */
const startMenu = $('#start-menu');
const smInput = $('#sm-input');
let smOpen = false;

export function renderStartMenu() {
  const grid = $('#sm-grid');
  grid.innerHTML = '';
  const apps = listApps().filter(a => a.desktop !== false);
  if (!apps.length) return;
  for (const app of apps) {
    const tile = el('div', { class: 'tile' });
    paintTile(tile, app);
    tile.append(icon(app.icon, 21));
    const item = el('button', {
      class: 'sm-item', 'data-search': (app.name + ' ' + app.id).toLowerCase(),
      onClick: () => { toggleStartMenu(false); wm.open(app.id); },
    }, tile, el('span', { class: 'name' }, app.name));
    // 悬停预读 chunk,点击时秒开(hoverPrefetch: false 的应用内部跳过)
    item.addEventListener('mouseenter', () => prefetchOnHover(app.id));
    // 开始菜单右键:打开 / 新窗口 / 发送到桌面 / 固定到任务栏
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pinned = pinnedApps().includes(app.id);
      showMenu(e.clientX, e.clientY, [
        { label: '打开', icon: 'chevronR', fn: () => { toggleStartMenu(false); wm.open(app.id); } },
        ...(app.singleton ? [] : [{ label: '打开新窗口', icon: 'plus', fn: () => { toggleStartMenu(false); wm.open(app.id); } }]),
        { sep: true },
        { label: '发送到桌面', icon: 'monitor', fn: () => { toggleStartMenu(false); sendAppToDesktop(app.id); } },
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

export function toggleStartMenu(force) {
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

export function renderStartUser() {
  const user = accounts.current();
  const name = user ? (accounts.displayName() || user) : settings.get('username');
  $('#sm-username').textContent = name;
  $('#sm-avatar').textContent = (name[0] || 'A').toUpperCase();
  $('#sm-user').title = user ? `已登录:${user}` : '未登录 — 点击管理用户';
}
subscribe('accounts:changed', renderStartUser);
subscribe('sys:settings-changed', (p) => {
  if (p?.changed?.includes('style')) renderStartMenu();
});
$('#sm-user').addEventListener('click', () => {
  toggleStartMenu(false);
  wm.open('settings', { params: { section: 'user' } });
});
$('#sm-power').innerHTML = svg('power', 17);
$('#sm-power').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  const loggedIn = !!accounts.current();
  showMenu(r.left - 130, r.top - 120, [
    {
      label: loggedIn ? '注销' : '登录 / 切换用户', icon: loggedIn ? 'logout' : 'user',
      fn: () => { toggleStartMenu(false); logoutSession(); },
    },
    { sep: true },
    { label: '重启', icon: 'refresh', fn: () => powerAction('reboot') },
    { label: '关机', icon: 'power', danger: true, fn: () => powerAction('shutdown') },
  ]);
});
