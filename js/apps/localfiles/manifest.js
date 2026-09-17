/* 本地资源 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'localfiles',
  name: '本地资源',
  icon: 'hardDrive',
  color: 'linear-gradient(135deg,#64748b,#334155)',
  neon: { a: '#60a5fa', b: '#93c5fd' },
  width: 880, height: 560,
  min: { w: 560, h: 360 },
  singleton: true,
  order: 1.5,
};
