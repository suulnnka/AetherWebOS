/* 本地资源 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'localfiles',
  name: '本地资源',
  icon: 'hardDrive',
  color: 'linear-gradient(135deg,#64748b,#334155)',
  neon: { a: '#60a5fa', b: '#93c5fd' },
  width: 880, height: 560,
  min: { w: 560, h: 360 },
  singleton: false,      // 多实例:可同时浏览多个本机目录
  order: 1.5,
  category: '系统',
  desc: '浏览本机真实文件,授权后导入系统使用',
  i18n: { en: { name: 'Local Files', desc: 'Browse real files on this device and import them after granting access' } },
};
