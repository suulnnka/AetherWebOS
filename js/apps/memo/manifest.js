/* 笔记(备忘录升级) —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'memo',
  name: '笔记',
  icon: 'fileText',
  color: 'linear-gradient(135deg,#fbbf24,#d97706)',
  neon: { a: '#fbbf24', b: '#f97316' },
  width: 860, height: 560,
  min: { w: 520, h: 380 },
  singleton: true,
  order: 2.6,
};
