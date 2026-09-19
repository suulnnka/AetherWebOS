/* ============================================================
 * AetherWebOS 启动入口
 * 只负责装配:应用注册 → 桌面外壳 → 启动序列。
 * 结构:
 *   js/core/     内核(总线/窗口管理/文件系统/设置/虚拟网络/邮件/短信…)
 *   js/system/   桌面外壳(桌面/任务栏/开始菜单/托盘/快捷键/启动)
 *   js/apps/     应用(每个应用一个目录:manifest.js + index.js + <id>.css)
 *   js/game/     内置游戏内容(示例谜题链)
 * 新增应用:在 js/apps/<id>/ 建目录,并在 js/apps/index.js 的 APPS 表补一行。
 * ============================================================ */

// ---- 内置应用:只注册清单;应用代码按需以独立 chunk 惰性加载 ----
import './apps/index.js';

// ---- 系统对话框(sysdialog 应用)----
import { dialogs } from './core/dialogs.js';

// ---- 内置游戏内容 ----
import './game/index.js';

// ---- 桌面外壳与启动 ----
import './system/desktop.js';
import './system/taskbar.js';
import './system/startmenu.js';
import './system/tray.js';
import './system/shortcuts.js';
import './system/boot.js';
