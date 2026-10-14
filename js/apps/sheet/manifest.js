/* 电子表格 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'sheet',
  name: '电子表格',
  icon: 'grid',
  color: 'linear-gradient(135deg,#1d9e5f,#0b7a4b)',
  neon: { a: '#34d399', b: '#10b981' },
  width: 940, height: 640,
  min: { w: 540, h: 400 },
  singleton: false,
  order: 2.6,
  category: '效率',
  desc: '纯表格编辑:列宽 / 单元格样式 / 列排序 / 缩放,存 .axl',
};
