/* ============================================================
 * Session —— 系统会话:注销锁屏(选择用户 → 密码 + 提示 → 进桌面)
 *
 *   logoutSession()   注销:关闭全部窗口 → 清除会话 → 显示锁屏
 *   showSession()     显示锁屏(登录 / 切换用户)
 *
 * 登录页行为:
 *  · 用户列表单选;默认选中上次登录用户,否则第一个用户
 *  · 密码框下方展示该用户的密码提示(profile.passwordHint)
 *  · 注册可填写可选密码提示
 *  · 首启无用户时由 boot 调用 accounts.bootstrapIfNeeded() 自动建号并进入
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

/** 默认选中:上次登录用户,否则列表第一个 */
function pickDefaultUser(users) {
  const last = accounts.lastUser();
  if (last && users.some(u => u.name === last)) return last;
  return users[0]?.name || '';
}

/* ---- 锁屏界面 ---- */
function buildPanel() {
  const box = el('div', { class: 'ss-box' });
  const users0 = accounts.list();
  const state = {
    user: pickDefaultUser(users0),
    reg: users0.length === 0,   // 理论上首启已 bootstrap;极端情况下仍可注册
  };
  let errEl, passIn, userInput, hintIn, hintLine, form;

  const refreshHint = () => {
    if (!hintLine) return;
    const h = state.reg
      ? (hintIn?.value?.trim() || '可选:用于锁屏时提示找回密码')
      : (accounts.passwordHint(state.user) || '未设置密码提示');
    hintLine.textContent = state.reg ? `提示(可选):${h}` : `密码提示:${h}`;
  };

  const redraw = () => {
    box.innerHTML = '';
    const users = accounts.list();
    const last = accounts.lastUser();
    box.append(
      el('div', { class: 'ss-logo' }, icon('grid', 30)),
      el('div', { class: 'ss-title' }, state.reg ? '创建新用户' : '欢迎回来'),
      el('div', { class: 'ss-sub' },
        state.reg ? '注册后自动登录进桌面' : '选择用户,输入密码登录'),
    );

    if (!state.reg && users.length) {
      const list = el('div', { class: 'ss-users' },
        ...users.map(u => el('button', {
          type: 'button',
          class: 'ss-user' + (state.user === u.name ? ' on' : ''),
          dataset: { user: u.name },
          onClick: (e) => {
            state.user = u.name;
            [...list.children].forEach(n => n.classList.remove('on'));
            e.currentTarget.classList.add('on');
            refreshHint();
            passIn?.focus();
            passIn?.select?.();
          },
        },
          el('span', { class: 'ss-avatar' }, (u.displayName[0] || '?').toUpperCase()),
          el('span', { class: 'ss-uname' }, u.displayName),
          u.name === last
            ? el('span', { class: 'ss-badge', title: '上次登录的用户' }, '上次登录')
            : null)));
      box.append(list);
    }

    errEl = el('div', { class: 'ss-error' });
    userInput = el('input', {
      class: 'input', placeholder: '用户名(2-20 位)', autocomplete: 'username', spellcheck: 'false',
    });
    passIn = el('input', {
      class: 'input', type: 'password',
      placeholder: state.reg ? '密码(至少 4 位)' : '密码',
      autocomplete: state.reg ? 'new-password' : 'current-password',
    });
    hintIn = el('input', {
      class: 'input', placeholder: '密码提示(可选,最多 80 字)', autocomplete: 'off', maxlength: '80',
    });
    hintIn.addEventListener('input', refreshHint);

    hintLine = el('div', { class: 'ss-hint' });
    refreshHint();

    const mainBtn = el('button', { class: 'btn primary ss-main' }, state.reg ? '创建并登录' : '登录');
    mainBtn.addEventListener('click', submit);
    [userInput, passIn, hintIn].forEach(i => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    }));

    async function submit() {
      errEl.textContent = '';
      mainBtn.disabled = true;
      try {
        const r = state.reg
          ? await accounts.register(userInput.value.trim(), passIn.value, {
            passwordHint: hintIn.value.trim() || undefined,
          })
          : await accounts.login(state.user, passIn.value);
        if (!r.ok) { errEl.textContent = r.error; return; }
        hideSession();
      } finally {
        mainBtn.disabled = false;
      }
    }

    form = el('div', { class: 'ss-form' });
    if (state.reg) form.append(userInput);
    form.append(passIn, hintLine);
    if (state.reg) form.append(hintIn);
    form.append(errEl, mainBtn);

    const switchBtn = el('button', {
      type: 'button',
      class: 'btn ss-switch',
      onClick: () => { state.reg = !state.reg; redraw(); },
    }, state.reg ? '已有账号?返回登录' : '注册新用户');

    box.append(form);
    if (users.length || !state.reg) box.append(switchBtn);
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
  // 焦点:优先密码框(已选中用户)
  setTimeout(() => {
    const pw = overlay?.querySelector('#session input[type=password]');
    (pw || overlay?.querySelector('input'))?.focus();
    pw?.select?.();
  }, 80);
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

/* 启动自检:仅当「已有用户」且「锁屏标记」时进入锁屏。
 * 无用户时交给 boot 的 bootstrapIfNeeded 自动建号并登录,不进注册页。 */
if (!accounts.current() &&
    localStorage.getItem(LOCK_KEY) === '1' &&
    accounts.list().length) {
  showSession();
}
