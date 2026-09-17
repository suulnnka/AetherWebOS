/* 计算器 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'calc',
  neon: { a: '#38bdf8', b: '#818cf8' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '计算器',
  icon: 'calc',
  color: 'linear-gradient(135deg,#0ea5e9,#2563eb)',
  width: 320, height: 460,
  min: { w: 260, h: 380 },
  singleton: true,
  order: 4,
};
