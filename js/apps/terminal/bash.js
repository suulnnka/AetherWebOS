/* ============================================================
 * 终端 —— Bash 命令引擎(唯一 shell)
 *
 * AetherWebOS 终端就是一个 bash:白名单 Linux 指令 + AetherWebOS 扩展命令
 * (虚拟网络 nslookup/ping/curl/ssh、IPC 演示 notify/vol/sysinfo、
 * 文件加密 crypt、系统对话框 alert/ask/progress 等)共用一张命令表:
 *  - 支持管道(|)、输出重定向(> >>)、引号、# 注释;
 *  - 操作本地虚拟文件系统(文件管家/记事本实时联动);
 *  - 网络类命令直达虚拟网络(vnet),无法访问真实互联网。
 * UI(回显/提示符/SSH 会话/密码掩码)由 terminal/index.js 提供。
 * ============================================================ */
import { fmtDate, fmtTime } from '../../core/utils.js';
import fs from '../../core/fs.js';
import { isEncrypted, encryptText, decryptText } from '../../core/crypto.js';
import { settings, WALLPAPERS, STATIC_WALLPAPERS, DYNAMIC_WALLPAPERS, pickWallpaper } from '../../core/store.js';
import { list as listApps } from '../../core/registry.js';
import { isAppLink, appLinkApp } from '../../core/applink.js';
import { open } from '../../core/wm.js';
import { publish, request } from '../../core/bus.js';
import { dialogs } from '../../core/dialogs.js';
import { httpGet, dnsResolve } from '../../core/vnet.js';

