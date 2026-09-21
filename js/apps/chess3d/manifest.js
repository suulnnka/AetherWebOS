/* 国际象棋(2D/3D 双视图)—— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'chess3d',
  name: '国际象棋',
  icon: 'star',
  color: 'linear-gradient(135deg,#0f766e,#134e4a)',
  neon: { a: '#2dd4bf', b: '#818cf8' },
  width: 900, height: 660,
  // 不写 min:2D/3D 棋盘都按容器缩放,最小窗口尺寸挂载后按「格距下限 MIN_CELL」
  // 经 wm.reportBoardMin() 上报(见 index.js 的 MIN_CELL 与 wm.js 的最小尺寸规范)
  singleton: true,
  desktopIcon: false,   // 收纳进桌面「棋类游戏」文件夹(见 /home/desktop/棋类游戏)
  order: 9.5,
};
