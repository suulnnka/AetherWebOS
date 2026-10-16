/* ============================================================
 * i18n —— 界面语言运行时(中文即键,gettext 式)
 *
 * 约定(docs/i18n.md §4):
 *   - t('新建') 在 zh 下恒等返回,en 下查字典回落键本身;
 *   - 字典按语言注册(每单元自有 i18n/en.js,文件内自注册),
 *     registerDict 多次调用对同一语言做合并;
 *   - 带参数的文案用 {name} 占位符:zh 回落串同样做插值,
 *     保证「运行时拼接串不可作键」的改写在中英文下行为一致;
 *   - 持久化枚举值(商店 category 等)以中文值为稳定标识,
 *     值进数据作身份,只在显示层过 t()。
 *
 * 依赖方向(勿成环):i18n → store → bus → utils(utils 是叶子,
 * utils.js 不得反向引用本模块;旧版 zh 日期工具保留在 utils,
 * 本模块的 fmtDate/fmtTime/fmtDateTime 是本地化版本,P1/P2 逐应用迁移)。
 * ============================================================ */
import { settings } from './store.js';
import { subscribe, publish } from './bus.js';

const dicts = new Map();          // 语言码('en')→ { zhKey: 译文 }
const changeCbs = new Set();

/** 注册 / 合并某语言的字典(各单元 i18n/<lang>..js 文件内自调用) */
export function registerDict(lang, tbl) {
  dicts.set(lang, Object.assign(dicts.get(lang) || {}, tbl));
}

/** 设置里的原始值:'auto' | 'zh-CN' | 'en-US' */
export const currentLocale = () => settings.get('locale') || 'zh-CN';

/** 解析为 BCP-47 标签:'auto' 跟随浏览器,en 家族归一 en-US,其余回落 zh-CN */
export function localeTag() {
  const v = currentLocale();
  if (v && v !== 'auto') return v;
  const n = navigator.language || 'zh-CN';
  return /^en/i.test(n) ? 'en-US' : 'zh-CN';
}

const langOf = (tag) => String(tag).split('-')[0].toLowerCase();

/** 查表翻译 + {var} 插值;zh 恒等(仅插值),未命中的键原样返回 */
export function t(key, params) {
  let s = key;
  const lang = langOf(localeTag());
  if (lang !== 'zh') {
    const tbl = dicts.get(lang);
    if (tbl && tbl[key] != null) s = tbl[key];
  }
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  return s;
}

/** 复数预留:目前与 t(key, { n }) 等价,译文可按需扩展 */
export const tn = (key, n) => t(key, { n });

export function onLocaleChange(fn) {
  changeCbs.add(fn);
  return () => changeCbs.delete(fn);
}

/* ---- 日期时间(zh 分支与 utils.js 旧版逐字节一致,e2e 依赖) ---- */
const WEEK_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

export function fmtDate(d = new Date(), withWeek = false) {
  const date = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
  if (!withWeek) return date;
  return langOf(localeTag()) === 'en'
    ? `${WEEK_EN[d.getDay()]} ${date}`
    : `${date} 周${WEEK_ZH[d.getDay()]}`;
}

export const fmtTime = (d = new Date(), withSec = false) =>
  [d.getHours(), d.getMinutes(), withSec ? d.getSeconds() : null]
    .filter(v => v != null)
    .map(v => p2(v))
    .join(':');

export const fmtDateTime = (d = new Date(), withSec = false) => `${fmtDate(d)} ${fmtTime(d, withSec)}`;

/* ---- boot 接入 ---- */

let readyPromise = null;
/** boot 期调用一次:设 <html lang>、广播 sys:locale-changed。
 * (字典加载统一在 system/boot.js 装配层按语言动态 import,此处不碰网络) */
export function ready() {
  if (!readyPromise) {
    readyPromise = Promise.resolve().then(() => {
      document.documentElement.lang = localeTag();
      publish('sys:locale-changed', { from: 'i18n', type: 'locale-changed', payload: { locale: currentLocale(), tag: localeTag() } });
    });
  }
  return readyPromise;
}

/* 设置变化联动:e2e / 自动化走 settings.set({locale}) 后 reload,
 * 正常 UI 路径在设置应用里确认后 reload;广播供 v2 现场重绘,此处只同步 lang */
subscribe('sys:settings-changed', (p) => {
  if (!p?.changed?.includes('locale')) return;
  document.documentElement.lang = localeTag();
  const payload = { locale: currentLocale(), tag: localeTag() };
  publish('sys:locale-changed', { from: 'i18n', type: 'locale-changed', payload });
  for (const fn of changeCbs) { try { fn(payload); } catch (e) { console.warn('[i18n] locale 回调失败:', e); } }
});