/* ---------- 词法:引号与注释 ---------- */
function tokenize(line) {
  const out = [];
  let cur = '', quote = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if ((c === ' ' || c === '\t')) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    if (c === '#' && !cur && !has) break;
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** 按未引用的 | 拆分管道段 */
function splitPipe(line) {
  const parts = [];
  let cur = '', quote = null;
  for (const c of line) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '|') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** 提取结尾的 > / >> 重定向 */
function extractRedir(stage) {
  const m = /^(.*?)(>>?)\s*([^\s>]+)\s*$/.exec(stage.trim());
  if (!m) return { cmd: stage, file: null, append: false };
  return { cmd: m[1], file: m[3], append: m[2] === '>>' };
}

/* ---------- 命令表 ----------
   每个命令: run(args, io) → string(stdout),可为 async
   io = { stdin, piped, print(text,cls), resolve(p), state }        */
const CMDS = {};

/* ---- 文件与目录 ---- */
CMDS.ls = {
  desc: '列出目录内容(ls [-l] [-a] [路径])',
  run(args, { resolve, piped }) {
    const long = args.filter(a => a.startsWith('-')).some(a => a.includes('l'));
    const all = args.filter(a => a.startsWith('-')).some(a => a.includes('a'));
    const target = resolve(args.find(a => !a.startsWith('-')) || '.');
    const items = fs.list(target);
    if (!items) throw new Error(`ls: 无法访问 ${target}: 没有那个文件或目录`);
    const shown = all ? [{ name: '.', dir: true }, { name: '..', dir: true }, ...items] : items;
    const names = shown.map(i => i.name + (i.dir ? '/' : ''));
    if (long) {
      return shown.map((i, k) => {
        const isDir = i.dir;
        const size = i.size ?? 4096;
        const mtime = i.mtime ? fmtDate(new Date(i.mtime)) : '          ';
        return `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'}  1 user user ${String(size).padStart(6)} ${mtime} ${names[k]}`;
      }).join('\n');
    }
    // 管道/重定向中每个文件一行(真实 bash 行为,便于 wc -l)
    return piped ? names.join('\n') + '\n' : names.join('  ');
  },
};

CMDS.cd = {
  desc: '切换目录(cd <路径>,~ 为主目录)',
  run(args, { resolve, state }) {
    const target = resolve(args[0] || '~');
    if (!fs.isDir(target)) throw new Error(`cd: ${args[0] || target}: 没有那个目录`);
    state.cwd = target;
    return '';
  },
};

CMDS.pwd = { desc: '显示当前目录', run: (a, { state }) => state.cwd };
CMDS.whoami = { desc: '当前用户', run: (a, { state }) => state.user };
CMDS.hostname = { desc: '主机名', run: () => 'aetherwebos' };
CMDS.uname = { desc: '系统信息(uname -a)', run: (args) => args.includes('-a') ? 'Linux aetherwebos 6.1.0-aetherwebos #1 SMP x86_64 GNU/Linux' : 'Linux' };
CMDS.date = { desc: '日期时间', run: () => new Date().toString() };
CMDS.uptime = { desc: '运行时间', run: () => 'up 3 days, 22:13, 1 user, load average: 0.31, 0.24, 0.18' };
CMDS.echo = {
  desc: '输出文本(echo [-n] <文本>)',
  run(args) {
    let nl = true;
    const rest = [...args];
    if (rest[0] === '-n') { nl = false; rest.shift(); }
    return rest.join(' ') + (nl ? '\n' : '');
  },
};
CMDS.cat = {
  desc: '查看文件(cat <文件…>,可接管道)',
  run(args, { stdin, resolve }) {
    if (!args.length) return stdin ?? '';
    return args.map((p) => {
      const f = fs.read(resolve(p));
      if (f == null) throw new Error(`cat: ${p}: 没有那个文件或目录`);
      if (isEncrypted(f)) throw new Error(`cat: ${p}: 是加密文件(在文件管家中解锁后查看)`);
      return f;
    }).join('');
  },
};
CMDS.mkdir = {
  desc: '创建目录(mkdir [-p] <名称>)',
  run(args, { resolve }) {
    const p = args.filter(a => !a.startsWith('-'))[0];
    if (!p) throw new Error('mkdir: 缺少操作数');
    fs.mkdir(resolve(p));
    return '';
  },
};
CMDS.rm = {
  desc: '删除(rm [-r] <路径>)',
  run(args, { resolve }) {
    const rec = args.filter(a => a.startsWith('-')).some(a => a.includes('r'));
    const p = args.filter(a => !a.startsWith('-'))[0];
    if (!p) throw new Error('rm: 缺少操作数');
    const target = resolve(p);
    if (fs.isDir(target) && !rec) throw new Error(`rm: 无法删除 ${p}: 是一个目录(使用 -r)`);
    if (!fs.rm(target)) throw new Error(`rm: 无法删除 ${p}: 没有那个文件或目录`);
    return '';
  },
};
CMDS.touch = {
  desc: '创建空文件/更新时间(touch <文件>)',
  run(args, { resolve }) {
    if (!args[0]) throw new Error('touch: 缺少文件操作数');
    const p = resolve(args[0]);
    if (!fs.exists(p)) fs.write(p, '');
    return '';
  },
};
CMDS.mv = {
  desc: '移动/重命名(mv <源> <目标>)',
  run(args, { resolve }) {
    if (args.length < 2) throw new Error('mv: 缺少目标文件操作数');
    if (!fs.rename(resolve(args[0]), resolve(args[1]))) throw new Error(`mv: 无法移动 ${args[0]}`);
    return '';
  },
};
CMDS.cp = {
  desc: '复制文件(cp <源> <目标>)',
  run(args, { resolve }) {
    if (args.length < 2) throw new Error('cp: 缺少目标文件操作数');
    const src = resolve(args[0]);
    if (fs.isDir(src)) throw new Error(`cp: 略过目录 ${args[0]}`);
    const c = fs.read(src);
    if (c == null) throw new Error(`cp: 无法统计 ${args[0]}: 没有那个文件`);
    fs.write(resolve(args[1]), c);
    return '';
  },
};
CMDS.head = {
  desc: '前 N 行(head [-n N] [文件])',
  run(args, { stdin, resolve }) {
    const n = Number(args[args.indexOf('-n') + 1]) || 10;
    const file = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');
    const text = file != null ? (fs.read(resolve(file)) ?? (() => { throw new Error(`head: 无法打开 ${file}`); })()) : stdin ?? '';
    return text.split('\n').slice(0, n).join('\n') + '\n';
  },
};
CMDS.tail = {
  desc: '后 N 行(tail [-n N] [文件])',
  run(args, { stdin, resolve }) {
    const n = Number(args[args.indexOf('-n') + 1]) || 10;
    const file = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');
    const text = file != null ? (fs.read(resolve(file)) ?? (() => { throw new Error(`tail: 无法打开 ${file}`); })()) : stdin ?? '';
    const lines = text.replace(/\n$/, '').split('\n');
    return lines.slice(-n).join('\n') + '\n';
  },
};
CMDS.grep = {
  desc: '筛选行(grep [-i] [-n] <模式> [文件])',
  run(args, { stdin, resolve }) {
    const flags = args.filter(a => a.startsWith('-'));
    const ci = flags.some(f => f.includes('i'));
    const num = flags.some(f => f.includes('n'));
    const rest = args.filter(a => !a.startsWith('-'));
    const pattern = rest.shift();
    if (!pattern) throw new Error('用法: grep [-i] [-n] <模式> [文件]');
    const file = rest[0];
    const text = file ? (fs.read(resolve(file)) ?? (() => { throw new Error(`grep: ${file}: 没有那个文件`); })()) : stdin ?? '';
    const rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : '');
    const hits = text.replace(/\n$/, '').split('\n')
      .map((l, i) => (rx.test(l) ? (num ? `${i + 1}:${l}` : l) : null))
      .filter(Boolean);
    return hits.join('\n') + (hits.length ? '\n' : '');
  },
};
CMDS.wc = {
  desc: '统计(wc [-l|-w|-c] [文件])',
  run(args, { stdin, resolve }) {
    const flags = args.filter(a => a.startsWith('-')).join('');
    const file = args.find(a => !a.startsWith('-'));
    const text = file ? (fs.read(resolve(file)) ?? (() => { throw new Error(`wc: ${file}: 没有那个文件`); })()) : stdin ?? '';
    const lines = text.replace(/\n$/, '') === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const chars = text.length;
    if (flags.includes('l')) return String(lines) + '\n';
    if (flags.includes('w')) return String(words) + '\n';
    if (flags.includes('c')) return String(chars) + '\n';
    return `${String(lines).padStart(4)} ${String(words).padStart(4)} ${String(chars).padStart(4)}${file ? ' ' + file : ''}\n`;
  },
};
CMDS.find = {
  desc: '查找文件(find [路径] -name <模式>)',
  run(args, { resolve }) {
    const ni = args.indexOf('-name');
    const pattern = ni >= 0 ? args[ni + 1] : null;
    const start = resolve(args.find((a, i) => !a.startsWith('-') && i !== ni + 1) || '.');
    const rx = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
    const acc = [];
    (function walk(p) {
      const items = fs.list(p) || [];
      for (const it of items) {
        if (!rx || rx.test(it.name)) acc.push(p === '/' ? '/' + it.name : p + '/' + it.name);
        if (it.dir) walk(it.path);
      }
    })(start);
    return acc.join('\n') + (acc.length ? '\n' : '');
  },
};
CMDS.tree = {
  desc: '目录树(tree [路径])',
  run(args, { resolve }) {
    const start = resolve(args[0] || '.');
    const acc = [start];
    (function walk(p, prefix) {
      const items = fs.list(p) || [];
      items.forEach((it, i) => {
        const last = i === items.length - 1;
        acc.push(prefix + (last ? '└─ ' : '├─ ') + it.name + (it.dir ? '/' : ''));
        if (it.dir) walk(it.path, prefix + (last ? '   ' : '│  '));
      });
    })(start, '');
    return acc.join('\n') + '\n';
  },
};

