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
 *   desktop    是否出现在开始菜单(默认 true;false 同时不参与桌面快捷方式播种)
 *   desktopIcon 初始化/迁移时是否在桌面生成 .app 快捷方式(默认 true;
 *              桌面本身不自动生成图标,应用入口都是快捷方式文件)
 *   order      排序权重(小的在前)
 *   prefetch   高频应用预读:启动空闲后在后台拉取应用 chunk,首次打开免等
 *   hoverPrefetch  鼠标悬停启动入口(桌面图标/开始菜单/任务栏)时预读
 *              chunk(默认 true;围棋等重型应用设为 false 关闭)
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
    desktopIcon: true,
    order: 100,
    prefetch: false,
    hoverPrefetch: true,
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
    desktopIcon: true,
    order: 100,
    prefetch: false,
    hoverPrefetch: true,
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

/* 空闲时预读标记了 prefetch 的高频应用(浏览器/终端等):后台拉取并执行
 * 其 chunk,首次打开窗口免等网络。失败只告警——预读是纯优化,
 * 真正打开时 ensureLoaded 会再试。 */
export function prefetchApps() {
  const kick = () => {
    for (const m of apps.values()) {
      if (!m.prefetch || !m.load) continue;
      m.load().catch((err) => console.warn(`[registry] 预读 ${m.id} 失败:`, err));
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(kick, { timeout: 3000 });
  else setTimeout(kick, 1500);
}

/* 悬停预读:鼠标移到启动入口(桌面图标/开始菜单磁贴/任务栏固定钮)上时
 * 提前拉取应用 chunk,真正点击时免等网络。清单 hoverPrefetch: false 的
 * 应用(围棋:引擎包后续会很大)跳过。
 * 重复触发因模块缓存立即返回;失败只告警,打开时 ensureLoaded 会再试。 */
export function prefetchOnHover(id) {
  const m = apps.get(id);
  if (!m || !m.load || m.hoverPrefetch === false) return;
  m.load().catch((err) => console.warn(`[registry] 悬停预读 ${id} 失败:`, err));
}

export const get = (id) => apps.get(id);

export function list() {
  return [...apps.values()].sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
}
