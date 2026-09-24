/* ============ 应用:终端 —— Bash(Bash 是唯一 shell,AetherWebOS 能力为扩展命令) ============ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './terminal.css';
import { createBash } from './bash.js';
import { settings } from '../../core/store.js';
import { accounts } from '../../core/accounts.js';
import { sshConnect, dnsResolve } from '../../core/vnet.js';

register({
  ...manifest,
  /* dialogs / fs / user 来自 ctx:对话框二级锁定;文件与身份按执行用户 */
  mount({ root, close, dialogs, fs, user }) {
    const history = [];
    let hIdx = 0;
    let sshSess = null;      // 活动的 SSH 远程会话(输入整体交给远程)
    let authReq = null;      // 进行中的密码验证 { host, user, tries }

    const out = el('div', { class: 'term-out' });
    const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const promptEl = el('span', { class: 't-prompt' }, '');
    const termEl = el('div', { class: 'term', onPointerdown: () => input.focus() }, out,
      el('div', { class: 'term-in' }, promptEl, input));

    function print(text = '', cls = '') {
      for (const line of String(text).split('\n')) {
        out.append(el('div', { class: cls }, line));
      }
      out.scrollTop = out.scrollHeight;
    }

    function prompt() {
      if (authReq) return;   // 密码提示行保持悬空,等 handleAuth 收尾
      if (sshSess) {
        const base = sshSess.cwd === '/' ? '/' : sshSess.cwd.split('/').pop() || '/';
        promptEl.textContent = `[${sshSess.user}@${sshSess.short()} ${base}]$ `;
      } else {
        shell.paintPrompt(promptEl);
      }
    }

    /* ---- SSH:密码验证与远程会话(UI 层状态,由 CMDS.ssh 触发) ---- */
    function beginSsh(arg) {
      const m = /^([\w.-]+)@([\w.-]+)$/.exec(arg || '');
      if (!m) return '用法: ssh <用户名>@<主机>';
      const [, user, host] = m;
      const r = dnsResolve(host);
      if (!r) return `ssh: 无法解析主机名 ${host}:虚拟 DNS 无记录`;
      print(`正在连接 ${r.host} [${r.ip}]…`, 't-dim');
      // 进入密码验证模式(输入不回显)
      authReq = { host, user, tries: 0 };
      input.type = 'password';
      print(`${user}@${r.host}'s password: `, 't-cmd');
      return null;
    }

    /** SSH 密码验证(输入已掩码,不回显) */
    function handleAuth(password) {
      const { host, user } = authReq;
      const r = sshConnect(host, user, password);
      out.lastChild?.remove(); // 移除悬空的密码提示行
      if (!r.ok) {
        authReq.tries++;
        if (r.reason === 'dns') {
          print('ssh: 连接失败:无法解析主机', 't-err');
          endAuth();
        } else if (authReq.tries >= 3) {
          print('Permission denied (publickey,password).', 't-err');
          print('连接失败(口令错误 3 次)', 't-dim');
          endAuth();
        } else {
          print('Permission denied, please try again.', 't-err');
          print(`${user}@${host}'s password: `, 't-cmd');
        }
        return;
      }
      sshSess = r.session;
      endAuth();
      if (r.banner) print(r.banner, 't-dim');
      if (r.motd) print(r.motd);
      prompt();
      print('已连接。输入 help 查看远程命令,exit 断开。', 't-dim');
    }

    function endAuth() {
      authReq = null;
      input.type = 'text';
      input.value = '';
    }

    const shell = createBash({
      user: user || accounts.current() || settings.get('username') || 'user',
      fs,
      history,
      print,
      hooks: { beginSsh },
      dialogs,
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const line = input.value;
        input.value = '';
        if (authReq) return handleAuth(line);   // 密码验证模式(不回显、不进历史)
        if (line.trim()) { history.push(line); hIdx = history.length; }
        if (sshSess) {
          // SSH 远程会话:命令整体交给虚拟服务器,不经本地 bash 解析
          print(`${promptEl.textContent}${line}`, 't-cmd');
          const r = sshSess.exec(line);
          for (const l of r.lines) {
            if (l.cls === 'clear') { out.innerHTML = ''; continue; }
            print(l.text, l.cls);
          }
          if (sshSess.ended) {
            print('Connection closed.', 't-dim');
            sshSess = null;
            prompt();
          }
          return;
        }
        (async () => {
          print(`${promptEl.textContent}${line}`, 't-cmd');
          await shell.runLine(line);
          if (shell.state.clear) { out.innerHTML = ''; shell.state.clear = false; }
          if (shell.state.exit) { shell.state.exit = false; close(); return; }
          prompt();
        })();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (hIdx > 0) input.value = history[--hIdx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (hIdx < history.length) input.value = history[++hIdx] || '';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        shell.complete(input);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault(); out.innerHTML = '';
      } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        if (input.selectionStart !== input.selectionEnd) return;   // 有选区:保留复制
        e.preventDefault();
        print(`${promptEl.textContent}${input.value}^C`, 't-dim');
        input.value = '';
      }
    });

    root.append(el('div', { class: 'app' }, termEl));

    prompt();
    print(shell.banner, 't-dim');
    print(`虚拟网络 nslookup / ping / curl / ssh,系统能力 notify / vol / crypt / open —— 输入 help 查看全部。`, 't-dim');
    setTimeout(() => input.focus(), 80);
  },
});
