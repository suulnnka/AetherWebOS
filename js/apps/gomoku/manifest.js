/* 五子棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'gomoku',
  name: '五子棋',
  icon: 'grid',
  color: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
  neon: { a: '#818cf8', b: '#c084fc' },
  width: 660, height: 724,
  min: { w: 520, h: 620 },
  singleton: true,
  order: 9.65,
};
