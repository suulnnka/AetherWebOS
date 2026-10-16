/* 便签 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载)
 * frameless:无边框窗口,自绘顶栏(拖动区 [data-windrag]);
 * 多实例:主窗口 = 待办清单,便签窗口 = params.noteId 的速记窗;
 * oldNames:曾用名( applink 播种时清理旧名桌面快捷方式) */
export default {
  id: 'todo',
  name: '便签',
  oldNames: ['任务'],
  icon: 'check',
  color: 'linear-gradient(135deg,#f5de8a,#eac53f)',
  neon: { a: '#f7dd7a', b: '#e8b93c' },
  frameless: true,
  width: 340, height: 260,
  min: { w: 230, h: 150 },
  singleton: false,
  order: 2.5,
  category: '效率',
  desc: '便签式待办与速记:清单 + 独立便签窗口,可置顶、换色',
  i18n: { en: { name: 'Sticky Notes', desc: 'Sticky to-dos and quick notes: lists + standalone note windows, pinnable and recolorable' } },
};
