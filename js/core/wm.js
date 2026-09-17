/* ============================================================
 * WM —— 窗口管理器(Window Manager)
 *
 * 职责:窗口的创建/销毁、焦点与层级(z-index)、拖动、
 *       8 方向调整大小、最小化/最大化/还原、级联定位。
 * 所有窗口事件通过总线广播:sys:win-open / win-close /
 * win-focus / win-min / win-restore / win-max / win-unmax
 * ============================================================ */

import { el, clamp } from './utils.js';
import { icon } from './icons.js';
import { publish } from './bus.js';
import { get as getApp } from './registry.js';
import { createAppBus } from './bus.js';
import { settings } from './store.js';
import fs from './fs.js';

const wins = new Map();   // winId -> win 对象
let zTop = 20;
let seq = 0;
let cascadeSeq = 0;

/* 模态对话框支持:dialog 窗口打开时显示遮罩,期间其他窗口不可激活 */
let shadeEl = null;
const modalWins = new Set();

function raiseShade() {
  if (!modalWins.size) { shadeEl?.remove(); shadeEl = null; return; }
  if (!shadeEl) {
    shadeEl = el('div', { class: 'modal-shade' });
    layerEl().append(shadeEl);
  }
  // 遮罩压在最低的对话框之下,堆叠的多个对话框都保持可见
  const bottom = Math.min(...[...modalWins].map(w => +w.el.style.zIndex || 0));
  shadeEl.style.zIndex = Math.max(1, bottom - 1);
}

const layerEl = () => document.getElementById('windows');
const area = () => layerEl().getBoundingClientRect();

const emit = (type, payload) =>
  publish(`sys:win-${type}`, { from: 'wm', type: `win-${type}`, payload });

