/* 天气 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'weather',
  name: '天气',
  icon: 'sun',
  color: 'linear-gradient(135deg,#38bdf8,#f59e0b)',
  neon: { a: '#38bdf8', b: '#fbbf24' },
  width: 820, height: 600,
  min: { w: 560, h: 420 },
  singleton: true,
  order: 2.8,
};
