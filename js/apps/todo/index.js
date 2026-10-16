/* ============================================================
 * 应用:便签(Todo)—— 每窗一板的独立数据
 *
 * 完全独立的便签风格:淡色底(可选色球换色)、无边框(frameless)、自绘顶栏。
 * 数据模型 v2:state.boards = 看板数组,每个窗口绑定一块板(boardId),
 *   - 待办板 type:'todo':自己的 tasks(清单数据彼此独立,互不共享)
 *   - 便签板 type:'note':自己的 text(跟记事本一个逻辑,点进去就能写)
 * 每块板有自己的 seq;保存走「读盘-只合并本板-写回」并串行化,
 * 不同窗口同时写不同的板不会互相覆盖。旧 v1 结构(tasks/notes 平铺)
 * 由 normalize 自动迁移:任务清单变首张待办板,每张旧便签各成一板。
 * 桌面图标打开 = 每次新开一张独立便签(不共享已开窗口的数据)。
 *
 * 主窗口顶栏:多行输入(Enter 或 ✓ 添加,封顶 5 行)+ ✓ + 最小化 + 锁
 *   (置顶)+ ☰ + ✕;输入态隐藏 最小化/锁/☰ 给输入让空间;
 *   双击空白处可直接新建任务。窗口随任务数自动增高(封顶后内部滚动)。
 * ☰ 菜单(待办/便签两处一致):新建待办 / 新建便签(都是新板新窗,
 *   创建者处于置顶时新窗继承置顶)/ 背景颜色球 / 删除待办|删除便签(只删本板数据)。
 * 激活态不透明 + macOS 式阴影,非激活态半透明无阴影(见 todo.css)。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './todo.css';
import { accounts } from '../../core/accounts.js';
import { open, reopen, taskList, get as getWin, focus as focusWin } from '../../core/wm.js';
import { requireLogin } from '../../core/loginpanel.js';
import { loadState, saveState, migrateFromLocalStorage } from '../../core/appdata.js';
import fs from '../../core/fs.js';

const KEY = 'webos.todo.v1';
const DEFAULT_BG = '#fef9e0';
const PALETTE = [
  { name: '柠檬', c: '#fef9e0' },
  { name: '樱花', c: '#fde8ec' },
  { name: '薄荷', c: '#e5f2e3' },
  { name: '晴空', c: '#e2edf7' },
  { name: '薰衣草', c: '#ece5f6' },
  { name: '青瓷', c: '#e2f1ee' },
];

let state = null;        // { seq, boards: Board[] } —— 文档形态,所有窗口共享的「盘面缓存」
let hydrated = false;    // appdata 水合完成(窗口据此判断「数据里真没有我这块板」)
let writeQ = Promise.resolve();   // 落盘串行化:读-合并-写 依次进行,防交错丢写

const boardOf = (id) => state?.boards.find(b => b.id === id) || null;

/** 首次使用的种子待办板:仅一条演示任务 */
function seedBoard() {
  return {
    id: 'b1', type: 'todo', color: '', seq: 2,
    tasks: [
      { id: 't1', text: '未完成任务', done: false },
    ],
  };
}

/** v1 结构({tasks,notes,color})与 v2({boards})统一降级/迁移到 v2 */
function normalize(raw) {
  if (!raw) return null;
  const task = (t) => ({ id: String(t.id ?? ''), text: String(t.text ?? '').trim(), done: !!t.done });
  if (Array.isArray(raw.boards)) {
    return {
      seq: raw.seq || 1,
      boards: raw.boards
        .map(b => b && b.id ? {
          id: String(b.id),
          type: b.type === 'note' ? 'note' : 'todo',
          color: String(b.color || ''),
          seq: b.seq || 1,
          ...(b.type === 'note'
            ? { text: String(b.text ?? '') }
            : { tasks: Array.isArray(b.tasks) ? b.tasks.map(task).filter(t => t.id && t.text) : [] }),
        } : null)
        .filter(Boolean),
      // 全关那一刻仍开着的板(桌面图标在「一个都没开」时整组恢复)
      lastOpen: Array.isArray(raw.lastOpen) ? raw.lastOpen.map(String).filter(Boolean) : [],
    };
  }
  if (Array.isArray(raw.tasks)) {
    // v1 → v2:任务清单变首张待办板,每张旧便签各成一板
    const boards = [];
    const tasks = raw.tasks.map(task).filter(t => t.id && t.text);
    if (tasks.length) boards.push({ id: 'b1', type: 'todo', color: String(raw.color || ''), seq: raw.seq || 1, tasks });
    for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
      if (!n?.id) continue;
      boards.push({ id: String(n.id), type: 'note', color: String(n.color || ''), seq: 1, text: String(n.text ?? '') });
    }
    return { seq: raw.seq || 1, boards };
  }
  return null;
}

