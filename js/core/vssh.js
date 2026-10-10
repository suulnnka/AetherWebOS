/* ============================================================
 * VSSH —— 模拟远程终端引擎(Hacknet 式玩法核心)
 *
 * vnet.js 持有服务器注册表并做 DNS/口令检查,本模块负责连接之后的一切:
 *   · 远端文件系统:作者用嵌套对象声明(目录=对象,文件=字符串,
 *     或 { $: 内容, mode, owner } 带属性文件),连接时转成节点树
 *     { t:'d'|'f', c/d, m, o, p }(p 为 9 位 rwxr-xr-x,无类型位);
 *   · 多会话:同一 主机/用户 的活动树全局唯一(liveTrees 缓存),
 *     多个终端窗口、多重嵌套跳板看到的都是同一份实时状态;
 *   · 持久化:远端写操作记录为覆盖层(写/删/建目录三张表,顺序无关),
 *     由 vnet 注入随游戏进度落 localStorage,跨重载还原;
 *   · 常用命令:ls(-l/-a)/cat/cd/pwd/echo(支持 > >>)/mkdir/rm/mv/cp/
 *     touch/head/tail/grep/wc/find/tree/whoami/id/hostname/uname/date/
 *     uptime/ps/df/history/clear/help + 传输 get/put + 内网侦察 scan;
 *   · 脚本执行:node <文件.ajs>(读远端文件按 r 鉴权,跑本机同款
 *     AetherJS 沙盒 Worker);内建未命中的命令按内容魔数回落远端
 *     exe 直击(./x.exe / 裸名 / 绝对路径,自动解密,改名也能跑);
 *   · 权限(轻量):节点带属主与 9 位模式,root 绕过;读文件/列目录查 r,
 *     写/建/删查父目录 w(缺位报 Permission denied,可做权限谜题)。
 *
 * 自定义命令(作者在 users.<名>.commands 定义)优先于内建命令,
 * 签名 (args, session) => string[] 与旧版一致;session 上另暴露
 * readFile/writeFile/listDir/resolveP 供作者写文件类谜题机关。
 * ============================================================ */
import { fmtDate } from './utils.js';
import { runAether } from './ascript.js';
import { isExe, unpackExe } from './aexe.js';

/* ---------- 词法:与 bash.js 同规则的引号/注释(应用层不 import core 之外,这里独立实现) ---------- */
function tokenize(line) {
  const out = [];
  let cur = '', quote = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === ' ' || c === '\t') { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    if (c === '#' && !cur && !has) break;
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** 结尾的 > / >> 重定向(远端 echo/cat 等输出落盘) */
function extractRedir(line) {
  const m = /^(.*?)(>>?)\s*([^\s>]+)\s*$/.exec(line.trim());
  if (!m) return { cmd: line, file: null, append: false };
  return { cmd: m[1], file: m[3], append: m[2] === '>>' };
}

/* ---------- 远端路径 ---------- */
function joinVPath(cwd, p) {
  const abs = String(p).startsWith('/') ? p : (cwd === '/' ? '' : cwd) + '/' + p;
  const out = [];
  for (const s of abs.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return '/' + out.join('/');
}

/* ---------- 覆盖层容量护栏:超过后停记(内存态继续生效,不再落盘) ---------- */
const OVERLAY_MAX = 400 * 1024;
const overlaySize = (ov) => {
  try { return JSON.stringify(ov).length; } catch { return OVERLAY_MAX + 1; }
};

/* ============================================================
 * 作者声明树 → 节点树
 *   '文本'                  → 文件 rw-r--r--
 *   { $:'文本', mode,owner,m } → 带属性文件(mode 9 位如 'rw-------')
 *   { ... }                 → 目录 rwxr-xr-x
 * ============================================================ */
function toNodes(obj, defOwner, seed) {
  if (obj == null) return { t: 'd', m: seed(), o: defOwner, p: 'rwxr-xr-x', c: {} };
  if (typeof obj === 'string' || obj instanceof Uint8Array) {
    return { t: 'f', d: String(obj), m: seed(), o: defOwner, p: 'rw-r--r--' };
  }
  if (typeof obj.$ === 'string') {
    return {
      t: 'f', d: obj.$,
      m: typeof obj.m === 'number' ? obj.m : seed(),
      o: obj.owner || defOwner,
      p: String(obj.mode || 'rw-r--r--').padEnd(9, '-').slice(0, 9),
    };
  }
  const dir = { t: 'd', m: typeof obj.m === 'number' ? obj.m : seed(), o: obj.owner || defOwner,
    p: String(obj.mode || 'rwxr-xr-x').padEnd(9, '-').slice(0, 9), c: {} };
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'm' || k === 'owner' || k === 'mode') continue;
    dir.c[k] = toNodes(v, defOwner, seed);
  }
  return dir;
}

