/* ============================================================
 * 启动序列:应用设置 → 壁纸/托盘/任务栏/开始菜单/桌面 → 全局调试接口
 * ============================================================ */
import { $, E2E } from '../core/utils.js';
import { svg } from '../core/icons.js';
import { subscribe, publish } from '../core/bus.js';
import { settings, applyAll as applyAllSettings } from '../core/store.js';
import { accounts } from '../core/accounts.js';
import fs from '../core/fs.js';
import { ensureDesktopShortcuts } from '../core/applink.js';
import { createAppFs } from '../core/appfs.js';
import vnet from '../core/vnet.js';
import mailSvc from '../core/mail.js';
import smsSvc from '../core/sms.js';
import { list as listApps } from '../core/registry.js';
import * as wm from '../core/wm.js';
import { dialogs } from '../core/dialogs.js';
import weatherSvc from '../core/weather.js';
import { WebOS as SYS } from '../core/exports.js';
import { renderStartMenu, renderStartUser } from './startmenu.js';
import { renderPinned, renderTasks } from './taskbar.js';
import { renderDesktopIcons, applyWallpaper } from './desktop.js';
import { paintVolIcon, paintBell, tickClock } from './tray.js';
import { setupLayoutButton } from './shortcuts.js';

function boot() {
  applyAllSettings();   // 主题 / 强调色 / 风格 / 动效 / 亮度 / 图标尺寸
  $('#start-btn').innerHTML = svg('grid', 19);
  setupLayoutButton();
  applyWallpaper();
  paintVolIcon();
  paintBell();
  renderPinned();
  renderTasks();
  renderStartMenu();
  renderStartUser();
  // 已有会话:确保家目录与桌面快捷方式齐全(刷新后 / 旧数据补齐)
  const cur = accounts.current();
  if (cur) {
    fs.ensureUserHome(cur);
    ensureDesktopShortcuts(cur);
  }
  renderDesktopIcons();
  tickClock();

  // 调试 / 自动化接口
  Object.assign(SYS, {
    bus: { subscribe, publish, send: (from, to, type, payload) => publish(`app:${to}`, { from, to, type, payload }) },
    wm, settings, accounts, fs, vnet, dialogs, mail: mailSvc, sms: smsSvc, weather: weatherSvc,
    __weatherDaily: weatherSvc.daily,
    apps: { list: listApps },
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
