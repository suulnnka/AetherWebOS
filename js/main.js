/* ============================================================
 * WebOS 启动入口
 * 只负责装配:应用注册 → 桌面外壳 → 启动序列。
 * 结构:
 *   js/core/     内核(总线/窗口管理/文件系统/设置/虚拟网络/邮件/短信…)
 *   js/system/   桌面外壳(桌面/任务栏/开始菜单/托盘/快捷键/启动)
 *   js/apps/     应用(每个应用一个目录:index.js + style.css)
 *   js/game/     内置游戏内容(示例谜题链)
 * 新增应用:在 js/apps/<id>/ 建目录,并在下方 import 一行。
 * ============================================================ */

// ---- 内置应用 ----
import './apps/browser/index.js';
import './apps/files/index.js';
import './apps/localfiles/index.js';
import './apps/viewer/index.js';
import './apps/mail/index.js';
import './apps/todo/index.js';
import './apps/sms/index.js';
import './apps/notes/index.js';
import './apps/settings/index.js';
import './apps/calc/index.js';
import './apps/terminal/index.js';
import './apps/bash/index.js';
import './apps/monitor/index.js';
import './apps/music/index.js';
import './apps/weather/index.js';
import './apps/memo/index.js';

// ---- 系统对话框(sysdialog 应用)----
import { dialogs } from './core/dialogs.js';

// ---- 内置游戏内容 ----
import './game/index.js';

// ---- 桌面外壳与启动 ----
import './system/appstyles.js';   // 应用专属样式注入
import './system/desktop.js';
import './system/taskbar.js';
import './system/startmenu.js';
import './system/tray.js';
import './system/shortcuts.js';
import './system/boot.js';
