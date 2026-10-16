/* ============================================================
 * Trash —— 回收站(桌面式删除的安全网)
 *
 * 每个用户一个回收站目录:~/\.trash/
 *   items/t<n>   被删条目原样搬入(rename 保内容/权限/属主,目录整棵)
 *   meta.json    还原信息:{ seq, items: { t<n>: { name, orig, at, dir } } }
 *
 * 删除(桌面 / 文件管家)= rename 进筒:可逆、内容零拷贝,与快照
 * (高级玩家的整树保险丝)互补。还原按原路径放回;原位置被占则
 * 「名称 (2)」避让,原父目录已不存在则落回家目录。彻底删除 =
 * rm(属主权限,冻结条目由 root 兜底——回收站是系统代管区,
 * 清空是属主的显式意图)。
 * ============================================================ */
import fs, { homePath } from './fs.js';
import { accounts } from './accounts.js';
import { publish } from './bus.js';

const META = 'meta.json';
const ITEMS = 'items';

/** user 的回收站目录;未登录 null */
export function trashPath(user = accounts.current()) {
  const h = homePath(user);
  return h ? `${h}/.trash` : null;
}

/** 确保回收站目录结构就绪,返回 items 目录路径;失败 null */
function ensureDirs(user) {
  const t = trashPath(user);
  if (!t) return null;
  const opts = { as: user, owner: user };
  if (!fs.isDir(t)) fs.mkdir(t, opts);
  const items = fs.joinPath(t, ITEMS);
  if (!fs.isDir(items)) fs.mkdir(items, opts);
  return fs.isDir(items) ? items : null;
}

/* meta.json 读写(属主本人) */
function metaPath(user) {
  return fs.joinPath(trashPath(user), META);
}
function loadMeta(user) {
  try {
    const raw = fs.read(metaPath(user), { as: user });
    const m = raw ? JSON.parse(raw) : null;
    if (m && typeof m.seq === 'number' && m.items && typeof m.items === 'object') return m;
  } catch { /* 损坏按空筒 */ }
  return { seq: 1, items: {} };
}
function saveMeta(user, meta) {
  fs.write(metaPath(user), JSON.stringify(meta), { as: user, owner: user });
}

const changed = (user, action) =>
  publish('sys:trash-changed', { from: 'trash', type: 'trash-changed', payload: { user, action } });

/** 路径是否在回收站内(禁止把回收站自己扔进自己) */
export function isTrashPath(p, user = accounts.current()) {
  const t = trashPath(user);
  return !!t && (p === t || String(p).startsWith(t + '/'));
}

/**
 * 把若干路径移入回收站(rename 语义,零内容拷贝)。
 * 批量搬移走 fs.batch:一次合并广播 + 一趟确定性落盘(同步主体在批内
 * 完成,收尾异步落定)。@returns {number} 成功移入的条数
 */
export function moveToTrash(paths, user = accounts.current()) {
  if (!user || !Array.isArray(paths)) return 0;
  const itemsDir = ensureDirs(user);
  if (!itemsDir) return 0;
  const meta = loadMeta(user);
  let n = 0;
  fs.batch(() => {
    for (const p of paths) {
      if (!p || isTrashPath(p, user)) continue;
      const st = fs.stat(p, { as: user });
      if (!st) continue;
      const key = 't' + (meta.seq++);
      if (!fs.rename(p, fs.joinPath(itemsDir, key), { as: user })) continue;
      meta.items[key] = { name: st.name, orig: st.path, at: Date.now(), dir: st.dir };
      n++;
    }
    if (n) saveMeta(user, meta);
  }).catch(() => {});
  if (n) changed(user, 'add');
  return n;
}

/**
 * 回收站清单(顺手清掉 items 里已不存在的死条目)。
 * @returns {Array<{key,name,orig,at,dir,size}>}
 */
export function listTrash(user = accounts.current()) {
  if (!user) return [];
  const t = trashPath(user);
  const itemsDir = fs.joinPath(t, ITEMS);
  if (!t || !fs.isDir(itemsDir)) return [];
  const meta = loadMeta(user);
  const out = [];
  let dead = false;
  for (const [key, info] of Object.entries(meta.items)) {
    const p = fs.joinPath(itemsDir, key);
    const st = fs.stat(p, { as: user });
    if (!st) { delete meta.items[key]; dead = true; continue; }
    out.push({
      key, path: p,
      name: info?.name || st.name,
      orig: info?.orig || '',
      at: info?.at || st.mtime,
      dir: !!info?.dir,
      size: st.size,
    });
  }
  out.sort((a, b) => b.at - a.at);
  if (dead) saveMeta(user, meta);
  return out;
}

export const trashCount = (user = accounts.current()) => listTrash(user).length;

/** 目标已占用时的避让名:「报告 (2).txt」 */
function uniqueName(dir, name) {
  if (!fs.exists(fs.joinPath(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const c = `${base} (${i})${ext}`;
    if (!fs.exists(fs.joinPath(dir, c))) return c;
  }
}

/**
 * 还原条目:回原路径;原父目录没了 → 落家目录;重名 → 避让名。
 * 循环走 fs.batch(一次合并广播 + 一趟确定性落盘)。
 * @returns {boolean} 是否全部成功
 */
export function restoreItems(keys, user = accounts.current()) {
  if (!user) return false;
  const itemsDir = ensureDirs(user);
  if (!itemsDir) return false;
  const meta = loadMeta(user);
  let ok = true;
  fs.batch(() => {
    for (const key of keys) {
      const info = meta.items[key];
      const src = fs.joinPath(itemsDir, key);
      if (!info || !fs.exists(src)) { delete meta.items[key]; ok = false; continue; }
      let destDir = fs.parentPath(info.orig || '');
      if (!destDir || !fs.isDir(destDir)) destDir = homePath(user) || '/home/' + user;
      const dest = fs.joinPath(destDir, uniqueName(destDir, info.name || fs.basename(src)));
      if (fs.rename(src, dest, { as: user })) delete meta.items[key];
      else ok = false;
    }
    saveMeta(user, meta);
  }).catch(() => {});
  changed(user, 'restore');
  return ok;
}

/** 彻底删除条目(rm;冻结条目 root 兜底) */
export function purgeItems(keys, user = accounts.current()) {
  if (!user) return false;
  const itemsDir = ensureDirs(user);
  if (!itemsDir) return false;
  const meta = loadMeta(user);
  fs.batch(() => {
    for (const key of keys) {
      const p = fs.joinPath(itemsDir, key);
      if (!fs.rm(p, { as: user })) fs.rm(p, { as: 'root' });   // 回收站代管区:清空是属主显式意图
      delete meta.items[key];
    }
    saveMeta(user, meta);
  }).catch(() => {});
  changed(user, 'purge');
  return true;
}

/** 清空回收站 */
export function emptyTrash(user = accounts.current()) {
  const list = listTrash(user);
  if (!list.length) return true;
  return purgeItems(list.map(i => i.key), user);
}

export default { trashPath, isTrashPath, moveToTrash, listTrash, trashCount, restoreItems, purgeItems, emptyTrash };