/** 异步水合:appdata / 旧 localStorage 迁移(migrate 对已存数据原样返回,normalize 兜底降级) */
async function loadAsync() {
  const user = accounts.current();
  if (!user) return null;
  try {
    const data = normalize(await migrateFromLocalStorage('todo', accounts.userKey(KEY), normalize, user));
    return data ?? normalize(await loadState('todo', user));
  } catch (e) {
    console.warn('[todo] 加载失败', e);
    return null;
  }
}

/** 落盘一块板:重读盘面,只把本板合并进去再写回 —— 别的窗口写别的板不受影响。
 *  占位板(pending,水合前的空壳)不落盘:防止竞态里用空数据覆盖真板。
 *  读盘失败(库损坏)不外抛:退回内存整体覆写自愈;写失败只告警 ——
 *  存储异常不该炸断调用链(菜单/删板等操作照常完成) */
function flushBoard(board) {
  const run = async () => {
    const user = accounts.current();
    if (!user || !board || board.pending) return;
    let disk;
    try {
      disk = normalize(await loadState('todo', user));
    } catch (e) {
      console.warn('[todo] 读盘失败,以内存数据整体覆写自愈:', e?.message || e);
    }
    disk = disk || (state?.boards?.length ? state : { seq: 1, boards: [] });
    board.seq = (board.seq || 0) + 1;
    const i = disk.boards.findIndex(b => b.id === board.id);
    if (i >= 0) disk.boards[i] = board;
    else disk.boards.push(board);
    disk.seq = Math.max(disk.seq || 0, (state?.seq || 0) + 1);
    state = disk;   // 内存盘面与磁盘对齐(其他板顺带刷新)
    try {
      await saveState('todo', disk, user);
      await fs.flush();   // 立即冲刷 inode 元数据防抖:关掉「写完就刷新 → 文件半写」的腐坏窗口
    }
    catch (e) { console.warn('[todo] 持久化失败', e?.message || e); }
  };
  writeQ = writeQ.then(run, run);
  return writeQ;
}

/** 删除一块板(只删它自己);存储失败同样只告警,窗口照常关闭 */
function dropBoard(boardId) {
  const run = async () => {
    const user = accounts.current();
    if (!user) return;
    let disk;
    try {
      disk = normalize(await loadState('todo', user));
    } catch (e) {
      console.warn('[todo] 读盘失败,以内存数据整体覆写自愈:', e?.message || e);
    }
    disk = disk || (state?.boards?.length ? state : { seq: 1, boards: [] });
    disk.boards = disk.boards.filter(b => b.id !== boardId);
    disk.seq = (disk.seq || 0) + 1;
    state = disk;
    try {
      await saveState('todo', disk, user);
      await fs.flush();
    }
    catch (e) { console.warn('[todo] 持久化失败', e?.message || e); }
  };
  writeQ = writeQ.then(run, run);
  return writeQ;
}

/** 打开一块板的窗口;该板已有窗口则聚焦(含从最小化还原),不重复开 */
function openBoardWin(boardId, type) {
  for (const t of taskList()) {
    if (t.appId !== 'todo') continue;
    if (getWin(t.id)?.ctx?.params?.boardId === boardId) { focusWin(t.id); return; }
  }
  open('todo', { params: { boardId, type } });
}

/** 记录「全关前仍开着的一组板」(每个便签窗口关闭时刷新;全部关完后,
 *  下一次桌面打开(无参)整组恢复它们) */
function saveLastOpen(ids) {
  const run = async () => {
    const user = accounts.current();
    if (!user) return;
    let disk;
    try { disk = normalize(await loadState('todo', user)); } catch { disk = null; }
    disk = disk || (state?.boards?.length ? state : { seq: 1, boards: [] });
    disk.lastOpen = ids;
    disk.seq = Math.max(disk.seq || 0, (state?.seq || 0) + 1);
    state = disk;
    try { await saveState('todo', disk, user); await fs.flush(); }
    catch (e) { console.warn('[todo] 持久化失败', e?.message || e); }
  };
  writeQ = writeQ.then(run, run);
  return writeQ;
}

/** 新建一块板并开窗。窗口先行:板已推进内存 state(seq 已提升,不会被
 *  水合的旧盘面冲掉),新窗口水合直接命中;落盘转后台,读盘失败时自愈,
 *  不让存储异常拦住开窗(菜单点了没反应的根因)。 */