/* ---- 虚拟网络(vnet) ---- */
CMDS.nslookup = {
  desc: '查询虚拟 DNS(nslookup <域名|IP>)',
  run(args) {
    const arg = args[0];
    if (!arg) throw new Error('用法: nslookup <域名|IP>');
    const r = dnsResolve(arg);
    if (!r) throw new Error(`*** 找不到 ${arg}:虚拟 DNS 无记录 **`);
    return `服务器:  nexus-dns
地址:    10.0.0.1

名称:    ${r.host}
地址:    ${r.ip}` + (r.note ? `\n备注:    ${r.note}` : '');
  },
};
CMDS.ping = {
  desc: '测试连通性(ping <域名|IP>)',
  run(args) {
    const target = args[0] || '';
    if (!target) throw new Error('用法: ping <域名|IP>');
    const r = dnsResolve(target);
    if (!r) throw new Error(`ping: 无法解析 ${target}:虚拟 DNS 无记录`);
    const lines = [`正在 Ping ${r.host} [${r.ip}] 具有 32 字节的数据:`];
    let lost = 0;
    for (let i = 0; i < 4; i++) {
      const t = r.latency + Math.floor(Math.random() * 8);
      if (r.ip === '10.0.0.1' || Math.random() > 0.15) lines.push(`来自 ${r.ip} 的回复: 字节=32 时间=${t}ms TTL=64`);
      else { lines.push(`请求超时。`); lost++; }
    }
    lines.push(``, `${r.host} 的 Ping 统计:数据包: 已发送 = 4,已接收 = ${4 - lost},丢失 = ${lost} (${lost * 25}% 丢失)`);
    return lines.join('\n');
  },
};
CMDS.curl = {
  desc: '抓取虚拟站点文本(curl <URL>)',
  run(args, { piped, print }) {
    const arg = args[0];
    if (!arg) throw new Error('用法: curl <虚拟URL>');
    const r = httpGet(arg);
    if (r.status === 'dns') throw new Error(`curl: (6) 无法解析主机 ${r.host} —— 虚拟网络外不可达`);
    if (r.status === 'refused') throw new Error(`curl: (7) 连接 ${r.host} (${r.ip}) 被拒绝`);
    if (r.status === '404') throw new Error(`curl: (22) 404 Not Found:${r.path}`);
    if (r.status === '403') throw new Error(`curl: (22) 403 Forbidden:${r.path}`);
    if (r.type === 'proxy') return '该资源是外部代理文件(二进制),请在浏览器中打开查看。';
    const text = String(r.body)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 400);
    if (!piped) print(`— ${r.url} (${r.ip}, ${r.ms}ms),完整页面请用浏览器打开`, 't-dim');
    return text || '(空响应)';
  },
};
CMDS.ifconfig = {
  desc: '本机虚拟网卡',
  run() {
    return `eth0: 10.0.0.2  掩码 255.255.255.0  网关 10.0.0.1
lo:   127.0.0.1
DNS:  nexus-dns (10.0.0.1) —— 仅解析虚拟网络`;
  },
};
CMDS.ssh = {
  desc: '连接虚拟服务器(ssh <用户>@<主机>,密码登录)',
  run(args, { hooks }) {
    const err = hooks.beginSsh(args[0] || '');
    if (err) throw new Error(err);
    return '';
  },
};

