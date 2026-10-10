/* ============================================================
 * FS —— 虚拟文件系统 v2(元数据在 OPFS JSON,内容在 OPFS 文件)
 *
 * 存储结构(根节点带版本号 v:2;版本不符 → 清空全部本地数据):
 *   根:   { v:2, t:'d', c:{...}, m:<mtime>, o:<ownerUid>, p:'rw-r--' }
 *   目录: { t:'d', c:{ <名称>: <node> }, m, o:<ownerUid>, p:<mode> }
 *   文件: { t:'f', d:'<内容>', m, o:<ownerUid>, p:<mode> }  ← d 仅在内存
 *
 * 属主 o 为**数字 uid**(accounts 全局发号,root=0,改名不变);
 * 老树里的字符串用户名在装载时迁移成 uid。显示时经
 * accounts.nameOf 反解;用户已删除的孤儿 uid 显示为 #<uid>。
 *
 * 落盘(inode 式拆分):
 *   · OPFS `webos/fs.v2.json` —— **仅元数据树**(无 d 字段,类似 inode 表)
 *   · OPFS `webos/fsdata/<绝对路径>` —— 每个文件的真实内容
 *     例:fsdata/home/user/appdata/sms.awdb
 *   · OPFS 是硬性前提:无降级路径,不支持的浏览器由 system/boot.js
 *     启动门禁直接拒绝(本模块不再有 localStorage 分支)
 *   · 同步 API 读内存;fsReady 等待首次加载完成
 *
 * 用户与目录绑定:
 *   /bin /app          系统目录(root 所有,预留给系统程序/应用包)
 *   /home/<user>/...   每个登录用户的家目录(含 desktop/documents/…)
 *
 * 权限(类 Linux,但无用户组):
 *   p 为 6 位 "rwxrwx":前 3 位属主,后 3 位其他用户;
 *   root 超级用户绕过全部检查。ls 显示时补成 9 位(组位=其他位)。
 *   r = 读文件 / 列目录(目录穿越不查权限:所有目录对已登录用户均可穿过,
 *       r 只管「能否列出该目录」,无独立运行权限);
 *   w = 写文件 / 改目录(在目录里新建条目还需对该目录 w);
 *   x = **管理位**:置位后该用户可移动/删除/重命名此节点,也可 chmod 它;
 *       缺 x 这些操作全拒(冻结),授回须 root。root 不受限。
 *
 * 当前会话用户来自 accounts.current();未登录时仅允许 root 内部操作
 * (as:'root')。所有写操作自动持久化并广播 sys:fs-changed。
 *
 * 快照与 COW(写时复制):
 *   · 快照 = 子树元数据克隆(含属主/权限/mtime),文件节点只记内容引用
 *     ref(对应活跃树绝对路径),**不拷贝任何内容** → 创建 O(节点数);
 *   · 活跃树首次覆盖/删除某路径的 fsdata 内容前,把旧字节「遮蔽」到
 *     fsshadow/<路径>@<代次>(cowGuard),引用它的未遮蔽快照全部转挂新代次
 *     —— 快照内容与活跃内容只在分叉那一刻复制一次,此后各写各的;
 *   · 快照注册表(剥掉内存 d 后)单独落盘 fs.snaps.v1.json,装载时重建
 *     未遮蔽引用索引;文本内容未分叉时直接读活跃 fsdata(必然一致)。
 * ============================================================ */

import { publish, subscribe } from './bus.js';
import { debounce } from './utils.js';
import { storageWiped, markStorageWiped } from './store.js';
import { accounts } from './accounts.js';
import {
  opfsReadText, opfsWriteText,
  opfsReadBytes, opfsWriteBytes,
  opfsReadSlice, opfsWriteAt, opfsFileSize,
  opfsRemovePath, opfsClearAll, opfsList,
} from './opfs.js';

/** OPFS 中的文件名 */
const OPFS_NAME = 'fs.v2.json';
/** 快照注册表文件名 */
const SNAPS_NAME = 'fs.snaps.v1.json';
/** 快照遮蔽内容根路径:fsshadow/<原绝对路径>@<代次> */
const SHADOW_DIR = 'fsshadow';
const FS_VERSION = 2;

