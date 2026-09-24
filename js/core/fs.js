/* ============================================================
 * FS —— 虚拟文件系统 v2(持久化到 localStorage)
 *
 * 存储结构(根节点带版本号 v:2;版本不符 → 清空全部本地数据):
 *   根:   { v:2, t:'d', c:{...}, m:<mtime>, o:'root', p:'rwxr-x' }
 *   目录: { t:'d', c:{ <名称>: <node> }, m, o:<owner>, p:<mode> }
 *   文件: { t:'f', d:'<内容>', m, o:<owner>, p:<mode> }
 *
 * 用户与目录绑定:
 *   /bin /app          系统目录(root 所有,预留给系统程序/应用包)
 *   /home/<user>/...   每个登录用户的家目录(含 desktop/documents/…)
 *
 * 权限(类 Linux,但无用户组):
 *   p 为 6 位 "rwxrwx":前 3 位属主,后 3 位其他用户;
 *   root 超级用户绕过全部检查。ls 显示时补成 9 位(组位=其他位)。
 *
 * 当前会话用户来自 accounts.current();未登录时仅允许 root 内部操作
 * (as:'root')。所有写操作自动持久化并广播 sys:fs-changed。
 * ============================================================ */

import { publish, subscribe } from './bus.js';
import { debounce } from './utils.js';
import { storageWiped, markStorageWiped } from './store.js';
import { accounts } from './accounts.js';

const KEY = 'webos.fs.v2';
const LEGACY_KEYS = ['webos.fs.v1'];
const FS_VERSION = 2;

const WELCOME = `欢迎使用 AetherWebOS!

这是一个纯前端的网页操作系统。
所有数据都保存在你浏览器的 localStorage 中,无需任何后端。

文件系统 v2:
 · 每个用户绑定 /home/<用户名> 家目录
 · 文件带属主与权限(类 Linux,无用户组)
 · 系统目录 /bin /app 预留给系统程序

推荐试一试:
 · 双击桌面图标,或点击左下角的开始按钮
 · 打开「终端」,输入 help 查看全部命令
 · ls -l 查看权限,chmod 修改权限
 · 在「系统设置 → 外观」更换主题、强调色与壁纸

快捷操作:
 · 双击窗口标题栏 = 最大化 / 还原
 · 拖动窗口边缘可调整大小
 · 桌面空白处右键 = 快捷菜单
 · 记事本内 Ctrl+S 保存

祝你玩得愉快!
`;

const DESKTOP_NOTE = `桌面便签

这里就是你的桌面目录(~/desktop)。
试试:
 · 桌面空白处右键 → 新建文本文档 / 新建文件夹
 · 拖动图标(自动对齐网格)、空白处拖框多选
 · 选中文件后:F2 重命名、Delete 删除、Enter 打开
 · 右键开始菜单或任务栏里的应用 → 固定到任务栏
`;

const DEVGUIDE = `# AetherWebOS 应用开发速览

## 1. 定义应用清单并注册

import { register } from '../core/registry.js';

register({
  id: 'hello',                    // 唯一 ID
  name: '你好世界',
  icon: 'message',                // icons.js 中的图标名
  color: 'linear-gradient(135deg,#06b6d4,#3b82f6)', // 磁贴背景
  width: 520, height: 380,        // 初始尺寸
  min: { w: 380, h: 280 },        // 最小尺寸
  singleton: true,                // 是否只允许开一个
  resizable: true,
  desktop: true,                  // 是否显示在桌面
  mount(ctx) { ... },             // 挂载函数(必须)
});

## 2. mount(ctx) 挂载上下文

ctx.root     挂载根元素(写你的 DOM 到这里)
ctx.bus      本应用的消息总线(见下)
ctx.params   打开窗口时传入的参数
ctx.fs / ctx.settings   文件系统与设置
ctx.setTitle(t) / ctx.close()
返回 { onClose, onResize, onParams } 钩子(可选)。

## 3. 布局:直接用 AppKit 类

.app > .app-toolbar / .app-mid(.app-side + .app-body) / .app-status
组件:.btn .input .field .switch .seg .card .list .table .modal-mask ...

## 4. 应用间通信(IPC)

ctx.bus.on('hello', (payload, msg) => msg.reply(data))
ctx.bus.send('files', 'refresh', { path: '/home' })
ctx.bus.request('monitor', 'stats').then(data => ...)
ctx.bus.broadcast('hello-all')
ctx.bus.notify('标题', '内容')
ctx.bus.onSys('fs-changed', payload => ...)
`;

