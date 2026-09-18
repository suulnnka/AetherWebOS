/* 图寻(单图模式) —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'tuxun',
  name: '图寻',
  icon: 'mapPin',
  color: 'linear-gradient(135deg,#f59e0b,#ef4444)',
  neon: { a: '#fbbf24', b: '#f87171' },
  width: 980, height: 660,
  min: { w: 600, h: 440 },
  singleton: true,
  order: 9.3,
};
