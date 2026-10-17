import { $, el } from '../core/utils.js';
import { icon, paintTile } from '../core/icons.js';
import { subscribe } from '../core/bus.js';
import { settings } from '../core/store.js';
import { list as listApps, prefetchOnHover, appName } from '../core/registry.js';
import { t } from '../core/i18n.js';
import { isInstalled } from '../core/install.js';
import { sendAppToDesktop } from '../core/applink.js';
import * as wm from '../core/wm.js';
import { showMenu, showMenuAnchored } from '../core/menu.js';
import { dialogs } from '../core/dialogs.js';

/* 任务栏:固定应用 + 运行窗口按钮 */
/* ============ 任务栏:固定按钮(可动态固定/取消) ============ */
const DEFAULT_PINNED = ['files', 'notes', 'terminal'];
export const pinnedApps = () => settings.get('pinnedApps') || DEFAULT_PINNED;

export function togglePin(id) {
  const cur = pinnedApps();
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
  settings.set({ pinnedApps: next });
}
subscribe('sys:settings-changed', (p) => {
  if (p?.changed?.includes('pinnedApps')) renderPinned();
  // 风格切换会更换图标家族(如 Win98 走像素图标),按钮需要重绘
  if (p?.changed?.includes('style')) { renderPinned(); renderTasks(); }
});

export function renderPinned() {
  const box = $('#tb-pinned');
  box.innerHTML = '';
  for (const id of pinnedApps()) {
    const app = listApps().find(a => a.id === id);
    if (!app) continue;
    if (!isInstalled(id)) continue;   // 安装按用户:本人未安装的应用不渲染固定钮
    const b = el('button', {
      class: 'tbtn', title: appName(id),
      onClick: () => {
        // 已在运行:聚焦;否则启动
        const open = wm.taskList().filter(w => w.appId === id);
        if (open.length) {
          const active = open.find(w => w.state !== 'min');
          if (active) { if (active.id === focusedId) wm.minimize(active.id); else wm.focus(active.id); }
          else wm.focus(open[0].id);   // 全在最小化:focus 会先还原再激活
        } else wm.open(id);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: t('打开 {name}', { name: appName(app.id) }), icon: 'chevronR', fn: () => wm.open(app.id) },
          { label: t('发送到桌面'), icon: 'monitor', fn: () => sendAppToDesktop(app.id) },
          { sep: true },
          { label: t('从任务栏取消固定'), icon: 'close', danger: true, fn: () => togglePin(app.id) },
        ]);
      },
    }, (() => { const t = el('span', { class: 't-ico' }); paintTile(t, app); t.append(icon(app.icon, 14)); return t; })());
    // 悬停预读 chunk,点击时秒开(hoverPrefetch: false 的应用内部跳过)
    b.addEventListener('mouseenter', () => prefetchOnHover(id));
    // 应用专属霓虹色(任务栏芯片灯条消费)
    if (app.neon?.a) b.style.setProperty('--neon-a', app.neon.a);
    if (app.neon?.b) b.style.setProperty('--neon-b', app.neon.b);
    box.append(b);
  }
}

let focusedId = null;
const tasksBox = $('#tb-tasks');

/* 任务按钮点击语义(按钮本体与溢出菜单共用):已聚焦则最小化,否则还原并聚焦 */
function activateTask(w) {
  if (w.id === focusedId && w.state !== 'min') wm.minimize(w.id);
  else wm.focus(w.id);   // focus 对最小化窗口先还原再激活
}

function taskButton(w) {
  return el('button', {
    class: 'tbtn' + (w.id === focusedId && w.state !== 'min' ? ' active' : ''),
    title: w.title,
    onClick: () => activateTask(w),
    onContextmenu: (e) => {
      e.preventDefault();
      const pinned = pinnedApps().includes(w.appId);
      showMenu(e.clientX, e.clientY, [
        { label: w.state === 'min' ? t('还原') : t('最小化'), icon: 'minus', fn: () => (w.state === 'min' ? wm.focus(w.id) : wm.minimize(w.id)) },
        { label: t('发送到桌面'), icon: 'monitor', fn: () => sendAppToDesktop(w.appId) },
        { label: pinned ? t('从任务栏取消固定') : t('固定到任务栏'), icon: 'check', fn: () => togglePin(w.appId) },
        { sep: true },
        { label: t('关闭窗口'), icon: 'close', danger: true, fn: () => wm.close(w.id) },
      ]);
    },
  }, (() => { const t = el('span', { class: 't-ico' }); paintTile(t, w); t.append(icon(w.icon || 'file', 14)); return t; })(),
    el('span', { class: 't-title' }, w.title));
}

/* 溢出指示钮:任务太多放不下时,前面的(较早打开)收进菜单,只留后面的 */
function overflowButton(hidden) {
  const b = el('button', {
    class: 'tbtn tb-overflow',
    title: t('还有 {n} 个较早任务被收起', { n: hidden.length }),
    onClick: () => showMenuAnchored(b, hidden.map(w => ({
      label: w.title, icon: w.icon || 'file', fn: () => activateTask(w),
    }))),
  }, el('span', { class: 't-ico' }, icon('chevronL', 14)),
    el('span', { class: 'ov-n' }, String(hidden.length)));
  return b;
}

