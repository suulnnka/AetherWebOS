/* 软件商店 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'appstore',
  name: '软件商店',
  icon: 'store',
  color: 'linear-gradient(135deg,#34d399,#0ea5e9)',
  neon: { a: '#34d399', b: '#38bdf8' },
  width: 940, height: 640,
  min: { w: 620, h: 460 },
  singleton: true,
  prefetch: true,  // 高频入口:未安装应用的打开引导会直达这里,预读 chunk 免等
  order: 2.2,
  category: '系统',
  desc: '发现并安装新应用',
};
