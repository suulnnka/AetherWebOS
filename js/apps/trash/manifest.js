/* 回收站 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'trash',
  neon: { a: '#94a3b8', b: '#475569' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '回收站',
  icon: 'trash',
  color: 'linear-gradient(135deg,#64748b,#475569)',
  width: 660, height: 480,
  min: { w: 460, h: 320 },
  singleton: true,
  desktop: false,   // 不进开始菜单:入口是桌面回收站图标与文件管家侧栏
  order: 2,
  category: '系统',
  desc: '回收站:还原误删的文件,或彻底删除',
};
