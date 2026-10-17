/* ============================================================
 * WM —— 窗口管理器(Window Manager)
 *
 * 职责:窗口的创建/销毁、焦点与层级(z-index)、拖动、
 *       8 方向调整大小、最小化/最大化/还原、级联定位。
 * 层级模型(见 tierOf/restack):0 普通 < 1 置顶 < 2 应用模态 < 3 系统模态,
 *       档内按最近激活时间排;z-index 全量重排,不增量递增。
 * 所有窗口事件通过总线广播:sys:win-open / win-close /
 * win-focus / win-blur / win-min / win-restore / win-max / win-unmax
 * ============================================================ */

import { el, clamp } from './utils.js';
import { icon, paintTile } from './icons.js';
import { publish, subscribe } from './bus.js';
import { ensureLoaded, get as getApp, appName } from './registry.js';
import { createAppBus } from './bus.js';
import { settings } from './store.js';
import { t } from './i18n.js';
import fs from './fs.js';
import { createAppFs } from './appfs.js';
import { accounts } from './accounts.js';
import { showMenu, copyText, selectionAt } from './menu.js';
import { forApp as dialogHelpers, dialogs } from './dialogs.js';
import { isInstalled } from './install.js';

const wins = new Map();   // winId -> win 对象
let seq = 0;
let cascadeSeq = 0;
let actSeq = 0;           // 激活序:同档内后激活的窗口排前面(见 restack)

/* 同时任务上限(任务栏按钮数):防任务栏挤爆与性能的兜底。
 * 对话框(dialog)不拦也不占名额 —— 上限期系统提示必须仍能弹出,否则连
 * 「请先关一些窗口」这句话本身都弹不出来;对话框照常计入 wins/任务栏。 */
export const MAX_WINS = 60;

/* ============================================================
 * 模态分级:0 = 非模态(一级,不影响任何界面)
 *           2 = 应用模态(二级,锁定弹出者应用的所有窗口)
 *           3 = 系统模态(三级,锁定整个系统:窗口区遮罩 + 任务栏 inert,
 *               仅对话框可操作)
 * dialog 窗口默认级别 3;普通窗口默认 0。
 * ============================================================ */
let shadeEl = null;
const modalWins = new Set();     // 系统模态(三级)对话框
const appModalWins = new Set();  // 应用模态(二级)对话框

/* ============================================================
 * 最小尺寸规范(WM 统一口径)
 *
 * 下限来源(取最大者):
 *   1) app.min 或 MIN_W/MIN_H —— 「整窗」下限:清单声明了 min 就以清单为准
 *      (允许比全局兜底更小,如窄便签),什么都没声明时用全局兜底;
 *   2) app.contentMin         —— 「内容区」下限,WM 负责补窗框(标题栏 + 边框)。
 *      棋类走这条:棋盘是固定像素、窗口再小棋盘也不缩,下限就是棋盘尺寸,
 *      不该在每个应用里各自重复「标题栏 38 + 边框 2」这种窗框魔数。
 *
 * 最后还要夹一层「不得超过桌面可用区」—— 小屏上窗口不能被自己的下限撑出屏幕。
 * ============================================================ */
const MIN_W = 320, MIN_H = 200;

/** 窗框实测:横向只有左右边框,纵向是标题栏 + 上下边框。
 *  量不出来(未布局 / 已最小化 display:none)时退回常量,别把下限算成 0。 */
function chromeOf(w) {
  const x = w.el.offsetWidth - w.body.offsetWidth;
  const y = w.el.offsetHeight - w.body.offsetHeight;
  return { x: x > 0 && x < 80 ? x : 2, y: y > 0 && y < 120 ? y : 40 };
}

/** 窗口当前下限(每次现算:主题换了标题栏高度、应用调了 setContentMin 都能跟上) */
function minSizeOf(w) {
  if (w.app?.dialog) return { w: 0, h: 0 };      // 对话框按内容定尺寸,不套下限
  const a = area();
  const c = chromeOf(w);
  const cw = w.contentMin ? w.contentMin.w + c.x : 0;
  const ch = w.contentMin ? w.contentMin.h + c.y : 0;
  return {
    w: Math.min(Math.max(w.app?.min?.w || MIN_W, cw), a.width),
    h: Math.min(Math.max(w.app?.min?.h || MIN_H, ch), a.height),
  };
}

/** 棋类专用:把「棋盘尺寸」翻译成窗口下限交给 WM(内部走 ctx.setContentMin)。
 *
 *  棋类棋盘是固定像素的,窗口再小它也不缩 —— 所以下限就该是
 *  「棋盘 + 窗内铬(工具栏 + 状态栏)」,而不是清单里拍脑袋写的一个数。
 *  工具栏/状态栏高度实测,棋盘尺寸由调用方给(棋盘会缩放的按格距下限换算),
 *  于是以后改棋盘常量(CS / --cs)不用回头改清单。
 *
 * @param ctx    挂载上下文
 * @param appEl  应用根元素(.app)
 * @param board  棋盘元素(取 offsetWidth/Height)或直接给 { w, h }
 * @param minW   宽度兜底:工具栏比棋盘还宽时用它(默认 0 = 只按棋盘定宽)
 */
export function reportBoardMin(ctx, appEl, board, minW = 0) {
  if (!appEl || !ctx?.setContentMin) return;
  const bw = board?.offsetWidth || board?.w || 0;
  const bh = board?.offsetHeight || board?.h || 0;
  if (!bw || !bh) return;                       // 还没布局,等下一次(比如视图切换后)
  const tool = appEl.querySelector('.app-toolbar');
  const stat = appEl.querySelector('.app-status');
  ctx.setContentMin({
    w: Math.max(bw, minW),
    h: bh + (tool?.offsetHeight || 44) + (stat?.offsetHeight || 26),
  });
}

