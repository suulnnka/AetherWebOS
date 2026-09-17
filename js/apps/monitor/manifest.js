/* 系统监视器 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'monitor',
  neon: { a: '#ff3860', b: '#ff2ad4' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '系统监视器',
  icon: 'activity',
  color: 'linear-gradient(135deg,#ec4899,#f43f5e)',
  width: 820, height: 560,
  min: { w: 560, h: 380 },
  singleton: true,
  order: 6,
};