/* ---- 文件加密 ---- */
CMDS.crypt = {
  desc: '文件加密(crypt encrypt|decrypt|islocked <文件> [密码])',
  async run(args, { resolve }) {
    const [sub, file, password] = args;
    if (!sub || !file) throw new Error('用法: crypt encrypt|decrypt|islocked <文件> [密码]');
    const p = fs.normPath(resolve(file));
    if (sub === 'encrypt') {
      if (!password) throw new Error('用法: crypt encrypt <文件> <密码>');
      const c = fs.read(p);
      if (c == null) throw new Error(`crypt: "${p}": 文件不存在`);
      if (isEncrypted(c)) throw new Error('crypt: 该文件已是加密状态');
      fs.write(p, await encryptText(c, password));
      return `已加密 🔒 ${p}`;
    }
    if (sub === 'decrypt') {
      if (!password) throw new Error('用法: crypt decrypt <文件> <密码>');
      const c = fs.read(p);
      if (c == null) throw new Error(`crypt: "${p}": 文件不存在`);
      if (!isEncrypted(c)) throw new Error('crypt: 该文件未加密');
      try {
        fs.write(p, await decryptText(c, password));
        return `已解密 ${p}`;
      } catch (e) {
        throw new Error(`crypt: ${e.message}`);
      }
    }
    if (sub === 'islocked') {
      const c = fs.read(p);
      return c == null ? '文件不存在' : isEncrypted(c) ? '🔒 已加密' : '未加密';
    }
    throw new Error(`用法: crypt encrypt|decrypt|islocked <文件> [密码](未知子命令 "${sub}")`);
  },
};

