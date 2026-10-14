/* ============================================================
 * OpenWith —— 文件打开路由与「打开方式」关联
 *
 * 统一桌面 / 文件管家 / Markdown 链接的文件打开分流:
 *   用户默认关联(localStorage,按扩展名)> 内置默认 > 记事本兜底。
 * askOpenWith() 弹「打开方式」选择器(可选「始终用此应用打开 .ext」),
 * 关联可在系统设置 → 应用 里查看与清除。
 * ============================================================ */
import fs from './fs.js';
import * as wm from './wm.js';
import { el } from './utils.js';
import { icon } from './icons.js';
import { get as getApp } from './registry.js';
import { publish } from './bus.js';

const KEY = 'webos.openwith.v1';

/** 与文件管家 / viewer MIME 同口径(三处原各自为政,收敛于此) */
export const PREVIEW_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp3|wav|ogg|flac|m4a|mp4|webm|mkv|mov|avi|pdf)$/i;
/** 代码编辑器语言(js/lib/chl.js CODE_EXT_RE 的同步副本:core 不引 lib,防高亮器进 core 包) */
export const CODE_EXT = /\.(ajs|js|css|html?|json)$/i;

/** 候选打开方式(顺序即菜单顺序;match 决定谁出现在选择器里) */
const OPENERS = [
  { id: 'mdedit', label: 'Markdown 编辑器', desc: '所见即所得编辑 .md 文档', match: (n) => /\.(md|markdown)$/i.test(n) },
  { id: 'sheet', label: '电子表格', desc: '编辑 .axl 表格(列宽 / 样式 / 缩放)', match: (n) => /\.axl$/i.test(n) },
  { id: 'codeedit', label: '代码编辑器', desc: 'AetherJS / CSS / HTML / JSON 高亮与运行', match: (n) => CODE_EXT.test(n) },
  { id: 'viewer', label: '文件预览', desc: '图片、音视频与 PDF', match: (n) => PREVIEW_EXT.test(n) },
  { id: 'notes', label: '记事本', desc: '纯文本,任何文件都能看', match: () => true },
];

/** 内置默认(无用户关联时):查不到再兜底记事本 */
const BUILTIN = {
  md: 'mdedit', markdown: 'mdedit',
  axl: 'sheet',
  ajs: 'codeedit', js: 'codeedit', css: 'codeedit', html: 'codeedit', htm: 'codeedit', json: 'codeedit',
  txt: 'notes', log: 'notes',
};
for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mkv', 'mov', 'avi', 'pdf']) {
  BUILTIN[ext] = 'viewer';
}

/* ---------- 用户默认关联(localStorage) ---------- */

function loadAssoc() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function saveAssoc(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* 忽略 */ }
  publish('sys:openwith-changed', { from: 'openwith', type: 'openwith-changed', payload: {} });
}

export const extOf = (name) => {
  const m = /\.([^.]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

/** 当前全部用户关联(设置页展示):{ ext: appId } */
export function associations() {
  return { ...loadAssoc() };
}

/** 设置 / 清除默认关联(appId 为 null 时清除,回落内置默认) */
export function setDefault(ext, appId) {
  const map = loadAssoc();
  if (appId) map[ext] = appId;
  else delete map[ext];
  saveAssoc(map);
}

/** 该文件名当前生效的打开方式 appId */
export function defaultFor(name) {
  const ext = extOf(name);
  const assoc = loadAssoc()[ext];
  if (assoc && getApp(assoc)) return assoc;
  const builtin = BUILTIN[ext];
  if (builtin && getApp(builtin)) return builtin;
  return 'notes';
}

/** 用指定应用打开文件(应用不存在返回 false) */
export function openWith(path, appId) {
  const app = getApp(appId);
  if (!app) return false;
  wm.open(appId, { params: { path: fs.normPath(path) } });
  return true;
}

/** 按默认关联打开(桌面 / 文件管家双击的统一入口) */
export function openFs(path) {
  return openWith(path, defaultFor(fs.basename(path)));
}

/**
 * 「打开方式…」选择器:候选应用列表 + 「始终用此应用打开 .ext」。
 * 级别 1(非模态):从右键菜单唤起,不打断其他操作。
 */
export function askOpenWith(path) {
  const p = fs.normPath(path);
  const name = fs.basename(p);
  const ext = extOf(name);
  const cur = defaultFor(name);
  return wm.popup({
    title: '打开方式',
    icon: 'external',
    width: 470,
    height: 420,
    level: 1,
    mount({ root, close }) {
      const done = () => close(true);
      const list = el('div', { class: 'ow-list' });
      const check = el('input', { type: 'checkbox' });
      for (const op of OPENERS.filter(o => o.match(name))) {
        const app = getApp(op.id);
        if (!app) continue;
        const ico = el('span', { class: 'ow-ico' }, icon(app.icon, 20));
        ico.style.background = app.color || 'var(--accent)';
        list.append(el('button', {
          class: 'ow-item' + (op.id === cur ? ' cur' : ''),
          onClick: () => {
            if (check.checked && ext) setDefault(ext, op.id);
            openWith(p, op.id);
            done();
          },
        },
          ico,
          el('span', { class: 'ow-main' },
            el('b', {}, op.label + (op.id === cur ? '(当前默认)' : '')),
            el('span', { class: 'ow-desc' }, op.desc))));
      }
      root.append(el('div', { class: 'ow' },
        el('div', { class: 'ow-head' },
          el('b', {}, '「' + name + '」'),
          ext ? el('span', { class: 'dim' }, ` .${ext} 文件`) : null),
        list,
        el('label', { class: 'ow-always' }, check,
          ext ? `始终用选择的应用打开 .${ext} 文件` : '始终用选择的应用打开此类文件')));
    },
  }).promise;
}
