/* ============================================================
 * Settings —— 系统设置存储(持久化到 localStorage)
 * 修改后自动:写入 localStorage → 应用到 DOM → 广播系统事件
 * ============================================================ */

import { publish } from './bus.js';

const KEY = 'webos.settings.v1';

/** 可选强调色 */
export const ACCENTS = ['#5b6cff', '#8b5cf6', '#d946ef', '#f43f5e', '#f59e0b', '#10b981', '#06b6d4', '#64748b'];

/** 风格主题(整套系统皮肤:窗口 / 任务栏 / 开始菜单 / 控件) */
export const STYLES = [
  { id: 'neon', name: '霓虹未来' },
  { id: 'modern', name: '现代' },
  { id: 'mac', name: 'macOS' },
  { id: 'win31', name: 'Win3.1' },
  { id: 'win98', name: 'Win98' },
  { id: 'winxp', name: 'WinXP' },
  { id: 'win7', name: 'Win7' },
  { id: 'ubuntu', name: 'Ubuntu' },
];

/** 自带强调色的皮肤(切换时覆盖用户自选色,样式表提供 --accent) */
export const STYLE_ACCENT = { ubuntu: '#e95420', neon: '#00e5ff' };

/** 内置静态壁纸(纯 CSS 渐变,零资源,静止不动) */
export const STATIC_WALLPAPERS = [
  { id: 'aurora', name: '极光', css: 'linear-gradient(135deg, #667eea 0%, #764ba2 45%, #f093fb 100%)' },
  { id: 'ocean', name: '深海', css: 'linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'sunset', name: '暮色', css: 'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 50%, #fbc2eb 100%)' },
  { id: 'forest', name: '青森', css: 'linear-gradient(160deg, #134e5e 0%, #71b280 100%)' },
  { id: 'night', name: '星夜', css: 'linear-gradient(135deg, #0f0c29 0%, #302b63 55%, #24243e 100%)' },
  { id: 'candy', name: '糖果', css: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 60%, #ffdde1 100%)' },
  { id: 'graphite', name: '石墨', css: 'linear-gradient(135deg, #232526 0%, #414345 100%)' },
  { id: 'meadow', name: '原野', css: 'linear-gradient(135deg, #00b09b 0%, #96c93d 100%)' },
  { id: 'teal', name: '青绿', css: '#008080' },   // Win98/3.1 时代的经典纯色桌面
];

/** 内置动态壁纸:光斑坐标分布在整张画布上,配合 wpPan/wpFlow 动画产生"流动"感 */
export const DYNAMIC_WALLPAPERS = [
  { id: 'nebula', name: '星云', css: 'radial-gradient(42% 36% at 20% 26%, rgba(99,102,241,0.9), transparent 70%), radial-gradient(36% 32% at 76% 20%, rgba(236,72,153,0.65), transparent 70%), radial-gradient(46% 40% at 70% 74%, rgba(34,211,238,0.6), transparent 70%), radial-gradient(40% 34% at 26% 78%, rgba(168,85,247,0.7), transparent 70%), radial-gradient(30% 26% at 52% 50%, rgba(56,189,248,0.45), transparent 70%), linear-gradient(160deg, #0b1026 0%, #1e1b4b 100%)' },
  { id: 'ember', name: '流金', css: 'radial-gradient(44% 38% at 22% 30%, rgba(251,146,60,0.85), transparent 70%), radial-gradient(38% 32% at 78% 24%, rgba(239,68,68,0.6), transparent 70%), radial-gradient(44% 40% at 72% 78%, rgba(250,204,21,0.55), transparent 70%), radial-gradient(36% 30% at 28% 76%, rgba(249,115,22,0.6), transparent 70%), linear-gradient(160deg, #1c1008 0%, #451a03 100%)' },
  { id: 'lagoon', name: '碧涛', css: 'radial-gradient(46% 40% at 24% 24%, rgba(45,212,191,0.8), transparent 70%), radial-gradient(40% 34% at 80% 30%, rgba(59,130,246,0.6), transparent 70%), radial-gradient(44% 38% at 72% 76%, rgba(16,185,129,0.6), transparent 70%), radial-gradient(38% 32% at 24% 80%, rgba(6,182,212,0.65), transparent 70%), linear-gradient(160deg, #04212b 0%, #0b3b47 100%)' },
  { id: 'blossom', name: '樱语', css: 'radial-gradient(44% 38% at 22% 28%, rgba(249,168,212,0.9), transparent 70%), radial-gradient(38% 32% at 78% 22%, rgba(196,181,253,0.7), transparent 70%), radial-gradient(44% 40% at 74% 76%, rgba(251,207,232,0.75), transparent 70%), radial-gradient(36% 32% at 26% 78%, rgba(244,114,182,0.6), transparent 70%), linear-gradient(160deg, #fdf2f8 0%, #ede9fe 100%)' },
];

/** 全部内置壁纸(动态在前);终端等按 id 查找时使用 */
export const WALLPAPERS = [...DYNAMIC_WALLPAPERS, ...STATIC_WALLPAPERS];

const DEFAULTS = {
  theme: 'auto',            // light | dark | auto
  style: 'neon',            // 默认风格皮肤:霓虹未来(modern | neon | mac | win31 | win98 | winxp | win7 | ubuntu)
  accent: '#5b6cff',
  wallpaperType: 'static',  // 当前生效的壁纸类型:static | dynamic
  wallpaperStatic: 'aurora', // 静态壁纸选择:内置 id 或 'custom'
  wallpaperDynamic: 'nebula', // 动态壁纸选择:内置 id(两组各自记住选择)
  wallpaperUrl: '',         // 自定义壁纸 URL / dataURL(属于静态壁纸)
  iconSize: 'medium',       // small | medium | large
  clockSeconds: false,      // 任务栏时钟显示秒
  pinnedApps: ['files', 'notes', 'terminal'],   // 任务栏固定应用
  volume: 65,
  muted: false,
  brightness: 100,
  username: 'admin',
  effects: true,            // 界面动效
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}

let state = { ...DEFAULTS, ...load() };

let persistTimer;
let wiped = false;   // 完全重置后置位:persist 不再写盘,防止 reload 前防抖定时器把旧数据写回
export const storageWiped = () => wiped;

function persist() {
  if (wiped) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('[settings] 持久化失败(可能已超出存储上限):', e); }
  }, 150);
}