/** 应用模态:窗口 w 是否被其应用的二级弹框锁定 */
function isAppLocked(w) {
  for (const d of appModalWins) {
    if (d.ownerApp === w.appId && d !== w) return true;
  }
  return false;
}

/** 为所有被二级弹框锁定的窗口同步遮罩层(标题栏 + 内容整体不可操作) */
function syncAppShades() {
  for (const w of wins.values()) {
    const locked = isAppLocked(w);
    if (locked && !w.shadeEl) {
      w.shadeEl = el('div', { class: 'app-shade' });
      w.el.append(w.shadeEl);
    } else if (!locked && w.shadeEl) {
      w.shadeEl.remove();
      w.shadeEl = null;
    }
  }
}

/* ---------------- 层级模型(restack) ----------------
 * 窗口分四档优先级,高档永远覆盖低档;同档内按最近激活时间(actSeq)定先后,
 * 后激活的在上:
 *   0 普通窗口
 *   1 置顶(pinned —— 只是提升一档,压不过任何模态)
 *   2 应用模态弹框(二级)
 *   3 系统模态弹框(三级)
 * 系统模态遮罩插在 0-2 档全部窗口之上、3 档之下 —— 置顶窗口自然被压住,
 * 模态解除后无需任何"恢复"动作,下一次重排自动回到置顶档。
 * 窗口集合 / 焦点 / 置顶 / 模态任一变化后由 restack() 全量重排 z-index,
 * 不再增量递增,也就没有计数溢出与重归一化的问题。 */
function tierOf(w) {
  if (w.modalLevel >= 3) return 3;
  if (w.modalLevel === 2) return 2;
  if (w.pinned) return 1;
  return 0;
}

function restack() {
  const sorted = [...wins.values()]
    .sort((a, b) => (tierOf(a) - tierOf(b)) || (a.actSeq - b.actSeq));
  // 遮罩占一个独立槽位:压在 0-2 档全部窗口之上、最低的 3 档窗口之下
  const k = shadeEl ? sorted.filter(w => tierOf(w) < 3).length : -1;
  sorted.forEach((w, i) => { w.el.style.zIndex = 10 + i + (k >= 0 && i >= k ? 1 : 0); });
  if (shadeEl) shadeEl.style.zIndex = 10 + k;
}

function raiseShade() {
  const locked = modalWins.size > 0;
  if (!locked) {
    shadeEl?.remove();
    shadeEl = null;
  } else if (!shadeEl) {
    shadeEl = el('div', { class: 'modal-shade' });
    layerEl().append(shadeEl);
  }
  restack();
  // 三级模态锁的是「整个系统」,而遮罩挂在窗口层,物理上盖不到任务栏 ——
  // 任务栏/开始菜单/托盘的锁定与已开面板的收起由订阅方完成
  // (taskbar.js 加锁 + inert,startmenu.js / tray.js 收面板)
  publish('sys:modal', { from: 'wm', type: 'modal', payload: { locked } });
}

const layerEl = () => document.getElementById('windows');
const area = () => layerEl().getBoundingClientRect();

/* ---------------- 应用内右键 ----------------
 * 统一拦截窗口内的 contextmenu:应用已自行处理的(文件管家/扫雷等,事件
 * 已 preventDefault)不干预;否则依次尝试应用自定义菜单(ctx.onContextMenu)、
 * 选中文字的「复制」、表单控件的「全选」,都没有就仅吞掉浏览器默认菜单。 */
layerEl().addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const winEl = e.target.closest?.('.win');
  const w = winEl ? wins.get(winEl.dataset.id) : null;
  let items;
  try { items = w?.ctxMenu?.({ x: e.clientX, y: e.clientY, target: e.target }); }
  catch (err) { console.error('[wm] 应用右键菜单出错:', err); }
  const menu = Array.isArray(items) ? [...items] : [];
  const sel = selectionAt(e.target);
  if (sel) {
    if (menu.length) menu.push({ sep: true });
    menu.push({ label: t('复制'), icon: 'copy', fn: () => copyText(sel) });
  } else {
    const field = e.target.closest?.('input, textarea');
    if (field) menu.push({ label: t('全选'), icon: 'textCursor', fn: () => field.select() });
  }
  if (menu.length) showMenu(e.clientX, e.clientY, menu);
});

const emit = (type, payload) =>
  publish(`sys:win-${type}`, { from: 'wm', type: `win-${type}`, payload });

/* ---------------- 打开窗口 ---------------- */
/* 惰性应用:窗口框架(标题栏 + 骨架加载态)立即立起,代码 chunk 到位后
 * 回填内容;已加载应用走模块缓存,同步路径无感。 */
