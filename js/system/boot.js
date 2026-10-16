/* ============================================================
 * 启动序列:应用设置 → 壁纸/托盘/任务栏/开始菜单/桌面 → 全局调试接口
 * ============================================================ */
import { $, E2E } from '../core/utils.js';
import { svg } from '../core/icons.js';
import { subscribe, publish } from '../core/bus.js';
import { settings, applyAll as applyAllSettings } from '../core/store.js';
import { ready, t, localeTag } from '../core/i18n.js';
import { accounts } from '../core/accounts.js';
import fs, { fsReady } from '../core/fs.js';
import { ensureDesktopShortcuts } from '../core/applink.js';
import { createAppFs } from '../core/appfs.js';
import vnet from '../core/vnet.js';
import mailSvc from '../core/mail.js';
import smsSvc from '../core/sms.js';
import { list as listApps } from '../core/registry.js';
import { installApp, uninstallApp, isInstalled, reconcileLegacyShortcuts } from '../core/install.js';
import { normalizeAllModes } from '../core/pkg.js';
import * as wm from '../core/wm.js';
import { dialogs } from '../core/dialogs.js';
import weatherSvc from '../core/weather.js';
import * as appdata from '../core/appdata.js';
import * as trashSvc from '../core/trash.js';
import * as clipSvc from '../core/clipboard.js';
import * as openwithSvc from '../core/openwith.js';
import { WebOS as SYS } from '../core/exports.js';
import { opfsAvailable } from '../core/opfs.js';
import { renderStartMenu, renderStartUser } from './startmenu.js';
import { renderPinned, renderTasks } from './taskbar.js';
import { renderDesktopIcons, applyWallpaper } from './desktop.js';
import { paintVolIcon, paintBell, tickClock } from './tray.js';
import { setupLayoutButton } from './shortcuts.js';
import { restoreIfSaved } from './sessionsave.js';

