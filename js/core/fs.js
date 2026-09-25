/* ============================================================
 * FS —— 虚拟文件系统 v2(元数据在 OPFS JSON,内容在 OPFS 文件)
 *
 * 存储结构(根节点带版本号 v:2;版本不符 → 清空全部本地数据):
 *   根:   { v:2, t:'d', c:{...}, m:<mtime>, o:'root', p:'rwxr-x' }
 *   目录: { t:'d', c:{ <名称>: <node> }, m, o:<owner>, p:<mode> }
 *   文件: { t:'f', d:'<内容>', m, o:<owner>, p:<mode> }  ← d 仅在内存
 *
 * 落盘(inode 式拆分):
 *   · OPFS `webos/fs.v2.json` —— **仅元数据树**(无 d 字段,类似 inode 表)
 *   · OPFS `webos/fsdata/<绝对路径>` —— 每个文件的真实内容
 *     例:fsdata/home/user/appdata/sms.awdb
 *   · 无 OPFS 时整树(含内容)降级 localStorage 键 webos.fs.v2
 *   · 同步 API 读内存;fsReady 等待首次加载/迁移完成
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
import {
  opfsReadText, opfsWriteText,
  opfsReadBytes, opfsWriteBytes,
  opfsReadSlice, opfsWriteAt, opfsFileSize,
  opfsClearAll, opfsAvailable,
} from './opfs.js';

/** localStorage 旧键(迁移源;迁移后删除) */
const LS_KEY = 'webos.fs.v2';
const LEGACY_KEYS = ['webos.fs.v1'];
/** OPFS 中的文件名 */
const OPFS_NAME = 'fs.v2.json';
const FS_VERSION = 2;

