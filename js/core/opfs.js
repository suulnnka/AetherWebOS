/* ============================================================
 * OPFS —— Origin Private File System 读写(由 js/core/fs.js 托管)
 *
 * 布局(webos/ 下):
 *   fs.v2.json          虚拟文件系统元数据树(inode 式,无文件内容)
 *   fsdata/<绝对路径>     文件内容(文本或二进制,如 …/sms.awdb)
 *   其余键(设置/账号等)仍在 localStorage
 *
 * 支持整文件与**按偏移随机读写**(opfsReadSlice / opfsWriteAt)。
 * 库(AetherWebDatabase)不得直接调用本模块,只经 fs.* 托管。
 * 路径可含 `/`,写入时自动创建中间目录。
 * 无 OPFS 时降级 localStorage 键 `webos.opfs.<path>`(base64)。
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

const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 读二进制;不存在 → null(无 OPFS 时 base64 存 localStorage 键) */
export async function opfsReadBytes(path) {
  if (!hasOpfs()) {
    try {
      const s = localStorage.getItem(LS_PREFIX + path);
      return s == null ? null : unb64(s);
    } catch { return null; }
  }
  try {
    const fh = await fileHandle(path, false);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/** 写二进制(覆盖);path 支持多级目录 */
export async function opfsWriteBytes(path, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!hasOpfs()) {
    localStorage.setItem(LS_PREFIX + path, b64(data));
    return true;
  }
  const fh = await fileHandle(path, true);
  const w = await fh.createWritable();
  try {
    await w.write(data);
  } finally {
    await w.close();
  }
  return true;
}

/**
 * 按偏移读字节(随机读)。文件不存在或区间无数据 → 返回实际短切片/null。
 * @param {string} path
 * @param {number} offset
 * @param {number} length
 */
export async function opfsReadSlice(path, offset, length) {
  const off = Math.max(0, offset | 0);
  const len = Math.max(0, length | 0);
  if (!hasOpfs()) {
    const full = await opfsReadBytes(path);
    if (!full) return null;
    if (off >= full.length) return new Uint8Array(0);
    return full.slice(off, Math.min(off + len, full.length));
  }
  try {
    const fh = await fileHandle(path, false);
    const file = await fh.getFile();
    if (off >= file.size) return new Uint8Array(0);
    const end = Math.min(off + len, file.size);
    return new Uint8Array(await file.slice(off, end).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 按偏移写字节(随机写);自动扩文件。
 * OPFS: createWritable({keepExistingData}) + write(offset, data)。
 * 无 OPFS: 对 localStorage base64 整串做读-改-写。
 */
export async function opfsWriteAt(path, data, offset) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const off = Math.max(0, offset | 0);
  if (!hasOpfs()) {
    try {
      let full = await opfsReadBytes(path);
      if (!full) full = new Uint8Array(0);
      const need = off + bytes.length;
      if (need > full.length) {
        const next = new Uint8Array(need);
        next.set(full);
        full = next;
      }
      full.set(bytes, off);
      localStorage.setItem(LS_PREFIX + path, b64(full));
      return true;
    } catch {
      return false;
    }
  }
  try {
    const fh = await fileHandle(path, true);
    const w = await fh.createWritable({ keepExistingData: true });
    try {
      await w.write(off, bytes);
    } finally {
      await w.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** 文件字节数;不存在 → 0 */
export async function opfsFileSize(path) {
  if (!hasOpfs()) {
    try {
      const s = localStorage.getItem(LS_PREFIX + path);
      return s == null ? 0 : unb64(s).length;
    } catch { return 0; }
  }
  try {
    const fh = await fileHandle(path, false);
    const file = await fh.getFile();
    return file.size;
  } catch {
    return 0;
  }
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