const WELCOME = `欢迎使用 AetherWebOS!

这是一个纯前端的网页操作系统。
文件系统与应用数据保存在浏览器 OPFS 中,无需任何后端。

文件系统 v2:
 · 每个用户绑定 /home/<用户名> 家目录
 · 文件带属主与权限(类 Linux,无用户组)
 · 系统目录 /bin /app 预留给系统程序
 · 应用数据在 ~/appdata/(页加密数据库)
 · 快照与 COW:终端 snap create <路径> 建快照,创建零拷贝、
   修改时才分叉复制,可随时 snap restore 整棵恢复

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

/* 默认权限:目录 rwx---- / 文件 rwx---- = 八进制 70(6 位:属主 + 其他)。
 * x = **管理位**:允移动/删除/重命名/改权限(chmod);缺 x 这些操作全拒
 * (冻结),root 不受限。属主默认持 x(创建者对自己的文件全权),
 * 其他段默认全空(穿越免费下,默认可读等于全设备可读)。
 * 冻结某个节点 = 去掉对应段的 x(appdata 库文件/目录 rw---- 即此口径,
 * 解冻须 root);缺省模式不经 makeNode 剥 x(平台基线,非调用方带入)。 */
const DIR_MODE = 'rwx----';
const FILE_MODE = 'rwx----';
const HOME_MODE = 'rw------';

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

function freshRoot() {
  const now = Date.now();
  return {
    v: FS_VERSION, t: 'd', m: now, o: 0, p: 'rw-r--',
    xs: 1,   // x 语义版本:1 = 管理位(置位允改名/删除/chmod);老树装载时一次性翻转,见 adoptTree
    c: {
      // 系统目录:r 控制可列;穿越免费;x 是管理位(root 本就绕过)
      bin: { t: 'd', m: now, o: 0, p: 'r--r--', c: {} },
      // 商店应用包目录:root 私有(others 三位全空),用户不可列/不可读/不可写
      app: { t: 'd', m: now, o: 0, p: 'rw----', c: {} },
      // /home 保持可列(用户名单);各用户家目录自身 HOME_MODE 私有
      home: { t: 'd', m: now, o: 0, p: 'rw-r--', c: {} },
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

/** 显示用 9 位权限(组位 = 其他位,无组概念);快照节点同构复用 */
const mode9Of = (n) => {
  const full = String(n.p || FILE_MODE).padEnd(6, '-').slice(0, 6);
  return full.slice(0, 3) + full.slice(3, 6) + full.slice(3, 6);
};

/** 按 id 找快照;调用方鉴权(snapOwnedBy:root 或创建者) */
function findSnap(id) {
  const num = Number(id);
  return snaps.items.find((it) => it.id === num) || null;
}
function snapOwnedBy(it, user) {
  if (!user) return false;
  return user === 'root' || it.user === uidOfActor(user);
}

/** 遍历文件:yield { path, content, bin, m } */
function* walkFiles(node, path) {
  if (node.t === 'f') {
    yield { path, content: node.d ?? null, bin: node.bin === true || node.d instanceof Uint8Array, m: node.m || 0 };
    return;
  }
  if (!node.c) return;
  for (const [name, ch] of Object.entries(node.c)) {
    yield* walkFiles(ch, childPath(path, name));
  }
}

/** 收集某子树下的全部文件:yield { path(绝对), rel(相对子树根) } */
function* walkSubtree(node, base, rel = '') {
  if (node.t === 'f') { yield { path: rel ? childPath(base, rel) : normPath(base), rel }; return; }
  if (!node.c) return;
  for (const [name, ch] of Object.entries(node.c)) {
    yield* walkSubtree(ch, base, rel ? rel + '/' + name : name);
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

/* ---------- 增量落盘簿记 ----------
 * 每次全量重写全部文件在大目录下要秒级(201 文件 ≈ 1.3s),
 * 防抖窗口内容易被导航/强杀打断 → 改为只写"变化过的文件":
 *   · mtime:m >= persistMark 的文件内容重写(写/建/chmod 都会刷新 m)
 *   · dirtyPaths:显式脏(重命名移入的子树),bin 文件从 copyFrom 复制字节
 *   · removedPaths:rm/改名遗留的 fsdata 垃圾,成功后递归清理 */
let persistMark = Infinity;                  // boot 完成前不增量:首写全量
const dirtyPaths = new Map();                // 绝对路径 → { copyFrom?: 旧绝对路径 }
const removedPaths = new Set();              // 待清理的旧绝对路径(文件或目录)

/* ---------- 快照与 COW(遮蔽式写时复制) ----------
 * 注册表 snaps(内存态,随 writeTree 落盘 fs.snaps.v1.json):
 *   { nextId, nextGen, items: [{ id, name, path, at, user, files, dirs, tree }] }
 * 快照树 = 克隆的元数据;文件节点带:
 *   ref = 内容引用的活跃绝对路径;gen = 遮蔽代次(null=未分叉,内容仍在
 *   活跃 fsdata/ref;数字=已分叉,内容在 fsshadow/ref@gen);d = 内存中
 *   与活跃树共享的内容引用(仅内存,落盘剥除)。
 * 不变量:gen==null ⇒ fsdata/ref 仍是快照时内容(每次覆盖/删除前先遮蔽)。 */
let snaps = { nextId: 1, nextGen: 1, items: [] };
let snapsDirty = false;                       // 注册表有变(增删/遮蔽),待落盘
/** ref 路径 → [{ node }] 未遮蔽引用(cowGuard 快路径;无快照时零开销) */
const unshadowedRefs = new Map();

/** 遍历快照树节点:yield { node, rel }(rel 相对快照根,'a/b.txt') */
function* walkSnapNodes(n, rel = '') {
  yield { node: n, rel };
  if (n.t === 'd' && n.c) {
    for (const [k, ch] of Object.entries(n.c)) {
      yield* walkSnapNodes(ch, rel ? rel + '/' + k : k);
    }
  }
}

/** 快照树里按相对路径取节点 */
function snapNodeAt(tree, rel) {
  let n = tree;
  for (const seg of String(rel || '').split('/').filter(Boolean)) {
    if (n?.t !== 'd') return null;
    n = n.c[seg];
    if (!n) return null;
  }
  return n;
}

/** 克隆子树为快照(元数据深拷贝;内容只记 ref,内存 d 共享引用) */
function cloneForSnapshot(n, path) {
  if (n.t === 'f') {
    const out = { t: 'f', m: n.m || Date.now(), o: n.o ?? 0, p: n.p || FILE_MODE, ref: path };
    if (n.d != null) out.d = n.d;
    if (n.bin) out.bin = true;
    if (n.s != null) out.s = n.s;
    return out;
  }
  const out = { t: 'd', m: n.m || Date.now(), o: n.o ?? 0, p: n.p || DIR_MODE, c: {} };
  if (n.c) {
    for (const [k, ch] of Object.entries(n.c)) out.c[k] = cloneForSnapshot(ch, childPath(path, k));
  }
  return out;
}

/** 重建未遮蔽引用索引(装载/删快照后) */
function reindexSnaps() {
  unshadowedRefs.clear();
  for (const it of snaps.items) {
    for (const { node: n } of walkSnapNodes(it.tree)) {
      if (n.t !== 'f' || n.gen != null || !n.ref) continue;
      if (!unshadowedRefs.has(n.ref)) unshadowedRefs.set(n.ref, []);
      unshadowedRefs.get(n.ref).push({ node: n });
    }
  }
}

const shadowPathOf = (n) => `${SHADOW_DIR}${n.ref}@${n.gen}`;

/**
 * COW 遮蔽:活跃树即将**覆盖或删除** fsdata/<path> 前,把该内容
 * 复制进快照私有域,所有未遮蔽引用转挂新代次。幂等(遮蔽后索引即摘除),
 * 无引用时零开销;字节源优先快照自己的内存 d(分叉时内容),缺 d(随机写
 * 文件)则读现存 backing(覆盖前必为快照时内容)。
 */
async function cowGuard(path) {
  if (!unshadowedRefs.size) return;
  const refs = unshadowedRefs.get(path);
  if (!refs) return;
  const gen = snaps.nextGen++;
  for (const { node } of refs) node.gen = gen;   // 先同步置位,防并发重复遮蔽
  unshadowedRefs.delete(path);
  snapsDirty = true;
  let src = null;
  for (const { node } of refs) {
    if (node.d != null && !(node.d instanceof Uint8Array && node.d.length === 0)) { src = node.d; break; }
  }
  const bytes = src != null
    ? (src instanceof Uint8Array ? src : new TextEncoder().encode(String(src)))
    : await opfsReadBytes('fsdata' + path);
  if (bytes && bytes.length) await opfsWriteBytes(`${SHADOW_DIR}${path}@${gen}`, bytes);
}

/** 读快照文件内容:内存 d → 遮蔽域 → 活跃 backing(未分叉必为快照时内容) */
async function snapReadFile(n) {
  if (n.d != null) return n.d;
  if (n.gen != null) {
    const p = shadowPathOf(n);
    return n.bin ? ((await opfsReadBytes(p)) ?? new Uint8Array(0))
                 : ((await opfsReadText(p)) ?? '');
  }
  return n.bin ? ((await opfsReadBytes('fsdata' + n.ref)) ?? new Uint8Array(0))
               : ((await opfsReadText('fsdata' + n.ref)) ?? '');
}

/** 快照树物化成可挂回活跃树的普通节点(内容全量读入内存 d) */
async function materializeSnap(sn, path) {
  if (sn.t === 'f') {
    let d = sn.d ?? null;
    if (d == null) d = await snapReadFile(sn);
    if (d == null) d = sn.bin ? new Uint8Array(0) : '';
    const out = { t: 'f', m: sn.m || Date.now(), o: typeof sn.o === 'number' ? sn.o : 0, p: sn.p || FILE_MODE, d: d instanceof Uint8Array ? d : String(d) };
    if (sn.bin) { out.bin = true; out.s = d.byteLength; }
    return out;
  }
  const out = { t: 'd', m: sn.m || Date.now(), o: typeof sn.o === 'number' ? sn.o : 0, p: sn.p || DIR_MODE, c: {} };
  for (const [k, ch] of Object.entries(sn.c || {})) out.c[k] = await materializeSnap(ch, childPath(path, k));
  return out;
}

/** 装载快照注册表(损坏时静默置空:快照是尽力而为数据,不动主树) */
async function loadSnaps() {
  snaps = { nextId: 1, nextGen: 1, items: [] };
  try {
    const raw = await opfsReadText(SNAPS_NAME);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.items)) {
      snaps = {
        nextId: Math.max(1, data.nextId || 1),
        nextGen: Math.max(1, data.nextGen || 1),
        items: data.items.filter((it) => it && it.tree && it.path),
      };
    }
  } catch { /* 忽略 */ }
  reindexSnaps();
}

/** 序列化注册表(剥内存 d;文件内容靠 ref/gen 落在 fsdata/fsshadow) */
function serializeSnaps() {
  return JSON.stringify({
    nextId: snaps.nextId, nextGen: snaps.nextGen,
    items: snaps.items.map((it) => ({ ...it, tree: stripContents(it.tree) })),
  });
}

/** 清理不再被任何快照引用的遮蔽域文件(删快照后;空目录残留无害不清) */
async function gcShadows() {
  const keep = new Set();
  for (const it of snaps.items) {
    for (const { node: n } of walkSnapNodes(it.tree)) {
      if (n.t === 'f' && n.gen != null) keep.add(n.ref.replace(/^\/+/, '') + '@' + n.gen);
    }
  }
  // 递归收齐 fsshadow 下现存文件(相对 fsshadow/ 的路径),不在 keep 的删除
  const files = [];
  async function scan(rel) {
    const entries = (await opfsList(rel ? `${SHADOW_DIR}/${rel}` : SHADOW_DIR)) || [];
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.dir) await scan(child);
      else files.push(child);
    }
  }
  await scan('');
  for (const f of files) {
    if (!keep.has(f)) await opfsRemovePath(`${SHADOW_DIR}/${f}`);
  }
}

/**
 * 落盘(增量,OPFS 唯一通道):
 *  1) 变化过的文件内容 → OPFS fsdata/<path>(未变的跳过)
 *  2) 元数据树(无 d) → fs.v2.json(每次都写,单文件)
 *  3) 清理 removedPaths 对应的 fsdata 遗留
 *  4) 快照注册表(有变才写)
 */
async function writeTree() {
  const t0 = Date.now();
  const meta = JSON.stringify(stripContents(root));
  try {
    // 先内容后元数据;随机访问文件(bin 且无 d)内容已在 fsdata,只写元数据
    for (const { path, content, bin, m } of walkFiles(root, '/')) {
      const explicit = dirtyPaths.get(path);
      if (explicit == null && m < persistMark) continue;   // 未变:与 OPFS 一致
      await cowGuard(path);   // COW:即将覆盖 backing,先遮蔽仍引用它的快照
      if (bin && (content == null || content === '')) {
        // 重命名移入的随机写文件:从旧路径复制字节
        if (explicit?.copyFrom != null) {
          const bytes = await opfsReadBytes('fsdata' + explicit.copyFrom);
          if (bytes && bytes.length) await opfsWriteBytes('fsdata' + path, bytes);
        }
        continue;
      }
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
    /* 路径已被重建(rm 后同路径再建)时保留新内容,只清真正不存在的遗留;
     * 否则会把刚写好的 fsdata 当垃圾删掉(内存 inode 却还在 → 读到全零) */
    for (const gone of removedPaths) {
      if (node(gone)) continue;
      await cowGuard(gone);   // COW:删除前遮蔽,快照转挂私有内容
      await opfsRemovePath('fsdata' + gone);
    }
    // 快照注册表(含本轮遮蔽产生的 gen 变化;失败保留脏标记下次重写)
    if (snapsDirty) {
      const payload = serializeSnaps();
      await opfsWriteText(SNAPS_NAME, payload);
      snapsDirty = false;
    }
  } catch (e) {
    console.warn('[fs] OPFS 持久化失败:', e);
    publish('sys:notify', { from: 'fs', type: 'notify', payload: { title: '存储写入失败', body: '文件未能保存(OPFS 写入失败),稍后将自动重试。' } });
    return;   // 失败:保留脏簿记,下次再试
  }
  dirtyPaths.clear();
  removedPaths.clear();
  persistMark = t0;
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
  migrateOwnerUids(tree);
  if (!tree.xs) {
    migrateDirTraverseX(tree); // 穿越时代:x=进入目录,并入 r 后清掉
    migrateXToManage(tree);    // 锁时代 → 管理时代:属主 x 取反(冻结保留),其他段清除
    tree.xs = 1;               // 标记语义版本,幂等:新树不重跑
  }
  root = tree;
}

/** 老树迁移:属主是字符串用户名的,改写为 uid(root→0;已删用户保留字符串,权限侧按孤儿处理) */
function migrateOwnerUids(n) {
  if (typeof n.o === 'string') {
    if (n.o === 'root') n.o = 0;
    else {
      const u = accounts.uidOf(n.o);
      if (u != null) n.o = u;
      // 用户已删:保留原字符串,ownerUid() 会归为孤儿 -1
    }
  }
  if (n.c) for (const ch of Object.values(n.c)) migrateOwnerUids(ch);
}

/**
 * 老树迁移:目录的穿越位 x 并入 r 后清除。
 * 仅对无 xs 标记的老树执行(新语义下目录的 x 是管理位,不能每次装载都剥)。
 * 文件的 x 不动:旧「可执行」本系统从未使用。
 */
function migrateDirTraverseX(n) {
  if (n.t === 'd' && typeof n.p === 'string') {
    let p = n.p.padEnd(6, '-').slice(0, 6);
    let changed = false;
    for (const base of [0, 3]) {
      if (p[base + 2] === 'x') {
        if (p[base] !== 'r') p = p.slice(0, base) + 'r' + p.slice(base + 1);
        p = p.slice(0, base + 2) + '-' + p.slice(base + 3);
        changed = true;
      }
    }
    if (changed) n.p = p;
  }
  if (n.c) for (const ch of Object.values(n.c)) migrateDirTraverseX(ch);
}

/**
 * 锁语义 → 管理语义 一次性翻转(见根节点 xs 标记):
 *  旧 x = 锁(置位 = 冻结该段),新 x = 管理位(置位 = 允改名/删除/chmod)。
 *  属主段取反:旧无 x(可管理)→ 新有 x(仍可管理);旧有 x(冻结)→ 新无 x(仍冻结)。
 *  其他段一律清 x(保守授权:对其他用户的可管理不因翻转而凭空出现)。
 *  翻转后 appdata/pkg 的开库/安装归一会把各自的冻结域重新收敛(它们的
 *  目标模式在新语义下就是无 x 的 rw----)。
 */
function migrateXToManage(n) {
  if (typeof n.p === 'string') {
    let p = n.p.padEnd(6, '-').slice(0, 6);
    // 属主段:x 取反
    p = p.slice(0, 2) + (p[2] === 'x' ? '-' : 'x') + p.slice(3);
    // 其他段:x 清除
    if (p[5] === 'x') p = p.slice(0, 5) + '-';
    n.p = p;
  }
  if (n.c) for (const ch of Object.values(n.c)) migrateXToManage(ch);
}

/** 首次启动:OPFS 元数据 → 空则默认树;损坏(有字节解析不了)整体清空 */
async function bootLoad() {
  // 1) OPFS 唯一数据源
  const fsRaw = await opfsReadText(OPFS_NAME);
  const fromOpfs = parseTree(fsRaw);
  if (fromOpfs) {
    await adoptTree(fromOpfs);
    await loadSnaps();         // 快照注册表(树装载后再读:遮蔽索引要建在最终树上)
    await gcShadows().catch(() => {});   // 回收崩溃残留的孤儿遮蔽文件
    persistMark = Date.now();   // 已与 OPFS 一致:此后只写变化过的文件
    markBooted();
    if (pendingPersist) {
      pendingPersist = false;
      writeChain = writeChain.then(writeTree, writeTree);
    }
    return;
  }

  // 2) 有字节但解析失败 = 版本/结构损坏 → 整体清空重载(与根版本号策略一致)
  if (fsRaw != null) {
    wipeAllAndReload();
    return;
  }

  // 3) 全新:写入默认树
  root = freshRoot();
  persistMark = Date.now();
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
  // OPFS 清空后再 reload(localStorage 顺带清掉旧版遗留键)
  Promise.resolve()
    .then(() => opfsClearAll())
    .catch(() => {})
    .finally(() => location.reload());
}

// 模块加载即开始水合(不阻塞 import)
bootLoad().catch((e) => {
  console.warn('[fs] 初始化失败:', e);
  persistMark = 0;   // 状态不明:首写全量,避免增量跳过
  markBooted();
});

/* 关页/导航前尽力冲刷(防抖窗口内的最后机会;异步写能完成多少算多少) */
addEventListener('pagehide', () => {
  if (!fsBooted || storageWiped()) return;
  if (pendingPersist || dirtyPaths.size || removedPaths.size) {
    pendingPersist = false;
    writeChain = writeTree();
  }
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
/** 节点属主 → uid:数字直用;字符串(老树/外部传入)经 accounts 解析;root/缺省 0 */
function ownerUid(n) {
  const o = n?.o;
  if (typeof o === 'number') return o;
  if (o == null || o === 'root') return 0;
  const u = accounts.uidOf(o);
  return u == null ? -1 : u;          // 用户已删:孤儿 uid,谁都不匹配(仅 root 超管)
}

/** uid → 显示名:root=0;已删用户显示 #uid;反解失败回落字符串 */
function ownerName(uid) {
  if (uid === 0) return 'root';
  return accounts.nameOf(uid) ?? `#${uid}`;
}

