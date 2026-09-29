/* ============================================================
 * mdopen —— Markdown 超链接的系统级打开路由
 *
 * 编辑器 / 文件预览里渲染出的 <a> 点击统一走这里:
 *  · http(s) 网址 → 系统浏览器打开
 *  · 本地路径(绝对,或相对文档所在目录)→ 按扩展名分流,
 *    与桌面 / 文件管家同规则:.md → Markdown 编辑器,
 *    图片/PDF/音视频 → 文件预览,目录 → 文件管家,其余 → 记事本
 *  · 其余协议(mailto: 等)→ 提示不支持
 * ============================================================ */
import { fs } from './fs.js';
import * as wm from './wm.js';
import { publish } from './bus.js';

const PREVIEW_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp3|wav|ogg|flac|m4a|mp4|webm|mkv|mov|avi|pdf)$/i;

/** 打开 markdown 链接;返回是否成功路由 */
export function openMdLink(url, docPath = null) {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) {
    wm.open('browser', { params: { url: u } });
    return true;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {                // mailto: 等其他协议
    publish('sys:notify', { from: 'mdopen', type: 'notify', payload: { title: '暂不支持该链接协议', body: u } });
    return false;
  }
  let p = u.split('#')[0].trim();
  if (!p) return false;
  if (!p.startsWith('/')) {                                 // 相对路径:按文档目录解析
    const base = docPath ? docPath.slice(0, docPath.lastIndexOf('/')) : (fs.homePath() || '/home');
    p = fs.normPath(base + '/' + p);
  } else {
    p = fs.normPath(p);
  }
  if (!fs.exists(p)) {
    publish('sys:notify', { from: 'mdopen', type: 'notify', payload: { title: '链接目标不存在', body: p } });
    return false;
  }
  const name = fs.basename(p);
  if (fs.isDir(p)) { wm.open('files', { params: { path: p } }); return true; }
  if (/\.md$/i.test(name)) { wm.open('mdedit', { params: { path: p } }); return true; }
  if (PREVIEW_EXT.test(name)) { wm.open('viewer', { params: { path: p } }); return true; }
  wm.open('notes', { params: { path: p } });
  return true;
}