/* level: 0 非模态 / 2 应用模态 / 3 系统模态;缺省时 dialog 窗口为 3,普通窗口为 0 */
export async function open(appId, { params, level, owner } = {}) {
  // 清单是纯数据,同步可得(含 singleton 等静态字段),无需等代码加载
  const m = getApp(appId);
  if (!m) { console.warn('[wm] 应用不存在:', appId); return null; }

  // 安装门禁:商店应用(store:true)未安装时拒绝打开,引导去软件商店
  if (!isInstalled(appId)) {
    dialogs.confirm({
      title: t('应用未安装'),
      message: t('「{name}」需要先在软件商店安装。', { name: appName(m.id) }),
      okText: t('打开软件商店'),
    }).then((go) => { if (go) open('appstore', { params: { focus: appId } }); });
    return null;
  }

  // 单实例:聚焦已有窗口并转发参数
  if (m.singleton) {
    for (const w of wins.values()) {
      if (w.appId !== appId) continue;
      restoreWin(w.id);
      focus(w.id);
      if (params) {
        // 骨架期应用还没挂载、总线上没有听众,参数先记下,挂载完成后补发
        if (w.pending) w.pendingParams = params;
        else publish(`app:${appId}`, { from: 'wm', to: appId, type: 'params', payload: params });
      }
      return w;
    }
  }

  // 同时任务上限:满了拒绝再开,toast 提示(见 MAX_WINS 注释,对话框走豁免)
  if (!m.dialog && wins.size >= MAX_WINS) {
    console.warn(`[wm] 已达同时窗口上限(${MAX_WINS}),拒绝打开:`, appId);
    publish('sys:notify', { from: 'wm', type: 'notify', payload: {
      title: t('窗口已达上限'),
      body: t('最多同时运行 {n} 个窗口,请先关闭一些窗口。', { n: MAX_WINS }),
    } });
    return null;
  }

  // 已加载:直接挂载
  if (!m.load) return spawnWindow(m, { params, level, owner, mount: (ctx) => m.mount(ctx) });

  // 惰性应用:骨架先行,chunk 到位后在同一窗口里回填真实内容
  const w = spawnWindow(m, { params, level, owner, mount: mountSkeleton });
  w.pending = true;
  // 无边框应用骨架期不可见:骨架(转圈加载态)长得就不是无边框的样子,
  // 且真挂载常要经水合决定去留(如便签的补齐/聚焦让位),可见一两帧
  // 就是「一闪而过」;应用挂载后自行显形(便签在水合定留时清 visibility)
  if (m.frameless) w.el.style.visibility = 'hidden';
  try {
    const app = await ensureLoaded(appId);
    if (wins.get(w.id) !== w) return w;   // 加载期间窗口已被关闭
    w.app = app;                          // 占位清单 → 含 mount 的完整清单
    w.body.textContent = '';              // 撤下骨架
    const hooks = app.mount(w.ctx);
    if (hooks && typeof hooks === 'object') Object.assign(w.hooks, hooks);
    w.pending = false;
    if (w.pendingParams) {
      publish(`app:${appId}`, { from: 'wm', to: appId, type: 'params', payload: w.pendingParams });
      w.pendingParams = null;
    }
  } catch (err) {
    // chunk 拉取失败或挂载抛异常:窗口内显示错误卡,不拖垮系统
    w.pending = false;
    if (wins.get(w.id) === w) { w.body.textContent = ''; mountFailed(w, err); }
  }
  return w;
}

/* 骨架占位:chunk 加载期间显示的窗口主体加载态 */
function mountSkeleton({ root }) {
  root.append(el('div', { class: 'win-skeleton' }, el('div', { class: 'spinner' })));
}

/* 挂载失败:窗口内错误卡(应用异常不会拖垮系统) */
function mountFailed(w, err) {
  console.error(`[wm] 窗口 "${w.app.id}" 挂载失败:`, err);
  w.body.append(el('div', { class: 'win-error' },
    el('b', {}, t('应用启动失败')),
    el('div', { class: 'mono' }, String(err?.message || err))));
}