/** 操作身份字符串 → 落盘用 uid('root'→0,未知用户→-1) */
function uidOfActor(user) {
  if (!user) return -1;
  if (user === 'root') return 0;
  const u = accounts.uidOf(user);
  return u == null ? -1 : u;
}

/** 解析 6 位模式 → 属主/其他 的 {r,w,x}(user 为登录名;x=管理位) */
function modeFor(n, user) {
  const full = String(n.p || FILE_MODE).padEnd(6, '-').slice(0, 6);
  if (user === 'root') return { r: true, w: true, x: true };
  const owner = user != null && uidOfActor(user) === ownerUid(n) && ownerUid(n) >= 0;
  const chunk = owner ? full.slice(0, 3) : full.slice(3, 6);
  return { r: chunk[0] === 'r', w: chunk[1] === 'w', x: chunk[2] === 'x' };
}

/**
 * 是否允许对 path 做 r/w。
 * 规则(无用户组):目录穿越不查权限(结构存在即可穿过);
 * 只对目标节点查属主位或"其他"位。
 * bit 为 'r'|'w'('x' 查管理位,不用于穿越)。
 */
function allow(p, bit, user) {
  if (!user) return false;
  if (user === 'root') return true;
  const segs = normPath(p).split('/').filter(Boolean);
  if (!segs.length) return modeFor(root, user)[bit] === true;
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur.t !== 'd') return false;
    cur = cur.c[segs[i]];
    if (!cur) return false;
  }
  if (cur.t !== 'd') return false;
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
 * 穿越检查:path 的父目录链结构上存在即可(不查 r/w/x)。
 * 用于 exists/stat 前提;终点本身的 r/w 由 allow() 判定。
 */
