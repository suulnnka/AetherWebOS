/* 日记 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'diary',
  name: '日记',
  icon: 'calendar',
  color: 'linear-gradient(135deg,#fb7185,#be123c)',
  neon: { a: '#fb7185', b: '#f0abfc' },
  width: 860, height: 560,
  min: { w: 620, h: 440 },
  singleton: true,
  order: 2.7,
};
