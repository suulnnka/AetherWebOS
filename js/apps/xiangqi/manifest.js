/* 中国象棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'xiangqi',
  name: '中国象棋',
  icon: 'grid',
  color: 'linear-gradient(135deg,#b45309,#7c2d12)',
  neon: { a: '#f59e0b', b: '#f87171' },
  width: 660, height: 790,
  min: { w: 500, h: 640 },
  singleton: true,
  order: 9.6,
};
