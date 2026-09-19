/* 围棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'go',
  name: '围棋',
  icon: 'circle',
  color: 'linear-gradient(135deg,#475569,#111827)',
  neon: { a: '#94a3b8', b: '#e2e8f0' },
  width: 640, height: 720,
  min: { w: 520, h: 600 },
  singleton: true,
  desktopIcon: false,   // 收纳进桌面「棋类游戏」文件夹(见 /home/desktop/棋类游戏)
  order: 9.7,
  hoverPrefetch: false,  // 引擎包后续会很大,不做悬停预读(引擎本就首次使用时才经 Worker 加载)
};