/* ---------- 节点树操作 ---------- */
const getNode = (root, path) => {
  let n = root;
  for (const s of path.split('/').filter(Boolean)) {
    if (n?.t !== 'd' || !(s in n.c)) return null;
    n = n.c[s];
  }
  return n;
};
const getParent = (root, path) => {
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return null;
  const name = segs.pop();
  const parent = getNode(root, '/' + segs.join('/'));
  return parent ? { parent, name, node: parent.c[name] ?? null } : null;
};

/** 在树里确保目录链存在(新建目录属 owner,模式 rwxr-xr-x) */
function ensureDir(root, path, owner, seed) {
  let n = root;
  for (const s of path.split('/').filter(Boolean)) {
    if (n.t !== 'd') return null;
    if (!n.c[s]) {
      n.c[s] = { t: 'd', m: seed(), o: owner, p: 'rwxr-xr-x', c: {} };
      n.m = seed();
    }
    n = n.c[s];
  }
  return n.t === 'd' ? n : null;
}

/* ---------- 轻量权限:root 绕过;属主段 p[0..2],其他段 p[6..8] ---------- */
const canBit = (user, node, bit) => {
  if (user === 'root') return true;
  const idx = bit === 'r' ? 0 : bit === 'w' ? 1 : 2;
  return node.o === user ? node.p[idx] !== '-' : node.p[6 + idx] !== '-';
};

/* ============================================================
 * 活动树缓存与覆盖层
 *   key = '<主机键>:<shared|u/用户>' —— 同一主机同一文件系统全局一棵,
 *   多窗口/嵌套会话实时共享;覆盖层三张表(顺序无关,幂等重放):
 *     w: { 绝对路径: 内容 }   d: { 绝对路径: 1 }   m: { 绝对路径: 1 }
 * ============================================================ */
const liveTrees = new Map();

/** 覆盖层归一(旧档无字段 / 手改坏档兜底) */
function overlaySlot(store, key) {
  if (!store.data[key] || typeof store.data[key] !== 'object') store.data[key] = { w: {}, d: {}, m: {} };
  const ov = store.data[key];
  if (!ov.w || typeof ov.w !== 'object') ov.w = {};
  if (!ov.d || typeof ov.d !== 'object') ov.d = {};
  if (!ov.m || typeof ov.m !== 'object') ov.m = {};
  return ov;
}

/** 把覆盖层重放到刚克隆的节点树上(先删后建再写,顺序无关、幂等) */
function applyOverlay(root, ov, owner, seed) {
  for (const p of Object.keys(ov.d)) {
    const par = getParent(root, p);
    if (par) delete par.parent.c[par.name];
  }
  for (const p of Object.keys(ov.m)) ensureDir(root, p, owner, seed);
  for (const [p, content] of Object.entries(ov.w)) {
    const segs = p.split('/').filter(Boolean);
    const name = segs.pop();
    const dir = ensureDir(root, '/' + segs.join('/'), owner, seed);
    if (!dir || !name) continue;
    const old = dir.c[name];
    dir.c[name] = { t: 'f', d: String(content), m: seed(), o: old?.o ?? owner, p: old?.p ?? 'rw-r--r--' };
  }
}

/** 覆盖层写操作统一入口(同时更新活动树):容量护栏满后停记,仅内存生效 */
function record(store, key, fn) {
  const ov = overlaySlot(store, key);
  if (overlaySize(ov) < OVERLAY_MAX) fn(ov);
  store.persist();
}

