import { el } from '../core/utils.js';
import { icon } from '../core/icons.js';
import * as wm from '../core/wm.js';
import { hideMenu, showMenuAnchored } from '../core/menu.js';
import { toggleStartMenu } from './startmenu.js';
import { renderDesktopIcons, applyWallpaper } from './desktop.js';

/* 多窗口布局按钮 + 全局快捷键 */
/* ============ 多窗口模式:布局按钮 + Alt+Q 切换活动窗口 ============ */
export function setupLayoutButton() {
  const btn = el('button', { class: 'tray-btn', title: '窗口布局', id: 'tb-layout' }, icon('grid', 16));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenuAnchored(e.currentTarget, [
      { label: '网格平铺全部窗口', icon: 'grid', fn: () => wm.tile() },
      { label: '层叠排列', icon: 'restore', fn: () => wm.cascade() },
      { label: '切换活动窗口(Alt+Q)', icon: 'refresh', fn: () => wm.focusCycle() },
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
