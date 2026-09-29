/* 音乐 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'music',
  neon: { a: '#a855f7', b: '#22d3ee' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '音乐',
  icon: 'music',
  color: 'linear-gradient(135deg,#8b5cf6,#d946ef)',
  width: 420, height: 480,
  min: { w: 340, h: 420 },
  singleton: true,
  order: 7,
  store: true,          // 商店应用:需经软件商店安装
  category: '娱乐',
  desc: '本地音乐播放,随点随听',
};
