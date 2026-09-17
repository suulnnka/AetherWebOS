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
 *
 * 惰性加载:js/apps/index.js 通过 registerLazy 只注册清单元数据,
 * 应用代码(index.js + CSS)作为独立 chunk 在首次打开时加载。
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

/* 惰性注册:应用代码(含 mount)按需加载,启动时只注册清单元数据。
 * load 是返回动态 import 的加载器;应用 index.js 执行 register()
 * 后会以完整清单覆盖此占位,load 字段随之消失。 */
export function registerLazy(manifest, load) {
  if (!manifest?.id || typeof load !== 'function') {
    console.error('[registry] 无效的惰性应用清单:', manifest);
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
    load,
  });
}

/* 打开窗口前调用:若应用尚未加载则拉取其 chunk(重复调用因模块
 * 缓存而立即返回),返回覆盖后的完整清单。 */
export async function ensureLoaded(id) {
  const m = apps.get(id);
  if (!m) return m;
  if (m.load) {
    await m.load();
    return apps.get(id);
  }
  return m;
}

export const get = (id) => apps.get(id);

export function list() {
  return [...apps.values()].sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
}