/* ---------------- 窗口构建(应用窗口与通用弹窗共用) ---------------- */
function spawnWindow(app, { params = {}, level, owner, mount } = {}) {
  const id = 'w' + (++seq);
  const a = area();
  const width = Math.min(app.width, a.width - 12);
  const height = Math.min(app.height, a.height - 12);
  const k = (cascadeSeq++) % 8;
  // 对话框居中显示;普通窗口级联偏移
  const x = app.dialog
    ? Math.round((a.width - width) / 2)
    : clamp(Math.round((a.width - width) / 2) + k * 30 - 105, 6, Math.max(6, a.width - width - 6));
  const y = app.dialog
    ? Math.max(6, Math.round((a.height - height) / 2) - 30)
    : clamp(Math.round((a.height - height) / 2) + k * 24 - 84, 6, Math.max(6, a.height - height - 6));

  // 注册应用取经 i18n 的显示名;popup 等合成清单不在注册表,appName 查不到回落清单 name
  const titleEl = el('span', { class: 'win-title' }, appName(app.id) || app.name);

  // 无边框窗口(frameless,如便签类应用):不创建系统窗头与窗口按钮,
  // 应用自绘顶栏(拖动区用 [data-windrag] 标注,关闭等按钮自理);
  // titleEl 仍保留在内存里供任务栏/事件读取标题
  const frameless = app.frameless === true;

  let head = null;
  if (!frameless) {
    const icoEl = el('span', { class: 'win-ico' },
      icon(app.icon, 13));
    paintTile(icoEl, app);

    const btnMin = el('button', { class: 'wbtn mn', title: t('最小化') }, icon('minus', 14));
    const btnMax = el('button', { class: 'wbtn mx', title: t('最大化 / 还原') },
      el('span', { class: 'i-max' }, icon('max', 13)),
      el('span', { class: 'i-restore' }, icon('restore', 13)));
    const btnClose = el('button', { class: 'wbtn close', title: t('关闭') }, icon('close', 14));
    if (!app.dialog) {
      btnMin.addEventListener('click', () => minimize(id));
      btnMax.addEventListener('click', () => toggleMax(id));
    }
    btnClose.addEventListener('click', () => close(id));
    // 对话框窗口:只保留关闭按钮(不可最小化/最大化/缩放)
    const headChildren = app.dialog
      ? [icoEl, titleEl, btnClose]
      : [icoEl, titleEl, btnMin, btnMax, btnClose];

    head = el('header', { class: 'win-head' }, ...headChildren);
  }
  const body = el('div', { class: 'win-body' });
  const root = el('section', {
    class: 'win opening',
    dataset: { app: app.id, id },
    style: { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px', zIndex: 10 },
  }, ...(head ? [head] : []), body,
    ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => el('div', { class: `rz rz-${d}`, dataset: { dir: d } })));

  // 应用专属霓虹灯条颜色(霓虹未来皮肤消费;--neon-a/--neon-b)
  if (app.neon?.a) root.style.setProperty('--neon-a', app.neon.a);
  if (app.neon?.b) root.style.setProperty('--neon-b', app.neon.b);

  const w = {
    id, appId: app.id, app, el: root, body, titleEl,
    state: 'normal',            // normal | min | max
    prevState: 'normal',
    restoreRect: null,
    hooks: {},
    bus: null,
    ctx: null,                  // 挂载上下文(惰性应用回填时复用)
    pending: false,             // true = 骨架期,内容待代码 chunk 到位后回填
    pendingParams: null,        // 骨架期收到的单实例转发参数,挂载后补发
    modalLevel: level ?? (app.dialog ? 3 : 0),
    ownerApp: owner || null,    // 二级弹框:锁定的目标应用
    shadeEl: null,
    pinned: false,              // 置顶:层级提升一档(见 tierOf),压不过任何模态
    actSeq: 0,                  // 激活序(focus 时更新)
    // 内容区下限(清单给的初值;应用挂载后可用 ctx.setContentMin() 按实测棋盘覆盖)
    contentMin: app.contentMin ? { ...app.contentMin } : null,
  };

  const win = {
    get id() { return id; },
    get appId() { return app.id; },
  };

  // 多窗口模式:按下即把焦点给这个窗口。这一次点击照常穿透到内容
  // (与 Windows / macOS 一致;早先的"首次点击仅激活"模式已移除)
  root.addEventListener('pointerdown', () => focus(id), true);

  // 窗口先进 DOM 再挂载:同步挂载与惰性回填两条路径行为一致,
  // 应用在 mount 里即可安全测量布局
  layerEl().append(root);

  // 开窗口就按下限校一遍:桌面可用区比清单宽高还小时会触发(此时才能量到窗框)
  {
    const mn = minSizeOf(w);
    if (width < mn.w) root.style.width = mn.w + 'px';
    if (height < mn.h) root.style.height = mn.h + 'px';
  }

  // 挂载内容
  w.bus = createAppBus(app.id);
  /* 执行用户:清单 executeAs —— 'session'(默认,打开时登录用户)|
     'root'(系统内部)| 固定用户名。窗口存续期内绑定不变。 */
  const execMode = app.executeAs || 'session';
  const execUser = execMode === 'session'
    ? accounts.current()
    : execMode;
  const appFs = createAppFs(app.id, execUser);
  const ctx = {
    root: body,
    win,
    bus: w.bus,
    params,
    /** 应用级文件系统:全部操作以执行用户鉴权(读/写/建/删/权限) */
    fs: appFs,
    /** 全局文件系统(系统/调试;应用请优先用 ctx.fs) */
    fsGlobal: fs,
    /** 本窗口的执行用户(打开时绑定;未登录为 null) */
    user: execUser,
    executeAs: execMode,
    settings,
    /** 应用自定义右键:fn({ x, y, target }) 返回菜单项数组(可含 {sep:true});
        返回 null/undefined 时走系统默认(选中文字 → 复制,表单控件 → 全选) */
    onContextMenu: (fn) => { w.ctxMenu = fn; },
    setTitle: (title) => {
      titleEl.textContent = title ?? (appName(app.id) || app.name);
      emit('title', { id, appId: app.id, title: titleEl.textContent });
    },
    close: () => close(id),
    focus: () => focus(id),
    minimize: () => minimize(id),
    /** 置顶开关(便签类应用):开启后窗口提升一个层级档,浮在普通窗口之上;
     *  仍低于二级/三级模态弹框 —— 全屏遮罩的系统模态压得住它(见 tierOf) */
    setPinned: (on) => {
      w.pinned = !!on;
      if (w.pinned) focus(id);   // 立即浮到置顶档最上
      else restack();
    },
    /** 程序化调整窗口尺寸(对话框自适应内容高度等);会被窗口下限夹住 */
    setSize: (nw, nh) => applyRect(w, { x: w.el.offsetLeft, y: w.el.offsetTop, w: nw, h: nh }, false),
    /** 上报「内容区」下限(不含标题栏/边框,WM 补):
     *  棋类按实测棋盘给 —— 棋盘尺寸改了不用回头改清单;已开的窗口立刻生效,
     *  并且如果当前比新下限还小,顺势把窗口撑到下限(免得卡在缩过头的状态) */
    setContentMin: (cm) => {
      w.contentMin = cm && cm.w > 0 && cm.h > 0 ? { w: cm.w, h: cm.h } : null;
      if (w.state !== 'normal') return;
      const mn = minSizeOf(w);
      if (w.el.offsetWidth < mn.w || w.el.offsetHeight < mn.h) {
        applyRect(w, { x: w.el.offsetLeft, y: w.el.offsetTop, w: mn.w, h: mn.h }, false);
      }
    },
    /** 应用绑定弹框:owner 自动为本应用,默认二级(应用模态);
        { level: 1 } 非模态 / { level: 3 } 系统模态 可覆盖 */
    dialogs: dialogHelpers(app.id),
    /** 应用绑定通用弹窗(同 ctx.dialogs 的绑定规则),见 popup() */
    popup: (opts = {}) => popup({ owner: app.id, ...opts }),
  };
  w.ctx = ctx;
  w.execUser = execUser;

  try {
    const hooks = mount(ctx);
    if (hooks && typeof hooks === 'object') w.hooks = hooks;
  } catch (err) {
    mountFailed(w, err);
  }

  makeDraggable(w);
  if (app.resizable !== false) makeResizable(w);

  // .opening 保留 950ms:霓虹皮肤的三段出场(灯条→下展→内容淡入)约需 0.95s;
  // 其余风格的 winIn 动画 0.2s 已结束,类多挂一会无副作用
  setTimeout(() => root.classList.remove('opening'), 950);

  wins.set(id, w);
  // 模态登记:三级进系统模态(全屏遮罩+焦点锁);二级锁定 owner 应用的所有窗口;
  // 二级未指明 owner 时无法表达"锁谁",退化为系统模态
  if (w.modalLevel === 2 && !w.ownerApp) { w.modalLevel = 3; }
  if (w.modalLevel >= 3) modalWins.add(w);
  if (w.modalLevel === 2) appModalWins.add(w);
  syncAppShades();
  focus(id);
  if (w.modalLevel >= 3) raiseShade();
  emit('open', { id, appId: app.id, title: titleEl.textContent });
  return w;
}

