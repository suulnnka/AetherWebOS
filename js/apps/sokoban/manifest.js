/* 推箱子 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'sokoban',
  name: '推箱子',
  icon: 'hardDrive',
  color: 'linear-gradient(135deg,#b45309,#78350f)',
  neon: { a: '#fbbf24', b: '#f59e0b' },
  width: 560, height: 660,
  min: { w: 420, h: 480 },
  singleton: true,
  order: 9.6,
};
