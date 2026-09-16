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
  { id: 'modern', name: '现代' },
  { id: 'neon', name: '霓虹未来' },
  { id: 'mac', name: 'macOS' },
  { id: 'win31', name: 'Win3.1' },
  { id: 'win98', name: 'Win98' },
  { id: 'winxp', name: 'WinXP' },
  { id: 'win7', name: 'Win7' },
  { id: 'ubuntu', name: 'Ubuntu' },
];

/** 自带强调色的皮肤(切换时覆盖用户自选色,样式表提供 --accent) */
export const STYLE_ACCENT = { ubuntu: '#e95420', neon: '#00e5ff' };

/** 内置壁纸(纯 CSS 渐变,零资源) */
export const WALLPAPERS = [
  { id: 'aurora', name: '极光', css: 'linear-gradient(135deg, #667eea 0%, #764ba2 45%, #f093fb 100%)' },
  { id: 'ocean', name: '深海', css: 'linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'sunset', name: '暮色', css: 'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 50%, #fbc2eb 100%)' },
  { id: 'forest', name: '青森', css: 'linear-gradient(160deg, #134e5e 0%, #71b280 100%)' },
  { id: 'night', name: '星夜', css: 'linear-gradient(135deg, #0f0c29 0%, #302b63 55%, #24243e 100%)' },
  { id: 'candy', name: '糖果', css: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 60%, #ffdde1 100%)' },
  { id: 'graphite', name: '石墨', css: 'linear-gradient(135deg, #232526 0%, #414345 100%)' },
  { id: 'meadow', name: '原野', css: 'linear-gradient(135deg, #00b09b 0%, #96c93d 100%)' },
];

const DEFAULTS = {
  theme: 'auto',            // light | dark | auto
  style: 'modern',          // 风格皮肤:modern | mac | win98 | winxp | win7
  accent: '#5b6cff',
  wallpaper: 'aurora',      // 内置壁纸 id,或 'custom'
  wallpaperUrl: '',         // 自定义壁纸 URL / dataURL
  iconSize: 'medium',       // small | medium | large
  clockSeconds: false,      // 任务栏时钟显示秒
  singleActive: false,      // 单活动窗口模式:非活动窗口首次点击仅激活
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

function persist() {
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
  html.dataset.style = state.style || 'modern';
  // 自带强调色的皮肤(Ubuntu 橙 / 霓虹青)让位给样式表,其余用用户自选色
  if (STYLE_ACCENT[state.style]) html.style.removeProperty('--accent');
  else html.style.setProperty('--accent', state.accent);
  html.classList.toggle('no-effects', !state.effects);
  const icons = document.getElementById('icons');
  if (icons) icons.dataset.size = state.iconSize;
  const br = document.getElementById('brightness');
  if (br) br.style.opacity = String((100 - state.brightness) / 100 * 0.8);
  document.body.classList.toggle('single-active', !!state.singleActive);
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
  /** 清空全部系统数据并重载 */
  reset() {
    localStorage.clear();
    location.reload();
  },
  resolvedTheme,
};

/** 桌面壁纸背景值 */
export function wallpaperCss() {
  if (state.wallpaper === 'custom' && state.wallpaperUrl) {
    const u = state.wallpaperUrl.replace(/"/g, '%22');
    return `#1a1a2e url("${u}") center / cover no-repeat`;
  }
  return (WALLPAPERS.find(w => w.id === state.wallpaper) || WALLPAPERS[0]).css;
}
