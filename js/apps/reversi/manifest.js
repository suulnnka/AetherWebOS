/* 黑白棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'reversi',
  name: '黑白棋',
  icon: 'circle',
  color: 'linear-gradient(135deg,#059669,#065f46)',
  neon: { a: '#10b981', b: '#a3e635' },
  width: 640, height: 660,
  // 不写 min:棋盘是固定像素的(56px 格),最小窗口尺寸挂载后按实测棋盘
  // 经 wm.reportBoardMin() 上报 —— 改棋盘常量不用回头改清单(见 wm.js 的最小尺寸规范)
  singleton: true,
  desktopIcon: false,   // 收纳进桌面「棋类游戏」文件夹(见 ~/desktop/棋类游戏)
  order: 9.8,
};
