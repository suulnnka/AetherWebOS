/* ============ 应用:终端 —— 展示 IPC 与系统能力的入口 ============ */
import { el, fmtDate, fmtTime } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './terminal.css';
import fs from '../../core/fs.js';
import { settings, WALLPAPERS, STATIC_WALLPAPERS, DYNAMIC_WALLPAPERS, pickWallpaper } from '../../core/store.js';
import { list as listApps } from '../../core/registry.js';
import { open } from '../../core/wm.js';
import { publish } from '../../core/bus.js';
import { httpGet, sshConnect, dnsResolve } from '../../core/vnet.js';
import { dialogs } from '../../core/dialogs.js';
import { isEncrypted, encryptText, decryptText } from '../../core/crypto.js';

register({
  ...manifest,
  mount({ root, bus }) {
    let cwd = '/home';
    const history = [];
    let hIdx = -1;
    let sshSess = null;      // 活动的 SSH 远程会话
    let authReq = null;      // 进行中的密码验证 { host, user, tries }
    let pendingMasked = false;

    const out = el('div', { class: 'term-out' });
    const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const promptEl = el('span', { class: 't-prompt' }, '');

    function prompt() {
      if (sshSess) {
        const base = sshSess.cwd === '/' ? '/' : sshSess.cwd.split('/').pop() || '/';
        promptEl.textContent = `[${sshSess.user}@${sshSess.short()} ${base}]$ `;
      } else {
        promptEl.textContent = `${settings.get('username')}@webos:${cwd}$ `;
      }
    }

    function print(text = '', cls = '') {
      for (const line of String(text).split('\n')) {
        out.append(el('div', { class: cls }, line));
      }
      out.scrollTop = out.scrollHeight;
    }

    /* ---------- 命令表 ---------- */
    const commands = {
      help() {
        print(`WebOS 终端 —— 可用命令:
  ls [路径]           列出目录内容
  cd <路径>           切换目录
  pwd                 显示当前目录
  cat <文件>          查看文件内容
  mkdir <名称>        创建目录
  rm <路径>           删除文件或目录
  echo <文本> [> 文件] 输出文本,可重定向写入文件
  edit <文件>         用记事本打开文件
  apps                列出已安装应用
  open <应用ID>       启动应用(如 open settings)
  notify <文本>       发送系统通知(IPC 演示)
  vol <0-100>         设置系统音量(IPC 演示)
  theme <light|dark|auto>  切换主题(IPC 演示)
  wallpaper <名称|URL>      更换壁纸
  sysinfo             向监视器请求系统状态(request/response 演示)
  date                显示日期时间
  whoami              当前用户
  clear               清屏
  reboot              重启系统

—— 虚拟网络 ——
  nslookup <主机>     查询虚拟 DNS
  ping <主机>         测试连通性
  curl <URL>          抓取虚拟站点文本
  ifconfig            本机虚拟网卡
  ssh <用户>@<主机>   连接虚拟服务器(密码登录)
  crypt encrypt|decrypt|islocked …   文件加密(AES-256)`, 't-dim');
      },
      ls(arg) {
        const p = arg ? fs.joinPath(cwd, arg) : cwd;
        const items = fs.list(p);
        if (!items) return print(`ls: 无法访问 "${p}": 不是目录`, 't-err');
        if (!items.length) return;
        print(items.map(i => i.name + (i.dir ? '/' : '')).join('  '));
      },
      cd(arg) {
        const p = arg ? fs.joinPath(cwd, arg) : '/home';
        if (fs.isDir(p)) { cwd = fs.normPath(p); prompt(); }
        else print(`cd: "${p}": 目录不存在`, 't-err');
      },
      pwd() { print(cwd); },
      cat(arg) {
        if (!arg) return print('用法: cat <文件>', 't-err');
        const p = fs.joinPath(cwd, arg);
        const c = fs.read(p);
        c == null ? print(`cat: "${p}": 文件不存在`, 't-err') : print(c || '(空文件)');
      },
      mkdir(arg) {
        if (!arg) return print('用法: mkdir <名称>', 't-err');
        fs.mkdir(fs.joinPath(cwd, arg)) ? print('已创建', 't-ok') : print('mkdir 失败', 't-err');
      },
      rm(arg) {
        if (!arg) return print('用法: rm <路径>', 't-err');
        const p = fs.joinPath(cwd, arg);
        fs.exists(p) ? (fs.rm(p), print('已删除', 't-ok')) : print(`rm: "${p}": 不存在`, 't-err');
      },
      echo(...args) {
        const gt = args.indexOf('>');
        if (gt >= 0 && args[gt + 1]) {
          const text = args.slice(0, gt).join(' ');
          const file = fs.joinPath(cwd, args[gt + 1]);
          fs.write(file, text + '\n');
          print(`已写入 ${file}`, 't-ok');
        } else {
          print(args.join(' '));
        }
      },
      edit(arg) {
        if (!arg) return print('用法: edit <文件>', 't-err');
        const p = fs.joinPath(cwd, arg);
        if (!fs.exists(p)) fs.write(p, '');
        open('notes', { params: { path: p } });
        print(`已在记事本打开 ${p}`, 't-ok');
      },
      apps() {
        for (const a of listApps()) print(`${a.id.padEnd(10)} ${a.name}${a.singleton ? '  (单实例)' : ''}`);
      },
      open(arg) {
        if (!arg || !listApps().some(a => a.id === arg)) return print(`open: 未找到应用 "${arg}",试试 apps 命令`, 't-err');
        open(arg);
        print(`已启动 ${arg}`, 't-ok');
      },
      notify(...args) {
        const text = args.join(' ');
        if (!text) return print('用法: notify <文本>', 't-err');
        publish('sys:notify', { from: 'terminal', type: 'notify', payload: { title: '终端消息', body: text } });
        print('通知已发送(可在系统监视器观察这条 IPC 消息)', 't-ok');
      },
      vol(arg) {
        const v = parseInt(arg, 10);
        if (isNaN(v) || v < 0 || v > 100) return print('用法: vol <0-100>', 't-err');
        settings.set({ volume: v, muted: false });
        print(`音量已设置为 ${v}%(托盘滑杆同步变化)`, 't-ok');
      },
      theme(arg) {
        if (!['light', 'dark', 'auto'].includes(arg)) return print('用法: theme <light|dark|auto>', 't-err');
        settings.set({ theme: arg });
        print(`主题已切换为 ${arg}`, 't-ok');
      },
      wallpaper(arg) {
        if (!arg) return print(
          '静态: ' + STATIC_WALLPAPERS.map(w => w.id).join(', ') +
          '\n动态: ' + DYNAMIC_WALLPAPERS.map(w => w.id).join(', ') +
          '\n或直接给图片 URL(静态)', 't-dim');
        if (/^https?:|^data:/.test(arg)) {
          settings.set({ wallpaperType: 'static', wallpaperStatic: 'custom', wallpaperUrl: arg });
        } else if (WALLPAPERS.some(w => w.id === arg)) {
          pickWallpaper(arg);
        } else return print(`wallpaper: 未知壁纸 "${arg}"`, 't-err');
        print('壁纸已更换', 't-ok');
      },
      async sysinfo() {
        print('正在向系统监视器发起请求…', 't-dim');
        try {
          const r = await bus.request('monitor', 'stats', null, 2000);
          print(`监视器响应: 窗口 ${r.windows} 个 · IPC 消息 ${r.messages} 条 · 开机于 ${fmtTime(new Date(r.boot))}`, 't-ok');
        } catch (e) {
          print('sysinfo: ' + e.message, 't-err');
          print('提示: 先用 open monitor 打开系统监视器,再试一次', 't-dim');
        }
      },
      date() { print(fmtDate(new Date(), true) + ' ' + fmtTime(new Date(), true)); },
      whoami() { print(settings.get('username')); },
      clear() { out.innerHTML = ''; },
      reboot() { print('正在重启…', 't-dim'); setTimeout(() => location.reload(), 600); },

      /* ---- 虚拟网络命令 ---- */
      nslookup(arg) {
        if (!arg) return print('用法: nslookup <域名|IP>', 't-err');
        const r = dnsResolve(arg);
        if (!r) return print(`*** 找不到 ${arg}:虚拟 DNS 无记录 **`, 't-err');
        print(`服务器:  nexus-dns
地址:    10.0.0.1

名称:    ${r.host}
地址:    ${r.ip}` + (r.note ? `\n备注:    ${r.note}` : ''), 't-ok');
      },
      ping(arg) {
        const target = arg || '';
        if (!target) return print('用法: ping <域名|IP>', 't-err');
        const r = dnsResolve(target);
        if (!r) return print(`ping: 无法解析 ${target}:虚拟 DNS 无记录`, 't-err');
        print(`正在 Ping ${r.host} [${r.ip}] 具有 32 字节的数据:`);
        let lost = 0;
        for (let i = 0; i < 4; i++) {
          const t = r.latency + Math.floor(Math.random() * 8);
          if (r.ip === '10.0.0.1' || Math.random() > 0.15) print(`来自 ${r.ip} 的回复: 字节=32 时间=${t}ms TTL=64`);
          else { print(`请求超时。`, 't-err'); lost++; }
        }
        print(`\n${r.host} 的 Ping 统计:数据包: 已发送 = 4,已接收 = ${4 - lost},丢失 = ${lost} (${lost * 25}% 丢失)`, 't-dim');
      },
      curl(arg) {
        if (!arg) return print('用法: curl <虚拟URL>', 't-err');
        const r = httpGet(arg);
        if (r.status === 'dns') return print(`curl: (6) 无法解析主机 ${r.host} —— 虚拟网络外不可达`, 't-err');
        if (r.status === 'refused') return print(`curl: (7) 连接 ${r.host} (${r.ip}) 被拒绝`, 't-err');
        if (r.status === '404') return print(`curl: (22) 404 Not Found:${r.path}`, 't-err');
        if (r.status === '403') return print(`curl: (22) 403 Forbidden:${r.path}`, 't-err');
        if (r.type === 'proxy') return print('该资源是外部代理文件(二进制),请在浏览器中打开查看。', 't-dim');
        const text = String(r.body)
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 400);
        print(text || '(空响应)');
        print(`— ${r.url} (${r.ip}, ${r.ms}ms),完整页面请用浏览器打开`, 't-dim');
      },
      ifconfig() {
        print(`eth0: 10.0.0.2  掩码 255.255.255.0  网关 10.0.0.1
lo:   127.0.0.1
DNS:  nexus-dns (10.0.0.1) —— 仅解析虚拟网络`, 't-dim');
      },

      /* ---- 文件加密:crypt encrypt/decrypt/islocked ---- */
      crypt: {
        async encrypt(file, password) {
          if (!file || !password) return print('用法: crypt encrypt <文件> <密码>', 't-err');
          const p = fs.normPath(fs.joinPath(cwd, file));
          const c = fs.read(p);
          if (c == null) return print(`crypt: "${p}": 文件不存在`, 't-err');
          if (isEncrypted(c)) return print('crypt: 该文件已是加密状态', 't-err');
          fs.write(p, await encryptText(c, password));
          print(`已加密 🔒 ${p}`, 't-ok');
        },
        async decrypt(file, password) {
          if (!file || !password) return print('用法: crypt decrypt <文件> <密码>', 't-err');
          const p = fs.normPath(fs.joinPath(cwd, file));
          const c = fs.read(p);
          if (c == null) return print(`crypt: "${p}": 文件不存在`, 't-err');
          if (!isEncrypted(c)) return print('crypt: 该文件未加密', 't-err');
          try {
            fs.write(p, await decryptText(c, password));
            print(`已解密 ${p}`, 't-ok');
          } catch (e) {
            print(`crypt: ${e.message}`, 't-err');
          }
        },
        islocked(file) {
          if (!file) return print('用法: crypt islocked <文件>', 't-err');
          const c = fs.read(fs.normPath(fs.joinPath(cwd, file)));
          print(c == null ? '文件不存在' : isEncrypted(c) ? '🔒 已加密' : '未加密');
        },
      },

      /* ---- 系统对话框演示 ---- */
      alert(...args) {
        if (!args.length) return print('用法: alert <文本>', 't-err');
        dialogs.error({ title: '系统错误', message: args.join(' '), detail: 'ERROR_DEMO (终端 alert 命令)' });
        print('已弹出系统错误对话框', 't-dim');
      },
      async ask(...args) {
        const v = await dialogs.prompt({ title: '终端询问', message: args.join(' ') || '请输入内容:' });
        print(`输入结果: ${v === null ? '(已取消)' : v}`);
      },
      async progress() {
        print('启动进度对话框演示…', 't-dim');
        const h = dialogs.progress({ title: '下载系统更新', message: '正在连接更新服务器…', cancelable: true });
        let v = 0;
        const timer = setInterval(() => {
          v += 8 + Math.floor(Math.random() * 10);
          if (v >= 100) {
            clearInterval(timer);
            h.set(100, '校验完成');
            h.done('更新下载完成');
            print('进度:完成', 't-ok');
            return;
          }
          h.set(v, `正在下载… ${v}%`);
        }, 220);
        const ok = await h.promise;
        if (!ok) { clearInterval(timer); print('进度:已取消', 't-err'); }
      },
      ssh(arg) {
        const m = /^([\w.-]+)@([\w.-]+)$/.exec(arg || '');
        if (!m) return print('用法: ssh <用户名>@<主机>', 't-err');
        const [, user, host] = m;
        const r = dnsResolve(host);
        if (!r) return print(`ssh: 无法解析主机名 ${host}:虚拟 DNS 无记录`, 't-err');
        print(`正在连接 ${r.host} [${r.ip}]…`, 't-dim');
        // 进入密码验证模式(输入不回显)
        authReq = { host, user, tries: 0 };
        pendingMasked = true;
        input.type = 'password';
        print(`${user}@${r.host}'s password: `, 't-cmd', true); // 不换行标记
      },
    };

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
          print(`${user}@${host}'s password: `, 't-cmd', true);
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
      pendingMasked = false;
      input.type = 'text';
      input.value = '';
    }

    function run(line) {
      // SSH 远程会话:命令交给虚拟服务器执行
      if (sshSess) {
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
      print(`${promptEl.textContent}${line}`, 't-cmd');
      const parts = line.trim().split(/\s+/).filter(Boolean);
      let cmd = parts.shift();
      if (!cmd) return;
      // 子命令分发:crypt encrypt … / crypt decrypt …
      let handler = commands[cmd];
      while (handler && typeof handler === 'object' && parts.length) {
        const sub = parts.shift();
        cmd += ' ' + sub;
        handler = handler[sub];
      }
      if (handler && typeof handler === 'object') {
        print(`用法:${cmd} <${Object.keys(handler).join('|')}>`, 't-dim');
      } else if (handler) {
        try { handler(...parts); }
        catch (e) { print(`${cmd}: ${e.message}`, 't-err'); }
      } else {
        print(`${cmd}: 未找到命令。输入 help 查看帮助`, 't-err');
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const line = input.value;
        input.value = '';
        if (authReq) return handleAuth(line);   // 密码验证模式(不回显、不进历史)
        if (line.trim()) { history.push(line); hIdx = history.length; }
        run(line);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (hIdx > 0) input.value = history[--hIdx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (hIdx < history.length) input.value = history[++hIdx] || '';
      } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault(); commands.clear();
      }
    });

    root.append(el('div', { class: 'app' },
      el('div', { class: 'term', onPointerdown: () => input.focus() },
        out,
        el('div', { class: 'term-in' }, promptEl, input))));

    prompt();
    print(`WebOS 终端 v1.0 —— 输入 help 查看命令`, 't-dim');
    print(`小技巧: 打开系统监视器的 IPC 页,再运行 notify / vol 命令,\n可以实时看到应用之间的消息流动。`, 't-dim');
    setTimeout(() => input.focus(), 80);
  },
});
