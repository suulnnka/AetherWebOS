/* ============================================================
 * UI —— 应用内通用对话框(模态框 / 确认框 / 输入框)
 * 挂载在应用窗口内部,随窗口一起存在, Promise 风格。
 * ============================================================ */

import { el } from './utils.js';

/**
 * modal(root, { title, body, input, confirmText, cancelText, danger })
 *  - body: 字符串或 DOM
 *  - input: { placeholder, value } 时显示输入框
 * 返回 Promise:确认 → input ? 字符串|空串 : true;取消 → null
 */
export function modal(root, opts = {}) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input', type: 'text',
      placeholder: opts.input?.placeholder || '',
      value: opts.input?.value ?? '',
      style: { width: '100%', marginTop: '6px' },
    });
    const box = el('div', { class: 'modal-box' },
      el('h3', {}, opts.title || '确认'),
      el('div', { class: 'm-body' },
        opts.body ?? '',
        opts.input ? input : null),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onClick: done(null) }, opts.cancelText || '取消'),
        el('button', {
          class: 'btn ' + (opts.danger ? 'danger' : 'primary'),
          onClick: done(() => (opts.input ? input.value : true)),
        }, opts.confirmText || '确定')));

    const mask = el('div', { class: 'modal-mask' }, box);

    function done(valueFn) {
      return () => {
        mask.remove();
        input.onkeydown = null;
        resolve(valueFn ? valueFn() : null);
      };
    }

    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(() => (opts.input ? input.value : true))(); }
      if (e.key === 'Escape') { e.preventDefault(); done(null)(); }
    };
    mask.addEventListener('pointerdown', (e) => { if (e.target === mask) done(null)(); });

    (root || document.body).append(mask);
    if (opts.input) { input.focus(); input.select(); }
  });
}

export const confirmBox = (root, title, body, danger = false) =>
  modal(root, { title, body, danger, confirmText: danger ? '删除' : '确定' });

export const promptBox = (root, title, placeholder = '', value = '') =>
  modal(root, { title, input: { placeholder, value }, confirmText: '确定' });
