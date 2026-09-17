/* 地图 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'map',
  name: '地图',
  icon: 'map',
  color: 'linear-gradient(135deg,#10b981,#0ea5e9)',
  neon: { a: '#34d399', b: '#22d3ee' },
  width: 960, height: 640,
  min: { w: 560, h: 420 },
  singleton: true,
  order: 2.95,
};
