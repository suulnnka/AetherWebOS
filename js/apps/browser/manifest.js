/* 浏览器 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'browser',
  neon: { a: '#00f0ff', b: '#3d7bff' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '浏览器',
  icon: 'globe',
  color: 'linear-gradient(135deg,#06b6d4,#0284c7)',
  width: 940, height: 660,
  min: { w: 520, h: 360 },
  singleton: true,
  prefetch: true,  // 高频应用:启动空闲后预读 chunk,首次打开免等
  order: 0,
  category: '工具',
  desc: '多标签网页浏览器,内网站点与真实互联网自动分流,星标收藏随账号保存',
};