/* ---------------- 打开窗口 ---------------- */
export function open(appId, { params } = {}) {
  const app = getApp(appId);
  if (!app) { console.warn('[wm] 应用不存在:', appId); return null; }

  // 单实例:聚焦已有窗口并转发参数
  if (app.singleton) {
    for (const w of wins.values()) {
      if (w.appId !== appId) continue;
      restoreWin(w.id);
      focus(w.id);
      if (params) publish(`app:${appId}`, { from: 'wm', to: appId, type: 'params', payload: params });
      return w;
    }
  }

  const id = 'w' + (++seq);
  const a = area();
  const width = Math.min(app.width, a.width - 12);
  const height = Math.min(app.height, a.height - 12);
  const k = (cascadeSeq++) % 8;
  // 对话框居中显示;普通窗口级联偏移
  const x = app.dialog
    ? Math.round((a.width - width) / 2)
    : clamp(Math.round((a.width - width) / 2) + k * 30 - 105, 6, Math.max(6, a.width - width - 6));
  const y = app.dialog
    ? Math.max(6, Math.round((a.height - height) / 2) - 30)
    : clamp(Math.round((a.height - height) / 2) + k * 24 - 84, 6, Math.max(6, a.height - height - 6));

  const titleEl = el('span', { class: 'win-title' }, app.name);
  const icoEl = el('span', { class: 'win-ico' },
    icon(app.icon, 13));
  icoEl.style.background = app.color || 'var(--accent)';

  const btnMin = el('button', { class: 'wbtn mn', title: '最小化' }, icon('minus', 14));
  const btnMax = el('button', { class: 'wbtn mx', title: '最大化 / 还原' },
    el('span', { class: 'i-max' }, icon('max', 13)),
    el('span', { class: 'i-restore' }, icon('restore', 13)));
  const btnClose = el('button', { class: 'wbtn close', title: '关闭' }, icon('close', 14));
  // 对话框窗口:只保留关闭按钮(不可最小化/最大化/缩放)
  const headChildren = app.dialog
    ? [icoEl, titleEl, btnClose]
    : [icoEl, titleEl, btnMin, btnMax, btnClose];

  const head = el('header', { class: 'win-head' }, ...headChildren);
  const body = el('div', { class: 'win-body' });
  const root = el('section', {
    class: 'win opening',
    dataset: { app: appId, id },
    style: { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px', zIndex: ++zTop },
  }, head, body,
    ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => el('div', { class: `rz rz-${d}`, dataset: { dir: d } })));

  // 应用专属霓虹灯条颜色(霓虹未来皮肤消费;--neon-a/--neon-b)
  if (app.neon?.a) root.style.setProperty('--neon-a', app.neon.a);
  if (app.neon?.b) root.style.setProperty('--neon-b', app.neon.b);

  const w = {
    id, appId, app, el: root, body, titleEl,
    state: 'normal',            // normal | min | max
    prevState: 'normal',
    restoreRect: null,
    hooks: {},
    bus: null,
  };

  const win = {
    get id() { return id; },
    get appId() { return appId; },
  };

  if (!app.dialog) {
    btnMin.addEventListener('click', () => minimize(id));
    btnMax.addEventListener('click', () => toggleMax(id));
  }
  btnClose.addEventListener('click', () => close(id));
  // 多窗口模式:始终只允许一个活动窗口;严格模式下,非活动窗口的
  // 首次点击仅用于激活(取消兼容鼠标事件,点击不穿透到内容)
  root.addEventListener('pointerdown', (e) => {
    const wasFocused = root.classList.contains('focused');
    focus(id);
    if (!wasFocused && settings.get('singleActive')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // 挂载应用
  w.bus = createAppBus(appId);
  const ctx = {
    root: body,
    win,
    bus: w.bus,
    params: params || {},
    fs,
    settings,
    setTitle: (t) => {
      titleEl.textContent = t ?? app.name;
      emit('title', { id, appId, title: titleEl.textContent });
    },
    close: () => close(id),
    focus: () => focus(id),
    /** 程序化调整窗口尺寸(对话框自适应内容高度等) */
    setSize: (nw, nh) => applyRect(w, { x: w.el.offsetLeft, y: w.el.offsetTop, w: nw, h: nh }, false),
  };

  try {
    const hooks = app.mount(ctx);
    if (hooks && typeof hooks === 'object') w.hooks = hooks;
  } catch (err) {
    console.error(`[wm] 应用 "${appId}" 挂载失败:`, err);
    body.append(el('div', { class: 'win-error' },
      el('b', {}, '应用启动失败'),
      el('div', { class: 'mono' }, String(err?.message || err))));
  }

  makeDraggable(w);
  if (app.resizable !== false) makeResizable(w);

  layerEl().append(root);
  setTimeout(() => root.classList.remove('opening'), 240);

  wins.set(id, w);
  focus(id);
  // 模态对话框:显示遮罩并保持焦点独占
  if (app.dialog) { modalWins.add(w); raiseShade(); }
  emit('open', { id, appId, title: titleEl.textContent });
  return w;
}

/* ---------------- 关闭 ---------------- */
export function close(id) {
  const w = wins.get(id);
  if (!w) return;
  if (w.hooks.onClose && w.hooks.onClose() === false) return; // 应用可拦截
  w.bus.dispose();
  wins.delete(id);
  if (w.app.dialog) { modalWins.delete(w); raiseShade(); }
  emit('close', { id, appId: w.appId });
  w.el.classList.add('closing');
  setTimeout(() => w.el.remove(), 170);
}

/* ---------------- 焦点与层级 ---------------- */
export function focus(id) {
  const w = wins.get(id);
  if (!w) return;
  // 模态期:只有对话框可激活(严格单活动窗口)
  if (modalWins.size && !w.app.dialog) return;
  if (w.state === 'min') restoreWin(id);
  if (w.el.style.zIndex != zTop) {
    w.el.style.zIndex = ++zTop;
    if (zTop > 900) renormalizeZ();
    if (w.app.dialog) raiseShade();
  }
  for (const o of wins.values()) o.el.classList.toggle('focused', o === w);
  emit('focus', { id, appId: w.appId });
}

function renormalizeZ() {
  [...wins.values()]
    .sort((a, b) => (+a.el.style.zIndex) - (+b.el.style.zIndex))
    .forEach((w, i) => { w.el.style.zIndex = 10 + i; });
  zTop = 10 + wins.size;
}

/* ---------------- 最小化 / 还原 ---------------- */
export function minimize(id) {
  const w = wins.get(id);
  if (!w || w.state === 'min') return;
  if (w.app.dialog) return;   // 对话框不可最小化(避免遮罩下无窗可操作的死角)
  w.prevState = w.state;
  w.state = 'min';
  w.el.classList.add('minimizing');
  setTimeout(() => {
    if (w.state === 'min') { w.el.style.display = 'none'; w.el.classList.remove('minimizing'); }
  }, 190);
  emit('min', { id, appId: w.appId });
}

export function restoreWin(id) {
  const w = wins.get(id);
  if (!w || w.state !== 'min') return;
  w.state = w.prevState === 'max' ? 'max' : 'normal';
  w.el.style.display = '';
  w.el.classList.add('opening');
  setTimeout(() => w.el.classList.remove('opening'), 240);
  emit('restore', { id, appId: w.appId });
}

export function toggleMax(id) {
  const w = wins.get(id);
  if (!w) return;
  if (w.state === 'max') unmaximize(w);
  else {
    if (w.state === 'min') restoreWin(id);
    maximize(w);
  }
}

function applyRect(w, r, animate) {
  if (animate) {
    w.el.classList.add('anim');
    setTimeout(() => w.el.classList.remove('anim'), 200);
  }
  Object.assign(w.el.style, {
    left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px',
  });
  w.hooks.onResize?.(r.w, r.h);
}

function maximize(w) {
  const a = area();
  w.restoreRect = { x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight };
  w.state = 'max';
  applyRect(w, { x: 0, y: 0, w: a.width, h: a.height }, true);
  w.el.classList.add('max');
  focus(w.id);
  emit('max', { id: w.id, appId: w.appId });
}

function unmaximize(w) {
  w.state = 'normal';
  w.el.classList.remove('max');
  applyRect(w, w.restoreRect || { x: 40, y: 30, w: 720, h: 480 }, true);
  focus(w.id);
  emit('unmax', { id: w.id, appId: w.appId });
}

/* ---------------- 拖动 ---------------- */
function makeDraggable(w) {
  const head = w.el.querySelector('.win-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.wbtn')) return;
    e.preventDefault();
    focus(w.id);
    const a = area();
    let rect = { w: w.el.offsetWidth, h: w.el.offsetHeight };
    let offX = e.clientX - w.el.offsetLeft;
    let offY = e.clientY - w.el.offsetTop;
    let started = false;
    const wasMax = w.state === 'max';

    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        started = true;
        // 从最大化状态拖动:先还原,窗口跟随鼠标比例位置
        if (w.state === 'max') {
          unmaximize(w);
          const rx = clamp((e.clientX - a.left) / a.width, 0.1, 0.9);
          rect = { w: w.el.offsetWidth, h: w.el.offsetHeight };
          offX = rect.w * rx;
          offY = 16;
        }
        w.el.classList.add('dragging');
      }
      const nx = clamp(ev.clientX - a.left - offX, -rect.w + 90, a.width - 90);
      const ny = clamp(ev.clientY - a.top - offY, 0, a.height - 36);
      w.el.style.left = nx + 'px';
      w.el.style.top = ny + 'px';
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      w.el.classList.remove('dragging');
      // 贴边分屏:拖到左/右边缘 → 半屏,拖到顶部 → 最大化
      if (started && !wasMax) {
        if (ev.clientY <= a.top + 6) {
          toggleMax(w.id);
        } else if (ev.clientX <= a.left + 12) {
          applyRect(w, { x: 0, y: 0, w: a.width / 2, h: a.height }, true);
        } else if (ev.clientX >= a.right - 12) {
          applyRect(w, { x: a.width / 2, y: 0, w: a.width / 2, h: a.height }, true);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  head.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.wbtn')) toggleMax(w.id);
  });
}

/* ---------------- 调整大小 ---------------- */
function makeResizable(w) {
  const minW = w.app.min?.w || 320;
  const minH = w.app.min?.h || 200;
  w.el.querySelectorAll('.rz').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      if (w.state === 'max') return;
      e.preventDefault();
      e.stopPropagation();
      focus(w.id);
      const dir = handle.dataset.dir;
      const a = area();
      const sx = e.clientX, sy = e.clientY;
      const r = { x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight };

      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        let { x, y, w: ww, h: hh } = r;
        if (dir.includes('e')) ww = clamp(r.w + dx, minW, a.width - r.x);
        if (dir.includes('s')) hh = clamp(r.h + dy, minH, a.height - r.y);
        if (dir.includes('w')) { ww = clamp(r.w - dx, minW, r.x + r.w); x = r.x + r.w - ww; }
        if (dir.includes('n')) { hh = clamp(r.h - dy, minH, r.y + r.h); y = r.y + r.h - hh; }
        Object.assign(w.el.style, { left: x + 'px', top: y + 'px', width: ww + 'px', height: hh + 'px' });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        w.hooks.onResize?.(w.el.offsetWidth, w.el.offsetHeight);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });
}