async function createBoardWin(type, pin = false) {
  state.seq = (state.seq || 0) + 1;
  const b = type === 'note'
    ? { id: 'n' + state.seq, type: 'note', color: '', seq: 1, text: '' }
    : { id: 'b' + state.seq, type: 'todo', color: '', seq: 1, tasks: [] };
  state.boards.push(b);
  open('todo', { params: { boardId: b.id, type, pin: pin || undefined } });
  flushBoard(b);
}

/* 多行输入自适应:高度贴内容,CSS max-height 封顶 5 行,超出由滚动接管;
 * 滚到最底,始终只显示最后 5 行 */
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
  ta.scrollTop = ta.scrollHeight;
}

/* ---------------- ☰ 菜单弹出层(便签配色,不走系统右键菜单) ---------------- */
let menuEl = null;
function closeMenu() {
  if (!menuEl) return;
  menuEl._cleanup?.();
  menuEl.remove();
  menuEl = null;
}
/**
 * @param anchor 锚点按钮(菜单出现在其下方,右对齐)
 * @param items  [{label, ico?, danger?, fn}] | {sep} | {label:'背景颜色', colors:当前色, onPick}
 */
function showNoteMenu(anchor, items) {
  closeMenu();
  const pop = el('div', { class: 'todo-menu' });
  for (const it of items) {
    if (it.sep) { pop.append(el('div', { class: 'tm-sep' })); continue; }
    if (it.boardList) {
      // 「打开已有」:列出除当前外的全部板(待办/便签),点击开窗
      pop.append(el('div', { class: 'tm-label' }, '打开已有'));
      const box = el('div', { class: 'tm-boards' });
      const others = (state?.boards || []).filter(b => b.id !== it.boardList);
      if (!others.length) box.append(el('div', { class: 'tm-empty-hint' }, '没有其他便签'));
      for (const b of others) {
        const name = b.type === 'note'
          ? ((b.text || '').split('\n').find(l => l.trim()) || '').trim().slice(0, 14) || '空便签'
          : (((b.tasks.find(t => !t.done) || b.tasks[0])?.text || '').slice(0, 14) || '空待办');
        box.append(el('button', {
          class: 'tm-item tm-board-item',
          onClick: () => { closeMenu(); openBoardWin(b.id, b.type); },   // 已开的板聚焦,不重复开
        }, icon(b.type === 'note' ? 'pencil' : 'check', 13), el('span', {}, name)));
      }
      pop.append(box);
      continue;
    }
    if (it.colors) {
      pop.append(el('div', { class: 'tm-label' }, it.label || '背景颜色'));
      pop.append(el('div', { class: 'tm-colors' },
        ...PALETTE.map(p => el('button', {
          class: 'tm-ball' + (p.c === it.colors ? ' cur' : ''),
          style: { background: p.c },
          title: p.name,
          onClick: () => { it.onPick(p.c); closeMenu(); },
        }))));
      continue;
    }
    pop.append(el('button', {
      class: 'tm-item' + (it.danger ? ' danger' : ''),
      onClick: () => { closeMenu(); it.fn?.(); },
    },
      it.ico ? icon(it.ico, 14) : null,
      el('span', {}, it.label)));
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8));
  let top = r.bottom + 6;
  if (top + pop.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 6);
  Object.assign(pop.style, { left: left + 'px', top: top + 'px' });
  menuEl = pop;
  const offDown = (e) => { if (!pop.contains(e.target)) closeMenu(); };
  const offKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', offDown, true);
    document.addEventListener('keydown', offKey, true);
  }, 0);
  pop._cleanup = () => {
    document.removeEventListener('pointerdown', offDown, true);
    document.removeEventListener('keydown', offKey, true);
  };
}

/* 菜单公共段:新建待办 / 新建便签 / 背景颜色(取色于 board)/ 删除本板。
 * persist 由各视图注入:防抖落盘「当前板」(板对象可能被同步采纳换过引用);
 * isPinned:创建者当前置顶态 —— 新建的板/窗继承它 */
function boardMenuItems(board, ctx, { onColor, persist, isPinned }) {
  return [
    { label: '新建待办', ico: 'plus', fn: () => { createBoardWin('todo', isPinned()); } },
    { label: '新建便签', ico: 'pencil', fn: () => { createBoardWin('note', isPinned()); } },
    { sep: true },
    { boardList: board?.id },
    { sep: true },
    { label: '背景颜色', colors: board?.color || DEFAULT_BG, onPick: (c) => {
      if (board) { board.color = c === DEFAULT_BG ? '' : c; onColor(); persist(); }
    } },
    { sep: true },
    { label: board?.type === 'note' ? '删除便签' : '删除待办', ico: 'trash', danger: true, fn: async () => {
      await dropBoard(board?.id);
      ctx.close();
    } },
  ];
}

