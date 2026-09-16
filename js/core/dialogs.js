/* ============================================================
 * Dialogs —— 系统对话框服务(真窗口 + 模态遮罩)
 *
 * 一组系统自带窗口,任何应用/系统代码都可直接调用:
 *   dialogs.info / success / warning / error     → Promise<void>
 *   dialogs.confirm({ danger, okText })          → Promise<boolean>
 *   dialogs.yesno()                              → Promise<'yes'|'no'|null>
 *   dialogs.prompt({ value, placeholder })       → Promise<string|null>
 *   dialogs.password()                           → Promise<string|null>
 *   dialogs.progress({ cancelable })             → 句柄 { set(v,msg), done(msg), cancel() } + .promise
 *
 * 对话框是真正的窗口(可拖动、任务栏可见、风格主题跟随),
 * 打开期间由 WM 保证模态:遮罩阻挡其他窗口,焦点只在对话框间切换。
 * ============================================================ */
import { el } from './utils.js';
import { icon } from './icons.js';
import { register } from './registry.js';
import { open as openWin, close as closeWin } from './wm.js';
import { publish } from './bus.js';
import { beep } from './audio.js';

const KINDS = {
  error:    { icon: 'close',         color: '#ef4444', beep: [196, 0.22] },
  warning:  { icon: 'alertTriangle', color: '#f59e0b', beep: [392, 0.16] },
  info:     { icon: 'info',          color: '#3b82f6' },
  success:  { icon: 'check',         color: '#10b981' },
  question: { icon: 'helpCircle',    color: '#8b5cf6' },
  lock:     { icon: 'lock',          color: '#8b5cf6' },
  progress: { icon: 'activity',      color: '#0ea5e9' },
};

/** 进度对话框句柄注册表(token → 控制接口) */
const progressApi = new Map();
let tokenSeq = 0;

function spawn(params) {
  return new Promise((resolve) => {
    openWin('sysdialog', { params: { ...params, _resolve: resolve } });
    publish('sys:dialog', { from: 'dialogs', type: 'dialog-open', payload: { kind: params.kind, title: params.title } });
  });
}