/* ---- 应用与系统(IPC 演示) ---- */
CMDS.apps = {
  desc: '列出已安装应用',
  run() {
    return listApps().map(a => `${a.id.padEnd(10)} ${a.name}${a.singleton ? '  (单实例)' : ''}`).join('\n');
  },
};
CMDS.open = {
  desc: '启动应用(open <应用ID|快捷方式>)',
  run(args, { resolve }) {
    const a = args[0];
    if (!a) throw new Error('用法: open <应用ID|快捷方式路径>');
    // .app 快捷方式:按路径解析并启动目标应用
    const p = resolve(a);
    if (fs.exists(p) && isAppLink(fs.basename(p))) {
      const app = appLinkApp(p);
      if (!app) throw new Error(`open: 快捷方式指向的应用不存在 ${p}`);
      open(app.id);
      return `已启动 ${app.name}`;
    }
    if (!listApps().some(x => x.id === a)) throw new Error(`open: 未找到应用 "${a}",试试 apps 命令`);
    open(a);
    return `已启动 ${a}`;
  },
};
CMDS.edit = {
  desc: '用记事本打开文件(edit <文件>)',
  run(args, { resolve }) {
    const p = resolve(args[0] || '');
    if (!args[0]) throw new Error('用法: edit <文件>');
    if (!fs.exists(p)) fs.write(p, '');
    open('notes', { params: { path: p } });
    return `已在记事本打开 ${p}`;
  },
};
CMDS.notify = {
  desc: '发送系统通知(notify <文本>)',
  run(args) {
    const text = args.join(' ');
    if (!text) throw new Error('用法: notify <文本>');
    publish('sys:notify', { from: 'terminal', type: 'notify', payload: { title: '终端消息', body: text } });
    return '通知已发送(可在系统监视器观察这条 IPC 消息)';
  },
};
CMDS.vol = {
  desc: '设置系统音量(vol <0-100>)',
  run(args) {
    const v = parseInt(args[0], 10);
    if (isNaN(v) || v < 0 || v > 100) throw new Error('用法: vol <0-100>');
    settings.set({ volume: v, muted: false });
    return `音量已设置为 ${v}%(托盘滑杆同步变化)`;
  },
};
CMDS.theme = {
  desc: '切换主题(theme <light|dark|auto>)',
  run(args) {
    if (!['light', 'dark', 'auto'].includes(args[0])) throw new Error('用法: theme <light|dark|auto>');
    settings.set({ theme: args[0] });
    return `主题已切换为 ${args[0]}`;
  },
};
CMDS.wallpaper = {
  desc: '更换壁纸(wallpaper <名称|URL>,无参数列出)',
  run(args) {
    const arg = args[0];
    if (!arg) {
      return `静态: ${STATIC_WALLPAPERS.map(w => w.id).join(', ')}
动态: ${DYNAMIC_WALLPAPERS.map(w => w.id).join(', ')}
或直接给图片 URL(静态)`;
    }
    if (/^https?:|^data:/.test(arg)) {
      settings.set({ wallpaperType: 'static', wallpaperStatic: 'custom', wallpaperUrl: arg });
    } else if (WALLPAPERS.some(w => w.id === arg)) {
      pickWallpaper(arg);
    } else throw new Error(`wallpaper: 未知壁纸 "${arg}"`);
    return '壁纸已更换';
  },
};
CMDS.sysinfo = {
  desc: '向监视器请求系统状态(request/response 演示)',
  async run(args, { print }) {
    print('正在向系统监视器发起请求…', 't-dim');
    const r = await request('terminal', 'monitor', 'stats', null, 2000);
    return `监视器响应: 窗口 ${r.windows} 个 · IPC 消息 ${r.messages} 条 · 开机于 ${fmtTime(new Date(r.boot))}`;
  },
};
CMDS.reboot = {
  desc: '重启系统',
  run() {
    setTimeout(() => location.reload(), 600);
    return '正在重启…';
  },
};

/* ---- 系统对话框 ---- */
CMDS.alert = {
  desc: '错误对话框演示(alert <文本>)',
  run(args) {
    if (!args.length) throw new Error('用法: alert <文本>');
    dialogs.error({ title: '系统错误', message: args.join(' '), detail: 'ERROR_DEMO (终端 alert 命令)' });
    return '已弹出系统错误对话框';
  },
};
CMDS.ask = {
  desc: '输入对话框演示(ask <问题>)',
  async run(args) {
    const v = await dialogs.prompt({ title: '终端询问', message: args.join(' ') || '请输入内容:' });
    return `输入结果: ${v === null ? '(已取消)' : v}`;
  },
};
CMDS.progress = {
  desc: '进度对话框演示(progress)',
  async run(args, { print }) {
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
    if (!ok) { clearInterval(timer); return '进度:已取消'; }
    return '';
  },
};

