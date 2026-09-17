/* ============================================================
 * 应用装配表
 *
 * 启动时只注册各应用的清单元数据(manifest.js,纯数据、体积极小),
 * 应用代码(<id>/index.js 及其 CSS)由 Vite 拆成独立 chunk,
 * 首次打开窗口时才按需加载(wm.open → registry.ensureLoaded)。
 *
 * 新增应用:
 *   1. 建 js/apps/<id>/ 目录:manifest.js(清单)+ index.js(实现)
 *   2. 在下方 APPS 表补一行 [manifest, () => import('./<id>/index.js')]
 * ============================================================ */
import { registerLazy } from '../core/registry.js';

import browser from './browser/manifest.js';
import files from './files/manifest.js';
import localfiles from './localfiles/manifest.js';
import viewer from './viewer/manifest.js';
import mail from './mail/manifest.js';
import todo from './todo/manifest.js';
import sms from './sms/manifest.js';
import notes from './notes/manifest.js';
import settings from './settings/manifest.js';
import calc from './calc/manifest.js';
import terminal from './terminal/manifest.js';
import bash from './bash/manifest.js';
import monitor from './monitor/manifest.js';
import music from './music/manifest.js';
import weather from './weather/manifest.js';
import memo from './memo/manifest.js';
import minesweeper from './minesweeper/manifest.js';
import chess3d from './chess3d/manifest.js';
import reversi from './reversi/manifest.js';
import solitaire from './solitaire/manifest.js';
import pairs from './pairs/manifest.js';
import sokoban from './sokoban/manifest.js';
import qq from './qq/manifest.js';

const APPS = [
  [browser, () => import('./browser/index.js')],
  [files, () => import('./files/index.js')],
  [localfiles, () => import('./localfiles/index.js')],
  [viewer, () => import('./viewer/index.js')],
  [mail, () => import('./mail/index.js')],
  [todo, () => import('./todo/index.js')],
  [sms, () => import('./sms/index.js')],
  [notes, () => import('./notes/index.js')],
  [settings, () => import('./settings/index.js')],
  [calc, () => import('./calc/index.js')],
  [terminal, () => import('./terminal/index.js')],
  [bash, () => import('./bash/index.js')],
  [monitor, () => import('./monitor/index.js')],
  [music, () => import('./music/index.js')],
  [weather, () => import('./weather/index.js')],
  [memo, () => import('./memo/index.js')],
  [minesweeper, () => import('./minesweeper/index.js')],
  [chess3d, () => import('./chess3d/index.js')],
  [reversi, () => import('./reversi/index.js')],
  [solitaire, () => import('./solitaire/index.js')],
  [pairs, () => import('./pairs/index.js')],
  [sokoban, () => import('./sokoban/index.js')],
  [qq, () => import('./qq/index.js')],
];

for (const [manifest, load] of APPS) registerLazy(manifest, load);
