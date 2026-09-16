/* ============ 全局右键菜单 ============ */
import { el } from './utils.js';
import { icon } from './icons.js';

/**
 * showMenu(x, y, items)
 * items: { label, icon, danger, fn } | { sep:true }
 */
export function showMenu(x, y, items) {
  const box = document.getElementById('ctx');
  box.innerHTML = '';
  box.hidden = false;

  for (const it of items) {
    if (it.sep) { box.append(el('div', { class: 'ctx-sep' })); continue; }
    box.append(el('button', {
      class: 'ctx-item' + (it.danger ? ' danger' : ''),
      onClick: () => { hideMenu(); it.fn?.(); },
    }, el('span', { class: 'ci-ico' }, icon(it.icon || 'chevronR', 14)), it.label));
  }

  const vw = innerWidth, vh = innerHeight;
  const r = box.getBoundingClientRect();
  box.style.left = Math.min(x, vw - r.width - 8) + 'px';
  box.style.top = Math.min(y, vh - r.height - 8) + 'px';
}

export function hideMenu() {
  const box = document.getElementById('ctx');
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#ctx')) hideMenu();
}, true);
window.addEventListener('blur', hideMenu);
