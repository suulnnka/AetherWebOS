/* ============================================================
 * OPFS —— Origin Private File System 读写(由 js/core/fs.js 托管)
 *
 * 布局(webos/ 下):
 *   fs.v2.json          虚拟文件系统元数据树(inode 式,无文件内容)
 *   fs.snaps.v1.json    快照注册表(fs.js 快照/COW 层)
 *   fsdata/<绝对路径>     文件内容(文本或二进制,如 …/sms.awdb)
 *   fsshadow/...        快照遮蔽内容(fs.js COW 层)
 *
 * OPFS 是本系统的**硬性前提**:没有 localStorage 降级路径,
 * 不支持 OPFS 的浏览器由启动序列直接拒之门外(system/boot.js)。
 * 因此各函数不再判断 navigator.storage —— 真拿不到句柄时会在
 * 自己的 try/catch 里按「不存在 / 失败」处理(读 → null,
 * 写 → 抛给调用方按持久化失败处理)。
 *
 * 支持整文件与**按偏移随机读写**(opfsReadSlice / opfsWriteAt)。
 * 库(AetherWebDatabase)不得直接调用本模块,只经 fs.* 托管。
 * 路径可含 `/`,写入时自动创建中间目录。
 * ============================================================ */

const DIR = 'webos';

/** OPFS 是否可用(启动门禁用;日常读写不再判断) */
export const opfsAvailable = () => !!(globalThis.navigator?.storage?.getDirectory);

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
  const fh = await fileHandle(path, true);
  const w = await fh.createWritable();
  try {
    await w.write(String(text));
  } finally {
    await w.close();
  }
  return true;
}

/** 读二进制;不存在 → null */
export async function opfsReadBytes(path) {
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
 */
export async function opfsWriteAt(path, data, offset) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const off = Math.max(0, offset | 0);
  try {
    const fh = await fileHandle(path, true);
    const w = await fh.createWritable({ keepExistingData: true });
    try {
      // 注意:write(offset, data) 两参形式不受支持(offset 会被当数据写入),
      // 必须用 WriteParams 形式 { type:'write', position, data }
      await w.write({ type: 'write', position: off, data: bytes });
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
  try {
    const fh = await fileHandle(path, false);
    const file = await fh.getFile();
    return file.size;
  } catch {
    return 0;
  }
}

/**
 * 枚举 webos/ 下某目录的直接子项:返回 [{ name, dir }](dir=true 为子目录)。
 * 快照遮蔽层的垃圾回收用它扫 fsshadow/;目录不存在 → null。
 */
export async function opfsList(path) {
  const segs = String(path).split('/').filter(Boolean);
  try {
    let dir = await navigator.storage.getDirectory();
    dir = await dir.getDirectoryHandle(DIR, { create: false });
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: false });
    const out = [];
    for await (const [name, h] of dir) out.push({ name, dir: h.kind === 'directory' });
    return out;
  } catch {
    return null;
  }
}

/**
 * 按多级路径删除 webos/ 下的文件或目录(递归)。
 * path 形如 'fsdata/home/<user>/x'(不含 webos 前缀);不存在也返回 true。
 */
export async function opfsRemovePath(path) {
  const segs = String(path).split('/').filter(Boolean);
  if (!segs.length) return false;
  try {
    let dir = await navigator.storage.getDirectory();
    dir = await dir.getDirectoryHandle(DIR, { create: false });
    const name = segs.pop();
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: false });
    await dir.removeEntry(name, { recursive: true });
    return true;
  } catch { /* 不存在或父目录已删 */ }
  return true;
}

/** 清空整个 webos OPFS 目录(完全重置用) */
export async function opfsClearAll() {
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