function canTraverse(p, user) {
  if (!user) return false;
  const segs = normPath(p).split('/').filter(Boolean);
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur.t !== 'd') return false;
    cur = cur.c[segs[i]];
    if (!cur) return false;
  }
  return cur.t === 'd';
}

/**
 * x = 管理位:该用户**可**移动/删除/重命名此节点,也可改它的权限
 * (chmod)。缺 x 这些操作全拒(冻结),解冻须 root 授回 x。
 * root 不受限;位在该用户的权限段(属主看前 3 位,其他看后 3 位)。
 */
function canManage(n, user) {
  if (!user || user === 'root') return true;
  return modeFor(n, user).x === true;
}

/** 内部建节点(owner 接受登录名或 uid number;落盘一律 uid)。
 *  mode 缺省用系统默认(FILE_MODE/DIR_MODE 自带属主 x,创建者可管理);
 *  显式 mode 原样落盘 —— x 是管理位,调用方给什么就是什么
 *  (系统内部建库/建包都显式给无 x 的 rw----,落盘即冻结)。 */
function makeNode(kind, owner, mode) {
  const m = Date.now();
  let uid;
  if (typeof owner === 'number') uid = owner;
  else if (owner == null || owner === '') uid = uidOfActor(actor());
  else uid = uidOfActor(owner);
  if (uid < 0) uid = 0;              // 未识别身份:归 root(仅系统路径会出现)
  const m6 = String(mode ?? (kind === 'd' ? DIR_MODE : FILE_MODE)).padEnd(6, '-').slice(0, 6);
  return kind === 'd'
    ? { t: 'd', c: {}, m, o: uid, p: m6 }
    : { t: 'f', d: '', m, o: uid, p: m6 };
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
    existing.o = uidOfActor(user);
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
        par.c[name] = makeNode('d', user, name === 'appdata' ? 'rw------' : DIR_MODE);
      } else {
        const f = makeNode('f', user);
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
    const f = makeNode('f', user);
    f.d = DESKTOP_NOTE;
    d.c['桌面便签.txt'] = f;
    d.m = Date.now();
  }
  const welcome = joinPath(home, 'documents/欢迎使用.txt');
  if (!node(welcome)) {
    const d = node(joinPath(home, 'documents'));
    const f = makeNode('f', user);
    f.d = WELCOME;
    d.c['欢迎使用.txt'] = f;
    d.m = Date.now();
  }
  const guide = joinPath(home, 'documents/应用开发指南.md');
  if (!node(guide)) {
    const d = node(joinPath(home, 'documents'));
    const f = makeNode('f', user);
    f.d = DEVGUIDE;
    d.c['应用开发指南.md'] = f;
    d.m = Date.now();
  }
  emit('ensure-home', home);
  return true;
}