/** 取(或首次构建)某主机某文件系统的活动树 */
function liveTree(server, user, store) {
  const shared = !!server.fs;
  const key = `${server.__key}:${shared ? 'shared' : 'u/' + user}`;
  if (liveTrees.has(key)) return { key, root: liveTrees.get(key) };
  // 作者声明树深拷贝成节点树(共享树默认属 root,私有树属登录用户)
  const seedBase = Date.now();
  let i = 0;
  const seed = () => seedBase - ((i = (i * 31 + 17 + seedBase) % 9973) + 40) * 36e5;   // 稳定伪随机 mtime(几天前)
  const defOwner = shared ? 'root' : user;
  const u = server.users[user] || {};
  const root = toNodes(shared ? server.fs : u.fs, defOwner, seed);
  // 家目录兜底(作者没写也连得上;共享树下各用户家目录私有),
  // 且家目录属主归该用户 —— 共享树默认属 root,不改主 guest 连自己家都写不进
  const homePath = u.home || '/home/' + user;
  const homeNode = ensureDir(root, homePath, user, () => seedBase);
  if (homeNode) homeNode.o = user;
  applyOverlay(root, overlaySlot(store, key), user, seed);
  liveTrees.set(key, root);
  return { key, root };
}

/** vnet.resetState() 调用:丢弃全部活动树(覆盖层由 vnet 清空) */
export function resetLiveTrees() { liveTrees.clear(); }

/* ============================================================
 * 建立会话(vnet.sshConnect 在 DNS/口令检查通过后调用)
 * opts = { host, ip, user, dnsList, overlay:{ data, persist }, localFs }
 * overlay.data 为 vnet mutable.sshFs(引用共享,改动由 vnet 落盘)
 * ============================================================ */
