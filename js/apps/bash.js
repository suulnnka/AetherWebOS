/* ============================================================
 * 应用:Bash 终端 —— 仅允许白名单内 Linux/Bash 指令
 *
 * 与「终端」(WebOS 命令行)不同,这个终端模拟一个受限 bash:
 *  - 只有 ALLOWED 中列出的命令可用,其余一律
 *    `bash: xxx: command not found`(网络类命令全部禁用);
 *  - 支持管道(|)、输出重定向(> >>)、引号、# 注释;
 *  - 操作本地虚拟文件系统(文件管家/记事本实时联动);
 *  - Tab 补全命令与文件名,Ctrl+L 清屏,Ctrl+C 中断行。
 * ============================================================ */
import { el, fmtDate } from '../core/utils.js';
import { register } from '../core/registry.js';
import fs from '../core/fs.js';
import { settings } from '../core/store.js';

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

/* ---------- 白名单命令实现 ----------
   每个命令: run(args, io) → string(stdout)
   io = { stdin, cwd(引用,可变), resolve(p), state }        */
const CMDS = {};

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
CMDS.hostname = { desc: '主机名', run: () => 'webos' };
CMDS.uname = { desc: '系统信息(uname -a)', run: (args) => args.includes('-a') ? 'Linux webos 6.1.0-webos #1 SMP x86_64 GNU/Linux' : 'Linux' };
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
CMDS.which = {
  desc: '命令位置(which <命令>)',
  run(args) {
    if (!args[0]) throw new Error('which: 缺少参数');
    if (!CMDS[args[0]]) throw new Error(`${args[0]} 不在允许的命令列表中`);
    return `/usr/bin/${args[0]}\n`;
  },
};
CMDS.man = {
  desc: '命令手册(man <命令>)',
  run(args) {
    const c = CMDS[args[0]];
    if (!c) throw new Error(`没有 ${args[0]} 的手册页。输入 help 查看全部命令`);
    return `${args[0].toUpperCase()}(1)\n\n  ${c.desc}\n`;
  },
};
CMDS.history = { desc: '命令历史', run: (a, { state }) => state.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n') + '\n' };
CMDS.clear = { desc: '清屏', run: (a, { state }) => { state.clear = true; return ''; } };
CMDS.help = {
  desc: '列出允许的命令',
  run() {
    return `受限 Bash —— 仅允许以下 ${Object.keys(CMDS).length} 个命令:
  ${Object.entries(CMDS).map(([n, c]) => `${n.padEnd(9)}${c.desc}`).join('\n  ')}

支持:管道 |、重定向 > >>、引号、# 注释、Tab 补全、Ctrl+L 清屏。
网络命令(curl/ssh/ping 等)与本终端不可用 —— 请使用「终端」。`;
  },
};

register({
  id: 'bash',
  name: 'Bash 终端',
  icon: 'terminal',
  color: 'linear-gradient(135deg,#166534,#052e16)',
  neon: { a: '#22c55e', b: '#a3e635' },
  width: 700, height: 460,
  min: { w: 420, h: 260 },
  singleton: false,
  order: 3.5,
  mount({ root, settings: _s, close }) {
    const state = {
      cwd: '/home',
      user: settings.get('username'),
      history: [],
      hIdx: 0,
    };

    const out = el('div', { class: 'term-out' });
    const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const promptEl = el('span', { class: 't-prompt' });

    const resolve = (p) => {
      if (p === '~' || p.startsWith('~/')) p = '/home' + p.slice(1);
      return fs.joinPath(state.cwd, p);
    };
    const shortCwd = () => state.cwd === '/home' ? '~' : state.cwd.replace(/^\/home/, '~');

    function paintPrompt() {
      promptEl.innerHTML = '';
      promptEl.append(
        el('span', { class: 'bp-user' }, `${state.user}@webos`),
        el('span', {}, ':'),
        el('span', { class: 'bp-path' }, shortCwd()),
        el('span', {}, '$ '));
    }

    function print(text = '', cls = '') {
      for (const line of String(text).replace(/\n$/, '').split('\n')) {
        out.append(el('div', { class: cls }, line));
      }
      out.scrollTop = out.scrollHeight;
    }

    function runLine(line) {
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
          result = impl.run(tokens.slice(1), { stdin, resolve, state, piped });
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
      if (!redirected && stdin) print(stdin);
    }

    /* Tab 补全:命令名或当前目录文件名 */
    function complete() {
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
        print(`${promptEl.textContent}${val}`, 't-cmd');
        print(hits.join('  '), 't-dim');
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const line = input.value;
        print(`${promptEl.textContent}${line}`, 't-cmd');
        input.value = '';
        if (line.trim()) { state.history.push(line); state.hIdx = state.history.length; }
        if (line.trim() === 'exit' || line.trim() === 'logout') { print('logout'); close(); return; }
        runLine(line);
        if (state.clear) { out.innerHTML = ''; state.clear = false; }
        paintPrompt();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (state.hIdx > 0) input.value = state.history[--state.hIdx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (state.hIdx < state.history.length) input.value = state.history[++state.hIdx] || '';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        complete();
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        out.innerHTML = '';
      } else if (e.key === 'c' && e.ctrlKey) {
        e.preventDefault();
        print(`${promptEl.textContent}${input.value}^C`, 't-dim');
        input.value = '';
      }
    });

    paintPrompt();
    print(`GNU Bash 5.2 (WebOS 受限环境) —— 输入 help 查看允许的命令`, 't-dim');
    print(`此终端仅限本地文件操作;网络命令请使用「终端」。`, 't-dim');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'term bash', onPointerdown: () => input.focus() },
        out,
        el('div', { class: 'term-in' }, promptEl, input))));

    setTimeout(() => input.focus(), 80);
  },
});
