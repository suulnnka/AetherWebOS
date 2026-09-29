/* 笔记(备忘录升级) —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'memo',
  name: '笔记',
  icon: 'fileText',
  color: 'linear-gradient(135deg,#fbbf24,#d97706)',
  neon: { a: '#fbbf24', b: '#f97316' },
  width: 860, height: 560,
  min: { w: 520, h: 380 },
  singleton: true,
  order: 2.6,
  store: true,          // 商店应用:需经软件商店安装
  category: '效率',
  desc: '卡片式笔记,支持加密与置顶',
};