export function openSession(server, opts = {}) {
  const { host, ip, user } = opts;
  const store = opts.overlay || { data: {}, persist() {} };
  const dnsList = opts.dnsList || (() => []);
  const localFs = opts.localFs;
  const u = server.users[user] || {};
  const { key: fsKey, root } = liveTree(server, user, store);

  /** 写远端文件(权限同 echo 重定向:父目录 w;覆盖已有文件还需文件 w) */
  function writeFile(abs, content, actor = user) {
    const par = getParent(root, abs);
    if (!par || par.parent.t !== 'd') return { ok: false, err: '没有那个文件或目录' };
    if (!canBit(actor, par.parent, 'w')) return { ok: false, err: '权限不够' };
    const old = par.parent.c[par.name];
    if (old && old.t === 'd') return { ok: false, err: '是一个目录' };
    if (old && !canBit(actor, old, 'w')) return { ok: false, err: '权限不够' };
    par.parent.c[par.name] = {
      t: 'f', d: String(content), m: Date.now(),
      o: old?.o ?? actor, p: old?.p ?? 'rw-r--r--',
    };
    par.parent.m = Date.now();
    record(store, fsKey, (ov) => {
      delete ov.d[abs];
      if (ov.m[abs]) delete ov.m[abs];
      ov.w[abs] = String(content);
    });
    return { ok: true };
  }

  const session = {
    user, host, ip, server,
    cwd: u.home || '/home/' + user,
    home: u.home || '/home/' + user,
    fsKey, fsRoot: root,      // fsRoot 兼容旧引用(活动树本体)
    ended: false,
    history: [],
    short() { return /^\d+\.\d+\.\d+\.\d+$/.test(this.host) ? this.host : this.host.split('.')[0]; },
    hostname() { return this.server.os?.hostname || this.short(); },
    hasCustom(cmd) { return !!u.commands?.[cmd]; },
    /* ---- 作者辅助 API(自定义命令里操作远端文件) ---- */
    resolveP(p) { return p === '~' || String(p).startsWith('~/') ? joinVPath(this.home, p.slice(1)) : joinVPath(this.cwd, p || '.'); },
    readFile(p) { const n = getNode(root, this.resolveP(p)); return n?.t === 'f' ? n.d : null; },
    writeFile(p, c) { const r = writeFile(this.resolveP(p), c, 'root'); return r.ok; },
    listDir(p) {
      const n = getNode(root, this.resolveP(p));
      return n?.t === 'd' ? Object.entries(n.c).map(([name, ch]) => ({ name, dir: ch.t === 'd', size: ch.t === 'f' ? String(ch.d ?? '').length : Object.keys(ch.c).length })) : null;
    },
    /** 上传本机文件到远端(scp 上行 / put 共用;按登录用户鉴权) */
    putFile(localAbsPath, remoteRel) {
      if (!localFs) return { ok: false, err: '本环境不支持传输' };
      const home = localFs.homePath?.() || '/home';
      let lp = String(localAbsPath).replace(/^~(?=\/|$)/, home);
      if (!lp.startsWith('/')) lp = home + '/' + lp;
      const content = localFs.read?.(lp);
      if (content == null || content instanceof Uint8Array) return { ok: false, err: `${localAbsPath}: 本机没有这个文件` };
      const abs = this.resolveP(remoteRel || String(localAbsPath).split('/').pop());
      const r = writeFile(abs, content);
      return r.ok ? { ok: true, abs } : { ok: false, err: r.err };
    },
    /** 取远端文件内容(scp 下行共用;按登录用户鉴权) */
    getFile(rel) {
      const abs = this.resolveP(rel);
      const n = getNode(root, abs);
      if (!n || n.t !== 'f') return { ok: false, err: `${rel}: 没有那个文件` };
      if (!canBit(this.user, n, 'r')) return { ok: false, err: `${rel}: 权限不够` };
      return { ok: true, abs, content: n.d ?? '' };
    },

    /** 执行一行命令(async:node/exe 走本机同款 AetherJS 沙盒 Worker,
     *  print 输出经 say 收集,回车到回显之间有 Worker 往返延迟) */
    async exec(cmdLine) {
      const { cmd, file: redirFile, append } = extractRedir(cmdLine);
      const parts = tokenize(cmd);
      const c = parts.shift();
      const out = [];
      const say = (text = '', cls = '') => out.push({ text, cls });
      if (!c) return { lines: out };
      this.history.push(String(cmdLine));

      if (c === 'exit' || c === 'logout') { this.ended = true; return { lines: out }; }
      if (c === 'clear') return { lines: [{ text: '', cls: 'clear' }] };

      // 作者自定义命令优先(谜题机关)
      const custom = u.commands?.[c];
      if (custom) {
        try { for (const line of (custom(parts, this) || [])) say(line); }
        catch (e) { say(String(e.message || e), 't-err'); }
      } else if (await this.builtin(c, parts, say) === false) {
        // 内建未命中 → 远端 exe 直击(与本地终端同款:内容魔数识别,与名字无关)
        const node = getNode(root, this.resolveP(c));
        const looksPath = c.includes('/') || /\.exe$/i.test(c);
        if (node?.t === 'f' && canBit(this.user, node, 'r')) {
          if (isExe(node.d ?? '')) {
            let src = null;
            try { src = await unpackExe(node.d ?? ''); }   // 自动解密(密钥混淆携带在文件内)
            catch (e) { say(`bash: ${c}: ${e.message}`, 't-err'); }
            if (src != null) {
              const r = await runAether(src, { print: (t) => say(t) });
              if (!r.ok) {
                const pos = r.error.line != null
                  ? `(${c}:${r.error.line}${r.error.col != null ? ':' + r.error.col : ''})` : '';
                say(`exe: 脚本执行失败 —— ${r.error.kind}: ${r.error.message} ${pos}`.trim(), 't-err');
              }
            }
          } else if (looksPath) {
            say(`bash: ${c}: 不是可执行文件(AEXE 打包的 exe 才能直接运行)`, 't-err');
          } else {
            say(`${c}: 未找到命令。输入 help 查看可用命令`, 't-err');
          }
        } else if (node?.t === 'f') {
          say(`bash: ${c}: 权限不够`, 't-err');
        } else if (looksPath) {
          say(`bash: ${c}: 没有那个文件或目录`, 't-err');
        } else {
          say(`${c}: 未找到命令。输入 help 查看可用命令`, 't-err');
        }
      }

      // 重定向:输出落远端文件(不回显)
      if (redirFile) {
        const text = out.map(l => l.text).join('\n');
        const abs = this.resolveP(redirFile);
        const prev = append ? (getNode(root, abs)?.t === 'f' ? getNode(root, abs).d : '') : '';
        const r = writeFile(abs, (prev ? prev + '\n' : '') + text);
        if (!r.ok) return { lines: [{ text: `${c}: ${redirFile}: ${r.err}`, cls: 't-err' }] };
        return { lines: [] };
      }
      return { lines: out };
    },

    /** 内建命令实现(say 输出一行;say(text, cls) 带样式)。
     *  未命中返回 false(exec 据此回落远端 exe 直击),其余返回 undefined。 */
    async builtin(c, args, say) {
      const P = (p) => this.resolveP(p);
      const N = (p) => getNode(root, P(p));
      const err = (msg) => say(msg, 't-err');

      switch (c) {
        case 'help': {
          const customs = Object.keys(u.commands || {});
          say(`可用命令:ls [-l|-a]  cat  cd  pwd  echo [> >>]  mkdir  rm  mv  cp  touch  head  tail  grep  wc  find  tree`, 't-dim');
          say(`          whoami  id  hostname  uname  date  uptime  ps  df  history  clear  scan`, 't-dim');
          say(`脚本    node <文件.ajs> | node -e <代码>(AetherJS 沙盒);./程序.exe 直接执行(AEXE 密文可执行文件)`, 't-dim');
          say(`传输:get <远端> [本地名]   put <本机> [远端名];跳板:ssh <用户>@<主机>;断开:exit`, 't-dim');
          if (customs.length) say(`本机扩展命令:${customs.join('  ')}`, 't-dim');
          break;
        }
        case 'ls': {
          const flags = args.filter(a => a.startsWith('-')).join('');
          const long = flags.includes('l'), all = flags.includes('a');
          const target = args.find(a => !a.startsWith('-')) || '.';
          const n = N(target);
          if (!n) return err(`ls: 无法访问 ${target}: 没有那个文件或目录`);
          if (!canBit(this.user, n, 'r')) return err(`ls: 无法打开目录 ${target}: 权限不够`);
          if (n.t === 'f') return say(target.split('/').pop());
          const shown = Object.entries(n.c)
            .filter(([name]) => all || !name.startsWith('.'))
            .sort((a, b) => (a[1].t === 'd') - (b[1].t === 'd') || a[0].localeCompare(b[0], 'zh'));
          if (!shown.length) return;
          if (long) {
            for (const [name, ch] of shown) {
              const mode = (ch.t === 'd' ? 'd' : '-') + ch.p;
              const size = ch.t === 'f' ? String(ch.d ?? '').length : Object.keys(ch.c).length * 64 + 4096;
              const dt = new Date(ch.m);
              say(`${mode}  1 ${ch.o} ${ch.o} ${String(size).padStart(6)} ${fmtDate(dt)} ${name}${ch.t === 'd' ? '/' : ''}`);
            }
          } else {
            say(shown.map(([name, ch]) => name + (ch.t === 'd' ? '/' : '')).join('  '));
          }
          break;
        }
        case 'cat': {
          if (!args.length) return err('用法: cat <文件…>');
          for (const p of args) {
            const n = N(p);
            if (!n) err(`cat: ${p}: 没有那个文件或目录`);
            else if (n.t === 'd') err(`cat: ${p}: 是一个目录`);
            else if (!canBit(this.user, n, 'r')) err(`cat: ${p}: 权限不够`);
            else say(n.d ?? '');
          }
          break;
        }
        case 'cd': {
          const target = args[0] ? P(args[0]) : this.home;
          const n = getNode(root, target);
          if (!n || n.t !== 'd') err(`cd: ${args[0] || target}: 没有那个目录`);
          else if (!canBit(this.user, n, 'r')) err(`cd: ${args[0]}: 权限不够`);
          else this.cwd = target;
          break;
        }
        case 'pwd': say(this.cwd); break;
        case 'echo': {
          let nl = true;
          const rest = [...args];
          if (rest[0] === '-n') { nl = false; rest.shift(); }
          say(rest.join(' ') + (nl ? '' : ''));
          break;
        }
        case 'mkdir': {
          const rec = args.some(a => a.startsWith('-') && a.includes('p'));
          const p = args.find(a => !a.startsWith('-'));
          if (!p) return err('用法: mkdir [-p] <目录>');
          const abs = P(p);
          if (getNode(root, abs)) return err(`mkdir: 无法创建目录 "${p}": 文件已存在`);
          // 找最深已存在祖先逐级鉴权(depth=0 即根;无 -p 时父目录必须已存在)
          const segs = abs.split('/').filter(Boolean);
          let depth = segs.length, ancestor = null;
          while (depth >= 0) {
            ancestor = depth === 0 ? root : getNode(root, '/' + segs.slice(0, depth).join('/'));
            if (ancestor) break;
            depth--;
          }
          if (!ancestor || ancestor.t !== 'd') return err(`mkdir: 无法创建目录 "${p}": 没有那个文件或目录`);
          if (depth !== segs.length - 1 && !rec) return err(`mkdir: 无法创建目录 "${p}": 没有那个文件或目录`);
          if (!canBit(this.user, ancestor, 'w')) return err(`mkdir: 无法创建目录 "${p}": 权限不够`);
          ensureDir(root, abs, this.user, () => Date.now());
          record(store, fsKey, (ov) => {
            delete ov.d[abs];
            if (ov.w[abs]) delete ov.w[abs];
            ov.m[abs] = 1;
          });
          break;
        }
        case 'rm': {
          const rec = args.some(a => a.startsWith('-') && a.includes('r'));
          const p = args.find(a => !a.startsWith('-'));
          if (!p) return err('用法: rm [-r] <路径>');
          const abs = P(p);
          if (abs === '/') return err('rm: 拒绝删除根目录');
          const par = getParent(root, abs);
          if (!par || !par.node) return err(`rm: 无法删除 "${p}": 没有那个文件或目录`);
          if (par.node.t === 'd' && !rec) return err(`rm: 无法删除 "${p}": 是一个目录(使用 -r)`);
          if (!canBit(this.user, par.parent, 'w')) return err(`rm: 无法删除 "${p}": 权限不够`);
          delete par.parent.c[par.name];
          par.parent.m = Date.now();
          record(store, fsKey, (ov) => { delete ov.w[abs]; delete ov.m[abs]; ov.d[abs] = 1; });
          break;
        }
        case 'mv': case 'cp': {
          if (args.length < 2) return err(`用法: ${c} <源> <目标>`);
          const srcAbs = P(args[0]);
          const sn = getNode(root, srcAbs);
          if (!sn) return err(`${c}: 无法统计 "${args[0]}": 没有那个文件或目录`);
          if (c === 'cp' && sn.t === 'd') return err(`cp: 略过目录 ${args[0]}`);
          let dstAbs = P(args[1]);
          const dn = getNode(root, dstAbs);
          if (dn?.t === 'd') dstAbs = joinVPath(dstAbs, args[0].split('/').filter(Boolean).pop());
          const r = writeFile(dstAbs, sn.d ?? '');
          if (!r.ok) return err(`${c}: 无法创建 "${args[1]}": ${r.err}`);
          if (c === 'mv') {
            const par = getParent(root, srcAbs);
            if (par && canBit(this.user, par.parent, 'w')) {
              delete par.parent.c[par.name];
              record(store, fsKey, (ov) => { delete ov.w[srcAbs]; delete ov.m[srcAbs]; ov.d[srcAbs] = 1; });
            } else return err(`mv: 无法移动 "${args[0]}": 权限不够`);
          }
          break;
        }
        case 'touch': {
          if (!args[0]) return err('用法: touch <文件>');
          const n = N(args[0]);
          if (n) { n.m = Date.now(); break; }
          const r = writeFile(P(args[0]), '');
          if (!r.ok) err(`touch: 无法创建 ${args[0]}: ${r.err}`);
          break;
        }
        case 'head': case 'tail': {
          const n = Number(args[args.indexOf('-n') + 1]) || 10;
          const file = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');
          const node = file != null ? N(file) : null;
          if (file != null && !node) return err(`${c}: 无法打开 ${file}`);
          const lines = String(node ? node.d : '').replace(/\n$/, '').split('\n');
          say((c === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n'));
          break;
        }
        case 'grep': {
          const flags = args.filter(a => a.startsWith('-')).join('');
          const rest = args.filter(a => !a.startsWith('-'));
          const pattern = rest.shift();
          if (!pattern) return err('用法: grep [-i] [-n] <模式> [文件]');
          const node = rest[0] != null ? N(rest[0]) : null;
          if (rest[0] != null && (!node || node.t !== 'f')) return err(`grep: ${rest[0]}: 没有那个文件`);
          if (node && !canBit(this.user, node, 'r')) return err(`grep: ${rest[0]}: 权限不够`);
          const rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.includes('i') ? 'i' : '');
          const hits = String(node ? node.d : '').replace(/\n$/, '').split('\n')
            .map((l, i) => (rx.test(l) ? (flags.includes('n') ? `${i + 1}:${l}` : l) : null))
            .filter(Boolean);
          if (hits.length) say(hits.join('\n'));
          break;
        }
        case 'wc': {
          const flags = args.filter(a => a.startsWith('-')).join('');
          const file = args.find(a => !a.startsWith('-'));
          const node = file != null ? N(file) : null;
          if (file != null && !node) return err(`wc: ${file}: 没有那个文件`);
          const text = String(node ? node.d : '');
          const body = text.replace(/\n$/, '');
          const lines = body === '' ? 0 : body.split('\n').length;
          const words = text.trim() ? text.trim().split(/\s+/).length : 0;
          if (flags.includes('l')) say(String(lines));
          else if (flags.includes('w')) say(String(words));
          else if (flags.includes('c')) say(String(text.length));
          else say(`${String(lines).padStart(4)} ${String(words).padStart(4)} ${String(text.length).padStart(4)}${file ? ' ' + file : ''}`);
          break;
        }
        case 'find': {
          const ni = args.indexOf('-name');
          const pattern = ni >= 0 ? args[ni + 1] : null;
          const start = P(args.find((a, i) => !a.startsWith('-') && i !== ni + 1) || '.');
          const rx = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
          const acc = [];
          (function walk(n, p) {
            if (!n || n.t !== 'd') return;
            for (const [name, ch] of Object.entries(n.c)) {
              const cp = p === '/' ? '/' + name : p + '/' + name;
              if (!rx || rx.test(name)) acc.push(cp);
              if (ch.t === 'd') walk(ch, cp);
            }
          })(getNode(root, start), start);
          if (acc.length) say(acc.join('\n'));
          break;
        }
        case 'tree': {
          const start = P(args[0] || '.');
          const startNode = getNode(root, start);
          if (!startNode || startNode.t !== 'd') return err(`tree: ${args[0] || '.'}: 不是一个目录`);
          const acc = [start];
          (function walk(n, p, prefix) {
            const items = Object.entries(n.c).filter(([name]) => !name.startsWith('.'))
              .sort((a, b) => (a[1].t === 'd') - (b[1].t === 'd') || a[0].localeCompare(b[0], 'zh'));
            items.forEach(([name, ch], i) => {
              const last = i === items.length - 1;
              acc.push(prefix + (last ? '└─ ' : '├─ ') + name + (ch.t === 'd' ? '/' : ''));
              if (ch.t === 'd') walk(ch, p + '/' + name, prefix + (last ? '   ' : '│  '));
            });
          })(startNode, start, '');
          say(acc.join('\n'));
          break;
        }
        case 'whoami': say(this.user); break;
        case 'id': {
          const isRoot = this.user === 'root';
          say(`uid=${isRoot ? 0 : 1000 + (this.user.length % 500)}(${this.user}) gid=100(users) groups=100(users)${isRoot ? ',0(root)' : ''}`);
          break;
        }
        case 'hostname': say(this.hostname()); break;
        case 'uname': {
          const os = this.server.os || {};
          say(args.includes('-a')
            ? `Linux ${this.hostname()} ${os.kernel || '5.15.0-nexus'} #1 SMP x86_64 GNU/Linux`
            : 'Linux');
          break;
        }
        case 'date': say(new Date().toString()); break;
        case 'uptime': {
          const up = this.server.os?.uptime || '14 天';
          say(` ${new Date().toTimeString().slice(0, 5)} up ${up}, 1 user, load average: 0.31, 0.24, 0.18`);
          break;
        }
        case 'ps': {
          say('  PID TTY          TIME CMD');
          say('    1 ?        00:00:04 systemd');
          say('   42 ?        00:00:12 sshd');
          say(`  311 pts/0    00:00:00 sshd: ${this.user}@pts/0`);
          say(`  312 pts/0    00:00:00 -bash`);
          break;
        }
        case 'df': {
          const files = (function count(n) {
            if (n.t === 'f') return 1;
            return Object.values(n.c).reduce((s, ch) => s + count(ch), 0);
          })(root);
          const used = 4 + Math.round(files * 1.7) % 20;
          say('文件系统        1K-块     已用     可用 已用% 挂载点');
          say(`/dev/nexus0  20961280 ${String(used * 1024).padStart(8)} ${String((20 - used) * 1024).padStart(8)}   ${String(Math.round(used / 20 * 100)).padStart(2)}% /`);
          break;
        }
        case 'history':
          this.history.forEach((h, i) => say(`${String(i + 1).padStart(4)}  ${h}`));
          break;
        case 'scan': {
          const rows = dnsList().map(r => `${r.ip.padEnd(12)} ${r.host.padEnd(20)} ${r.note}`);
          if (rows.length) say(rows.join('\n')); else say('(内网无可公开主机)', 't-dim');
          say('提示:ping/nslookup/curl 请回本机执行;跳板连接用 ssh <用户>@<主机>', 't-dim');
          break;
        }
        case 'get': case 'download': {
          if (!localFs) return err('get: 本环境不支持下载');
          if (!args[0]) return err('用法: get <远程文件> [本地名]');
          const g = this.getFile(args[0]);
          if (!g.ok) return err(`get: ${g.err}`);
          const local = (localFs.homePath?.() || '/home') + '/downloads/' + (args[1] || String(args[0]).split('/').pop());
          if (!localFs.write(local, g.content)) return err('get: 下载失败(无写入权限)');
          say(`已下载 → ${local}`, 't-ok');
          break;
        }
        case 'put': case 'upload': {
          if (!args[0]) return err('用法: put <本机文件> [远端名]');
          const p = this.putFile(args[0], args[1]);
          if (!p.ok) return err(`put: ${p.err}`);
          say(`已上传 → ${p.abs}`, 't-ok');
          break;
        }
        case 'ssh':
          err('ssh 请直接输入:ssh <用户名>@<主机>(在远程会话里输入即从本机跳板)', 't-dim');
          break;
        /* 远端 node:读远端文件(按 r 鉴权)跑本机同款沙盒 Worker;
         * 输出语义与本地 node 一致:print 直写,程序值不回显 */
        case 'node': {
          if (args[0] === '-v' || args[0] === '--version') {
            say('AetherJS v0.2(JS 安全子集,AetherWebFramework 运行时;help node 查看用法)');
            break;
          }
          let source, name;
          if (args[0] === '-e') {
            source = args.slice(1).join(' ');
            name = '<inline>';
            if (!source) return err('用法: node -e <代码>');
          } else {
            if (!args[0]) return err('用法: node <文件.ajs> | node -e <代码> | node -v');
            const n = N(args[0]);
            if (!n || n.t !== 'f') return err(`node: 无法加载 ${args[0]}:没有那个文件或目录`);
            if (!canBit(this.user, n, 'r')) return err(`node: ${args[0]}: 权限不够`);
            source = String(n.d ?? '');
            name = args[0];
          }
          const r = await runAether(source, { print: (t) => say(t) });
          if (!r.ok) {
            const pos = r.error.line != null
              ? `(${name}:${r.error.line}${r.error.col != null ? ':' + r.error.col : ''})` : '';
            err(`node: 脚本执行失败 —— ${r.error.kind}: ${r.error.message} ${pos}`.trim());
          }
          break;
        }
        default:
          return false;   // 未命中:交回 exec 回落远端 exe 直击
      }
    },

    /** Tab 补全:首词补命令名,其余补当前目录条目 */
    complete(line) {
      const parts = line.split(/\s+/);
      const last = parts[parts.length - 1] || '';
      if (parts.length <= 1 && !line.endsWith(' ')) {
        const pool = ['cat', 'cd', 'clear', 'cp', 'date', 'df', 'download', 'echo', 'exit', 'find', 'get',
          'grep', 'head', 'help', 'history', 'hostname', 'id', 'logout', 'ls', 'mkdir', 'mv', 'node', 'ps', 'pwd', 'put',
          'rm', 'scan', 'tail', 'touch', 'tree', 'uname', 'uptime', 'upload', 'wc', 'whoami',
          ...Object.keys(u.commands || {})];
        return pool.filter(n => n.startsWith(last)).sort();
      }
      const dir = getNode(root, this.cwd);
      if (!dir) return [];
      const prefix = last.includes('/') ? last.slice(0, last.lastIndexOf('/') + 1) : '';
      const baseDir = getNode(root, joinVPath(this.cwd, prefix || '.'));
      if (!baseDir || baseDir.t !== 'd') return [];
      const frag = last.slice(prefix.length);
      return Object.entries(baseDir.c)
        .filter(([name]) => name.startsWith(frag))
        .map(([name, ch]) => prefix + name + (ch.t === 'd' ? '/' : ''))
        .sort();
    },
  };
  return session;
}
