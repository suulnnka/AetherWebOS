/* ============================================================
 * Registry —— 应用注册表
 *
 * 应用清单(App Manifest)字段:
 *   id         唯一 ID(也是 IPC 地址)
 *   name       显示名称
 *   icon       icons.js 中的图标名
 *   color      磁贴背景(CSS background 值)
 *   width/height        初始窗口尺寸
 *   min:{w,h}           最小尺寸
 *   singleton  是否单实例(再次打开时聚焦已有窗口)
 *   resizable  是否允许调整大小(默认 true)
 *   desktop    是否出现在桌面与开始菜单(默认 true)
 *   order      排序权重(小的在前)
 *   mount(ctx) 挂载函数:在 ctx.root 里构建界面,可返回生命周期钩子
 * ============================================================ */

const apps = new Map();

export function register(manifest) {
  if (!manifest?.id || typeof manifest.mount !== 'function') {
    console.error('[registry] 无效的应用清单:', manifest);
    return;
  }
  apps.set(manifest.id, {
    width: 780, height: 540,
    min: { w: 360, h: 240 },
    singleton: false,
    resizable: true,
    desktop: true,
    order: 100,
    ...manifest,
  });
}

export const get = (id) => apps.get(id);

export function list() {
  return [...apps.values()].sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
}