register({
  ...manifest,
  mount(ctx) {
    const { root } = ctx;
    // ---- 账号门:未登录先渲染登录面板 ----
    if (requireLogin(root, '便签', appRemount)) {
      // 无边框窗口没有系统关闭钮:登录门也要留一个 ✕,免得窗口关不掉
      const gateBar = el('div', { class: 'todo-bar todo-bar-gate', dataset: { windrag: '' } },
        el('span', { style: { flex: 1 } }),
        el('button', { class: 'todo-bar-btn todo-close', title: '关闭', onClick: () => ctx.close() }, icon('close', 14)));
      root.prepend(gateBar);
      return;
    }
    if (!state) state = { seq: 1, boards: [] };
    // 本窗绑定:params.boardId(旧会话记录的 noteId 兼容;type 标注视图);
    // 无参 = 主待办板(第一张待办板,没有则播种)
    const params = ctx.params || {};
    const boardId = params.boardId || params.noteId || null;
    const isNote = params.type === 'note' || !!params.noteId;
    const startPinned = params.pin === true;   // 置顶的创建者开的新窗继承置顶
    // 占位板:指定 id 的等水合回填;无参的先用种子(盘上已有板时水合会换);
    // pending 标记 = 水合前的空壳,flushBoard 拒绝落盘
    const ref = { board: boardId
      ? { id: boardId, type: isNote ? 'note' : 'todo', color: '', seq: 0, tasks: [], text: '', pending: true }
      : Object.assign(seedBoard(), { pending: true }) };
    return isNote ? mountNote(ctx, ref, boardId, startPinned) : mountMain(ctx, ref, boardId, startPinned);
  },
});

/* 水合:盘面比内存新才采纳;然后解析本窗的板(缺板且已水合 → 关窗) */
function hydrate(ctx, ref, boardId, render) {
  loadAsync().then((s) => {
    hydrated = true;
    if (s && s.seq > (state?.seq || 0)) state = s;
    if (boardId) {
      const b = boardOf(boardId);
      if (!b) { ctx.close(); return; }   // 数据里没有这块板(他窗已删):关掉
      ref.board = b;
    } else {
      // 无参:桌面图标。一个便签窗口都没开时,整组恢复「上次全关前开着
      // 的板」;已有窗口则新开一张独立空便签(不与已开窗口共享数据);
      // params.reuseFirst(登录重挂载)= 回到第一张待办板。
      // 盘上从来没有任何板才播种演示种子。回写 boardId:会话恢复原样开回这块板
      let b = ctx.params?.reuseFirst ? state.boards.find(x => x.type === 'todo') : null;
      // 注意排除自身(水合回调时本窗已登记进窗口表)
      if (!b && !ctx.params?.reuseFirst && !taskList().some(t => t.appId === 'todo' && t.id !== ctx.win.id)) {
        const ids = (state.lastOpen || []).filter(id => boardOf(id));
        if (ids.length) {
          state.lastOpen = [];
          saveLastOpen([]);
          ids.forEach(id => openBoardWin(id, boardOf(id).type));
          ctx.close();   // 关掉这个占位窗,让位给整组恢复
          return;
        }
      }
      if (!b) {
        if (state.boards.length === 0) {
          b = ref.board;
          delete b.pending;   // 种子转正
        } else {
          b = { id: 'b' + ((state.seq = (state.seq || 0) + 1)), type: 'todo', color: '', seq: 1, tasks: [] };
        }
        state.boards.push(b);
        ctx.params.boardId = b.id;
        flushBoard(b);
      }
      ref.board = b;
    }
    render();
  });
  // 轮询:盘面更新时刷新本窗的板(自己刚写的不算:flush 已对齐 seq)
  const syncTimer = setInterval(async () => {
    try {
      const user = accounts.current();
      if (!user) return;
      const fresh = normalize(await loadState('todo', user));
      if (!fresh || fresh.seq <= (state?.seq || 0)) return;
      state = fresh;
      const b = boardOf(ref.board?.id);
      if (!b) { if (hydrated) ctx.close(); return; }
      if (b.seq !== ref.board.seq) { ref.board = b; render(); }
      else ref.board = b;   // 其他板变了,本板没变:只对齐引用
    } catch { /* 忽略 */ }
  }, 1500);
  return () => clearInterval(syncTimer);
}

/* ============================================================
 * 待办板窗口
 * ============================================================ */
