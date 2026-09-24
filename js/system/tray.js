import { $, el, clamp, fmtDate, fmtTime } from '../core/utils.js';
import { icon, svg } from '../core/icons.js';
import { subscribe, publish } from '../core/bus.js';
import { settings } from '../core/store.js';
import { showMenu } from '../core/menu.js';
import { toggleStartMenu } from './startmenu.js';

/* 系统托盘:音量 / 日历时钟 / 通知中心 / 开关机 */
/* ============ 托盘:弹出面板管理 ============ */
let openPop = null;

export function closePopover() {
  if (!openPop) return;
  openPop.pop.remove();
  openPop.anchor.classList.remove('on');
  openPop = null;
}

export function togglePopover(name, anchor, build, width) {
  if (openPop?.name === name) return closePopover();
  closePopover();
  const pop = el('div', { class: 'popover', dataset: { pop: name }, style: width ? { width: width + 'px' } : {} }, build());
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  // 面板中心对齐锚点中心:X 为面板右缘到视口右缘的距离
  pop.style.right = clamp(innerWidth - r.right + r.width / 2 - pw / 2, 8, innerWidth - pw - 8) + 'px';
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

/* 三级(系统模态)弹框弹出时收起托盘面板:模态期只允许对话框交互(见 wm.js raiseShade) */
subscribe('sys:modal', (p) => { if (p?.locked) closePopover(); });

/* ---- 音量面板 ---- */
function volIconName() {
  const s = settings.get();
  if (s.muted || s.volume === 0) return 'volumeX';
  return s.volume < 45 ? 'volume1' : 'volume2';
}

export function paintVolIcon() {
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

export function tickClock() {
  const now = new Date();
  $('#clock-time').textContent = fmtTime(now, settings.get('clockSeconds'));
  $('#clock-date').textContent = fmtDate(now);
}
setInterval(tickClock, 1000);

/* ---- 通知中心 ============ */
const notifications = [];
let unread = 0;

subscribe('sys:settings-changed', (p) => {
  if (p?.changed?.includes('style')) { paintVolIcon(); paintBell(); }
});

export function paintBell() {
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

/* ============ 开关机 ============ */
export function powerAction(mode) {
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