/* 登录 / 注册 / 系统建号 → 自动准备家目录;改登录名 → 家目录目录名跟随 */
subscribe('accounts:changed', (payload, msg) => {
  const t = msg?.type;
  const u = payload?.user || accounts.current();
  if ((t === 'login' || t === 'created' || t === 'register') && u) ensureUserHome(u);
  if (t === 'renamed' && payload?.from && payload?.to) {
    const run = () => {
      const oldHome = node(`/home/${payload.from}`);
      if (!oldHome || oldHome.t !== 'd') { ensureUserHome(payload.to); return; }
      if (node(`/home/${payload.to}`)) return;   // 目标已存在:不动旧目录
      const homeDir = node('/home');
      if (!homeDir || homeDir.t !== 'd') return;
      delete homeDir.c[payload.from];
      homeDir.c[payload.to] = oldHome;
      homeDir.m = Date.now();
      oldHome.m = Date.now();
      // 内容文件按 rename 语义记 dirty/removed,让 fsdata 跟着搬家
      const oldNorm = `/home/${payload.from}`, newNorm = `/home/${payload.to}`;
      for (const f of walkSubtree(oldHome, newNorm)) {
        dirtyPaths.set(f.path, { copyFrom: f.rel ? oldNorm + '/' + f.rel : oldNorm });
      }
      removedPaths.add(oldNorm);
      emit('rename', newNorm);
    };
    if (fsBooted) run();
    else fsReady().then(() => { try { run(); } catch { /* 忽略 */ } });
  }
});

