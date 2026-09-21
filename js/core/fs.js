/* ============================================================
 * FS —— 虚拟文件系统(持久化到 localStorage)
 *
 * 存储结构:
 *   目录: { t:'d', c:{ <名称>: <node> }, m:<mtime> }
 *   文件: { t:'f', d:'<内容>', m:<mtime> }
 * 所有写操作自动持久化,并广播 sys:fs-changed 事件。
 * ============================================================ */

import { publish } from './bus.js';
import { debounce } from './utils.js';
import { list as listApps } from './registry.js';
import { storageWiped } from './store.js';

const KEY = 'webos.fs.v1';

const WELCOME = `欢迎使用 AetherWebOS!

这是一个纯前端的网页操作系统。
所有数据都保存在你浏览器的 localStorage 中,无需任何后端。

推荐试一试:
 · 双击桌面图标,或点击左下角的开始按钮
 · 打开「终端」,输入 help 查看全部命令
 · 在「系统设置 → 外观」更换主题、强调色与壁纸
 · 打开「系统监视器」,切到 IPC 消息页,可以看到
   应用之间流动的所有消息
 · 用记事本改这个文件,文件管家会实时刷新

快捷操作:
 · 双击窗口标题栏 = 最大化 / 还原
 · 拖动窗口边缘可调整大小
 · 桌面空白处右键 = 快捷菜单
 · 记事本内 Ctrl+S 保存

祝你玩得愉快!
`;

const DESKTOP_NOTE = `桌面便签

这里就是你的桌面目录(/home/desktop)。
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

/* 桌面「棋类游戏」文件夹预置的快捷方式(内容 = 应用 ID 的 .app 文件) */
const CHESS_APPS = {
  chess3d: '国际象棋',
  xiangqi: '中国象棋',
  go: '围棋',
  gomoku: '五子棋',
  reversi: '黑白棋',
};

/* 桌面不自动生成图标:桌面上的一切都是 /home/desktop 里的真实文件,
 * 应用入口以 .app 快捷方式存在。初始化时为各应用在桌面生成快捷
 * 方式(棋类应用收进「棋类游戏」文件夹),用户可随意删除、改名、收纳;
 * 完整的应用列表始终在开始菜单。 */
function desktopShortcutSeeds() {
  const seeds = {};
  for (const a of listApps()) {
    if (a.desktop === false || a.desktopIcon === false) continue;
    seeds[a.name + '.app'] = { t: 'f', d: a.id };
  }
  return seeds;
}

function defaultTree() {
  const now = Date.now();
  const chessLinks = {};
  for (const [id, name] of Object.entries(CHESS_APPS)) {
    chessLinks[name + '.app'] = { t: 'f', d: id, m: now };
  }
  const shortcuts = {};
  for (const [fname, node] of Object.entries(desktopShortcutSeeds())) {
    shortcuts[fname] = { ...node, m: now };
  }
  return {
    t: 'd', m: now, c: {
      home: {
        t: 'd', m: now, c: {
          desktop: {
            t: 'd', m: now, c: {
              '桌面便签.txt': { t: 'f', d: DESKTOP_NOTE, m: now },
              '棋类游戏': { t: 'd', m: now, c: chessLinks },
              ...shortcuts,
            },
          },
          documents: {
            t: 'd', m: now, c: {
              '欢迎使用.txt': { t: 'f', d: WELCOME, m: now },
              '应用开发指南.md': { t: 'f', d: DEVGUIDE, m: now },
            },
          },
          pictures: { t: 'd', m: now, c: {} },
          music: { t: 'd', m: now, c: {} },
          downloads: { t: 'd', m: now, c: {} },
        },
      },
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const tree = JSON.parse(raw);
    return tree?.t === 'd' ? tree : null;
  } catch { return null; }
}

let root = load() || defaultTree();

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

/* ---------- 文件系统 API ---------- */
export const fs = {
  normPath, basename, parentPath, joinPath,

  exists: (p) => !!node(p),
  isDir: (p) => node(p)?.t === 'd',

  stat(p) {
    const n = node(p);
    if (!n) return null;
    return {
      name: basename(p), path: normPath(p),
      dir: n.t === 'd',
      size: n.t === 'f' ? (n.d || '').length : Object.keys(n.c).length,
      mtime: n.m || 0,
    };
  },

  /** 列出目录,返回按"目录在前 + 名称排序"的数组 */
  list(p) {
    const n = node(p);
    if (!n || n.t !== 'd') return null;
    const base = normPath(p) === '/' ? '' : normPath(p);
    return Object.entries(n.c)
      .map(([name, ch]) => ({
        name, path: base + '/' + name,
        dir: ch.t === 'd',
        size: ch.t === 'f' ? (ch.d || '').length : Object.keys(ch.c).length,
        mtime: ch.m || 0,
      }))
      .sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
  },

  read(p) {
    const n = node(p);
    return n?.t === 'f' ? (n.d ?? '') : null;
  },

  /** 写文件(自动创建父目录),返回 boolean */
  write(p, content) {
    const name = basename(p);
    if (!name || name === '/') return false;
    const par = this.mkdir(parentPath(p), { silent: true });
    if (!par) return false;
    const old = par.c[name];
    par.c[name] = { t: 'f', d: String(content), m: Date.now() };
    par.m = Date.now();
    emit('write', p);
    return true;
  },

  /** 创建目录(可递归),返回父目录 node */
  mkdir(p, { silent } = {}) {
    let n = root;
    for (const seg of normPath(p).split('/').filter(Boolean)) {
      if (n.t !== 'd') return null;
      if (!n.c[seg]) { n.c[seg] = { t: 'd', c: {}, m: Date.now() }; n.m = Date.now(); if (!silent) emit('mkdir', p); }
      n = n.c[seg];
    }
    persist();
    return n;
  },

  /** 删除文件或目录(含子内容) */
  rm(p) {
    const par = node(parentPath(p));
    const name = basename(p);
    if (!par || !par.c[name]) return false;
    delete par.c[name];
    par.m = Date.now();
    emit('rm', p);
    return true;
  },

  /** 移动/重命名 */
  rename(oldP, newP) {
    const par = node(parentPath(oldP));
    const name = basename(oldP);
    if (!par || !par.c[name]) return false;
    const n = par.c[name];
    delete par.c[name];
    const dstPar = this.mkdir(parentPath(newP), { silent: true });
    if (!dstPar) { par.c[name] = n; return false; }
    dstPar.c[basename(newP)] = n;
    n.m = Date.now();
    emit('rename', newP);
    return true;
  },

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
