/* 短信 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'sms',
  name: '短信',
  icon: 'message',
  color: 'linear-gradient(135deg,#22c55e,#16a34a)',
  neon: { a: '#4ade80', b: '#22d3ee' },
  width: 860, height: 560,
  min: { w: 560, h: 380 },
  singleton: true,
  order: 1.8,
};
