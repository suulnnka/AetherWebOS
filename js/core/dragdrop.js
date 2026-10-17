/* ============================================================
 * DragDrop —— 系统级文件拖放协议
 *
 * 网页没有「拖文件给另一个窗口」这半边:HTML5 DnD 只服务宿主机
 * → 浏览器的导入(viewer/localfiles),系统内虚拟文件互不相通。
 * 本模块补齐这半边,一套指针协议贯通桌面图标 / 文件管家 / 回收站:
 *
 *   startFileDrag(pointerdown事件, makeSession)   源头:5px 起拖阈值,
 *     过阈值才调 makeSession() 构造会话(选择已在按下时落定);
 *     未过阈值松手 = 普通点击,零干扰。
 *   registerTarget({ cls, accepts, drop })         目标:注册即挂进
 *     全局注册表;悬停解析走 document.elementFromPoint,天然按真实
 *     层叠与窗口遮挡裁决(被别的窗口盖住的图标收不到投放)。
 *   movePaths / trashPaths                         放置语义:拖入即移动
 *     (rename,零拷贝);同目录投放报错;重名跳过不覆盖。
 *
 * 会话期间显示幽灵图标 #drag-ghost:挂在 body 根层叠上下文,
 * z-index 980 —— 高于窗口层 #windows(5),低于任务栏(1000)/
 * 右键菜单(1300)/ 模态遮罩(1500+),层级模型见 wm.js restack。
 * 原图标原地淡显(.dragging,不再越层浮到窗口之上 —— 旧版
 * .dicon.dragging 的 z-index:10 会把图标抬过整层窗口,视觉上
 * 暗示能拖进去实际不能,是层级冲突的根因)。
 * ============================================================ */
import { el } from './utils.js';
import fs from './fs.js';
import { icon } from './icons.js';
import { accounts } from './accounts.js';
import { dialogs } from './dialogs.js';
import { moveToTrash } from './trash.js';
import { publish } from './bus.js';
import { t } from './i18n.js';

let session = null;   // 活动会话(未起拖时 null)
let ghostEl = null;
let hover = null;     // 当前悬停目标 { el, cls }

const targets = [];   // { cls, accepts(hitEl, session)→目标元素|null, drop(el, session, x, y) }

export const isDragging = () => !!session;

/**
 * 开始一次文件拖拽。在源元素的 pointerdown(左键)上调用;
 * makeSession 在跨过 5px 起拖阈值时调用一次,返回会话或 null(放弃):
 *   { paths, user?, originEls?, ghost:{icon,color,label}, onBlankDesktop?(x,y) }
 * onBlankDesktop:松手在空白桌面时回调(桌面图标的原位重排);
 * 未提供时空白桌面按「移动到桌面目录」处理(文件管家拖出)。
 */
