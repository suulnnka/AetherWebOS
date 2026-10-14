/* ============================================================
 * Clipboard —— 系统级文件剪贴板(会话级,不落盘)
 *
 * 真实 OS 的剪贴板是系统资源:跨应用、能携带文件。本模块管
 * VFS 文件的复制/剪切/粘贴(文件管家与桌面共用一套状态),
 * 事件 sys:clipboard-changed 供各窗口刷新剪切态与粘贴按钮。
 *
 * 剪贴板里的文本仍走浏览器 Clipboard API(menu.js copyText),
 * 两者互不干扰 —— 这里只补「文件」这一真实 OS 必有而网页没有的半边。
 * ============================================================ */
import fs from './fs.js';
import { accounts } from './accounts.js';
import { publish } from './bus.js';

let clip = null;   // { mode:'copy'|'cut', paths:[...], user } | null

const changed = () =>
  publish('sys:clipboard-changed', { from: 'clipboard', type: 'clipboard-changed', payload: { mode: clip?.mode, n: clip?.paths.length } });

/** 复制 / 剪切若干路径(执行用户缺省 = 当前会话用户,粘贴以其身份执行) */
export function setFiles(mode, paths, user = accounts.current()) {
  clip = (mode === 'cut' || mode === 'copy') && Array.isArray(paths) && paths.length && user
    ? { mode, paths: [...new Set(paths.map(p => fs.normPath(p)))], user }
    : null;
  changed();
}

export function clearFiles() {
  if (!clip) return;
  clip = null;
  changed();
}

/** 当前剪贴板(原样;源可能已被删,粘贴时逐条校验) */
export function get() {
  return clip ? { ...clip, paths: [...clip.paths] } : null;
}

/** 是否有可粘贴内容(源至少一条还在) */
export function hasFiles() {
  return !!clip && clip.paths.some(p => fs.exists(p));
}

/** 剪切态:路径是否正被剪切(待粘贴)—— 文件管家据此把条目淡显 */
export function isCut(path) {
  return clip?.mode === 'cut' && clip.paths.includes(fs.normPath(path));
}

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

/** 读整个文件:普通文件走内存 d;随机访问大文件(bin 无 d)整读字节 */
async function readAll(p, user) {
  const st = fs.stat(p, { as: user });
  let data = fs.read(p, { as: user });
  if (data == null) return null;
  if (data instanceof Uint8Array && data.length === 0 && st && st.size > 0) {
    data = await fs.readAt(p, 0, st.size, { as: user }) ?? data;
  }
  return data;
}

/** 递归复制子树(目录 mkdir,文件 write;权限/属主按新建默认) */
async function copyTree(src, dest, user) {
  const st = fs.stat(src, { as: user });
  if (!st) return false;
  if (st.dir) {
    if (!fs.mkdir(dest, { as: user, owner: user })) return false;
    let ok = true;
    for (const ch of fs.list(src, { as: user }) || []) {
      ok = (await copyTree(ch.path, fs.joinPath(dest, ch.name), user)) && ok;
    }
    return ok;
  }
  const data = await readAll(src, user);
  if (data == null) return false;
  return fs.write(dest, data, { as: user, owner: user });
}

/**
 * 把剪贴板内容粘贴进 dest 目录(执行用户缺省 = 设置剪贴板的用户)。
 * copy → 递归复制(重名避让);cut → rename(源消失,剪贴板清空)。
 * @returns {Promise<{copied:number,moved:number}>}
 */
export async function pasteInto(dest, user = clip?.user) {
  const out = { copied: 0, moved: 0 };
  if (!clip || !user || !fs.isDir(dest)) return out;
  for (const p of clip.paths) {
    // 源已删 / 粘贴进自己或自己的子目录 → 跳过
    if (!fs.exists(p)) continue;
    if (fs.normPath(dest) === p || fs.normPath(dest).startsWith(p + '/')) continue;
    const name = uniqueName(dest, fs.basename(p));
    const target = fs.joinPath(dest, name);
    if (clip.mode === 'cut') {
      if (fs.rename(p, target, { as: user })) out.moved++;
    } else if (await copyTree(p, target, user)) {
      out.copied++;
    }
  }
  if (clip.mode === 'cut') { clip = null; changed(); }   // 剪切是一次性动作
  return out;
}

export default { setFiles, clearFiles, get, hasFiles, isCut, pasteInto };
