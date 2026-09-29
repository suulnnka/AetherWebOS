/* 数据库 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'dbviewer',
  name: '数据库',
  icon: 'grid',
  color: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
  neon: { a: '#a78bfa', b: '#818cf8' },
  width: 880, height: 620,
  min: { w: 600, h: 440 },
  singleton: true,
  order: 2.6,
};