/* ---------------- 通用弹窗(任意内容的三级模态窗口) ----------------
 * 弹窗不等于消息框:内容可以是复杂配置页、画布渲染的游戏等任意界面。
 *
 *   const h = wm.popup({
 *     title: '高级设置', width: 720, height: 520,
 *     level: 2,                 // 1 非模态 / 2 应用模态 / 3 系统模态
 *     chrome: 'dialog',         // 仅关闭钮 + 居中;'full' = 完整窗口件
 *     mount({ root, close, setSize, bus }) { root.append(...); },
 *   });
 *   h.promise.then(v => ...);   // close(value) 的 value 在此兑现
 *   h.close('ok');
 *
 * 返回 { id, win, promise, close(value) }。 */
export function popup({
  title = t('弹窗'), icon: ic = 'sliders',
  width = 560, height = 420, min,
  resizable = true,
  chrome = 'dialog',
  level = 2, owner,
  mount, params,
} = {}) {
  let resolveClosed;
  const promise = new Promise((res) => { resolveClosed = res; });
  const app = {
    id: 'popup', name: title, icon: ic,
    dialog: chrome !== 'full',
    width, height, min, resizable,
    singleton: false, desktop: false,
  };
  let w;
  w = spawnWindow(app, {
    params,
    level,
    owner,
    mount: (ctx) => {
      // close(value):关闭弹窗并让 promise 以 value 兑现
      ctx.close = (value) => { w._popupValue = value; close(w.id); };
      const hooks = mount?.(ctx) || {};
      const userOnClose = hooks.onClose;
      hooks.onClose = () => {
        // 返回 false 可拦截关闭(如游戏中误触);拦截时不兑现 promise
        if (typeof userOnClose === 'function' && userOnClose() === false) return false;
        resolveClosed(w._popupValue);
        return true;
      };
      return hooks;
    },
  });
  return { id: w.id, win: w, promise, close: (value) => { w._popupValue = value; close(w.id); } };
}

/* ---------------- 关闭 ---------------- */
export function close(id) {
  const w = wins.get(id);
  if (!w) return;
  if (w.hooks.onClose && w.hooks.onClose() === false) return; // 应用可拦截
  const wasFocused = w.el.classList.contains('focused');
  w.bus.dispose();
  wins.delete(id);
  if (w.modalLevel >= 3) { modalWins.delete(w); raiseShade(); }
  if (w.modalLevel === 2) { appModalWins.delete(w); syncAppShades(); }
  restack();   // 模态窗口的遮罩槽位随窗口集合变化(raiseShade 内亦重排,此处兜底)
  // 关的是活动窗口:焦点接棒给最近激活的剩余窗口,无人可接则广播失焦(无活动窗口)。
  // 类立即摘掉 —— 关闭动画的 170ms 里别再被 focusedCount 计入
  if (wasFocused) {
    w.el.classList.remove('focused');
    dropNativeFocus(w);
    const next = nextFocusable();
    if (next) focus(next.id);
    else emit('blur', { id: w.id, appId: w.appId });
  }
  emit('close', { id, appId: w.appId });
  w.el.classList.add('closing');
  setTimeout(() => w.el.remove(), 170);
}

/* 卸载联动(install 模块广播,按用户):窗口只属于当前会话用户,
 * 仅当本人卸载(该应用对其不再可用)才关闭其窗口 */
subscribe('sys:apps-changed', (payload) => {
  if (payload?.action !== 'uninstall' || !payload.id) return;
  if (payload.user && payload.user !== accounts.current()) return;
  for (const w of [...wins.values()]) {
    if (w.appId === payload.id) close(w.id);
  }
});

/* ---------------- 焦点与层级 ---------------- */

/** 当前活动窗口(0 或 1 个;无活动窗口是合法状态 ——
 *  点击桌面 / 最小化活动窗口 / 关窗无人接棒时进入) */
function focusedWin() {
  for (const w of wins.values()) if (w.el.classList.contains('focused')) return w;
  return null;
}

/** 焦点资格:focus() 与关窗接棒(nextFocusable)共用的模态拒绝判断 */
function canFocus(w) {
  if (modalWins.size && w.modalLevel !== 3) return false;   // 系统模态期:只有对话框可激活
  if (isAppLocked(w)) return false;   // 应用模态期:被二级弹框锁定的窗口不可激活
  return true;
}

