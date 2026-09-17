/* 任务 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'todo',
  name: '任务',
  icon: 'check',
  color: 'linear-gradient(135deg,#10b981,#0d9488)',
  neon: { a: '#34d399', b: '#2dd4bf' },
  width: 760, height: 560,
  min: { w: 520, h: 380 },
  singleton: true,
  order: 2.5,
};