/* 默认权限:目录 rwxr-x / 文件 rw-r--(6 位:属主 + 其他) */
const DIR_MODE = 'rwxr-x';
const FILE_MODE = 'rw-r--';
const HOME_MODE = 'rwx------';

/** 版本不符 / 结构损坏 → 清空浏览器内全部 WebOS 数据并重载(不做兼容迁移) */
function wipeAllAndReload() {
  markStorageWiped();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch { /* 忽略 */ }
  location.reload();
}

function detectStale() {
  // 已有 v2 但结构/版本不对
  const raw = localStorage.getItem(KEY);
  if (raw) {
    try {
      const d = JSON.parse(raw);
      return !(d && d.v === FS_VERSION && d.t === 'd' && d.c && typeof d.c === 'object');
    } catch { return true; }
  }
  // 无 v2:存在旧版 FS 键 → 旧数据,直接清空
  return LEGACY_KEYS.some(k => localStorage.getItem(k) != null);
}

function freshRoot() {
  const now = Date.now();
  return {
    v: FS_VERSION, t: 'd', m: now, o: 'root', p: DIR_MODE,
    c: {
      bin: { t: 'd', m: now, o: 'root', p: 'r-xr-x', c: {} },
      app: { t: 'd', m: now, o: 'root', p: 'r-xr-x', c: {} },
      home: { t: 'd', m: now, o: 'root', p: DIR_MODE, c: {} },
    },
  };
}

function load() {
  if (detectStale()) { wipeAllAndReload(); return null; }
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const tree = JSON.parse(raw);
    return tree?.t === 'd' && tree.v === FS_VERSION ? tree : null;
  } catch { return null; }
}

let root = load() || freshRoot();

const persist = debounce(() => {
  if (storageWiped()) return;   // 完全重置后不再写盘,防止 reload 前防抖定时器把旧数据写回
  try { localStorage.setItem(KEY, JSON.stringify(root)); }
  catch (e) {
    console.warn('[fs] 持久化失败:', e);
    publish('sys:notify', { from: 'fs', type: 'notify', payload: { title: '存储空间不足', body: '文件未能保存,请清理数据。' } });
  }
}, 250);

