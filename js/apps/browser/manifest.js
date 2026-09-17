/* 浏览器 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'browser',
  neon: { a: '#00f0ff', b: '#3d7bff' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '浏览器',
  icon: 'globe',
  color: 'linear-gradient(135deg,#06b6d4,#0284c7)',
  width: 900, height: 620,
  min: { w: 520, h: 360 },
  singleton: true,
  order: 0,
};
