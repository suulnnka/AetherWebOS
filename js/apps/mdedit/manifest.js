/* Markdown 编辑器 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'mdedit',
  name: 'Markdown 编辑器',
  icon: 'pencil',
  color: 'linear-gradient(135deg,#818cf8,#c084fc)',
  neon: { a: '#818cf8', b: '#c084fc' },
  width: 860, height: 620,
  min: { w: 480, h: 360 },
  singleton: false,
  order: 2.5,
};