/* ---------------- 查询与全局操作 ---------------- */
export const isOpen = (appId) => [...wins.values()].some(w => w.appId === appId);
export const count = () => wins.size;
export const get = (id) => wins.get(id);

/** 任务栏按钮所需的信息 */
export function taskList() {
  return [...wins.values()].map(w => ({
    id: w.id, appId: w.appId, title: w.titleEl.textContent,
    state: w.state, icon: w.app.icon, color: w.app.color,
    neon: w.app.neon || null,
  }));
}

/** 显示桌面:全部最小化 / 全部还原 */
export function toggleShowDesktop() {
  const anyVisible = [...wins.values()].some(w => w.state !== 'min');
  for (const w of wins.values()) {
    if (anyVisible) minimize(w.id);
    else restoreWin(w.id);
  }
}

/** 浏览器窗口尺寸变化后重新约束所有窗口 */
export function relayout() {
  const a = area();
  for (const w of wins.values()) {
    if (w.state === 'max') {
      Object.assign(w.el.style, { left: '0px', top: '0px', width: a.width + 'px', height: a.height + 'px' });
    } else if (w.state === 'normal') {
      const ww = Math.min(w.el.offsetWidth, a.width);
      const hh = Math.min(w.el.offsetHeight, a.height);
      Object.assign(w.el.style, {
        left: clamp(w.el.offsetLeft, -ww + 90, a.width - 90) + 'px',
        top: clamp(w.el.offsetTop, 0, a.height - 36) + 'px',
        width: ww + 'px', height: hh + 'px',
      });
    }
  }
}

