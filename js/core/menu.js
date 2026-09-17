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

/** 复制文本到剪贴板:优先 Clipboard API,失败回退隐藏 textarea + execCommand */
export async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
    return ok;
  }
}

/**
 * 取目标处的选中文字:表单控件用自身选区,普通内容用全局选区(且须落在同一窗口内)
 */
export function selectionAt(target) {
  const field = target.closest?.('input, textarea');
  if (field) {
    const s = field.selectionStart ?? 0, e = field.selectionEnd ?? 0;
    return e > s ? field.value.slice(s, e) : '';
  }
  const sel = getSelection();
  const text = String(sel || '');
  if (!text || !sel.anchorNode) return '';
  const winEl = target.closest?.('.win');
  return winEl && winEl.contains(sel.anchorNode) ? text : '';
}
