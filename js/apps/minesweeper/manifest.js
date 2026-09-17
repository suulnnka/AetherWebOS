/* 扫雷 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'minesweeper',
  name: '扫雷',
  icon: 'alertTriangle',
  color: 'linear-gradient(135deg,#334155,#0f172a)',
  neon: { a: '#94a3b8', b: '#f43f5e' },
  width: 560, height: 620,
  min: { w: 420, h: 420 },
  singleton: true,
  order: 9,
};
