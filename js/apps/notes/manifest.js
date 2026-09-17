/* 记事本 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'notes',
  neon: { a: '#00e08f', b: '#19d3ff' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '记事本',
  icon: 'fileText',
  color: 'linear-gradient(135deg,#10b981,#059669)',
  width: 720, height: 520,
  min: { w: 420, h: 300 },
  singleton: false,
  order: 2,
};
