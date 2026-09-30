/* 线索 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'clues',
  name: '线索',
  icon: 'nodes',
  color: 'linear-gradient(135deg,#22d3ee,#0e7490)',
  neon: { a: '#22d3ee', b: '#34d399' },
  width: 940, height: 640,
  min: { w: 560, h: 420 },
  singleton: true,
  order: 2.65,
  store: true,          // 商店应用:需经软件商店安装
  category: '效率',
  desc: '节点式笔记:便签节点连成线索图,双击聚焦',
};
