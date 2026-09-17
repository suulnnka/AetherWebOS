/* 系统设置 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'settings',
  neon: { a: '#8b5cf6', b: '#c084fc' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '系统设置',
  icon: 'settings',
  color: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
  width: 860, height: 600,
  min: { w: 640, h: 420 },
  singleton: true,
  order: 5,
};
