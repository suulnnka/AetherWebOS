/* 文件预览 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'viewer',
  name: '文件预览',
  icon: 'image',
  color: 'linear-gradient(135deg,#0ea5e9,#6366f1)',
  neon: { a: '#38bdf8', b: '#818cf8' },
  width: 760, height: 560,
  min: { w: 420, h: 320 },
  singleton: false,
  order: 1.6,
};