const mq = matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change', () => { if (state.theme === 'auto') { applyAll(); publishTheme(); } });

function resolvedTheme() { return state.theme === 'auto' ? (mq.matches ? 'dark' : 'light') : state.theme; }

/** 把当前设置应用到 DOM(主题/强调色/风格皮肤/动效/亮度/图标尺寸) */
export function applyAll() {
  const html = document.documentElement;
  html.dataset.theme = resolvedTheme();
  html.dataset.style = state.style || 'neon';
  // 自带强调色的皮肤(Ubuntu 橙 / 霓虹青)让位给样式表,其余用用户自选色
  if (STYLE_ACCENT[state.style]) html.style.removeProperty('--accent');
  else html.style.setProperty('--accent', state.accent);
  html.classList.toggle('no-effects', !state.effects);
  const icons = document.getElementById('icons');
  if (icons) icons.dataset.size = state.iconSize;
  const br = document.getElementById('brightness');
  if (br) br.style.opacity = String((100 - state.brightness) / 100 * 0.8);
}

function publishTheme() {
  publish('sys:theme-changed', { from: 'settings', type: 'theme-changed', payload: { theme: resolvedTheme() } });
}

export const settings = {
  /** get('volume') 或 get() 全量 */
  get: (k) => (k == null ? state : state[k]),
  /** set({ volume: 30 }) —— 自动持久化并广播 */
  set(patch) {
    const changed = Object.keys(patch).filter(k => patch[k] !== state[k]);
    if (!changed.length) return;
    Object.assign(state, patch);
    persist();
    applyAll();
    publish('sys:settings-changed', { from: 'settings', type: 'settings-changed', payload: { changed, patch } });
    if (changed.includes('theme')) publishTheme();
    if (changed.includes('volume') || changed.includes('muted')) {
      publish('sys:volume-changed', {
        from: 'settings', type: 'volume-changed',
        payload: { volume: state.volume, muted: state.muted },
      });
    }
  },
  /** 完全重置此电脑:删除浏览器中保存的全部数据(设置、文件、账号、应用数据)并重启 */
  reset() {
    wiped = true;
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch { /* 忽略 */ }
    location.reload();
  },
  resolvedTheme,
};

/** 当前生效壁纸的背景值(动态 / 静态 / 自定义图片) */
export function wallpaperCss() {
  if (state.wallpaperType === 'dynamic') {
    return (DYNAMIC_WALLPAPERS.find(w => w.id === state.wallpaperDynamic) || DYNAMIC_WALLPAPERS[0]).css;
  }
  if (state.wallpaperStatic === 'custom' && state.wallpaperUrl) {
    const u = state.wallpaperUrl.replace(/"/g, '%22');
    return `#1a1a2e url("${u}") center / cover no-repeat`;
  }
  return (STATIC_WALLPAPERS.find(w => w.id === state.wallpaperStatic) || STATIC_WALLPAPERS[0]).css;
}

/** 壁纸动效类型:'flow'(动态壁纸,推移+流动光斑)/ 'none'(静态壁纸与自定义图片,静止) */
export function wallpaperMotion() {
  return state.wallpaperType === 'dynamic' ? 'flow' : 'none';
}

/** 按 id 选择壁纸:自动识别动态/静态分组,选中并立即切换到该类型(自定义图片请用 settings.set) */
export function pickWallpaper(id) {
  if (DYNAMIC_WALLPAPERS.some(w => w.id === id)) {
    return settings.set({ wallpaperType: 'dynamic', wallpaperDynamic: id });
  }
  settings.set({ wallpaperType: 'static', wallpaperStatic: id });
}
