/* 接龙 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'solitaire',
  name: '接龙',
  icon: 'star',
  color: 'linear-gradient(135deg,#166534,#14532d)',
  neon: { a: '#22c55e', b: '#eab308' },
  width: 900, height: 640,
  min: { w: 640, h: 460 },
  singleton: true,
  order: 9.2,
};
