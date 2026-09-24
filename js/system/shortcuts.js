import { el } from '../core/utils.js';
import { icon } from '../core/icons.js';
import * as wm from '../core/wm.js';
import { hideMenu } from '../core/menu.js';
import { toggleStartMenu } from './startmenu.js';
import { renderDesktopIcons, applyWallpaper } from './desktop.js';
import { togglePopover, closePopover } from './tray.js';

/* 多窗口布局按钮 + 全局快捷键 */
/* ============ 多窗口模式:布局按钮 + Alt+Q 切换活动窗口 ============ */
function buildLayoutPanel() {
  const items = [
    { label: '网格平铺全部窗口', icon: 'grid', fn: () => wm.tile() },
    { label: '层叠排列', icon: 'restore', fn: () => wm.cascade() },
    { label: '切换活动窗口(Alt+Q)', icon: 'refresh', fn: () => wm.focusCycle() },
  ];
  // 与音量/时钟同一套 popover 外壳;条目复用右键菜单的 .ctx-item 观感
  return el('div', { class: 'pop-layout' },
    ...items.map(it => el('button', {
      class: 'ctx-item',
      onClick: () => { closePopover(); it.fn(); },
    }, el('span', { class: 'ci-ico' }, icon(it.icon, 14)), it.label)));
}

export function toggleLayoutPopover(anchor) {
  hideMenu();
  togglePopover('layout', anchor, buildLayoutPanel, 240);
}

export function setupLayoutButton() {
  const btn = el('button', { class: 'tray-btn', title: '窗口布局', id: 'tb-layout' }, icon('grid', 16));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLayoutPopover(e.currentTarget);
  });
  // 放进托盘,与音量/通知/时钟一起贴右(不跟任务芯片挤在左侧)
  document.getElementById('tray').prepend(btn);
}

/* ============ 全局快捷键 ============ */
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'q' || e.key === 'Q')) {
    e.preventDefault();
    wm.focusCycle();
    return;
  }
  if (e.key === 'Escape') {
    if (document.getElementById('start-menu')?.classList.contains('open')) toggleStartMenu(false);
    closePopover();
    hideMenu();
  }
  if (e.key === 'F5' && !e.ctrlKey) { e.preventDefault(); renderDesktopIcons(); }
});
window.addEventListener('resize', () => { wm.relayout(); renderDesktopIcons(); });
