/* ============ 应用:终端 —— Bash(Bash 是唯一 shell,AetherWebOS 能力为扩展命令) ============
 * 远程会话(模拟远程终端,引擎在 core/vssh.js):
 *   · 会话栈 sshStack:本地 → A → B 跳板链,远程会话里再输 ssh 即嵌套连接,
 *     exit 逐层弹出;多个终端窗口各自独立成栈,同主机同用户共享远端文件状态;
 *   · 密码验证(authReq)不回显,ssh 连接与 scp 一次性传输共用同一流程;
 *   · Tab 补全在远程会话里补远端命令名 / 远端当前目录条目。
 */
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
    const sshStack = [];    // 远程会话栈:末位是当前层,exit 弹出回上一层
    let authReq = null;     // 进行中的密码验证 { host, user, tries, mode:'ssh'|'scp', … }

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

    const cur = () => sshStack[sshStack.length - 1] || null;

    function prompt() {
      if (authReq) return;   // 密码提示行保持悬空,等 handleAuth 收尾
      const s = cur();
      if (s) {
        const base = s.cwd === s.home ? '~' : (s.cwd === '/' ? '/' : s.cwd.split('/').pop() || '/');
        promptEl.textContent = `[${s.user}@${s.short()} ${base}]$ `;
      } else {
        shell.paintPrompt(promptEl);
      }
    }

    /* ---- 连接发起(本地 ssh/scp 命令与远程会话里的跳板 ssh 共用) ---- */
    function beginSsh(arg) {
      const m = /^([\w.-]+)@([\w.-]+)$/.exec(arg || '');
      if (!m) return '用法: ssh <用户名>@<主机>';
      const [, user, host] = m;
      const r = dnsResolve(host);
      if (!r) return `ssh: 无法解析主机名 ${host}:虚拟 DNS 无记录`;
      const via = sshStack.length ? `(经 ${cur().short()} 跳板)` : '';
      print(`正在连接 ${r.host} [${r.ip}]${via}…`, 't-dim');
      // 进入密码验证模式(输入不回显)
      authReq = { host, user, tries: 0, mode: 'ssh' };
      input.type = 'password';
      print(`${user}@${r.host}'s password: `, 't-cmd');
      return null;
    }

    /** scp 一次性传输(不进交互会话):dir 'up' 上传本地→远端,'down' 下载远端→本地 */
    function beginScp({ user, host, remote, local, dir }) {
      const r = dnsResolve(host);
      if (!r) return `scp: 无法解析主机名 ${host}:虚拟 DNS 无记录`;
      print(`正在连接 ${r.host} [${r.ip}]…`, 't-dim');
      authReq = { host, user, tries: 0, mode: 'scp', remote, local, dir };
      input.type = 'password';
      print(`${user}@${r.host}'s password: `, 't-cmd');
      return null;
    }

    /** 密码验证(输入已掩码,不回显):成功后按模式入栈会话或执行一次性传输 */
    function handleAuth(password) {
      const { host, user } = authReq;
      const r = sshConnect(host, user, password, { localFs: fs });
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
      const req = authReq;
      endAuth();

      if (req.mode === 'scp') {
        const s = r.session;
        if (req.dir === 'down') {
          const g = s.getFile(req.remote || String(req.local).split('/').pop());
          if (!g.ok) print(`scp: ${g.err}`, 't-err');
          else if (!fs.write(req.local, g.content)) print(`scp: 写入 ${req.local} 失败(无权限)`, 't-err');
          else print(`${s.host}:${g.abs} → ${req.local}`, 't-ok');
        } else {
          const p = s.putFile(req.local, req.remote);
          if (!p.ok) print(`scp: ${p.err}`, 't-err');
          else print(`${req.local} → ${s.host}:${p.abs}`, 't-ok');
        }
        prompt();
        return;
      }

      sshStack.push(r.session);
      if (r.banner) print(r.banner, 't-dim');
      if (r.motd) print(r.motd);
      prompt();
      print(sshStack.length > 1 ? '跳板连接已建立。' : '已连接。输入 help 查看远程命令,exit 断开。', 't-dim');
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
      hooks: { beginSsh, beginScp },
      dialogs,
    });

    /* 远程会话的命令行处理:跳板拦截 → 执行 → ended 弹栈 */
    function runRemote(line) {
      const s = cur();
      const words = line.trim().split(/\s+/);
      // ssh 在远程会话里 = 从本机跳板发起嵌套连接(作者自定义 ssh 命令时除外)
      if (words[0] === 'ssh' && !s.hasCustom('ssh')) {
        print(`${promptEl.textContent}${line}`, 't-cmd');
        const err = beginSsh(words[1] || '');
        if (err) print(err, 't-err');
        return;
      }
      print(`${promptEl.textContent}${line}`, 't-cmd');
      const r = s.exec(line);
      for (const l of r.lines) {
        if (l.cls === 'clear') { out.innerHTML = ''; continue; }
        print(l.text, l.cls);
      }
      if (s.ended) {
        sshStack.pop();
        print(sshStack.length ? `Connection to ${s.host} closed.` : 'Connection closed.', 't-dim');
        prompt();
      }
    }

    /** 远程会话 Tab 补全(命令名 / 远端当前目录条目) */
    function completeRemote() {
      const s = cur();
      const val = input.value;
      const parts = val.split(/\s+/);
      const hits = s.complete(val);
      if (hits.length === 1) {
        parts[parts.length - 1] = hits[0];
        input.value = parts.join(' ') + ' ';
      } else if (hits.length > 1) {
        print(`${promptEl.textContent}${val}`, 't-cmd');
        print(hits.join('  '), 't-dim');
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const line = input.value;
        input.value = '';
        if (authReq) return handleAuth(line);   // 密码验证模式(不回显、不进历史)
        if (line.trim()) { history.push(line); hIdx = history.length; }
        if (cur()) return runRemote(line);
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
        if (authReq) return;
        if (cur()) completeRemote();
        else shell.complete(input);
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
    print(`虚拟网络 nslookup / ping / curl / ssh / scp,系统能力 notify / vol / crypt / open —— 输入 help 查看全部。`, 't-dim');
    setTimeout(() => input.focus(), 80);

  },
});
