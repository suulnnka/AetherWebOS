/* 黑白棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'reversi',
  name: '黑白棋',
  icon: 'circle',
  color: 'linear-gradient(135deg,#059669,#065f46)',
  neon: { a: '#10b981', b: '#a3e635' },
  width: 640, height: 660,
  min: { w: 460, h: 480 },
  singleton: true,
  order: 9.8,
};