/* ---------- 文件系统 API ---------- */
export const fs = {
  normPath, basename, parentPath, joinPath, homePath, desktopPath, ensureUserHome,
  /** 首次 OPFS 装载/迁移完成(启动序列应 await) */
  ready: fsReady,
  /** 存储后端(OPFS 唯一,无降级;保留接口供监视器/设置展示) */
  storageBackend: () => 'opfs',

  exists: (p) => !!node(p),
  isDir: (p) => node(p)?.t === 'd',

  /** 属主 + 显示用 9 位权限(组位 = 其他位,无组概念) */
  modeString(n) {
    return mode9Of(n);
  },

  stat(p, opts = {}) {
    const n = node(p);
    if (!n) return null;
    if (!allow(p, 'r', actor(opts))) return null;   // 元数据也算读:无读权限连 stat 都不给
    return {
      name: basename(p), path: normPath(p),
      dir: n.t === 'd',
      size: inodeSize(n),
      mtime: n.m || 0,
      owner: ownerName(ownerUid(n)),
      mode: this.modeString(n),
      mode6: String(n.p || FILE_MODE).padEnd(6, '-').slice(0, 6),
      ownerUid: ownerUid(n),
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
        owner: ownerName(ownerUid(ch)),
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
    if (!fsBooted) await fsReady();   // 快照索引装载完成后再动 backing(COW 遮蔽依赖它)
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
      // 穿越免费:在父目录里新建只需父目录 w
      if (!allow(parPath, 'w', user)) return false;
      const mkdirOpts = { silent: true };
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'as') && opts.as !== undefined) {
        mkdirOpts.as = opts.as;
      }
      const par = this.mkdir(parPath, mkdirOpts);
      if (!par) return false;
      if (par.c[name]) return false;
      n = makeNode('f', opts.owner || user || 'root', opts.mode);
      n.bin = true;
      par.c[name] = n;
      par.m = Date.now();
    } else if (!allow(p, 'w', user)) {
      return false;
    }

    await cowGuard(path);   // COW:就地覆写 backing 前,先遮蔽引用它的快照
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
    // 穿越免费:在父目录里新建只需父目录 w
    if (!allow(parPath, 'w', user)) return false;
    // 父目录补齐:仅在显式指定了 as 时传入,避免 as:undefined 被当成无身份
    const mkdirOpts = { silent: true };
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'as') && opts.as !== undefined) {
      mkdirOpts.as = opts.as;
    }
    const par = this.mkdir(parPath, mkdirOpts);
    if (!par) return false;
    if (par.c[name]) return false;
    const n = makeNode('f', opts.owner || user || 'root', opts.mode);
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
        // 新建子目录:只需当前目录可写(穿越免费;root 免检)
        if (!modeFor(n, user).w) return null;
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

  /** 删除文件或目录(含子内容);缺 x 管理位时拒绝(root 除外) */
  rm(p, opts = {}) {
    const user = actor(opts);
    const par = node(parentPath(p));
    const name = basename(p);
    if (!par || !par.c[name]) return false;
    if (!allow(parentPath(p), 'w', user)) return false;
    const victim = par.c[name];
    if (!canManage(victim, user)) return false;   // 缺 x 管理位:不可删
    if ((user !== 'root' && ownerUid(victim) !== uidOfActor(user)) && !modeFor(victim, user).w) return false;
    delete par.c[name];
    removedPaths.add(normPath(p));   // fsdata 遗留待清理
    par.m = Date.now();
    emit('rm', p);
    return true;
  },

  /** 移动/重命名;源节点缺 x 管理位时拒绝(root 除外) */
  rename(oldP, newP, opts = {}) {
    const user = actor(opts);
    const par = node(parentPath(oldP));
    const name = basename(oldP);
    if (!par || !par.c[name]) return false;
    if (!allow(parentPath(oldP), 'w', user)) return false;
    if (!allow(parentPath(newP), 'w', user)) return false;
    const n = par.c[name];
    if (!canManage(n, user)) return false;   // 缺 x 管理位:不可改名/移动
    delete par.c[name];
    const dstPar = this.mkdir(parentPath(newP), { silent: true, ...opts });
    if (!dstPar) { par.c[name] = n; return false; }
    dstPar.c[basename(newP)] = n;
    n.m = Date.now();
    // 子树搬移:文本文件靠 mtime 即可重写;随机写文件(内容仅在 OPFS)需按 copyFrom 复制字节
    const oldNorm = normPath(oldP), newNorm = normPath(newP);
    for (const f of walkSubtree(n, newNorm)) {
      dirtyPaths.set(f.path, { copyFrom: f.rel ? oldNorm + '/' + f.rel : oldNorm });
    }
    removedPaths.add(oldNorm);
    emit('rename', newP);
    return true;
  },

  /** chmod:mode 为 6 位 "rwxrwx" 或 4 位八进制如 "755"(映射为 6 位) */
  chmod(p, mode, opts = {}) {
    const n = node(p);
    if (!n) return false;
    const user = actor(opts);
    if (!user) return false;
    if (user !== 'root' && ownerUid(n) !== uidOfActor(user)) return false;   // 仅属主或 root 可改
    if (!canManage(n, user)) return false;   // 缺 x 管理位:chmod 同拒,授权须 root
    let m6;
    if (/^[0-7]{4}$/.test(String(mode))) {
      // 四位八进制:忽略特殊位,取属主 + 其他(无用户组)
      const s = String(mode);
      const bits = (d) => ((d & 4) ? 'r' : '-') + ((d & 2) ? 'w' : '-') + ((d & 1) ? 'x' : '-');
      m6 = bits(parseInt(s[1], 8)) + bits(parseInt(s[3], 8));
    } else if (/^[0-7]{2}$/.test(String(mode))) {
      // 两位八进制:属主 + 其他(本系统无用户组),如 chmod 70 = rwx----(新文件默认)
      const bits = (d) => ((d & 4) ? 'r' : '-') + ((d & 2) ? 'w' : '-') + ((d & 1) ? 'x' : '-');
      m6 = bits(parseInt(String(mode)[0], 8)) + bits(parseInt(String(mode)[1], 8));
    } else if (/^[rwxt-]{6,}$/.test(String(mode))) {
      m6 = String(mode).padEnd(6, '-').slice(0, 6);
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
    if (typeof newOwner === 'number') n.o = newOwner;
    else {
      const u = uidOfActor(newOwner);
      if (u < 0) return false;           // 无此用户
      n.o = u;
    }
    n.m = Date.now();
    emit('chown', p);
    return true;
  },

  /* ---------- 快照与 COW ----------
   * 快照按创建者(root 或属主)可见;内容引用 + 遮蔽见文件头。 */
  snapshots: {
    /**
     * 创建快照(O(节点数),不拷内容)。
     * @returns {Promise<{id,name,path,at,files,dirs}|null>} 仅属主或 root 可建
     */
    async create(p, opts = {}) {
      if (!fsBooted) await fsReady();
      const path = normPath(p);
      const n = node(path);
      if (!n) return null;
      const user = actor(opts);
      if (!user) return null;
      if (user !== 'root' && ownerUid(n) !== uidOfActor(user)) return null;
      const tree = cloneForSnapshot(n, path);
      let files = 0, dirs = 0;
      for (const { node: sn } of walkSnapNodes(tree)) {
        if (sn.t === 'f') {
          files++;
          if (sn.gen == null && sn.ref) {
            if (!unshadowedRefs.has(sn.ref)) unshadowedRefs.set(sn.ref, []);
            unshadowedRefs.get(sn.ref).push({ node: sn });
          }
        } else dirs++;
      }
      const it = {
        id: snaps.nextId++,
        name: String(opts.name ?? `snap-${snaps.items.length + 1}`),
        path, at: Date.now(),
        user: uidOfActor(user),
        files, dirs, tree,
      };
      snaps.items.push(it);
      snapsDirty = true;
      emit('snapshot-create', path);
      return { id: it.id, name: it.name, path: it.path, at: it.at, files: it.files, dirs: it.dirs };
    },

    /** 快照清单(root 全量;普通用户仅自己创建的) */
    list(opts = {}) {
      const user = actor(opts);
      const uid = uidOfActor(user);
      return snaps.items
        .filter((it) => user === 'root' || it.user === uid)
        .map((it) => ({ id: it.id, name: it.name, path: it.path, at: it.at, files: it.files, dirs: it.dirs, owner: ownerName(it.user) }))
        .sort((a, b) => a.id - b.id);
    },

    /** 列快照内目录(元数据,同步);rel 相对快照根,如 'documents' */
    readDir(id, rel = '', opts = {}) {
      const it = findSnap(id);
      if (!it || !snapOwnedBy(it, actor(opts))) return null;
      const n = snapNodeAt(it.tree, rel);
      if (!n || n.t !== 'd') return null;
      return Object.entries(n.c)
        .map(([name, ch]) => ({
          name, dir: ch.t === 'd',
          size: inodeSize(ch),
          mtime: ch.m || 0,
          owner: ownerName(ownerUid(ch)),
          mode: mode9Of(ch),
        }))
        .sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
    },

    /** 读快照内文件(COW:未分叉读活跃内容,分叉读遮蔽域);
     *  文本 → string,二进制 → Uint8Array;无权限/不存在 → null */
    async readFile(id, rel = '', opts = {}) {
      if (!fsBooted) await fsReady();
      const it = findSnap(id);
      if (!it || !snapOwnedBy(it, actor(opts))) return null;
      const n = snapNodeAt(it.tree, rel);
      if (!n || n.t !== 'f') return null;
      return await snapReadFile(n);
    },

    /**
     * 恢复快照到其原路径:整棵子树替换为快照时状态(权限口径同 rm:
     * 父目录 w + 目标可管理)。快照本身不受影响,可反复恢复。
     * @returns {Promise<boolean>}
     */
    async restore(id, opts = {}) {
      if (!fsBooted) await fsReady();
      const it = findSnap(id);
      if (!it) return false;
      const user = actor(opts);
      if (!snapOwnedBy(it, user)) return false;
      const path = normPath(it.path);
      // 整树快照:换根(basename('/') === '/',走常规分支会挂出名为 '/' 的怪孩子);
      // 快照克隆不含 v/xs 引导字段,换根时补回,否则下次装载按版本不符清盘
      if (path === '/') {
        if (user !== 'root') return false;              // 根属 root,恢复同理
        const freshRootTree = await materializeSnap(it.tree, '/');
        freshRootTree.v = FS_VERSION;
        freshRootTree.xs = 1;
        // 全部文件显式置脏(恢复保留旧 mtime,不触发 m>=persistMark 的常规写);
        // 恢复后树上不存在的旧路径成为 fsdata 垃圾,无害不清(与 rm 重建同口径)
        for (const f of walkSubtree(freshRootTree, '/')) dirtyPaths.set(f.path, {});
        root = freshRootTree;
        emit('snapshot-restore', '/');
        return true;
      }
      const parPath = parentPath(path), name = basename(path);
      const par = node(parPath);
      if (!par || par.t !== 'd') return false;          // 父目录须在(路径被改名/删则手工挪回)
      if (!allow(parPath, 'w', user)) return false;
      const old = par.c[name];
      if (old) {
        if (!canManage(old, user)) return false;        // 替换 = 删除重建,与 rm 同门
        if (user !== 'root' && ownerUid(old) !== uidOfActor(user) && !modeFor(old, user).w) return false;
      }
      const fresh = await materializeSnap(it.tree, path);
      if (old) removedPaths.add(path);                  // fsdata 遗留簿记(遮蔽先行)
      // 恢复保留原 mtime → 不满足 m>=persistMark 的常规写,显式置脏全部文件
      for (const f of walkSubtree(fresh, path)) dirtyPaths.set(f.path, {});
      par.c[name] = fresh;
      par.m = Date.now();
      emit('snapshot-restore', path);
      return true;
    },

    /** 删除快照(创建者或 root);无主遮蔽内容随之回收 */
    async remove(id, opts = {}) {
      if (!fsBooted) await fsReady();
      const it = findSnap(id);
      if (!it) return false;
      if (!snapOwnedBy(it, actor(opts))) return false;
      snaps.items = snaps.items.filter((x) => x !== it);
      reindexSnaps();
      snapsDirty = true;
      emit('snapshot-remove', it.path);
      await gcShadows();
      return true;
    },
  },

  /** 当前会话用户(未登录 null) */
  currentUser: () => accounts.current(),

  /** 是否允许 user 对 path 做 r/w(bit 也可传 'x' 查管理位;应用级 API 经 AppFS 调用) */
  can(p, bit, user = accounts.current()) {
    return allow(p, bit, user);
  },
  /** 父目录链结构上存在即可穿越(不查权限;存在性/进入前提) */
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
    if (tree?.t === 'd') {
      migrateOwnerUids(tree);
      migrateDirTraverseX(tree);
      root = tree;
      // 整树替换:原树全部路径不复存在,快照引用全部悬空 → 整体废弃
      snaps = { nextId: 1, nextGen: 1, items: [] };
      reindexSnaps();
      snapsDirty = true;
      opfsRemovePath(SHADOW_DIR).catch(() => {});   // 尽力清理遮蔽域
      persistMark = 0;   // 外部整树导入:内容全部重写一次
      emit('import', '/');
      return true;
    }
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