/* ---------------- 多窗口布局模式 ---------------- */

const visible = () => [...wins.values()].filter(w => w.state !== 'min');

/** 网格平铺:所有可见窗口排满桌面(间隙 8px),最后一行拉伸占满整行 */
export function tile() {
  const vis = visible();
  if (vis.length < 2) return false;
  const a = area();
  const gap = 8;
  const cols = Math.ceil(Math.sqrt(vis.length));
  const rows = Math.ceil(vis.length / cols);
  const cw = (a.width - gap * (cols + 1)) / cols;
  const ch = (a.height - gap * (rows + 1)) / rows;
  vis.forEach((w, i) => {
    if (w.state === 'max') { w.state = 'normal'; w.el.classList.remove('max'); }
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, vis.length - row * cols);   // 该行窗口数
    const rowW = (a.width - gap * (inRow + 1)) / inRow;      // 末行拉伸占满
    applyRect(w, {
      x: Math.round(gap + (i % inRow) * (rowW + gap)),
      y: Math.round(gap + row * (ch + gap)),
      w: Math.round(rowW), h: Math.round(ch),
    }, true);
  });
  return true;
}

/** 层叠排列:恢复级联布局 */
export function cascade() {
  const vis = visible();
  vis.forEach((w, i) => {
    if (w.state === 'max') { w.state = 'normal'; w.el.classList.remove('max'); }
    const a = area();
    const ww = Math.min(780, a.width - 40);
    const hh = Math.min(540, a.height - 40);
    applyRect(w, {
      x: Math.round((a.width - ww) / 2 + i * 26 - (vis.length - 1) * 13),
      y: Math.round((a.height - hh) / 2 + i * 22 - (vis.length - 1) * 11),
      w: ww, h: hh,
    }, true);
  });
  return true;
}

/** 切换活动窗口(Alt+Q):按最近使用顺序循环;模态期只在对话框之间切换 */
export function focusCycle() {
  const pool = (modalWins.size ? [...modalWins] : visible())
    .sort((x, y) => (+y.el.style.zIndex) - (+x.el.style.zIndex));
  if (pool.length < 2) return;
  const cur = pool.findIndex(w => w.el.classList.contains('focused'));
  focus(pool[(cur + 1) % pool.length].id);
}

/** 关闭并重新打开某应用的所有窗口(登录状态变化后刷新界面) */
export function reopen(appId) {
  const ids = [...wins.values()].filter(w => w.appId === appId).map(w => w.id);
  for (const id of ids) close(id);
  // 等动画结束后重开
  setTimeout(() => open(appId), 200);
}

/** 当前活动窗口数(应恒为 0 或 1) */
export const focusedCount = () => document.querySelectorAll('.win.focused').length;
