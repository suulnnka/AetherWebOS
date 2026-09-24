/* ============================================================
 * OPFS —— Origin Private File System 文本读写
 *
 * 布局(webos/ 下):
 *   fs.v2.json          虚拟文件系统元数据树(inode 式,无文件内容)
 *   fsdata/<绝对路径>     文件内容(如 fsdata/home/u/appdata/sms.awdb)
 *   其余键(设置/账号等)仍在 localStorage
 *
 * 路径可含 `/`,写入时自动创建中间目录。
 * 所有 API 均为 Promise;无 OPFS 时降级 localStorage 键
 * `webos.opfs.<path>`(便于无 OPFS 环境跑通,容量仍受限)。
 * ============================================================ */

const DIR = 'webos';
const LS_PREFIX = 'webos.opfs.';

function hasOpfs() {
  return !!(globalThis.navigator?.storage?.getDirectory);
}

/** 拆成 { dirs: [...], file } —— path 可含多级 */
function splitPath(path) {
  const parts = String(path).split('/').filter(Boolean);
  if (!parts.length) throw new Error('OPFS 路径为空');
  const file = parts.pop();
  return { dirs: parts, file };
}

async function fileHandle(path, create = true) {
  const root = await navigator.storage.getDirectory();
  let dir = await root.getDirectoryHandle(DIR, { create: true });
  const { dirs, file } = splitPath(path);
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir.getFileHandle(file, { create });
}

/** 读文本;不存在 → null */
export async function opfsReadText(path) {
  if (!hasOpfs()) {
    try {
      return localStorage.getItem(LS_PREFIX + path);
    } catch { return null; }
  }
  try {
    const fh = await fileHandle(path, false);
    const file = await fh.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

/** 写文本(覆盖);path 支持多级目录 */
export async function opfsWriteText(path, text) {
  if (!hasOpfs()) {
    localStorage.setItem(LS_PREFIX + path, String(text));
    return true;
  }
  const fh = await fileHandle(path, true);
  const w = await fh.createWritable();
  try {
    await w.write(String(text));
  } finally {
    await w.close();
  }
  return true;
}

/** 删文件(单级,在 webos/ 根下);不存在也返回 true */
export async function opfsRemove(name) {
  if (!hasOpfs()) {
    try { localStorage.removeItem(LS_PREFIX + name); } catch { /* 忽略 */ }
    return true;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: false });
    await dir.removeEntry(name);
  } catch { /* 不存在 */ }
  return true;
}

/** 清空整个 webos OPFS 目录(完全重置用) */
export async function opfsClearAll() {
  if (!hasOpfs()) {
    const gone = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) gone.push(k);
    }
    for (const k of gone) localStorage.removeItem(k);
    return true;
  }
  try {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(DIR, { recursive: true });
      return true;
    } catch {
      const dir = await root.getDirectoryHandle(DIR, { create: false });
      const names = [];
      for await (const [name] of dir) names.push(name);
      for (const name of names) {
        try { await dir.removeEntry(name, { recursive: true }); } catch { /* 忽略 */ }
      }
      try { await root.removeEntry(DIR); } catch { /* 忽略 */ }
      return true;
    }
  } catch {
    return false;
  }
}

/** 是否使用了真实 OPFS(而非 localStorage 降级) */
export const opfsAvailable = hasOpfs;