/** 收回窗口内的原生输入焦点:失焦窗口里的输入框不再接收键盘 */
function dropNativeFocus(w) {
  const ae = document.activeElement;
  if (ae && ae !== document.body && w.el.contains(ae)) ae.blur();
}

/** 失焦善后(类已摘/将摘):收原生焦点、通知应用、广播 sys:win-blur */
function notifyBlur(w) {
  dropNativeFocus(w);
  w.hooks.onBlur?.();
  emit('blur', { id: w.id, appId: w.appId });
}

/** 取消激活:所有窗口失焦(点击桌面等「操作落在窗口外」时)。
 *  系统模态期拒绝 —— 活动对话框不因外部操作丢焦点锁。 */
export function blur() {
  const cur = focusedWin();
  if (!cur || modalWins.size) return;
  cur.el.classList.remove('focused');
  notifyBlur(cur);
}

/** 当前活动窗口 id(无活动窗口为 null) */
export function activeId() {
  return focusedWin()?.id ?? null;
}

export function focus(id) {
  const w = wins.get(id);
  if (!w) return;
  if (!canFocus(w)) return;
  if (w.state === 'min') restoreWin(id);
  const prev = focusedWin();
  w.actSeq = ++actSeq;   // 同档内按激活时间排:刚激活的浮到本档最上
  for (const o of wins.values()) o.el.classList.toggle('focused', o === w);
  if (prev !== w) {
    if (prev) notifyBlur(prev);   // 焦点让位:旧窗口收键盘焦点、通知应用
    w.hooks.onFocus?.();
  }
  restack();
  emit('focus', { id, appId: w.appId });
}

/* 原生焦点 ↔ 窗口激活耦合:键盘焦点落进某个未激活窗口(Tab 越窗 / 应用
 * 编程式 focus())时,像点击一样激活该窗口 —— 保证键盘焦点永远只在活动
 * 窗口内(或窗口之外);被模态锁住的窗口不给激活,焦点元素一并收回。
 * 挂载期(窗口尚未登记进 wins)的 autofocus 放行,spawnWindow 随后会 focus。 */
document.addEventListener('focusin', (e) => {
  const winEl = e.target?.closest?.('.win');
  if (!winEl || winEl.classList.contains('focused')) return;
  const w = wins.get(winEl.dataset.id);
  if (!w) return;
  if (canFocus(w)) focus(w.id);
  else e.target.blur();
});

/** 焦点接棒候选:可见且有资格激活的窗口里最近激活的一个
 *  (关活动窗口 / 「显示桌面」还原后由它接棒;关对话框时 owner 因 actSeq 最高自然回焦) */
function nextFocusable() {
  let best = null;
  for (const w of wins.values()) {
    if (w.state === 'min' || !canFocus(w)) continue;
    if (!best || w.actSeq > best.actSeq) best = w;
  }
  return best;
}

/* ---------------- 最小化 / 还原 ---------------- */
export function minimize(id) {
  const w = wins.get(id);
  if (!w || w.state === 'min') return;
  if (w.app.dialog) return;   // 对话框不可最小化(避免遮罩下无窗可操作的死角)
  w.prevState = w.state;
  w.state = 'min';
  w.el.classList.add('minimizing');
  // 活动窗口被收起 → 失焦(不转移:逐个收起与「显示桌面」都自然进入无活动状态)
  if (w.el.classList.contains('focused')) {
    w.el.classList.remove('focused');
    notifyBlur(w);
  }
  setTimeout(() => {
    if (w.state === 'min') { w.el.style.display = 'none'; w.el.classList.remove('minimizing'); }
  }, 190);
  emit('min', { id, appId: w.appId });
}

export function restoreWin(id) {
  const w = wins.get(id);
  if (!w || w.state !== 'min') return;
  w.state = w.prevState === 'max' ? 'max' : 'normal';
  w.el.style.display = '';
  w.el.classList.add('opening');
  setTimeout(() => w.el.classList.remove('opening'), 950);   // 与出场动画时长对齐,同上
  emit('restore', { id, appId: w.appId });
}

export function toggleMax(id) {
  const w = wins.get(id);
  if (!w) return;
  if (w.state === 'max') unmaximize(w);
  else {
    if (w.state === 'min') restoreWin(id);
    maximize(w);
  }
}

/** 落地一个矩形:所有改尺寸的入口(最大化/还原/贴边分屏/平铺/层叠/应用 setSize)都走这里,
 *  下限在这一层统一兜住,调用方不用各自记着「不能小于 min」。
 *  给的空间不够就**膨胀到下限**(平铺时因此可能压到隔壁窗口 —— 棋盘不能缩,只能让它盖着),
 *  膨胀后左上角往回收,尽量让整窗留在桌面内(窗口比桌面还大时钉在 0)。 */
function applyRect(w, r, animate) {
  const mn = minSizeOf(w);
  const a = area();
  // 几何取整:小数 left/top/width/height 会让阴影模糊光栅逐帧对不齐(闪烁),整数也更利内容渲染
  const rect = {
    x: r.x, y: r.y,
    w: Math.max(Math.round(r.w), mn.w), h: Math.max(Math.round(r.h), mn.h),
  };
  rect.x = Math.round(clamp(rect.x, 0, Math.max(0, a.width - rect.w)));
  rect.y = Math.round(clamp(rect.y, 0, Math.max(0, a.height - rect.h)));
  if (animate) {
    w.el.classList.add('anim');
    setTimeout(() => w.el.classList.remove('anim'), 200);
  }
  Object.assign(w.el.style, {
    left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px',
  });
  w.hooks.onResize?.(rect.w, rect.h);
}