export function startFileDrag(e, makeSession) {
  if (e.button !== 0 || session) return;   // 仅左键;同一时刻至多一个会话
  const sx = e.clientX, sy = e.clientY;
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };
  const move = (ev) => {
    if (!session) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      const s = makeSession();
      // 空路径会话仅限纯重排(提供 onBlankDesktop):任何放置目标都不接受它
      if (!s || !(s.paths?.length || s.onBlankDesktop)) { cleanup(); return; }
      s.paths = s.paths || [];
      session = { user: accounts.current(), originEls: [], ...s };
      document.body.classList.add('file-drag');
      for (const n of session.originEls) n.classList?.add?.('dragging');
      ghostEl = el('div', { id: 'drag-ghost' },
        el('span', { class: 'dg-tile', style: { background: s.ghost?.color || 'var(--accent)' } },
          icon(s.ghost?.icon || 'file', 18)),
        el('span', { class: 'dg-label' }, s.ghost?.label || ''),
        s.paths.length > 1 ? el('span', { class: 'dg-count' }, String(s.paths.length)) : null);
      document.body.append(ghostEl);
    }
    track(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    const s = session;
    if (s) {
      const hit = resolve(ev.clientX, ev.clientY);
      endDrag();
      if (hit) {
        try { hit.tg.drop(hit.el, s, ev.clientX, ev.clientY); }
        catch (err) { console.error('[dragdrop] 放置处理出错:', err); }
      }
    }
    cleanup();
  };
  const cancel = () => { endDrag(); cleanup(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

/* 会话收尾:撤幽灵与高亮、还原淡显;无放置目标时即「取消」语义 */
function endDrag() {
  ghostEl?.remove();
  ghostEl = null;
  setHover(null);
  document.body.classList.remove('file-drag');
  for (const n of session?.originEls || []) n.classList?.remove?.('dragging');
  session = null;
}

/* 幽灵跟随 + 悬停目标解析(elementFromPoint,遮挡自动正确) */
function track(x, y) {
  if (ghostEl) {
    ghostEl.style.left = (x + 14) + 'px';
    ghostEl.style.top = (y + 12) + 'px';
  }
  const hit = resolve(x, y);
  setHover(hit);
  ghostEl?.classList.toggle('ok', !!hit);
}

function resolve(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  // 注册表顺序即优先级:具体目标(文件夹行/图标)先于笼统目标(窗口体/桌面)
  for (const tg of targets) {
    const node = tg.accepts(hit, session);
    if (node?.isConnected) return { el: node, tg };
  }
  return null;
}

function setHover(hit) {
  if (hover?.el === hit?.el) return;
  if (hover?.cls) hover.el.classList.remove(hover.cls);
  hover = hit ? { el: hit.el, cls: hit.tg.cls } : null;
  if (hover?.cls) hover.el.classList.add(hover.cls);
}

/**
 * 注册一个拖放目标。accepts 收 elementFromPoint 的命中元素,返回
 * 实际目标元素(通常 hit.closest(选择器) 并校验属于自己窗口)或 null;
 * drop 收(目标元素, 会话, 松手坐标)。返回注销函数(应用 onClose 调)。
 */
export function registerTarget(entry) {
  targets.push(entry);
  return () => {
    const i = targets.indexOf(entry);
    if (i >= 0) targets.splice(i, 1);
    // 悬停中的目标被注销(如窗口关闭):下一次 track 会重新解析,这里无需处理
  };
}

const notify = (title, body) =>
  publish('sys:notify', { from: 'dragdrop', type: 'notify', payload: { title, body } });

/**
 * 拖入 = 移动(rename,零拷贝)。
 * 同目录投放(源与目标相同)→ 报错;目标是某被拖文件夹自身/子目录 → 报错;
 * 目标重名 → 跳过不覆盖(toast 提示);成功 → toast 汇总。
 * @returns {number} 实际移动的条数
 */
export function movePaths(paths, destDir, user = accounts.current()) {
  const dest = fs.normPath(destDir);
  const src = [...new Set((paths || []).map(p => fs.normPath(p)))];
  const parents = [...new Set(src.map(p => fs.parentPath(p)))];
  if (parents.length === 1 && fs.normPath(parents[0]) === dest) {
    dialogs.error({
      title: t('无法移动'),
      message: t('「{name}」已经在「{dir}」中,不能移动到它所在的文件夹。',
        { name: fs.basename(src[0]), dir: dest }),
    });
    return 0;
  }
  // 剔除:中途已删 / 目标是自身或其子目录(全部被剔除 = 移入自己)
  const items = src.filter(p => fs.exists(p) && p !== dest && !dest.startsWith(p + '/'));
  if (!items.length) {
    dialogs.error({ title: t('无法移动'), message: t('不能把文件夹移动到它自己或它的子文件夹中。') });
    return 0;
  }
  let moved = 0, clash = 0;
  fs.batch(() => {
    for (const p of items) {
      const target = fs.joinPath(dest, fs.basename(p));
      if (fs.exists(target)) { clash++; continue; }   // 重名:跳过,不覆盖
      if (fs.rename(p, target, { as: user })) moved++;
    }
  }).catch(() => {});
  if (moved) notify(t('已移动 {n} 个项目', { n: moved }), dest);
  if (clash) notify(t('已跳过 {n} 个同名项目', { n: clash }), t('目标文件夹已有同名项目,未覆盖。'));
  return moved;
}

/** 拖入回收站 = 删除(rename 入筒,可在回收站窗口还原) */
export function trashPaths(paths, user = accounts.current()) {
  const n = moveToTrash(paths, user);
  if (n) notify(t('已移入回收站 {n} 项', { n }), t('可在回收站窗口中还原。'));
  return n;
}

export default { isDragging, startFileDrag, registerTarget, movePaths, trashPaths };
