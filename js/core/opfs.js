/* ============================================================
 * OPFS —— Origin Private File System 文本读写
 *
 * 布局:
 *   <origin>/webos/fs.v2.json     虚拟文件系统整棵树
 *   其余键(设置/账号等)仍在 localStorage
 *
 * 所有 API 均为 Promise;OPFS 不可用时降级为 localStorage 键
 * `webos.opfs.<name>`(便于无 OPFS 环境跑通,容量仍受限)。
 * ============================================================ */

const DIR = 'webos';
const LS_PREFIX = 'webos.opfs.';

function hasOpfs() {
  return !!(globalThis.navigator?.storage?.getDirectory);
}

async function dirHandle(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

async function fileHandle(name, create = true) {
  const dir = await dirHandle(true);
  return dir.getFileHandle(name, { create });
}

/** 读文本;不存在 → null */
export async function opfsReadText(name) {
  if (!hasOpfs()) {
    try {
      const v = localStorage.getItem(LS_PREFIX + name);
      return v;
    } catch { return null; }
  }
  try {
    const fh = await fileHandle(name, false);
    const file = await fh.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

/** 写文本(覆盖) */
export async function opfsWriteText(name, text) {
  if (!hasOpfs()) {
    localStorage.setItem(LS_PREFIX + name, String(text));
    return true;
  }
  const fh = await fileHandle(name, true);
  const w = await fh.createWritable();
  try {
    await w.write(String(text));
  } finally {
    await w.close();
  }
  return true;
}

/** 删文件;不存在也返回 true */
export async function opfsRemove(name) {
  if (!hasOpfs()) {
    try { localStorage.removeItem(LS_PREFIX + name); } catch { /* 忽略 */ }
    return true;
  }
  try {
    const dir = await dirHandle(false);
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
    // removeEntry recursive:需浏览器支持;不支持则逐项删
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