function mountMain(ctx, ref, boardId, startPinned) {
  const { root, setTitle, onContextMenu } = ctx;

  // 用户手动改过窗口尺寸(拖边等)后,不再自动调整窗口
  let userResized = false;
  let selfFit = false;          // 自己 setSize 引发的 onResize 不算用户操作
  let pinned = startPinned;     // 置顶创建者开的新窗继承置顶
  // 防抖落盘本窗「当前板」(板对象可能被同步采纳换过引用,须现取)
  let flushT = 0;
  const persist = () => { clearTimeout(flushT); flushT = setTimeout(() => flushBoard(ref.board), 200); };

  // 右键:任务行 → 完成 / 删除(文本选中时系统自动附加「复制」)
  onContextMenu(({ target }) => {
    const row = target.closest?.('.todo-item');
    if (!row || row.classList.contains('todo-draft')) return null;
    const t = ref.board.tasks.find(x => x.id === row.dataset.id);
    if (!t) return null;
    return [
      { label: t.done ? '标记为待办' : '标记完成', icon: 'check', fn: () => { t.done = !t.done; persist(); render(); } },
      { sep: true },
      { label: '删除任务', icon: 'trash', danger: true, fn: () => { del(t); } },
    ];
  });

  /* ---- 顶栏(融合标题栏):输入 + [弹性占位] + ✓ + 最小化 + 锁 + ☰ + ✕ ----
   * 输入态(editing)隐藏 最小化/锁/☰,给输入让出空间 */
  const winEl = root.closest('.win');
  const bar = el('div', { class: 'todo-bar', dataset: { windrag: '' } });
  const input = el('textarea', { class: 'todo-input', rows: 1, placeholder: '记点什么…', spellcheck: 'false' });
  const addBtn = el('button', { class: 'todo-bar-btn todo-add-btn', title: '添加任务' }, icon('check', 15));
  const minBtn = el('button', { class: 'todo-bar-btn todo-min', title: '最小化' }, icon('minus', 14));
  const lockBtn = el('button', { class: 'todo-bar-btn todo-lock', title: '置顶' }, icon('lock', 14));
  const menuBtn = el('button', { class: 'todo-bar-btn todo-menu-btn', title: '更多设置' }, icon('menu', 15));
  const closeBtn = el('button', { class: 'todo-bar-btn todo-close', title: '关闭' }, icon('close', 14));

  const add = () => {
    const text = input.value.trim();
    if (!text) return;
    ref.board.tasks.push({ id: 't' + (ref.board.seq = (ref.board.seq || 0) + 1), text, done: false });
    input.value = '';
    autoGrow(input);
    syncInput();
    persist();
    render();
    input.focus();
  };
  // 输入法组合中的按键(回车上屏 / Esc 取消候选)归输入法,不进快捷键
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  const imeBusy = (e) => e.isComposing || e.keyCode === 229 || composing;
  input.addEventListener('keydown', (e) => {
    if (imeBusy(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
    else if (e.key === 'Escape') {
      // 无文字:退回收窄的正常态;有文字:filled 保持展开(文字不清)
      bar.classList.remove('editing');
      input.blur();
    }
  });
  // 输入内容后 ✓ 出现、输入框保持展开;无内容失焦时收窄
  const syncInput = () => {
    addBtn.classList.toggle('has', !!input.value.trim());
    input.classList.toggle('filled', !!input.value);
  };
  input.addEventListener('input', () => { autoGrow(input); syncInput(); fitHeight(); });
  // 聚类驱动样式(editing):展开输入框 + 隐藏 最小化/锁/☰
  input.addEventListener('focus', () => { bar.classList.add('editing'); syncInput(); });
  input.addEventListener('blur', () => { bar.classList.remove('editing'); });
  // ✓ 用 pointerdown + preventDefault:按下即添加,先于输入框失焦引发的
  // 收窄回流(此前 click 常被按钮位移吞掉,表现为「第一次点没反应」)
  addBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); add(); });
  minBtn.addEventListener('click', () => ctx.minimize());
  lockBtn.addEventListener('click', () => {
    pinned = !pinned;
    lockBtn.classList.toggle('on', pinned);
    lockBtn.title = pinned ? '取消置顶' : '置顶';
    ctx.setPinned(pinned);
  });
  if (startPinned) {
    lockBtn.classList.add('on');
    lockBtn.title = '取消置顶';
    ctx.setPinned(true);   // 挂载期窗口尚未登记,focus 为 no-op;spawn 末尾的 focus 按置顶档抬到最前
  }
  closeBtn.addEventListener('click', () => ctx.close());
  // 弹性占位:把图标组钉在右上角,不受输入框宽度影响;也是主要拖动区;
  // 图标收进紧密小组(组内间距 2px),不再跟着顶栏的大间距散开
  const spacer = el('span', { class: 'todo-bar-spacer' });
  const btnGroup = el('div', { class: 'todo-bar-btns' }, addBtn, minBtn, lockBtn, menuBtn, closeBtn);
  bar.append(input, spacer, btnGroup);

  menuBtn.addEventListener('click', () => showNoteMenu(menuBtn, boardMenuItems(ref.board, ctx, {
    persist, onColor: applyColor, isPinned: () => pinned,
  })));

  /* ---- 列表 ---- */
  const app = el('div', { class: 'app todo-app' });
  const listBox = el('div', { class: 'todo-items' });
  const list = el('div', { class: 'todo-list' });
  listBox.append(list);
  app.append(bar, listBox);
  root.append(app);
  autoGrow(input);   // 规范初始高度(单行)

  const del = (t) => {
    ref.board.tasks = ref.board.tasks.filter(x => x.id !== t.id);
    persist();
    render();
  };

  function taskRow(t) {
    return el('div', { class: 'todo-item' + (t.done ? ' done' : ''), dataset: { id: t.id } },
      el('button', {
        class: 'todo-check' + (t.done ? ' on' : ''),
        title: t.done ? '标记为待办' : '标记完成',
        onClick: () => { t.done = !t.done; persist(); render(); },
      }),
      el('div', { class: 'todo-t' }, t.text),
      el('button', {
        class: 'todo-del', title: '删除',
        onClick: () => del(t),
      }, icon('close', 12)));
  }

  /* 双击任务 → 行内编辑:Enter 保存 / Esc 还原 / 失焦保存 */
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.todo-item');
    if (!row || e.target.closest('.todo-check, .todo-del')) return;
    const label = row.querySelector('.todo-t');
    if (!label) return;                       // 草稿行走自己的提交逻辑
    const t = ref.board.tasks.find(x => x.id === row.dataset.id);
    if (!t || row.querySelector('.todo-edit')) return;
    const ed = el('textarea', { class: 'todo-edit', rows: 1, spellcheck: 'false' });
    ed.value = t.text;
    row.draggable = false;                    // 编辑期间不启动行拖拽
    label.replaceWith(ed);
    autoGrow(ed);
    ed.focus();
    ed.setSelectionRange(ed.value.length, ed.value.length);
    let settled = false;
    const commit = (save) => {
      if (settled) return;
      settled = true;
      const v = ed.value.trim();
      if (save && v) { t.text = v; persist(); }   // 清空则视为放弃,保留原文
      render();
    };
    ed.addEventListener('keydown', (e2) => {
      if (e2.isComposing || e2.keyCode === 229) return;   // 输入法组合中的回车/Esc 归输入法
      if (e2.key === 'Enter' && !e2.shiftKey) { e2.preventDefault(); commit(true); }
      else if (e2.key === 'Escape') { e2.preventDefault(); commit(false); }
    });
    // blur/focusout 双保险(settled 防重入)
    ed.addEventListener('blur', () => commit(true));
    ed.addEventListener('focusout', () => commit(true));
    ed.addEventListener('input', () => { autoGrow(ed); fitHeight(); });
  });

  /* 双击空白处 → 新建任务(草稿行):有文字才落库,空内容失焦即弃 */
  function startNewDraft() {
    const existed = list.querySelector('.todo-draft .todo-edit');
    if (existed) { existed.focus(); return; }
    list.querySelector('.todo-empty')?.remove();
    const row = el('div', { class: 'todo-item todo-draft' });
    const ed = el('textarea', { class: 'todo-edit', rows: 1, placeholder: '新任务,回车创建…', spellcheck: 'false' });
    row.append(ed);
    list.append(row);
    listBox.scrollTop = listBox.scrollHeight;
    autoGrow(ed);
    fitHeight();
    ed.focus();
    let settled = false;
    const commit = (save) => {
      if (settled) return;
      settled = true;
      const v = ed.value.trim();
      if (save && v) {
        ref.board.tasks.push({ id: 't' + (ref.board.seq = (ref.board.seq || 0) + 1), text: v, done: false });
        persist();
      }
      render();
    };
    ed.addEventListener('keydown', (e2) => {
      if (e2.isComposing || e2.keyCode === 229) return;   // 输入法组合中的回车/Esc 归输入法
      if (e2.key === 'Enter' && !e2.shiftKey) { e2.preventDefault(); commit(true); }
      else if (e2.key === 'Escape') { e2.preventDefault(); commit(false); }
    });
    // blur/focusout 双保险(settled 防重入):有文字才创建,空内容即弃
    ed.addEventListener('blur', () => commit(!!ed.value.trim()));
    ed.addEventListener('focusout', () => commit(!!ed.value.trim()));
    ed.addEventListener('input', () => { autoGrow(ed); fitHeight(); });
  }
  // 双击空白建任务:监听挂在应用根 —— 列表空白、底部预留区都算数。
  // isConnected 守卫:行内编辑(在 list 监听器里先行执行)会把双击的目标
  // .todo-t 替换出 DOM,游离节点上 closest 恒为 null,会被误判成「双击了
  // 空白」而抢焦点建草稿、把刚开的编辑器瞬间顶掉(真实双击打在文字上,
  // 表现为双击编辑几乎永远失败)
  app.addEventListener('dblclick', (e) => {
    if (!e.target.isConnected) return;            // 目标刚被行内编辑替换:不是空白
    if (e.target.closest('.todo-item')) return;   // 任务行:走行内编辑
    if (e.target.closest('.todo-bar')) return;    // 顶栏:不建(输入框等)
    startNewDraft();
  });

  // 回车 = 新建并直接编辑一条任务(同双击空白):本窗激活、且事件不是从
  // 输入控件发出时生效(顶栏输入框/行内编辑/草稿里的回车各有自己的语义,
  // 按事件源判而不是 activeElement —— 草稿提交的回车会冒泡到此处)
  const onKeyNew = (e) => {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;   // 输入法组合中的回车归输入法
    if (!winEl.classList.contains('focused')) return;
    if (e.target?.closest?.('input, textarea, button, select, [contenteditable="true"]')) return;
    if (e.target !== document.body && e.target !== document && !app.contains(e.target)) return;
    e.preventDefault();
    startNewDraft();
  };
  document.addEventListener('keydown', onKeyNew);

  // 拖拽排序(指针版,5px 起拖阈值):原生 draggable 会让双击编辑极易被
  // 手抖误触成拖拽(第二击按下稍有位移就被抢走),弃用;指针方案不与
  // 双击/点击抢手势 —— 未超过阈值就是普通点击/双击,超过才进入拖拽。
  let drag = null;
  const onDragMove = (e) => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.started = true;
    }
    list.querySelector(`.todo-item[data-id="${CSS.escape(drag.id)}"]`)?.classList.add('dragging');
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.todo-item');
    if (!over || over.dataset.id === drag.id) return;
    const from = ref.board.tasks.findIndex(t => t.id === drag.id);
    const to = ref.board.tasks.findIndex(t => t.id === over.dataset.id);
    if (from < 0 || to < 0) return;
    const [moved] = ref.board.tasks.splice(from, 1);
    ref.board.tasks.splice(to, 0, moved);
    persist(); render();
  };
  const onDragUp = () => {
    if (!drag) return;
    if (drag.started) list.querySelectorAll('.dragging').forEach(r => r.classList.remove('dragging'));
    drag = null;
  };
  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const row = e.target.closest('.todo-item');
    if (!row || row.classList.contains('todo-draft')) return;
    if (e.target.closest('.todo-check, .todo-del, .todo-edit')) return;
    drag = { id: row.dataset.id, x: e.clientX, y: e.clientY, started: false };
  });
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);

  function render() {
    setTitle('便签');   // 标题恒定,任务栏不随内容变
    list.innerHTML = '';
    if (!ref.board.tasks.length) {
      list.append(el('div', { class: 'todo-empty' }, '没有任务,记一条吧'));
    } else {
      for (const t of ref.board.tasks) list.append(taskRow(t));
    }
    fitHeight();
  }

  /* ---- 窗口随内容自动调高 ----
   * 量「自然内容高」(列表内层不受滚动容器夹高),加上窗框即整窗高;
   * 封顶为桌面可用区高度(留边),超出部分由列表内部滚动。
   * 用户改过尺寸后(userResized)永久停用,直到应用重开。 */
  let fittedW = 0, fittedH = 0; // 最近一次调整后的整窗尺寸(判用户是否改过)
  function fitHeight() {
    if (userResized || !winEl || !winEl.offsetHeight) return;   // 最小化中量不到,跳过
    const cs = getComputedStyle(app);
    const need = list.offsetHeight + bar.offsetHeight
      + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.rowGap);
    const chrome = winEl.offsetHeight - root.offsetHeight;
    const areaH = winEl.parentElement.getBoundingClientRect().height;
    if (!areaH || chrome < 0) return;
    const winH = Math.min(Math.round(need + chrome), Math.round(areaH - 30));
    if (Math.abs(winEl.offsetHeight - winH) < 2) { fittedW = winEl.offsetWidth; fittedH = winEl.offsetHeight; return; }
    selfFit = true;
    try {
      ctx.setSize(winEl.offsetWidth, winH);
      // 回读:setSize 会被窗口下限/桌面夹住,记录实际生效值
      fittedW = winEl.offsetWidth; fittedH = winEl.offsetHeight;
    } finally { selfFit = false; }
  }
  fittedW = winEl?.offsetWidth || 0;
  fittedH = winEl?.offsetHeight || 0;

  /* ---- 背景色 ---- */
  function applyColor() { winEl?.style.setProperty('--note-bg', ref.board?.color || DEFAULT_BG); }
  applyColor();

  render();
  const stopSync = hydrate(ctx, ref, boardId, () => { applyColor(); render(); });

  return {
    // 尺寸真的变了才是用户操作:主题切换等触发的 relayout 不改尺寸,不算
    onResize(nw, nh) {
      if (selfFit) return;
      if (Math.abs(nw - fittedW) < 2 && Math.abs(nh - fittedH) < 2) return;
      userResized = true;
    },
    onClose() {
      stopSync(); closeMenu();
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
      document.removeEventListener('keydown', onKeyNew);
      // 记录「此刻仍开着的一组板」(含自己):全部关完后,下次桌面打开整组恢复
      try {
        const ids = taskList().filter(t => t.appId === 'todo')
          .map(t => getWin(t.id)?.ctx?.params?.boardId)
          .filter(Boolean);
        saveLastOpen(ids);
      } catch { /* 忽略 */ }
      return true;
    },
  };
}

