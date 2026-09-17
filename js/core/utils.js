/* ============ 通用工具函数 ============ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 测试模式(页面带 ?e2e=1 时为 true,e2e 冒烟测试 tools/e2e.mjs 自动携带)。
 * 约定:只允许缩短"纯装饰性等待"(开机画面动画、游戏翻回锁定等),
 * 不得改变任何业务逻辑或测试断言的最终状态。
 */
export const E2E = new URLSearchParams(location.search).has('e2e');

/**
 * DOM 构建助手
 * el('div', { class:'a', style:{ left:'1px' }, dataset:{ id:1 }, onClick:fn, html:'', ...attrs }, ...children)
 * children 可以是字符串 / DOM 节点 / 数组 / null(忽略)
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(2) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const WEEKS = ['日', '一', '二', '三', '四', '五', '六'];
export const fmtDate = (d = new Date(), withWeek = false) => {
  const s = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  return withWeek ? `${s} 周${WEEKS[d.getDay()]}` : s;
};
export const fmtTime = (d = new Date(), withSec = false) =>
  [d.getHours(), d.getMinutes(), withSec ? d.getSeconds() : null]
    .filter(v => v != null)
    .map(v => String(v).padStart(2, '0'))
    .join(':');

/** 安全地把十六进制色转为 rgba() */
export function hexToRgba(hex, a = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(91,108,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
