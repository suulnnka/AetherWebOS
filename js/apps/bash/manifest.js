/* Bash 终端 —— 应用清单(纯数据;实现在 index.js,由 js/apps/index.js 惰性加载) */
export default {
  id: 'bash',
  name: 'Bash 终端',
  icon: 'terminal',
  color: 'linear-gradient(135deg,#166534,#052e16)',
  neon: { a: '#22c55e', b: '#a3e635' },
  width: 700, height: 460,
  min: { w: 420, h: 260 },
  singleton: false,
  order: 3.5,
};