export function renderTasks() {
  const list = wm.taskList();
  tasksBox.innerHTML = '';
  for (const w of list) {
    const b = taskButton(w);
    if (w.neon?.a) b.style.setProperty('--neon-a', w.neon.a);
    if (w.neon?.b) b.style.setProperty('--neon-b', w.neon.b);
    tasksBox.append(b);
  }

  /* 收不下时藏头留尾:全部按最小宽排布仍溢出 → 前面的(较早打开)收进溢出菜单,
   * 保留最后 k 个。宽度口径与 CSS 同源(min-width/gap 读 computed style,
   * 换主题改了尺寸这里自动跟上)。 */
  const avail = tasksBox.clientWidth;
  if (avail <= 0 || tasksBox.scrollWidth <= avail + 1) return;   // 放得下(或未布局)
  const cs = getComputedStyle(tasksBox);
  const minW = parseFloat(cs.getPropertyValue('--tb-task-min')) || 48;
  const gap = parseFloat(cs.columnGap) || 3;

  const ov = overflowButton(list.slice(0, list.length));   // 先挂上量宽度,数量随后修正
  tasksBox.prepend(ov);
  const usable = avail - ov.offsetWidth - gap;
  const k = Math.max(0, Math.min(list.length, Math.floor((usable + gap) / (minW + gap))));
  const hidden = list.slice(0, list.length - k);
  for (let i = 0; i < hidden.length; i++) tasksBox.children[1].remove();   // 摘掉排在最前的任务钮
  if (!hidden.length) { ov.remove(); return; }
  ov.replaceWith(overflowButton(hidden));   // 数量/菜单内容落定
}

/* 视口/固定区变化 → 任务区可用宽变了,重算藏几个 */
new ResizeObserver(() => renderTasks()).observe(tasksBox);

for (const ev of ['open', 'close', 'focus', 'blur', 'min', 'restore', 'max', 'unmax', 'title']) {
  subscribe(`sys:win-${ev}`, (p) => {
    if (ev === 'focus') focusedId = p?.id ?? null;
    if (ev === 'blur' && p?.id === focusedId) focusedId = null;   // 无活动窗口:清除高亮
    renderTasks();
  });
}

/* 三级(系统模态)弹框期间任务栏一并锁定:遮罩挂在窗口层,物理上盖不到任务栏,
 * 由 inert 挡掉指针与键盘焦点(含已开的开始菜单/托盘入口),sys-locked 供 CSS 压暗;
 * 解锁后恢复(见 wm.js raiseShade / shell.css) */
subscribe('sys:modal', (p) => {
  const tb = $('#taskbar');
  const locked = !!p?.locked;
  tb.classList.toggle('sys-locked', locked);
  if (locked) tb.setAttribute('inert', '');
  else tb.removeAttribute('inert');
});

/* 任务栏统一右键:固定/任务按钮已自行 preventDefault 并弹菜单,这里不干预;
 * 其余区域(开始、窗口布局、托盘、空白/分隔条)一律拦掉浏览器默认菜单,
 * 按命中目标给出对应系统菜单。 */
$('#taskbar').addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const x = e.clientX, y = e.clientY;
  const layoutItems = [
    { label: t('网格平铺全部窗口'), icon: 'grid', fn: () => wm.tile() },
    { label: t('层叠排列'), icon: 'restore', fn: () => wm.cascade() },
    { label: t('切换活动窗口(Alt+Q)'), icon: 'refresh', fn: () => wm.focusCycle() },
  ];
  const shellItems = [
    { label: t('显示桌面'), icon: 'monitor', fn: () => wm.toggleShowDesktop() },
    { sep: true },
    { label: t('任务栏设置'), icon: 'settings', fn: () => wm.open('settings', { params: { section: 'desktop' } }) },
  ];

  if (e.target.closest('.tb-start')) {
    showMenu(x, y, [
      { label: t('打开开始菜单'), icon: 'grid', fn: () => $('#start-btn').click() },
      { sep: true },
      ...shellItems,
    ]);
    return;
  }
  if (e.target.closest('#tb-layout')) {
    // 与左键一致:打开同一套托盘 popover(而非右键菜单样式)
    $('#tb-layout').click();
    return;
  }
  if (e.target.closest('#tray-vol')) {
    const muted = !!settings.get('muted');
    showMenu(x, y, [
      { label: muted ? t('取消静音') : t('静音'), icon: muted ? 'volume2' : 'volumeX', fn: () => settings.set({ muted: !muted }) },
      { sep: true },
      { label: t('声音设置'), icon: 'settings', fn: () => wm.open('settings', { params: { section: 'sound' } }) },
    ]);
    return;
  }
  if (e.target.closest('#tray-bell')) {
    showMenu(x, y, [
      { label: t('打开通知中心'), icon: 'bell', fn: () => $('#tray-bell').click() },
      { sep: true },
      ...shellItems,
    ]);
    return;
  }
  if (e.target.closest('#tray-clock')) {
    showMenu(x, y, [
      { label: t('打开日历'), icon: 'calendar', fn: () => $('#tray-clock').click() },
      {
        label: settings.get('clockSeconds') ? t('时钟不显示秒') : t('时钟显示秒'),
        icon: 'clock',
        fn: () => settings.set({ clockSeconds: !settings.get('clockSeconds') }),
      },
      { sep: true },
      ...shellItems,
    ]);
    return;
  }
  // 空白任务栏 / 托盘容器 / 固定·任务区空隙 / 分隔条
  showMenu(x, y, [...layoutItems, { sep: true }, ...shellItems]);
});
