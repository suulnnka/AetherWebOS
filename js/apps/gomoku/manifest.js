/* 五子棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'gomoku',
  name: '五子棋',
  icon: 'grid',
  color: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
  neon: { a: '#818cf8', b: '#c084fc' },
  width: 660, height: 724,
  // 不写 min:棋盘固定像素(CS 34 × 15 路),最小窗口尺寸挂载后按实测棋盘
  // 经 wm.reportBoardMin() 上报 —— 改 CS 不用回头改清单(见 wm.js 的最小尺寸规范)
  singleton: true,
  desktopIcon: false,   // 收纳进桌面「棋类游戏」文件夹(见 ~/desktop/棋类游戏)
  order: 9.65,
};
