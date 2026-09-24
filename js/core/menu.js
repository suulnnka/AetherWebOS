/* ============ 全局右键菜单 ============ */
import { el, clamp } from './utils.js';
import { icon } from './icons.js';

const PAD = 8;

function buildMenu(items) {
  const box = document.getElementById('ctx');
  box.innerHTML = '';
  for (const it of items) {
    if (it.sep) { box.append(el('div', { class: 'ctx-sep' })); continue; }
    box.append(el('button', {
      class: 'ctx-item' + (it.danger ? ' danger' : ''),
      onClick: () => { hideMenu(); it.fn?.(); },
    }, el('span', { class: 'ci-ico' }, icon(it.icon || 'chevronR', 14)), it.label));
  }
  box.hidden = false;
  return box;
}

function place(box, x, y) {
  // offsetWidth/Height 不受 popIn 的 scale 动画影响,比 getBoundingClientRect 稳
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = clamp(x, PAD, innerWidth - w - PAD) + 'px';
  box.style.top = clamp(y, PAD, innerHeight - h - PAD) + 'px';
}

/**
 * showMenu(x, y, items)
 * items: { label, icon, danger, fn } | { sep:true }
 */
export function showMenu(x, y, items) {
  place(buildMenu(items), x, y);
}

/**
 * 锚点弹出(按钮/图标):右缘对齐锚点,贴在任务栏内侧
 * (底栏在上、顶栏在下),越界时翻转并钳入视口。
 */
export function showMenuAnchored(anchor, items) {
  const box = buildMenu(items);
  const a = anchor.getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight;
  const tb = document.getElementById('taskbar')?.getBoundingClientRect();
  const taskbarOnTop = !!tb && tb.top < innerHeight / 2;
  const gap = 6;

  let left = a.right - w;
  let top = taskbarOnTop ? a.bottom + gap : a.top - h - gap;
  // 预留空间不够则翻到另一侧
  if (!taskbarOnTop && top < PAD) top = a.bottom + gap;
  if (taskbarOnTop && top + h > innerHeight - PAD) top = a.top - h - gap;

  place(box, left, top);
}

export function hideMenu() {
  const box = document.getElementById('ctx');
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

// 菜单项上再右键:屏蔽浏览器默认菜单(菜单自身不应再弹出系统菜单)
document.getElementById('ctx').addEventListener('contextmenu', (e) => e.preventDefault());

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
