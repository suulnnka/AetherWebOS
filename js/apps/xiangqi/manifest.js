/* 中国象棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'xiangqi',
  name: '中国象棋',
  icon: 'grid',
  color: 'linear-gradient(135deg,#b45309,#7c2d12)',
  neon: { a: '#f59e0b', b: '#f87171' },
  width: 660, height: 790,
  // 不写 min:棋盘固定像素(CS 54 × 9/10 路),最小窗口尺寸挂载后按实测棋盘
  // 经 wm.reportBoardMin() 上报 —— 改 CS 不用回头改清单(见 wm.js 的最小尺寸规范)
  singleton: true,
  desktopIcon: false,   // 收纳进桌面「棋类游戏」文件夹(见 /home/desktop/棋类游戏)
  order: 9.6,
};