/* ---------- 路径工具 ---------- */
export function normPath(p) {
  const out = [];
  for (const seg of String(p || '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}
export const basename = (p) => normPath(p).split('/').filter(Boolean).pop() || '/';
export const parentPath = (p) => {
  const segs = normPath(p).split('/').filter(Boolean);
  segs.pop();
  return '/' + segs.join('/');
};
export const joinPath = (a, b) =>
  normPath(String(b).startsWith('/') ? b : (normPath(a) === '/' ? '' : normPath(a)) + '/' + b);

/** 当前用户的家目录 /home/<user>(未登录返回 null) */
export function homePath(user = accounts.current()) {
  return user ? `/home/${user}` : null;
}
/** 当前用户的桌面目录(桌面即此目录) */
export function desktopPath(user = accounts.current()) {
  const h = homePath(user);
  return h ? `${h}/desktop` : null;
}

function node(p) {
  let n = root;
  for (const seg of normPath(p).split('/').filter(Boolean)) {
    if (n.t !== 'd') return null;
    n = n.c[seg];
    if (!n) return null;
  }
  return n;
}

function emit(action, path) {
  persist();
  publish('sys:fs-changed', { from: 'fs', type: 'fs-changed', payload: { action, path: normPath(path) } });
}

/* ---------- 权限 ---------- */
/** 解析 6 位模式 → 属主/其他 的 {r,w,x} */
function modeFor(n, user) {
  const full = String(n.p || FILE_MODE).padEnd(6, '-').slice(0, 6);
  if (user === 'root') return { r: true, w: true, x: true };
  const owner = user && n.o === user;
  const chunk = owner ? full.slice(0, 3) : full.slice(3, 6);
  return { r: chunk[0] === 'r', w: chunk[1] === 'w', x: chunk[2] === 'x' };
}

/**
 * 是否允许对 path 做 r/w/x。
 * 规则(无用户组):祖先目录逐级需 x;目标节点查属主位或"其他"位。
 * bit 为 'r'|'w'|'x';祖先穿越不额外要求 r。
 */
function allow(p, bit, user) {
  if (!user) return false;
  if (user === 'root') return true;
  const segs = normPath(p).split('/').filter(Boolean);
  if (!segs.length) return modeFor(root, user)[bit] === true;
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur.t !== 'd' || !modeFor(cur, user).x) return false;
    cur = cur.c[segs[i]];
    if (!cur) return false;
  }
  if (cur.t !== 'd' || !modeFor(cur, user).x) return false;
  const target = cur.c[segs[segs.length - 1]];
  if (!target) return false;
  return modeFor(target, user)[bit] === true;
}

/** 内部解析当前操作身份:显式 as > 会话用户 */
function actor(opts) {
  if (opts?.as) return opts.as;
  return accounts.current();
}

/** 内部建节点(带属主/权限) */
function makeNode(kind, owner, mode) {
  const m = Date.now();
  return kind === 'd'
    ? { t: 'd', c: {}, m, o: owner || 'root', p: mode || DIR_MODE }
    : { t: 'f', d: '', m, o: owner || actor() || 'root', p: mode || FILE_MODE };
}

/* ---------- 用户家目录 ---------- */
/**
 * 确保 /home/<user> 存在(幂等)。由登录/注册触发。
 * 权限:家目录 700(仅本人),其下标准子目录继承属主。
 */
export function ensureUserHome(user) {
  if (!user || user === 'root') return false;
  const home = `/home/${user}`;
  const existing = node(home);
  if (existing) {
    existing.o = user;
    if (existing.p !== HOME_MODE) existing.p = HOME_MODE;
  } else {
    // 沿途创建:仅 /home 下新建
    const homeDir = node('/home');
    if (!homeDir || homeDir.t !== 'd') return false;
    homeDir.c[user] = makeNode('d', user, HOME_MODE);
    homeDir.m = Date.now();
  }
  const seed = (name, content) => {
    const p = joinPath(home, name);
    if (!node(p)) {
      const par = node(home);
      if (name === 'desktop' || name === 'documents' || name === 'pictures' || name === 'music' || name === 'downloads') {
        par.c[name] = makeNode('d', user, DIR_MODE);
      } else {
        const f = makeNode('f', user, FILE_MODE);
        f.d = content ?? '';
        par.c[name] = f;
      }
      par.m = Date.now();
    }
  };
  seed('desktop');
  seed('documents');
  seed('pictures');
  seed('music');
  seed('downloads');
  const deskNote = joinPath(home, 'desktop/桌面便签.txt');
  if (!node(deskNote)) {
    const d = node(joinPath(home, 'desktop'));
    const f = makeNode('f', user, FILE_MODE);
    f.d = DESKTOP_NOTE;
    d.c['桌面便签.txt'] = f;
    d.m = Date.now();
  }
  const welcome = joinPath(home, 'documents/欢迎使用.txt');
  if (!node(welcome)) {
    const d = node(joinPath(home, 'documents'));
    const f = makeNode('f', user, FILE_MODE);
    f.d = WELCOME;
    d.c['欢迎使用.txt'] = f;
    d.m = Date.now();
  }
  const guide = joinPath(home, 'documents/应用开发指南.md');
  if (!node(guide)) {
    const d = node(joinPath(home, 'documents'));
    const f = makeNode('f', user, FILE_MODE);
    f.d = DEVGUIDE;
    d.c['应用开发指南.md'] = f;
    d.m = Date.now();
  }
  emit('ensure-home', home);
  return true;
}

/* 登录 / 注册 / 系统建号 → 自动准备家目录 */
subscribe('accounts:changed', (payload, msg) => {
  const t = msg?.type;
  const u = payload?.user || accounts.current();
  if ((t === 'login' || t === 'created' || t === 'register') && u) ensureUserHome(u);
});

/* ---------- 文件系统 API ---------- */
export const fs = {
  normPath, basename, parentPath, joinPath, homePath, desktopPath, ensureUserHome,

  exists: (p) => !!node(p),
  isDir: (p) => node(p)?.t === 'd',

  /** 属主 + 显示用 9 位权限(组位 = 其他位,无组概念) */
  modeString(n) {
    const full = String(n.p || FILE_MODE).padEnd(6, '-').slice(0, 6);
    return full.slice(0, 3) + full.slice(3, 6) + full.slice(3, 6);
  },

  stat(p) {
    const n = node(p);
    if (!n) return null;
    return {
      name: basename(p), path: normPath(p),
      dir: n.t === 'd',
      size: n.t === 'f' ? (n.d || '').length : Object.keys(n.c).length,
      mtime: n.m || 0,
      owner: n.o || 'root',
      mode: this.modeString(n),
      mode6: String(n.p || FILE_MODE).padEnd(6, '-').slice(0, 6),
    };
  },

  /** 列出目录(需读权限);返回按"目录在前 + 名称排序"的数组,无权限返回 null */
  list(p) {
    const n = node(p);
    if (!n || n.t !== 'd') return null;
    const user = accounts.current();
    if (!allow(p, 'r', user)) return null;
    const base = normPath(p) === '/' ? '' : normPath(p);
    return Object.entries(n.c)
      .map(([name, ch]) => ({
        name, path: base + '/' + name,
        dir: ch.t === 'd',
        size: ch.t === 'f' ? (ch.d || '').length : Object.keys(ch.c).length,
        mtime: ch.m || 0,
        owner: ch.o || 'root',
        mode: this.modeString(ch),
      }))
      .sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
  },

  read(p) {
    const n = node(p);
    if (n?.t !== 'f') return null;
    if (!allow(p, 'r', accounts.current())) return null;
    return n.d ?? '';
  },

  /** 系统内部读(绕过权限;用于快捷方式解析等) */
  readRaw(p) {
    const n = node(p);
    return n?.t === 'f' ? (n.d ?? '') : null;
  },

  /**
   * 写文件(自动创建父目录)。
   * opts.as  跳过会话身份(系统内部)
   * opts.owner 新建时的属主(默认当前用户 / root)
   * opts.mode  新建时 6 位权限
   */
  write(p, content, opts = {}) {
    const name = basename(p);
    if (!name || name === '/') return false;
    const user = actor(opts);
    if (!user) return false;
    const existing = node(p);
    if (existing) {
      if (!allow(p, 'w', user)) return false;
      existing.d = String(content);
      existing.m = Date.now();
      emit('write', p);
      return true;
    }
    const parPath = parentPath(p);
    if (!allow(parPath, 'w', user) || !allow(parPath, 'x', user)) return false;
    const par = this.mkdir(parPath, { silent: true, as: opts.as, owner: opts.owner });
    if (!par) return false;
    if (par.c[name]) return false;
    const n = makeNode('f', opts.owner || user || 'root', opts.mode || FILE_MODE);
    n.d = String(content);
    par.c[name] = n;
    par.m = Date.now();
    emit('write', p);
    return true;
  },

  /** 创建目录(可递归),返回目录 node;失败返回 null */
  mkdir(p, { silent, as, owner, mode } = {}) {
    const user = actor({ as });
    if (!user) return null;
    const segs = normPath(p).split('/').filter(Boolean);
    if (!segs.length) return root;
    let n = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (n.t !== 'd') return null;
      if (!n.c[seg]) {
        // 新建子目录:当前目录需可写可进入(root 免检)
        if (!modeFor(n, user).w || !modeFor(n, user).x) return null;
        const isLast = i === segs.length - 1;
        n.c[seg] = makeNode(
          'd',
          owner || (isLast ? (user === 'root' ? 'root' : user) : user) || 'root',
          mode || (owner && isLast ? HOME_MODE : DIR_MODE),
        );
        n.m = Date.now();
        if (!silent) emit('mkdir', p);
      }
      n = n.c[seg];
    }
    persist();
    return n;
  },

  /** 删除文件或目录(含子内容) */
  rm(p, opts = {}) {
    const user = actor(opts);
    const par = node(parentPath(p));
    const name = basename(p);
    if (!par || !par.c[name]) return false;
    if (!allow(parentPath(p), 'w', user)) return false;
    const victim = par.c[name];
    if (victim.o !== user && !modeFor(victim, user).w) return false;
    delete par.c[name];
    par.m = Date.now();
    emit('rm', p);
    return true;
  },

  /** 移动/重命名 */
  rename(oldP, newP, opts = {}) {
    const user = actor(opts);
    const par = node(parentPath(oldP));
    const name = basename(oldP);
    if (!par || !par.c[name]) return false;
    if (!allow(parentPath(oldP), 'w', user)) return false;
    if (!allow(parentPath(newP), 'w', user)) return false;
    if (!allow(parentPath(newP), 'x', user)) return false;
    const n = par.c[name];
    delete par.c[name];
    const dstPar = this.mkdir(parentPath(newP), { silent: true, ...opts });
    if (!dstPar) { par.c[name] = n; return false; }
    dstPar.c[basename(newP)] = n;
    n.m = Date.now();
    emit('rename', newP);
    return true;
  },

  /** chmod:mode 为 6 位 "rwxrwx" 或 4 位八进制如 "755"(映射为 6 位) */
  chmod(p, mode, opts = {}) {
    const n = node(p);
    if (!n) return false;
    const user = actor(opts);
    if (!user) return false;
    if (user !== 'root' && n.o !== user) return false;   // 仅属主或 root 可改
    let m6;
    if (/^[0-7]{4}$/.test(String(mode))) {
      // 四位八进制:忽略特殊位,取属主 + 其他(无用户组)
      const s = String(mode);
      const bits = (d) => ((d & 4) ? 'r' : '-') + ((d & 2) ? 'w' : '-') + ((d & 1) ? 'x' : '-');
      m6 = bits(parseInt(s[1], 8)) + bits(parseInt(s[3], 8));
    } else if (/^[rwxt-]{6}$/.test(String(mode))) {
      m6 = String(mode);
    } else if (/^[0-7]{3}$/.test(String(mode))) {
      const bits = (d) => ((d & 4) ? 'r' : '-') + ((d & 2) ? 'w' : '-') + ((d & 1) ? 'x' : '-');
      const [u, g, o] = String(mode).split('').map(c => parseInt(c, 8));
      // 无组:中间位并入"其他"
      m6 = bits(u) + bits(g | o);
    } else return false;
    n.p = m6;
    n.m = Date.now();
    emit('chmod', p);
    return true;
  },

  /** chown:仅 root */
  chown(p, newOwner, opts = {}) {
    const n = node(p);
    if (!n) return false;
    const user = actor(opts);
    if (user !== 'root' && !opts.as) return false;
    n.o = String(newOwner);
    n.m = Date.now();
    emit('chown', p);
    return true;
  },

  /** 当前会话用户(未登录 null) */
  currentUser: () => accounts.current(),

  /** 全盘统计 */
  stats() {
    let files = 0, dirs = 0, bytes = 0;
    (function walk(n) {
      if (n.t === 'f') { files++; bytes += (n.d || '').length; }
      else { dirs++; for (const ch of Object.values(n.c)) walk(ch); }
    })(root);
    return { files, dirs, bytes };
  },

  exportAll: () => root,
  importAll(tree) {
    if (tree?.t === 'd') { root = tree; emit('import', '/'); return true; }
    return false;
  },
};

export default fs;
