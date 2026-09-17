/* ============================================================
 * Session —— 系统会话:注销锁屏(用户列表 → 密码登录 → 进桌面)
 *
 *   logoutSession()   注销:关闭全部窗口 → 清除会话 → 显示锁屏
 *   showSession()     显示锁屏(登录 / 切换用户;无账号时直接进入注册)
 *
 * 已登录时打开应用、注销后窗口全部关闭,锁屏期间桌面不可交互。
 * ============================================================ */
import { $, el } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { publish, subscribe } from '../core/bus.js';
import { accounts } from '../core/accounts.js';
import * as wm from '../core/wm.js';

let overlay = null;
export const sessionActive = () => !!overlay;

/* 锁屏标志(持久化):注销后刷新页面仍停留在锁屏,直到登录成功 */
const LOCK_KEY = 'webos.session-locked.v1';
const setLockFlag = (v) => {
  try { v ? localStorage.setItem(LOCK_KEY, '1') : localStorage.removeItem(LOCK_KEY); } catch { /* 忽略 */ }
};

/* ---- 锁屏界面 ---- */
function buildPanel() {
  const box = el('div', { class: 'ss-box' });
  const state = { user: accounts.list()[0]?.name || '', reg: !accounts.list().length };
  let errEl, passIn, userInput, form;

  const redraw = () => {
    box.innerHTML = '';
    const users = accounts.list();
    box.append(
      el('div', { class: 'ss-logo' }, icon('grid', 30)),
      el('div', { class: 'ss-title' }, state.reg ? '创建新用户' : '欢迎回来'),
      el('div', { class: 'ss-sub' },
        state.reg ? '注册后自动登录进桌面' : users.length ? '选择用户并输入密码登录' : '还没有账号,先创建一个'));

    if (!state.reg && users.length) {
      const list = el('div', { class: 'ss-users' },
        ...users.map(u => el('button', {
          class: 'ss-user' + (state.user === u.name ? ' on' : ''),
          onClick: (e) => {
            state.user = u.name;
            [...list.children].forEach(n => n.classList.remove('on'));
            e.currentTarget.classList.add('on');
            passIn?.focus();
          },
        },
          el('span', { class: 'ss-avatar' }, (u.displayName[0] || '?').toUpperCase()),
          el('span', { class: 'ss-uname' }, u.displayName),
          u.name === accounts.current() ? el('span', { class: 'ss-badge' }, '上次登录') : null)));
      box.append(list);
    }

    errEl = el('div', { class: 'ss-error' });
    userInput = el('input', { class: 'input', placeholder: '用户名(2-20 位)', autocomplete: 'off' });
    passIn = el('input', { class: 'input', type: 'password', placeholder: state.reg ? '密码(至少 4 位)' : '密码' });
    const mainBtn = el('button', { class: 'btn primary ss-main' }, state.reg ? '创建并登录' : '登录');

    mainBtn.addEventListener('click', submit);
    [userInput, passIn].forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));

    async function submit() {
      errEl.textContent = '';
      mainBtn.disabled = true;
      try {
        const r = state.reg
          ? await accounts.register(userInput.value.trim(), passIn.value)
          : await accounts.login(state.user, passIn.value);
        if (!r.ok) { errEl.textContent = r.error; return; }
        hideSession();
      } finally {
        mainBtn.disabled = false;
      }
    }

    form = el('div', { class: 'ss-form' });
    if (state.reg) form.append(userInput);
    form.append(passIn, errEl, mainBtn);

    const switchBtn = el('button', {
      class: 'btn ss-switch',
      onClick: () => { state.reg = !state.reg; redraw(); },
    }, state.reg ? '已有账号?返回登录' : '注册新用户');

    box.append(form);
    if (accounts.list().length) box.append(switchBtn);   // 系统里一个用户都没有时只提供注册
  };
  redraw();
  return box;
}

/** 显示锁屏(已登录则先注销;先挂载再注销,避免 accounts:changed 重入) */
export function showSession() {
  if (overlay) return;
  overlay = el('div', { id: 'session' }, buildPanel());
  document.body.append(overlay);
  setLockFlag(true);
  if (accounts.current()) accounts.logout();   // 触发 accounts:changed → 开始菜单等同步
  publish('session:changed', { from: 'session', type: 'locked', payload: { active: true } });
  setTimeout(() => overlay?.querySelector('input')?.focus(), 80);
}

function hideSession() {
  if (!overlay) return;
  overlay.classList.add('out');
  setLockFlag(false);
  setTimeout(() => { overlay?.remove(); overlay = null; }, 200);
  publish('session:changed', { from: 'session', type: 'unlocked', payload: { active: false } });
}

/** 注销:清空工作区 → 显示锁屏 */
export function logoutSession() {
  wm.closeAll();
  showSession();
}

/* 登录状态变化联动(注意:bus 回调首参是 payload,信封在第二参):
 *  - 登录 → 收起锁屏(无论登录发生在锁屏还是应用内的登录门)
 *  - 注销/删除用户导致无会话 → 系统还有其他用户时进入锁屏 */
subscribe('accounts:changed', (p, msg) => {
  const type = msg?.type;
  if (type === 'login') {
    if (overlay && accounts.current()) hideSession();
    return;
  }
  if ((type === 'logout' || type === 'removed') && !accounts.current() && !overlay && accounts.list().length) {
    showSession();
  }
});

/* 启动自检:上次处于锁屏(注销后刷新页面)→ 直接进入锁屏 */
if (localStorage.getItem(LOCK_KEY) === '1' && !accounts.current()) showSession();
