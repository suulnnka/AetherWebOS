/* QQ —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'qq',
  name: 'QQ',
  icon: 'message',
  color: 'linear-gradient(135deg,#3b82f6,#1d4ed8)',
  neon: { a: '#60a5fa', b: '#22d3ee' },
  width: 620, height: 500,
  min: { w: 480, h: 380 },
  singleton: true,
  order: 2.9,
};
