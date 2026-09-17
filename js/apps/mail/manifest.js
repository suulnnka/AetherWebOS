/* 邮件 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'mail',
  name: '邮件',
  icon: 'mail',
  color: 'linear-gradient(135deg,#0891b2,#2563eb)',
  neon: { a: '#22d3ee', b: '#60a5fa' },
  width: 980, height: 620,
  min: { w: 640, h: 400 },
  singleton: true,
  order: 1.7,
};