/* ---- shell 内建 ---- */
CMDS.history = { desc: '命令历史', run: (a, { state }) => state.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n') + '\n' };
CMDS.clear = { desc: '清屏', run: (a, { state }) => { state.clear = true; return ''; } };
CMDS.exit = { desc: '退出终端', run: (a, { state }) => { state.exit = true; return ''; } };
CMDS.logout = { desc: '退出终端(同 exit)', run: (a, { state }) => { state.exit = true; return ''; } };
CMDS.help = {
  desc: '列出可用命令',
  run() {
    return `GNU Bash (AetherWebOS) —— 可用命令:
  文件目录  ${['ls', 'cd', 'pwd', 'cat', 'mkdir', 'rm', 'touch', 'mv', 'cp', 'head', 'tail', 'grep', 'wc', 'find', 'tree'].join(' ')}
  系统      ${['whoami', 'hostname', 'uname', 'date', 'uptime', 'history', 'clear', 'exit', 'reboot'].join(' ')}
  虚拟网络  ${['nslookup', 'ping', 'curl', 'ifconfig', 'ssh'].join(' ')}
  应用与IPC ${['apps', 'open', 'edit', 'notify', 'vol', 'theme', 'wallpaper', 'sysinfo'].join(' ')}
  文件加密  crypt encrypt|decrypt|islocked <文件> [密码]
  对话框    ${['alert', 'ask', 'progress'].join(' ')}

man <命令> 查看用法;支持管道 |、重定向 > >>、引号、# 注释、Tab 补全、Ctrl+L 清屏、Ctrl+C 中断。`;
  },
};

/**
 * 创建 bash 会话(唯一 shell)。
 * print 由终端 UI 提供;hooks.beginSsh 由 UI 提供(密码掩码与远程会话
 * 是终端层状态);exit / 清屏的收尾由宿主在 runLine 之后检查 state。
 */
export function createBash({ user, history, print, hooks }) {
  const state = { cwd: '/home', user, history, clear: false, exit: false };

  const resolve = (p) => {
    if (p === '~' || p.startsWith('~/')) p = '/home' + p.slice(1);
    return fs.joinPath(state.cwd, p);
  };
  const shortCwd = () => state.cwd === '/home' ? '~' : state.cwd.replace(/^\/home/, '~');

  /** Ubuntu 风格彩色提示符(装入宿主的提示符元素) */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = text;
    return n;
  };
  function paintPrompt(promptEl) {
    promptEl.innerHTML = '';
    promptEl.append(
      el('span', 'bp-user', `${state.user}@aetherwebos`),
      el('span', '', ':'),
      el('span', 'bp-path', shortCwd()),
      el('span', '', '$ '));
  }
  const promptText = () => `${state.user}@aetherwebos:${shortCwd()}$ `;

  async function runLine(line) {
    const stages = splitPipe(line);
    let stdin = null;
    let redirected = false;
    for (let s = 0; s < stages.length; s++) {
      const { cmd, file, append } = extractRedir(stages[s]);
      const tokens = tokenize(cmd);
      if (!tokens.length) continue;
      const name = tokens[0];
      const impl = CMDS[name];
      if (!impl) { print(`bash: ${name}: command not found`, 't-err'); return; }
      const piped = stages.length > 1 || !!file;   // 处于管道中或重定向到文件
      let result;
      try {
        result = await impl.run(tokens.slice(1), { stdin, resolve, state, piped, print, hooks });
      } catch (e) {
        print(String(e.message || e), 't-err');
        return;
      }
      stdin = result;
      if (file) {
        const target = resolve(file);
        const prev = append && fs.exists(target) ? fs.read(target) : '';
        fs.write(target, (prev ?? '') + result);
        redirected = true;
      }
    }
    if (!redirected && stdin) print(String(stdin).replace(/\n$/, ''));
  }

  /* Tab 补全:命令名或当前目录文件名 */
  function complete(input) {
    const val = input.value;
    const parts = val.split(/\s+/);
    const last = parts[parts.length - 1] || '';
    let pool;
    if (parts.length <= 1) {
      pool = Object.keys(CMDS);
    } else {
      pool = (fs.list(state.cwd) || []).map(i => i.name + (i.dir ? '/' : ''));
    }
    const hits = pool.filter(n => n.startsWith(last));
    if (hits.length === 1) {
      parts[parts.length - 1] = hits[0];
      input.value = parts.join(' ') + ' ';
    } else if (hits.length > 1) {
      print(`${promptText()}${val}`, 't-cmd');
      print(hits.join('  '), 't-dim');
    }
  }

  return {
    state,
    paintPrompt,
    promptText,
    runLine,
    complete,
    banner: `GNU Bash 5.2 (AetherWebOS) —— 输入 help 查看命令,man <命令> 查看用法`,
  };
}