function boot() {
  // OPFS 硬门禁:文件系统以 OPFS 为唯一存储、无降级路径,
  // 不支持的浏览器直接拒绝启动(停留在开机画面给出提示)
  if (!opfsAvailable()) {
    const el = document.getElementById('boot');
    if (el) {
      el.innerHTML = `
        <div style="max-width:540px;padding:0 24px;text-align:center;color:#e8ecff;font:14px/1.9 system-ui,-apple-system,sans-serif;">
          <div style="font-size:38px;margin-bottom:10px;">⚠️</div>
          <div style="font-size:18px;letter-spacing:2px;margin-bottom:10px;">此浏览器无法运行 AetherWebOS</div>
          <div style="opacity:.78;">文件系统需要 OPFS(Origin Private File System)作为唯一存储,
          当前浏览器不支持,且系统不提供任何降级路径。<br>
          请改用 Chrome / Edge 86+ 等支持 OPFS 的现代浏览器打开。</div>
        </div>`;
    }
    console.warn('[boot] 浏览器不支持 OPFS,拒绝启动');
    return;
  }

  const start = async () => {
    applyAllSettings();   // 主题 / 强调色 / 风格 / 动效 / 亮度 / 图标尺寸
    // 界面语言:解析 locale、设 <html lang>;en 时动态加载 core/system/lib
    // 单元字典(zh 零开销,字典加载点统一在此装配层,docs/i18n.md §5)
    await ready();
    if (localeTag().split('-')[0].toLowerCase() === 'en') {
      await Promise.all([
        import('../core/i18n/en.js'),
        import('../system/i18n/en.js'),
        import('../lib/i18n/en.js'),
      ]).catch((e) => console.warn('[boot] 界面字典加载失败(回落中文):', e));
    }
    // index.html 静态可见文案随语言同步(动态设值,源文件保持 zh)
    $('#sm-input').placeholder = t('搜索应用…');
    $('#start-btn').title = t('开始菜单');
    $('#tray-vol').title = t('音量');
    $('#tray-bell').title = t('通知');
    $('#tray-clock').title = t('日期和时间');
    $('#sm-power').title = t('电源');
    $('#start-btn').innerHTML = svg('grid', 19);
    setupLayoutButton();
    applyWallpaper();
    paintVolIcon();
    paintBell();

    // 首启:尚无任何可登录用户 → 自动创建默认账号并登录(不进注册锁屏)
    try { await fsReady(); }   // OPFS 装载/迁移完成后再碰文件系统
    catch (e) { console.warn('[boot] FS 就绪失败:', e); }
    if (!accounts.current() && !accounts.list().length) {
      try { await accounts.bootstrapIfNeeded(); }
      catch (e) { console.warn('[boot] 自动创建初始用户失败:', e); }
    }
    // 先渲染与文件系统无关的外壳(任务栏/开始菜单/时钟):下面的 fs.batch
    // 播种要走 OPFS 落盘,不应推迟它们就绪(桌面图标已由 accounts:changed
    // 订阅者先行渲染,批量完成后下方再绘一次为准)
    renderPinned();
    renderTasks();
    renderStartMenu();
    renderStartUser();
    tickClock();
    // 已有会话 / 刚 bootstrap:先迁移旧版桌面快捷方式(商店出现前播种过
    // 全部应用 → 视为已安装),再确保家目录与桌面快捷方式齐全。
    // 播种走 fs.batch:几十个写入合并为一条广播 + 一趟确定性落盘
    // (reconcileLegacyShortcuts 不直接写 fs,其补播种经广播同步回到
    // applink,并入同一批)
    const cur = accounts.current();
    if (cur) {
      try {
        await fs.batch(async () => {
          fs.ensureUserHome(cur);
          reconcileLegacyShortcuts();
          ensureDesktopShortcuts(cur);
        });
      } catch (e) { console.warn('[boot] 播种批量失败:', e); }
    }
    // 应用包模式兜底:老版本写过的 /app 残留模式(r-xr-x / rw-r--)在
    // 穿越免费的新语义下是真实泄露,开机整树归一到 root 私有(幂等)
    try { normalizeAllModes(); }
    catch (e) { console.warn('[boot] /app 模式归一失败:', e); }
    renderDesktopIcons();

    // E2E/调试:URL hash 直开应用(#open=browser&url=http%3A%2F%2Fportal.nexus%2F,
    // 其余键并入应用 params)—— 无交互环境下(如 Firefox --headless --screenshot)
    // 也能进入指定页面做渲染比对
    if (E2E && location.hash.startsWith('#open=')) {
      const q = new URLSearchParams(location.hash.slice(6));
      const appId = q.get('open');
      q.delete('open');
      if (appId) setTimeout(() => wm.open(appId, { params: Object.fromEntries(q) }), 300);
    }

    // 会话恢复:刷新/重开浏览器后把上次打开的窗口开回来(注销不恢复;
    // 锁屏态等登录成功由 sessionsave 的登录接力补上)
    if (!location.hash.startsWith('#open=')) restoreIfSaved();
  };
  start();

  // 调试 / 自动化接口(appdata 必须经此拿应用图同一实例:
  // 开发服务器 HMR 会给改过的模块加 ?t= 后缀,另行动态 import 会得到
  // 带独立 Database 缓存的第二个实例,读到陈旧数据)
  Object.assign(SYS, {
    bus: { subscribe, publish, send: (from, to, type, payload) => publish(`app:${to}`, { from, to, type, payload }) },
    wm, settings, accounts, fs, vnet, dialogs, mail: mailSvc, sms: smsSvc, weather: weatherSvc, appdata,
    trash: trashSvc, clipboard: clipSvc, openwith: openwithSvc,
    __weatherDaily: weatherSvc.daily,
    apps: { list: listApps, install: installApp, uninstall: uninstallApp, isInstalled },
    ensureDesktopShortcuts,
    createAppFs,
  });
  window.WebOS = SYS;

  // 开机画面淡出(测试模式跳过装饰性动画,否则每个用例组都要白等 1.5s)
  setTimeout(() => $('#boot').classList.add('hide'), E2E ? 60 : 1000);
  setTimeout(() => $('#boot').remove(), E2E ? 180 : 1500);

  console.log('%cAetherWebOS 1.0 已启动 %c— 全局对象:WebOS',
    'color:#5b6cff;font-weight:bold', 'color:#888');
}

boot();
