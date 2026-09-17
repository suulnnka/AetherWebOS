/* 3D 国际象棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'chess3d',
  name: '3D 国际象棋',
  icon: 'star',
  color: 'linear-gradient(135deg,#0f766e,#134e4a)',
  neon: { a: '#2dd4bf', b: '#818cf8' },
  width: 900, height: 660,
  min: { w: 620, h: 460 },
  singleton: true,
  order: 9.5,
};
