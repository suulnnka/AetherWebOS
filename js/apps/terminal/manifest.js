/* 终端 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'terminal',
  neon: { a: '#00ff9d', b: '#00c3ff' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '终端',
  icon: 'terminal',
  color: 'linear-gradient(135deg,#334155,#0f172a)',
  width: 700, height: 440,
  min: { w: 420, h: 260 },
  singleton: false,
  order: 3,
};
