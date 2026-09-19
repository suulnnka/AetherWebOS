/* 文件管家 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'files',
  neon: { a: '#ffb400', b: '#ff5e00' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '文件管家',
  icon: 'folder',
  color: 'linear-gradient(135deg,#f59e0b,#f97316)',
  width: 880, height: 560,
  min: { w: 560, h: 360 },
  singleton: true,
  prefetch: true,  // 高频应用:启动空闲后预读 chunk,首次打开免等
  order: 1,
};
