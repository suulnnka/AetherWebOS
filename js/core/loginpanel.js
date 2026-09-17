/* ============================================================
 * 登录面板(账号系统 UI)—— 供需要账号的应用复用
 *
 * requireLogin(rootEl, appName, onLogin):
 *   未登录时在 rootEl 渲染登录/注册面板(阻止应用内容);
 *   登录/注册成功后调用 onLogin(username)。
 * ============================================================ */
import { el } from './utils.js';
import { icon } from './icons.js';
import { accounts } from './accounts.js';

/**
 * 在 root 渲染登录面板。返回 true 表示已登录(无需渲染),
 * 登录成功回调 onLogin(user)。
 */
export function requireLogin(root, appName, onLogin) {
  const user = accounts.current();
  if (user) return false;   // 已登录,应用自行渲染

  root.innerHTML = '';
  const mode = { reg: false };

  const title = el('h2', {}, appName);
  const sub = el('div', { class: 'dim acc-sub' }, '此应用需要登录后使用(数据按账号隔离)');
  const userIn = el('input', { class: 'input', placeholder: '用户名', autocomplete: 'off' });
  const passIn = el('input', { class: 'input', type: 'password', placeholder: '密码' });
  const errEl = el('div', { class: 'acc-error' });
  const mainBtn = el('button', { class: 'btn primary acc-main-btn' }, '登录');
  const switchLink = el('button', {
    class: 'btn acc-switch',
    onClick: () => {
      mode.reg = !mode.reg;
      title.textContent = mode.reg ? `注册 — ${appName}` : appName;
      mainBtn.textContent = mode.reg ? '注册并登录' : '登录';
      switchLink.textContent = mode.reg ? '已有账号?去登录' : '没有账号?注册一个';
      errEl.textContent = '';
    },
  }, '没有账号?注册一个');

  async function submit() {
    errEl.textContent = '';
    mainBtn.disabled = true;
    try {
      const r = mode.reg
        ? await accounts.register(userIn.value.trim(), passIn.value)
        : await accounts.login(userIn.value.trim(), passIn.value);
      if (!r.ok) { errEl.textContent = r.error; return; }
      root.innerHTML = '';
      onLogin(r.user);
    } finally {
      mainBtn.disabled = false;
    }
  }
  mainBtn.addEventListener('click', submit);
  [userIn, passIn].forEach(i => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  }));

  root.append(el('div', { class: 'acc-panel' },
    icon('lock', 30),
    title,
    sub,
    userIn,
    passIn,
    errEl,
    mainBtn,
    switchLink));
  return true;
}

/** 登出按钮(带用户名显示) */
export function logoutButton(onLogout) {
  const user = accounts.current();
  return el('button', {
    class: 'btn acc-logout', title: `退出 ${user}`,
    onClick: () => { accounts.logout(); onLogout?.(); },
  }, icon('power', 12), user || '未登录');
}