export const dialogs = {
  info: (o = {}) => spawn({ kind: 'info', buttons: ['ok'], ...o }),
  success: (o = {}) => spawn({ kind: 'success', buttons: ['ok'], ...o }),
  warning: (o = {}) => spawn({ kind: 'warning', buttons: ['ok'], ...o }),
  error: (o = {}) => spawn({ kind: 'error', buttons: ['ok'], ...o }),

  /** 确认框:确定 → true;取消/关闭/Esc → false */
  confirm({ title = '确认', message = '', detail = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
    return spawn({ kind: danger ? 'warning' : 'question', buttons: ['cancel', 'ok'], danger, title, message, detail, okText, cancelText });
  },

  /** 是/否框:→ 'yes' | 'no' | null(关闭) */
  yesno({ title = '请选择', message = '', detail = '' } = {}) {
    return spawn({ kind: 'question', buttons: ['no', 'yes'], title, message, detail, okText: '是', cancelText: '否' });
  },

  /** 输入框:确定 → 输入值(可为空串);取消/关闭 → null */
  prompt({ title = '输入', message = '', value = '', placeholder = '', okText = '确定' } = {}) {
    return spawn({ kind: 'info', input: 'text', buttons: ['cancel', 'ok'], title, message, value, placeholder, okText });
  },

  /** 密码输入框 */
  password({ title = '需要密码', message = '请输入密码', okText = '解锁' } = {}) {
    return spawn({ kind: 'lock', input: 'password', buttons: ['cancel', 'ok'], title, message, okText });
  },

  /**
   * 进度对话框。返回句柄:
   *   h.set(0~100, '阶段说明')   h.done('完成说明') → promise 为 true
   *   h.cancel() → promise 为 false;用户点取消同样为 false
   */
  progress({ title = '处理中', message = '请稍候…', determinate = true, cancelable = true } = {}) {
    const token = 'pg' + (++tokenSeq);
    const promise = spawn({
      kind: 'progress', buttons: cancelable ? ['cancel'] : [], title, message,
      determinate, cancelable, progressToken: token, okText: '确定', cancelText: '取消',
    });
    const settleWrap = (val, msg) => {
      if (!progressApi.has(token)) return;
      const api = progressApi.get(token);
      progressApi.delete(token);
      api.finish(val, msg);
    };
    promise.then((v) => settleWrap(!!v));   // 用户取消(false)/关闭(false)
    const handle = {
      promise: promise.then((v) => v === true || v === 'ok'),
      set(value, msg) { progressApi.get(token)?.set(value, msg); },
      done(msg = '完成') { settleWrap(true, msg); },
      cancel() { settleWrap(false, '已取消'); },
    };
    return handle;
  },
};

/* ============ sysdialog 应用(所有对话框共用的窗口载体) ============ */
register({
  id: 'sysdialog',
  name: '系统对话框',
  icon: 'info',
  color: 'linear-gradient(135deg,#64748b,#475569)',
  width: 430, height: 240,
  singleton: false,
  resizable: false,
  desktop: false,     // 不出现在桌面/开始菜单
  dialog: true,       // 仅关闭按钮 + 模态 + 居中
  mount({ root, params: p, setTitle, close, setSize }) {
    const kind = KINDS[p.kind] || KINDS.info;
    let settled = false;

    try { if (kind.beep) beep(kind.beep[0], kind.beep[1]); } catch { /* 无手势时忽略 */ }

    const settle = (value) => {
      if (settled) return;
      settled = true;
      p._resolve?.(value);
      close();
    };

    /* ---- 内容 ---- */
    const iconBubble = el('span', { class: 'dlg-icon', style: { background: kind.color } }, icon(kind.icon, 20));

    const input = p.input
      ? el('input', {
        class: 'input dlg-input', type: p.input,
        value: p.value || '', placeholder: p.placeholder || '',
      })
      : null;

    const barFill = el('i', { style: { width: '0%' } });
    const bar = el('div', { class: 'dlg-bar' + (p.determinate === false ? ' indet' : '') }, barFill);
    const pct = el('span', { class: 'dlg-pct mono' }, '');
    const msgEl = el('div', { class: 'dlg-msg' }, p.message || '');

    // 取消语义:输入类 → null;确认类 → false;是/否类关闭 → null
    const cancelValue = () => (p.input ? null : (p.buttons.includes('yes') ? null : false));

    const btnBox = el('div', { class: 'dlg-btns' });
    // 是/否框 → ['否','是'];其余 → [取消, 确定]
    if (p.buttons.includes('yes')) {
      btnBox.append(el('button', { class: 'btn', onClick: () => settle('no') }, '否'));
      btnBox.append(el('button', { class: 'btn primary', onClick: () => settle('yes') }, '是'));
    } else {
      for (const spec of p.buttons) {
        if (spec === 'cancel') {
          btnBox.append(el('button', { class: 'btn', onClick: () => settle(cancelValue()) }, p.cancelText || '取消'));
        } else if (spec === 'ok') {
          btnBox.append(el('button', {
            class: 'btn ' + (p.danger ? 'danger' : 'primary'),
            onClick: () => settle(p.input ? input.value : true),
          }, p.okText || '确定'));
        }
      }
    }

    const dlg = el('div', { class: 'app dlg' },
      el('div', { class: 'dlg-main' },
        iconBubble,
        el('div', { class: 'dlg-text' },
          el('div', { class: 'dlg-title' }, p.title || ''),
          msgEl,
          p.detail ? el('div', { class: 'dlg-detail' }, p.detail) : null)),
      input,
      p.kind === 'progress' ? el('div', { class: 'dlg-progress' }, bar, pct) : null,
      btnBox);

    root.append(dlg);
    setTitle(p.title || '系统对话框');

    /* ---- 进度句柄接线 ---- */
    if (p.progressToken) {
      progressApi.set(p.progressToken, {
        set(value, msg) {
          if (typeof value === 'number') {
            barFill.style.width = value + '%';
            pct.textContent = Math.round(value) + '%';
          }
          if (msg) msgEl.textContent = msg;
        },
        finish(ok, msg) {
          if (msg) msgEl.textContent = msg;
          barFill.style.width = '100%';
          setTimeout(() => settle(ok ? true : false), ok ? 250 : 120);
        },
      });
    }

    /* ---- 键盘:Enter 确认 / Esc 取消 ----
       注意忽略"对话框出生之前"就已创建的事件:若对话框是在某个
       keydown 处理器内弹出的(如终端命令),该事件继续传播到
       document 时不应当作本对话框的 Enter/Esc。 */
    const bornAt = performance.now();
    const onKey = (e) => {
      if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (e.timeStamp <= bornAt) return;
      const isTop = root.closest('.win')?.classList.contains('focused');
      if (!isTop) return;
      if (e.key === 'Enter') { e.preventDefault(); settle(p.input ? input.value : (p.buttons.includes('yes') ? 'yes' : true)); }
      if (e.key === 'Escape') { e.preventDefault(); settle(p.buttons.includes('yes') ? 'no' : cancelValue()); }
    };
    document.addEventListener('keydown', onKey);

    /* ---- 自适应高度(测量内容后调整窗口) ---- */
    setTimeout(() => {
      const h = dlg.scrollHeight + 14;
      if (h > 40) setSize(430, Math.min(h + 44, window.innerHeight - 120));
      (p.input ? input : btnBox.lastChild)?.focus();
      if (p.input) input.select();
    }, 40);

    return {
      onClose() {
        document.removeEventListener('keydown', onKey);
        if (p.progressToken) progressApi.delete(p.progressToken);
        if (!settled) { settled = true; p._resolve?.(cancelValue()); }
        return true;
      },
    };
  },
});

export default dialogs;