function maximize(w) {
  const a = area();
  w.restoreRect = { x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight };
  w.state = 'max';
  applyRect(w, { x: 0, y: 0, w: a.width, h: a.height }, true);
  w.el.classList.add('max');
  focus(w.id);
  emit('max', { id: w.id, appId: w.appId });
}

function unmaximize(w) {
  w.state = 'normal';
  w.el.classList.remove('max');
  applyRect(w, w.restoreRect || { x: 40, y: 30, w: 720, h: 480 }, true);
  focus(w.id);
  emit('unmax', { id: w.id, appId: w.appId });
}

/* ---------------- 拖动 ---------------- */
/* 拖动位移走 transform 而非逐帧改 left/top:配合 .dragging 的 will-change,
 * 窗口(连同阴影)提升为合成层后由合成器整体挪动、零重绘 —— 逐帧改
 * left/top 则窗口与模糊阴影每帧重画,且指针坐标带小数(Windows 125%/
 * 150% 缩放)会让阴影光栅逐帧对不齐,表现为活动窗口阴影闪烁。
 * 松手时把位移固化回取整的 left/top,同一帧清掉 transform,无肉眼跳动。 */
function makeDraggable(w) {
  const head = w.el.querySelector('.win-head');
  const zone = head || w.el;   // 无边框窗口:监听整窗,命中 [data-windrag] 才可拖
  zone.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.wbtn')) return;
    if (!head && !e.target.closest('[data-windrag]')) return;
    // 顶栏里嵌了输入控件时(无边框应用自绘顶栏),点在控件上不启动拖动
    if (e.target.closest('input, textarea, button, select, [contenteditable="true"]')) return;
    e.preventDefault();
    focus(w.id);
    const a = area();
    let rect = { w: w.el.offsetWidth, h: w.el.offsetHeight };
    let offX = e.clientX - w.el.offsetLeft;
    let offY = e.clientY - w.el.offsetTop;
    let started = false;
    let baseX = 0, baseY = 0;   // 位移基准(从最大化还原后现取)
    let lastX = 0, lastY = 0;   // 最近一次目标位置,松手时固化
    const wasMax = w.state === 'max';

    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        started = true;
        // 从最大化状态拖动:先还原,窗口跟随鼠标比例位置
        if (w.state === 'max') {
          unmaximize(w);
          const rx = clamp((e.clientX - a.left) / a.width, 0.1, 0.9);
          rect = { w: w.el.offsetWidth, h: w.el.offsetHeight };
          offX = rect.w * rx;
          offY = 16;
        }
        baseX = w.el.offsetLeft;
        baseY = w.el.offsetTop;
        w.el.classList.add('dragging');
        // 拖动打断出场动画:winIn 的 transform 关键帧会盖住拖动位移
        w.el.classList.remove('opening');
      }
      lastX = clamp(ev.clientX - a.left - offX, -rect.w + 90, a.width - 90);
      lastY = clamp(ev.clientY - a.top - offY, 0, a.height - 36);
      w.el.style.transform =
        `translate(${Math.round(lastX - baseX)}px, ${Math.round(lastY - baseY)}px)`;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      w.el.classList.remove('dragging');
      if (!started) return;
      // 位移固化回取整的 left/top 并清掉 transform(同一帧,无跳动)
      w.el.style.left = Math.round(lastX) + 'px';
      w.el.style.top = Math.round(lastY) + 'px';
      w.el.style.transform = '';
      // 贴边分屏:拖到左/右边缘 → 半屏,拖到顶部 → 最大化
      if (!wasMax) {
        if (ev.clientY <= a.top + 6) {
          toggleMax(w.id);
        } else if (ev.clientX <= a.left + 12) {
          applyRect(w, { x: 0, y: 0, w: a.width / 2, h: a.height }, true);
        } else if (ev.clientX >= a.right - 12) {
          applyRect(w, { x: a.width / 2, y: 0, w: a.width / 2, h: a.height }, true);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  if (head) head.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.wbtn')) toggleMax(w.id);
  });
}

/* ---------------- 调整大小 ---------------- */
function makeResizable(w) {
  w.el.querySelectorAll('.rz').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      if (w.state === 'max') return;
      e.preventDefault();
      e.stopPropagation();
      focus(w.id);
      // 每次按下都现算:应用挂载后才上报 contentMin 的情况也能生效
      const { w: minW, h: minH } = minSizeOf(w);
      const dir = handle.dataset.dir;
      const a = area();
      const sx = e.clientX, sy = e.clientY;
      const r = { x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight };

      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        let { x, y, w: ww, h: hh } = r;
        if (dir.includes('e')) ww = clamp(r.w + dx, minW, a.width - r.x);
        if (dir.includes('s')) hh = clamp(r.h + dy, minH, a.height - r.y);
        if (dir.includes('w')) { ww = clamp(r.w - dx, minW, r.x + r.w); x = r.x + r.w - ww; }
        if (dir.includes('n')) { hh = clamp(r.h - dy, minH, r.y + r.h); y = r.y + r.h - hh; }
        // 取整:小数几何会让阴影光栅逐帧抖动(同拖动的闪烁问题)
        Object.assign(w.el.style, {
          left: Math.round(x) + 'px', top: Math.round(y) + 'px',
          width: Math.round(ww) + 'px', height: Math.round(hh) + 'px',
        });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        w.hooks.onResize?.(w.el.offsetWidth, w.el.offsetHeight);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });
}

