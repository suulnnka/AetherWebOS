/* 围棋 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'go',
  name: '围棋',
  icon: 'circle',
  color: 'linear-gradient(135deg,#475569,#111827)',
  neon: { a: '#94a3b8', b: '#e2e8f0' },
  width: 640, height: 744,
  // 不写 min:棋盘固定像素(CS 30 × 19 路),最小窗口尺寸挂载后按实测棋盘
  // 经 wm.reportBoardMin() 上报 —— 改 CS 不用回头改清单(见 wm.js 的最小尺寸规范)
  singleton: true,
  desktopIcon: false,   // 收纳进桌面「棋类游戏」文件夹(见 ~/desktop/棋类游戏)
  order: 9.7,
  store: true,          // 商店应用:需经软件商店安装
  category: '游戏',
  desc: '19 路围棋,自研神经网络引擎(KataGo 系)对弈',
  hoverPrefetch: false,  // 引擎 chunk + 1.1MB 模型权重都不小,不做悬停预读(引擎本就首次使用时才经 Worker 加载)
};