/* ============================================================
 * 便签板窗口:无输入框、无勾选框,点进去就能写(记事本逻辑)
 * ============================================================ */
function mountNote(ctx, ref, boardId, startPinned) {
  const { root, setTitle } = ctx;
  const winEl = root.closest('.win');

  setTitle('便签');

  const bar = el('div', { class: 'todo-bar todo-bar-note', dataset: { windrag: '' } },
    el('span', { style: { flex: 1 } }),
    el('div', { class: 'todo-bar-btns' },
      el('button', { class: 'todo-bar-btn todo-min', title: '最小化' }, icon('minus', 14)),
      el('button', { class: 'todo-bar-btn todo-lock', title: '置顶' }, icon('lock', 14)),
      el('button', { class: 'todo-bar-btn todo-menu-btn', title: '更多设置' }, icon('menu', 15)),
      el('button', { class: 'todo-bar-btn todo-close', title: '关闭' }, icon('close', 14))));
  const ta = el('textarea', { class: 'todo-note-text', placeholder: '写点什么…', spellcheck: 'false' });
  const app = el('div', { class: 'app todo-app todo-note-app' }, bar, ta);
  root.append(app);

  let pinned = startPinned;     // 置顶创建者开的新窗继承置顶
  // 防抖落盘本窗「当前板」(同 mountMain:现取引用)
  let flushT = 0;
  const persist = () => { clearTimeout(flushT); flushT = setTimeout(() => flushBoard(ref.board), 200); };
  const lockBtn = bar.querySelector('.todo-lock');
  bar.querySelector('.todo-min').addEventListener('click', () => ctx.minimize());
  lockBtn.addEventListener('click', () => {
    pinned = !pinned;
    lockBtn.classList.toggle('on', pinned);
    lockBtn.title = pinned ? '取消置顶' : '置顶';
    ctx.setPinned(pinned);
  });
  if (startPinned) {
    lockBtn.classList.add('on');
    lockBtn.title = '取消置顶';
    ctx.setPinned(true);
  }
  bar.querySelector('.todo-close').addEventListener('click', () => ctx.close());
  bar.querySelector('.todo-menu-btn').addEventListener('click', (e) => {
    showNoteMenu(e.currentTarget, boardMenuItems(ref.board, ctx, { persist, onColor: applyColor, isPinned: () => pinned }));
  });

  ta.addEventListener('input', () => { ref.board.text = ta.value; persist(); });

  function applyColor() {
    winEl?.style.setProperty('--note-bg', ref.board?.color || DEFAULT_BG);
  }
  function render() {
    if (document.activeElement !== ta) ta.value = ref.board?.text || '';
    applyColor();
  }
  render();
  const stopSync = hydrate(ctx, ref, boardId, render);

  return {
    onClose() {
      stopSync(); closeMenu();
      try {
        const ids = taskList().filter(t => t.appId === 'todo')
          .map(t => getWin(t.id)?.ctx?.params?.boardId)
          .filter(Boolean);
        saveLastOpen(ids);
      } catch { /* 忽略 */ }
      return true;
    },
  };
}

/** 重新挂载当前应用(登录状态变化后调用):回到已有清单,而不是新开一张 */
function appRemount() {
  reopen('todo', { reuseFirst: true });
}