/* ---------------- 查询与全局操作 ---------------- */
export const isOpen = (appId) => [...wins.values()].some(w => w.appId === appId);
export const count = () => wins.size;
export const get = (id) => wins.get(id);

/** 任务栏按钮所需的信息 */
export function taskList() {
  return [...wins.values()].map(w => ({
    id: w.id, appId: w.appId, title: w.titleEl.textContent,
    state: w.state, icon: w.app.icon, color: w.app.color,
    neon: w.app.neon || null,
  }));
}

/** 显示桌面:全部最小化 / 全部还原 */
export function toggleShowDesktop() {
  const anyVisible = [...wins.values()].some(w => w.state !== 'min');
  for (const w of wins.values()) {
    if (anyVisible) minimize(w.id);
    else restoreWin(w.id);
  }
  // 全部还原后回到此前的活动窗口(minimize 时焦点已清空,还原不另猜)
  if (!anyVisible) { const n = nextFocusable(); if (n) focus(n.id); }
}

/** 浏览器窗口尺寸变化后重新约束所有窗口:
 *  桌面变小时窗口跟着收,但**收不过应用上报的下限**(下限本身已被桌面可用区夹过一层),
 *  并且这里要通知应用(onResize)—— 棋盘类得重新量一次才能跟着变。 */
export function relayout() {
  const a = area();
  for (const w of wins.values()) {
    if (w.state === 'max') {
      const aw = Math.round(a.width), ah = Math.round(a.height);
      Object.assign(w.el.style, { left: '0px', top: '0px', width: aw + 'px', height: ah + 'px' });
      w.hooks.onResize?.(aw, ah);
    } else if (w.state === 'normal') {
      const mn = minSizeOf(w);
      const ww = Math.min(Math.max(w.el.offsetWidth, mn.w), a.width);
      const hh = Math.min(Math.max(w.el.offsetHeight, mn.h), a.height);
      Object.assign(w.el.style, {
        left: clamp(w.el.offsetLeft, -ww + 90, a.width - 90) + 'px',
        top: clamp(w.el.offsetTop, 0, a.height - 36) + 'px',
        width: ww + 'px', height: hh + 'px',
      });
      w.hooks.onResize?.(ww, hh);
    }
  }
}

/* ---------------- 多窗口布局模式 ---------------- */

const visible = () => [...wins.values()].filter(w => w.state !== 'min');

/** 网格平铺:所有可见窗口排满桌面(间隙 8px),最后一行拉伸占满整行 */
export function tile() {
  const vis = visible();
  if (vis.length < 2) return false;
  const a = area();
  const gap = 8;
  const cols = Math.ceil(Math.sqrt(vis.length));
  const rows = Math.ceil(vis.length / cols);
  const cw = (a.width - gap * (cols + 1)) / cols;
  const ch = (a.height - gap * (rows + 1)) / rows;
  vis.forEach((w, i) => {
    if (w.state === 'max') { w.state = 'normal'; w.el.classList.remove('max'); }
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, vis.length - row * cols);   // 该行窗口数
    const rowW = (a.width - gap * (inRow + 1)) / inRow;      // 末行拉伸占满
    applyRect(w, {
      x: Math.round(gap + (i % inRow) * (rowW + gap)),
      y: Math.round(gap + row * (ch + gap)),
      w: Math.round(rowW), h: Math.round(ch),
    }, true);
  });
  return true;
}

/** 层叠排列:恢复级联布局 */
export function cascade() {
  const vis = visible();
  vis.forEach((w, i) => {
    if (w.state === 'max') { w.state = 'normal'; w.el.classList.remove('max'); }
    const a = area();
    const ww = Math.min(780, a.width - 40);
    const hh = Math.min(540, a.height - 40);
    applyRect(w, {
      x: Math.round((a.width - ww) / 2 + i * 26 - (vis.length - 1) * 13),
      y: Math.round((a.height - hh) / 2 + i * 22 - (vis.length - 1) * 11),
      w: ww, h: hh,
    }, true);
  });
  return true;
}

/** 切换活动窗口(Alt+Q):按最近使用顺序循环;
 *  系统模态期只在对话框之间切换,应用模态期跳过被锁定的窗口 */
export function focusCycle() {
  const pool = (modalWins.size ? [...modalWins] : visible().filter(w => !isAppLocked(w)))
    .sort((x, y) => (+y.el.style.zIndex) - (+x.el.style.zIndex));
  if (pool.length < 2) return;
  const cur = pool.findIndex(w => w.el.classList.contains('focused'));
  focus(pool[(cur + 1) % pool.length].id);
}

/** 关闭并重新打开某应用的所有窗口(登录状态变化后刷新界面);params 透传给重开的窗口 */
export function reopen(appId, params) {
  const ids = [...wins.values()].filter(w => w.appId === appId).map(w => w.id);
  for (const id of ids) close(id);
  // 等动画结束后重开
  setTimeout(() => open(appId, params ? { params } : undefined), 200);
}

/** 关闭所有窗口(注销时清空工作区) */
export function closeAll() {
  for (const id of [...wins.keys()]) close(id);
}

/* 改登录名:窗口的执行用户是打开时绑死的旧名,uid 解析不到会失去权限 ——
 * 全部关掉(应用重开即绑新名);会话已是新名,不影响其他窗口。 */
subscribe('accounts:changed', (payload, msg) => {
  if (msg?.type !== 'renamed' || !payload?.from) return;
  for (const w of [...wins.values()]) {
    if (w.execUser === payload.from) close(w.id);
  }
});

/** 当前活动窗口数(应恒为 0 或 1) */
export const focusedCount = () => document.querySelectorAll('.win.focused').length;