const WELCOME = `欢迎使用 AetherWebOS!

这是一个纯前端的网页操作系统。
文件系统与应用数据保存在浏览器 OPFS 中,无需任何后端。

文件系统 v2:
 · 每个用户绑定 /home/<用户名> 家目录
 · 文件带属主与权限(类 Linux,无用户组)
 · 系统目录 /bin /app 预留给系统程序
 · 应用数据在 ~/appdata/(页加密数据库)

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
ctx.fs       应用级文件系统(读/写/建/删,按执行用户鉴权)★ 推荐
ctx.user     本窗口执行用户(打开时绑定;未登录 null)
ctx.settings 系统设置
ctx.setTitle(t) / ctx.close()
返回 { onClose, onResize, onParams } 钩子(可选)。
清单可声明 executeAs: 'session'(默认)| 'root' | 固定用户名。

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

/** 解析整棵树 JSON;结构/版本不符返回 null */
function parseTree(raw) {
  if (!raw) return null;
  try {
    const tree = JSON.parse(raw);
    return tree && tree.v === FS_VERSION && tree.t === 'd' && tree.c && typeof tree.c === 'object'
      ? tree
      : null;
  } catch { return null; }
}

/** localStorage 里是否存在无法识别的 FS 数据(需整体清空) */
function lsLooksStale() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw && !parseTree(raw)) return true;
    return LEGACY_KEYS.some((k) => localStorage.getItem(k) != null);
  } catch { return false; }
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

/** 子节点绝对路径:base 为 '' | '/' | '/home' 等 */
function childPath(base, name) {
  if (!base || base === '/') return '/' + name;
  return base + '/' + name;
}

/** 内存树 → 仅元数据(去掉文件 d),供 OPFS inode JSON */
function stripContents(node) {
  if (node.t === 'f') {
    const { d: _d, ...rest } = node;
    return rest;
  }
  const out = { ...node };
  if (out.c) {
    const c = {};
    for (const [k, ch] of Object.entries(node.c)) c[k] = stripContents(ch);
    out.c = c;
  }
  return out;
}

/** 文件内容长度:二进制 byteLength,文本 length */
function contentSize(d) {
  if (d instanceof Uint8Array) return d.byteLength;
  return (d || '').length;
}

/** 文件长度:优先 inode 上记录的 s(随机写文件可能无内联 d) */
function inodeSize(n) {
  if (n.t !== 'f') return Object.keys(n.c).length;
  if (n.s != null) return n.s;
  return contentSize(n.d);
}

/** 遍历文件:yield { path, content, bin } */
function* walkFiles(node, path) {
  if (node.t === 'f') {
    yield { path, content: node.d ?? null, bin: node.bin === true || node.d instanceof Uint8Array };
    return;
  }
  if (!node.c) return;
  for (const [name, ch] of Object.entries(node.c)) {
    yield* walkFiles(ch, childPath(path, name));
  }
}

/** 内存中是否有任一文件已带内容(旧整树 JSON 迁移源) */
function hasInlineContent(node) {
  if (node.t === 'f') return node.d != null;
  if (!node.c) return false;
  for (const ch of Object.values(node.c)) {
    if (hasInlineContent(ch)) return true;
  }
  return false;
}

/**
 * 从 fsdata/ 水合缺失的文件内容(元数据树无 d 时)。
 * 二进制 inode 带 bin:true 且无 d → **不整文件加载**(随机读经 readAt);
 * 旧版 AWDBVFS1 字符串 → 解码、标 bin,并重写 OPFS 为原始字节。
 */
async function hydrateContents(node, path) {
  if (node.t === 'f') {
    if (node.d != null) return;
    if (node.bin) return; // 内容仅在 OPFS,由 readAt 按需读取
    const raw = await opfsReadText('fsdata' + path);
    if (raw == null) {
      node.d = '';
      return;
    }
    // 旧 base64 包装 → 迁为原始二进制字节
    if (raw.startsWith('AWDBVFS1:')) {
      try {
        const bytes = Uint8Array.from(atob(raw.slice(9)), (c) => c.charCodeAt(0));
        node.d = bytes;
        node.bin = true;
        node.s = bytes.length;
        await opfsWriteBytes('fsdata' + path, bytes);
        return;
      } catch { /* 落到当文本 */ }
    }
    node.d = raw;
    return;
  }
  if (!node.c) return;
  for (const [name, ch] of Object.entries(node.c)) {
    await hydrateContents(ch, childPath(path, name));
  }
}

/** 内存态:同步 API 的真相源;首次从 OPFS/LS 异步水合 */
let root = freshRoot();
/** 首次加载(含 OPFS 迁移)完成前为 false;写盘在 ready 前会排队 */
let fsBooted = false;
const bootWaiters = [];
/* 写盘队列:debounce 触发时若尚未 ready,挂到 ready 后再写 */
let pendingPersist = false;
let writeChain = Promise.resolve();

function markBooted() {
  if (fsBooted) return;
  fsBooted = true;
  while (bootWaiters.length) bootWaiters.pop()();
  // ready 前挂起的写盘冲刷
  if (pendingPersist && !storageWiped()) {
    pendingPersist = false;
    writeChain = writeChain.then(writeTree, writeTree);
  }
}

/** 等待 FS 首次从 OPFS 装载/迁移完成 */
export function fsReady() {
  if (fsBooted) return Promise.resolve();
  return new Promise((res) => bootWaiters.push(res));
}

/**
 * 落盘:
 *  1) 每个文件内容 → OPFS fsdata/<path>
 *  2) 元数据树(无 d) → fs.v2.json
 * OPFS 不可用时整树(含 d)写入 localStorage 键作回退。
 */
async function writeTree() {
  const meta = JSON.stringify(stripContents(root));
  const full = JSON.stringify(root); // 降级用
  try {
    if (opfsAvailable()) {
      // 先内容后元数据;随机访问文件(bin 且无 d)内容已在 fsdata,只写元数据
      for (const { path, content, bin } of walkFiles(root, '/')) {
        if (bin && (content == null || content === '')) continue;
        if (bin || content instanceof Uint8Array) {
          const bytes = content instanceof Uint8Array
            ? content
            : new TextEncoder().encode(String(content ?? ''));
          if (bytes.length) await opfsWriteBytes('fsdata' + path, bytes);
        } else {
          await opfsWriteText('fsdata' + path, content);
        }
      }
      await opfsWriteText(OPFS_NAME, meta);
    } else {
      await opfsWriteText(OPFS_NAME, full);
    }
    try {
      localStorage.removeItem(LS_KEY);
      for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    } catch { /* 忽略 */ }
  } catch (e) {
    console.warn('[fs] OPFS 持久化失败,回退 localStorage:', e);
    try { localStorage.setItem(LS_KEY, full); }
    catch (e2) {
      console.warn('[fs] 持久化失败:', e2);
      publish('sys:notify', { from: 'fs', type: 'notify', payload: { title: '存储空间不足', body: '文件未能保存,请清理数据。' } });
    }
  }
}

function schedulePersist() {
  if (storageWiped()) return;
  pendingPersist = true;
  const run = async () => {
    if (storageWiped() || !pendingPersist) return;
    pendingPersist = false;
    await writeTree();
  };
  if (!fsBooted) return;   // ready 后由 markBooted 冲刷
  writeChain = writeChain.then(run, run);
}

const persist = debounce(() => schedulePersist(), 250);

/** 装入树并按需从 fsdata/ 水合内容 */
async function adoptTree(tree) {
  if (!hasInlineContent(tree)) {
    await hydrateContents(tree, '/');
  }
  root = tree;
}

/** 首次启动:OPFS 元数据 → 旧 localStorage 迁移 → 空则默认树 */
async function bootLoad() {
  // 1) OPFS 优先
  const fromOpfs = parseTree(await opfsReadText(OPFS_NAME));
  if (fromOpfs) {
    await adoptTree(fromOpfs);
    markBooted();
    if (pendingPersist) {
      pendingPersist = false;
      writeChain = writeChain.then(writeTree, writeTree);
    }
    return;
  }

  // 2) OPFS 无数据:看 localStorage 旧键(可能仍含内联内容)
  if (lsLooksStale() && !parseTree(localStorage.getItem(LS_KEY))) {
    wipeAllAndReload();
    return;
  }
  const fromLs = parseTree(localStorage.getItem(LS_KEY));
  if (fromLs) {
    // 旧整树:保留内存中的 d,立刻拆到 OPFS
    root = fromLs;
    markBooted();
    writeChain = writeChain.then(writeTree, writeTree);
    await writeChain;
    return;
  }

  // 3) 全新:写入默认树
  root = freshRoot();
  markBooted();
  writeChain = writeChain.then(writeTree, writeTree);
}

/** 版本不符 / 结构损坏 → 清空浏览器内全部 WebOS 数据并重载(不做兼容迁移) */
function wipeAllAndReload() {
  markStorageWiped();
  markBooted();   // 解除 fsReady,避免启动序列死等
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch { /* 忽略 */ }
  // OPFS 清空后再 reload(降级路径下 opfsClearAll 清的是 LS 前缀键)
  Promise.resolve()
    .then(() => opfsClearAll())
    .catch(() => {})
    .finally(() => location.reload());
}

// 模块加载即开始水合(不阻塞 import)
bootLoad().catch((e) => {
  console.warn('[fs] 初始化失败:', e);
  markBooted();
});

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

/** 内部解析当前操作身份:显式 as(含 null)> 会话用户;as:undefined 视为未指定 */
function actor(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'as') && opts.as !== undefined) {
    return opts.as;
  }
  return accounts.current();
}

/**
 * 穿越检查:path 上每一级目录(不含终点自身)对 user 是否可进入(x)。
 * 用于 exists/stat 前提;终点本身的 r/w/x 由 allow() 判定。
 */
function canTraverse(p, user) {
  if (!user) return false;
  if (user === 'root') return true;
  const segs = normPath(p).split('/').filter(Boolean);
  if (!segs.length) return modeFor(root, user).x === true;
  let cur = root;
  if (!modeFor(root, user).x) return false;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur.t !== 'd' || !modeFor(cur, user).x) return false;
    cur = cur.c[segs[i]];
    if (!cur) return false;
  }
  // 终点的父目录必须可进入;若终点是目录,进入它也要 x(由调用方按需再查 allow)
  return cur.t === 'd' && modeFor(cur, user).x === true;
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
  // OPFS 尚未水合:推迟到 ready,避免在空 freshRoot 上建家再被覆盖
  if (!fsBooted) {
    fsReady().then(() => { try { ensureUserHome(user); } catch { /* 忽略 */ } });
    return false;
  }
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
      if (name === 'desktop' || name === 'documents' || name === 'pictures' || name === 'music' || name === 'downloads' || name === 'appdata') {
        par.c[name] = makeNode('d', user, name === 'appdata' ? 'rwx------' : DIR_MODE);
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
  seed('appdata');
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
  /** 首次 OPFS 装载/迁移完成(启动序列应 await) */
  ready: fsReady,
  /** 是否使用真实 OPFS(否则为 localStorage 降级) */
  storageBackend: () => (opfsAvailable() ? 'opfs' : 'localStorage'),

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
      size: inodeSize(n),
      mtime: n.m || 0,
      owner: n.o || 'root',
      mode: this.modeString(n),
      mode6: String(n.p || FILE_MODE).padEnd(6, '-').slice(0, 6),
    };
  },

  /**
   * 列出目录(需读权限);返回按"目录在前 + 名称排序"的数组,无权限返回 null。
   * opts.as 指定执行用户(应用级 API 传入应用的执行用户;未登录传 null)。
   */
  list(p, opts = {}) {
    const n = node(p);
    if (!n || n.t !== 'd') return null;
    const user = actor(opts);
    if (!allow(p, 'r', user)) return null;
    const base = normPath(p) === '/' ? '' : normPath(p);
    return Object.entries(n.c)
      .map(([name, ch]) => ({
        name, path: base + '/' + name,
        dir: ch.t === 'd',
        size: inodeSize(ch),
        mtime: ch.m || 0,
        owner: ch.o || 'root',
        mode: this.modeString(ch),
      }))
      .sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
  },

  /** 读文件;无读权限或不存在返回 null。opts.as 指定执行用户
   *  二进制文件返回 Uint8Array(bin:true),文本返回 string。 */
  read(p, opts = {}) {
    const n = node(p);
    if (n?.t !== 'f') return null;
    if (!allow(p, 'r', actor(opts))) return null;
    return n.d ?? (n.bin ? new Uint8Array(0) : '');
  },

  /** 系统内部读(绕过权限;用于快捷方式解析等) */
  readRaw(p) {
    const n = node(p);
    if (n?.t !== 'f') return null;
    return n.d ?? (n.bin ? new Uint8Array(0) : '');
  },

  /** 读二进制;文本文件按 UTF-8 编码返回;不存在 → null */
  readBinary(p, opts = {}) {
    const n = node(p);
    if (n?.t !== 'f') return null;
    if (!allow(p, 'r', actor(opts))) return null;
    if (n.d instanceof Uint8Array) return n.d;
    if (typeof n.d === 'string') return new TextEncoder().encode(n.d);
    return new Uint8Array(0);
  },

  /**
   * 按偏移随机读(异步;内容在 OPFS fsdata,库不得绕过本方法直连 OPFS)。
   * 返回该区间实际字节(可能短于 length);文件不存在/无权限 → null。
   */
  async readAt(p, offset, length, opts = {}) {
    const n = node(p);
    if (n?.t !== 'f') return null;
    if (!allow(p, 'r', actor(opts))) return null;
    const path = normPath(p);
    // 仅内存(未落盘或小文本):从 d 切片
    if (n.d != null && !n.bin) {
      const bytes = typeof n.d === 'string'
        ? new TextEncoder().encode(n.d)
        : n.d;
      return bytes.slice(offset, offset + length);
    }
    // 随机访问文件:直接切 OPFS fsdata,不整文件进内存
    const slice = await opfsReadSlice('fsdata' + path, offset, length);
    if (slice) return slice;
    // OPFS 读失败但内存有完整二进制
    if (n.d instanceof Uint8Array) return n.d.slice(offset, offset + length);
    return null;
  },

  /**
   * 按偏移随机写(异步)。自动建父目录与文件节点;标 bin、记录大小 s。
   * 内容**不**整份驻留内存(随机写文件 d 为空),由 writeAt 直写 fsdata。
   * @returns {Promise<boolean>}
   */
  async writeAt(p, offset, data, opts = {}) {
    const name = basename(p);
    if (!name || name === '/') return false;
    const user = actor(opts);
    if (!user) return false;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const path = normPath(p);
    const off = Math.max(0, offset | 0);

    let n = node(p);
    if (n && n.t === 'd') return false;
    if (!n) {
      const parPath = parentPath(p);
      if (!allow(parPath, 'w', user) || !allow(parPath, 'x', user)) return false;
      const mkdirOpts = { silent: true };
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'as') && opts.as !== undefined) {
        mkdirOpts.as = opts.as;
      }
      const par = this.mkdir(parPath, mkdirOpts);
      if (!par) return false;
      if (par.c[name]) return false;
      n = makeNode('f', opts.owner || user || 'root', opts.mode || FILE_MODE);
      n.bin = true;
      par.c[name] = n;
      par.m = Date.now();
    } else if (!allow(p, 'w', user)) {
      return false;
    }

    const ok = await opfsWriteAt('fsdata' + path, bytes, off);
    if (!ok) return false;

    n.bin = true;
    n.d = undefined;           // 随机写文件不驻留整份内容
    n.s = Math.max(n.s || 0, off + bytes.length);
    n.m = Date.now();
    emit('write', p);
    return true;
  },

  /** 文件字节数;优先 inode.s,否则读存储;不存在 → null */
  async fileSize(p, opts = {}) {
    const n = node(p);
    if (n?.t !== 'f') return null;
    if (!allow(p, 'r', actor(opts))) return null;
    if (n.s != null) return n.s;
    if (n.d != null && !n.bin) return contentSize(n.d);
    return await opfsFileSize('fsdata' + normPath(p));
  },

  /**
   * 写文件(自动创建父目录)。
   * content 支持 string | Uint8Array;二进制自动标 bin 并走 fsdata 字节路径。
   * opts.as  跳过会话身份(系统内部)
   * opts.owner 新建时的属主(默认当前用户 / root)
   * opts.mode  新建时 6 位权限
   */
  write(p, content, opts = {}) {
    const name = basename(p);
    if (!name || name === '/') return false;
    const user = actor(opts);
    if (!user) return false;
    const isBin = content instanceof Uint8Array;
    const val = isBin ? content.slice() : String(content);
    const existing = node(p);
    if (existing) {
      if (!allow(p, 'w', user)) return false;
      existing.d = val;
      if (isBin) {
        existing.bin = true;
        existing.s = val.length;
      } else {
        delete existing.bin;
        existing.s = undefined;
      }
      existing.m = Date.now();
      emit('write', p);
      return true;
    }
    const parPath = parentPath(p);
    if (!allow(parPath, 'w', user) || !allow(parPath, 'x', user)) return false;
    // 父目录补齐:仅在显式指定了 as 时传入,避免 as:undefined 被当成无身份
    const mkdirOpts = { silent: true };
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'as') && opts.as !== undefined) {
      mkdirOpts.as = opts.as;
    }
    const par = this.mkdir(parPath, mkdirOpts);
    if (!par) return false;
    if (par.c[name]) return false;
    const n = makeNode('f', opts.owner || user || 'root', opts.mode || FILE_MODE);
    n.d = val;
    if (isBin) {
      n.bin = true;
      n.s = val.length;
    }
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
    if (user !== 'root') return false;   // 仅 root 可 chown
    n.o = String(newOwner);
    n.m = Date.now();
    emit('chown', p);
    return true;
  },

  /** 当前会话用户(未登录 null) */
  currentUser: () => accounts.current(),

  /** 是否允许 user 对 path 做 r/w/x(应用级 API 经 AppFS 调用) */
  can(p, bit, user = accounts.current()) {
    return allow(p, bit, user);
  },
  /** 是否可穿越 path 的父目录链(存在性/进入前提) */
  canTraverse(p, user = accounts.current()) {
    return canTraverse(p, user);
  },

  /** 全盘统计 */
  stats() {
    let files = 0, dirs = 0, bytes = 0;
    (function walk(n) {
      if (n.t === 'f') { files++; bytes += contentSize(n.d); }
      else { dirs++; for (const ch of Object.values(n.c)) walk(ch); }
    })(root);
    return { files, dirs, bytes };
  },

  exportAll: () => root,
  importAll(tree) {
    if (tree?.t === 'd') { root = tree; emit('import', '/'); return true; }
    return false;
  },
  /** 立即落盘(测试 / 关页前);返回 Promise */
  async flush() {
    pendingPersist = true;
    if (!fsBooted) await fsReady();
    pendingPersist = false;
    writeChain = writeChain.then(writeTree, writeTree);
    await writeChain;
  },
};

export default fs;
