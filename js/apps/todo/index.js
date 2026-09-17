/* ============================================================
 * 应用:任务(Todo)
 *
 * 项目分组 + 优先级 + 截止日期 + 星标 + 进度统计。
 * 数据持久化到 localStorage(webos.todo.v1)。
 * 系统联动:
 *  - 新建带截止日期的任务时可选提醒(经 sys:notify 弹系统通知);
 *  - 桌面/文件管家的 /home/desktop/todo.txt 汇出只读清单(可选命令)。
 * ============================================================ */
import { el, escapeHtml, fmtDate } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './todo.css';
import { dialogs } from '../../core/dialogs.js';
import { subscribe, publish } from '../../core/bus.js';
import fs from '../../core/fs.js';
import sms from '../../core/sms.js';
import { accounts } from '../../core/accounts.js';
import { reopen } from '../../core/wm.js';
import { requireLogin, logoutButton } from '../../core/loginpanel.js';

const KEY = 'webos.todo.v1';
let state = null;
function load() {
  const userKey = accounts.userKey(KEY);
  if (!userKey) return null;
  try {
    const s = JSON.parse(localStorage.getItem(userKey));
    if (s && Array.isArray(s.tasks)) return s;
  } catch { /* 忽略 */ }
  return {
    seq: 1,
    projects: ['个人', '工作'],
    tasks: [
      { id: 't1', project: '个人', text: '探索 WebOS 的各个应用', done: true, prio: 1, due: '', starred: false, created: Date.now() - 86400e3 },
      { id: 't2', project: '个人', text: '完成《赛博档案》谜题', done: false, prio: 2, due: '', starred: true, created: Date.now() - 3600e3 },
      { id: 't3', project: '工作', text: '给 hint@nexus 写信获取提示', done: false, prio: 0, due: fmtDate(new Date()), starred: false, created: Date.now() },
    ],
  };
}
let saveT;
const persist = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const userKey = accounts.userKey(KEY);
    if (!userKey) return;
    try { localStorage.setItem(userKey, JSON.stringify(state)); } catch (e) { console.warn('[todo] 持久化失败', e); }
  }, 200);
};

const PRIO = [
  { v: 0, name: '低', color: '#64748b' },
  { v: 1, name: '中', color: '#0ea5e9' },
  { v: 2, name: '高', color: '#ef4444' },
];
const prioOf = (v) => PRIO[v] || PRIO[0];
const dueMeta = (t) => {
  if (!t.due) return null;
  const today = fmtDate(new Date());
  if (t.due < today) return { text: '已逾期', cls: 'late' };
  if (t.due === today) return { text: '今天', cls: 'today' };
  return { text: t.due.slice(5), cls: '' };
};

register({
  ...manifest,
  mount({ root, setTitle, bus, onContextMenu }) {
    // ---- 账号门:未登录先渲染登录面板 ----
    if (requireLogin(root, '任务', () => { /* 重新挂载由外层负责 */ location.hash = location.hash; root.innerHTML = ''; appRemount(); })) {
      return;
    }
    state = load();
    if (!state) {
      state = { seq: 1, projects: ['个人', '工作'], tasks: [] };
      persist();
    }

    // 应用内右键:任务行 → 完成 / 星标 / 删除(文本选中时系统自动附加「复制」)
    onContextMenu(({ target }) => {
      const row = target.closest?.('.todo-item');
      if (!row) return null;
      const t = state.tasks.find(x => x.id === row.dataset.id);
      if (!t) return null;
      return [
        { label: t.done ? '标记为待办' : '标记完成', icon: 'check', fn: () => { t.done = !t.done; if (t.done) publish('sys:notify', { from: 'todo', type: 'notify', payload: { title: '任务完成', body: t.text } }); persist(); render(); } },
        { label: t.starred ? '取消星标' : '星标', icon: 'star', fn: () => { t.starred = !t.starred; persist(); render(); } },
        { sep: true },
        { label: '删除任务', icon: 'trash', danger: true, fn: () => { state.tasks = state.tasks.filter(x => x.id !== t.id); persist(); render(); } },
      ];
    });
    let project = 'all';        // all | 项目名 | done
    let filter = 'all';         // all | active | done | starred
    let draft = { text: '', due: '', prio: 1, project: '个人' };

    const side = el('div', { class: 'app-side' });
    const list = el('div', { class: 'app-body todo-list' });
    const statusL = el('span', {}, '');
    const statusR = el('span', { class: 'mono' }, '');

    const stats = () => {
      const all = state.tasks;
      return {
        total: all.length,
        done: all.filter(t => t.done).length,
        active: all.filter(t => !t.done).length,
        starred: all.filter(t => t.starred && !t.done).length,
        overdue: all.filter(t => !t.done && t.due && t.due < fmtDate(new Date())).length,
        byProject: (name) => all.filter(t => t.project === name && !t.done).length,
      };
    };

    function refreshTitle() {
      const s = stats();
      setTitle(s.active ? `任务 — ${s.active} 项待办` : '任务 — 全部完成 🎉');
    }

    function renderSide() {
      const s = stats();
      side.innerHTML = '';
      side.append(el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '4px 10px 8px' } }, '列表'));
      const navItem = (id, ico, name, count) => el('button', {
        class: 'nav-item' + (project === id ? ' active' : ''),
        onClick: () => { project = id; render(); },
      }, el('span', { class: 'ni' }, icon(ico, 15)), name,
        count != null ? el('span', { style: { marginLeft: 'auto', fontSize: '11.5px', color: 'var(--text-2)' } }, String(count)) : null);
      side.append(
        navItem('all', 'grid', '全部任务', s.active),
        navItem('starred', 'star', '星标', s.starred || ''),
        navItem('done', 'check', '已完成', s.done));
      side.append(el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '12px 10px 8px' } }, '项目'));
      for (const p of state.projects) {
        const row = el('div', { class: 'todo-proj-row' },
          el('button', {
            class: 'nav-item' + (project === p ? ' active' : ''),
            style: { flex: 1, minWidth: 0 },
            onClick: () => { project = p; render(); },
          }, el('span', { class: 'ni' }, icon('folder', 15)), p,
            el('span', { style: { marginLeft: 'auto', fontSize: '11.5px', color: 'var(--text-2)' } }, String(s.byProject(p)))),
          el('button', {
            class: 'icon-btn todo-proj-del', title: '删除项目(任务移入个人)',
            onClick: async () => {
              const n = state.tasks.filter(t => t.project === p).length;
              const ok = await dialogs.confirm({
                title: '删除项目', danger: true, okText: '删除',
                message: `删除项目「${p}」?其中 ${n} 个任务将移入「个人」。`,
              });
              if (!ok) return;
              state.tasks.forEach(t => { if (t.project === p) t.project = '个人'; });
              state.projects = state.projects.filter(x => x !== p);
              if (project === p) project = 'all';
              persist(); render();
            },
          }, icon('close', 11)));
        side.append(row);
      }
      side.append(el('button', {
        class: 'btn', style: { marginTop: '8px', width: '100%' },
        onClick: async () => {
          const name = await dialogs.prompt({ title: '新建项目', message: '项目名称:' });
          if (name == null || !name.trim()) return;
          if (state.projects.includes(name.trim())) return;
          state.projects.push(name.trim());
          project = name.trim();
          persist(); render();
        },
      }, icon('plus', 13), '新建项目'));

      // 进度环
      const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
      side.append(el('div', { class: 'todo-progress card' },
        el('div', { class: 'card-title', style: { fontSize: '12.5px' } }, icon('activity', 13), '完成度'),
        el('div', { class: 'todo-ring', style: { '--p': pct } },
          el('div', { class: 'todo-ring-num' }, `${pct}%`)),
        el('div', { class: 'dim', style: { fontSize: '11.5px', textAlign: 'center' } }, `${s.done} / ${s.total} 已完成`),
        s.overdue ? el('div', { style: { color: '#ef4444', fontSize: '11.5px', textAlign: 'center', marginTop: '4px' } }, `${s.overdue} 项已逾期`) : null));
    }

    function taskRow(t) {
      const p = prioOf(t.prio);
      const dm = dueMeta(t);
      return el('div', { class: 'todo-item' + (t.done ? ' done' : ''), dataset: { id: t.id }, draggable: 'true' },
        el('button', {
          class: 'todo-check' + (t.done ? ' on' : ''),
          title: t.done ? '标记为待办' : '标记完成',
          onClick: () => {
            t.done = !t.done;
            if (t.done) { bus.notify('任务完成 🎉', t.text); publish('sys:notify', { from: 'todo', type: 'notify', payload: { title: '任务完成', body: t.text } }); }
            persist(); render();
          },
        }, t.done ? icon('check', 12) : ''),
        el('span', { class: 'todo-prio', title: `优先级:${p.name}`, style: { background: p.color } }),
        el('div', { class: 'todo-text' },
          el('span', { class: 'todo-t' }, t.text),
          el('span', { class: 'todo-meta' },
            el('span', { class: 'dim', style: { fontSize: '11px' } }, t.project),
            dm ? el('span', { class: 'todo-due ' + dm.cls }, icon('clock', 10), dm.text) : null)),
        el('button', {
          class: 'icon-btn todo-star' + (t.starred ? ' on' : ''),
          onClick: () => { t.starred = !t.starred; persist(); render(); },
        }, icon('star', 13)),
        el('button', {
          class: 'icon-btn todo-del', title: '删除',
          onClick: async () => {
            const ok = await dialogs.confirm({ title: '删除任务', message: `删除「${t.text}」?`, danger: true, okText: '删除' });
            if (!ok) return;
            state.tasks = state.tasks.filter(x => x.id !== t.id);
            persist(); render();
          },
        }, icon('trash', 12)));
    }

    function visibleTasks() {
      let arr = [...state.tasks];
      if (project === 'done') arr = arr.filter(t => t.done);
      else {
        if (project !== 'all') arr = arr.filter(t => t.project === project);
        if (filter === 'active') arr = arr.filter(t => !t.done);
        else if (filter === 'starred') arr = arr.filter(t => t.starred);
        else arr.sort((a, b) => (a.done - b.done));   // 未完成在前
      }
      if (project !== 'done') {
        arr.sort((a, b) => (a.done - b.done) || (b.prio - a.prio) || (a.due || '9999').localeCompare(b.due || '9999'));
      }
      return arr;
    }

    function renderList() {
      list.innerHTML = '';
      // 快速添加条:文本 + 项目 + 截止日期 + 优先级
      const textInput = el('input', { class: 'input', placeholder: '添加任务,回车确认…', style: { flex: 1 } });
      const projSel = el('select', { class: 'select', title: '所属项目', style: { width: '92px' } },
        ...state.projects.map(p => el('option', { value: p, selected: p === draft.project ? '' : null }, p)));
      const dueInput = el('input', { class: 'input', type: 'date', value: draft.due, title: '截止日期(可选)', style: { width: '140px' } });
      const prioSel = el('select', { class: 'select', title: '优先级', style: { width: '70px' } },
        ...PRIO.map(p => el('option', { value: p.v, selected: draft.prio === p.v ? '' : null }, p.name)));
      if (!state.projects.includes(draft.project)) draft.project = state.projects[0] || '个人';
      projSel.value = draft.project;
      const add = () => {
        const text = textInput.value.trim();
        if (!text) return;
        state.tasks.push({
          id: 't' + (state.seq++),
          project: projSel.value,
          text, done: false, prio: +prioSel.value, due: dueInput.value,
          starred: false, created: Date.now(),
        });
        draft = { text: '', due: dueInput.value, prio: +prioSel.value, project: projSel.value };
        persist();
        textInput.value = '';
        render();
        bus.notify('任务已添加', text);
      };
      textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

      // 过滤器
      const seg = el('div', { class: 'seg' },
        ...[['all', '全部'], ['active', '待办'], ['starred', '星标']].map(([v, n]) =>
          el('button', {
            class: 'seg-btn' + (filter === v ? ' active' : ''),
            onClick: (e2) => { filter = v; render(); },
          }, n)));

      list.append(el('div', { class: 'todo-add row' }, textInput, projSel, dueInput, prioSel,
        el('button', { class: 'btn primary icon', title: '添加', onClick: add }, icon('plus', 14))));
      list.append(el('div', { class: 'row', style: { padding: '0 4px 10px' } }, seg, el('span', { class: 'grow' }),
        el('button', {
          class: 'btn', title: '清除已完成',
          onClick: async () => {
            const n = state.tasks.filter(t => t.done).length;
            if (!n) return;
            const ok = await dialogs.confirm({ title: '清除已完成', message: `清除 ${n} 个已完成任务?`, danger: true, okText: '清除' });
            if (!ok) return;
            state.tasks = state.tasks.filter(t => !t.done);
            persist(); render();
          },
        }, icon('trash', 12), '清除已完成')));

      const arr = visibleTasks();
      if (!arr.length) {
        list.append(el('div', { class: 'empty' }, icon('check', 40),
          project === 'done' ? '还没有已完成的任务' : '没有待办任务,享受当下 ☕'));
      } else {
        const box = el('div', { class: 'todo-items' });
        for (const t of arr) box.append(taskRow(t));
        // 拖拽排序(同过滤视图内)
        let dragId = null;
        box.addEventListener('dragstart', (e) => { dragId = e.target.closest('.todo-item')?.dataset.id; });
        box.addEventListener('dragover', (e) => {
          e.preventDefault();
          const over = e.target.closest('.todo-item');
          if (!over || over.dataset.id === dragId) return;
          const from = state.tasks.findIndex(t => t.id === dragId);
          const to = state.tasks.findIndex(t => t.id === over.dataset.id);
          if (from < 0 || to < 0) return;
          const [moved] = state.tasks.splice(from, 1);
          state.tasks.splice(to, 0, moved);
          persist(); render();
        });
        list.append(box);
      }

      const s = stats();
      statusL.textContent = `${s.active} 待办 · ${s.done} 已完成`;
      statusR.textContent = s.overdue ? `${s.overdue} 逾期` : '';
    }

    function render() { renderSide(); renderList(); refreshTitle(); }

    // 到期提醒:每天首次打开检查(应用存活期间每分钟轮询一次)
    let reminded = new Set();
    function checkDue() {
      const today = fmtDate(new Date());
      for (const t of state.tasks) {
        if (t.done || !t.due || reminded.has(t.id)) continue;
        if (t.due <= today) {
          reminded.add(t.id);
          publish('sys:notify', {
            from: 'todo', type: 'notify',
            payload: { title: t.due < today ? '任务已逾期 ⏰' : '任务今日到期 📌', body: t.text },
          });
          // 系统联动:到期短信(经虚拟短信服务,游戏作者也可挂钩子)
          sms.deliverLater({
            from: 'todo-reminder', fromName: '任务提醒',
            text: `【任务提醒】${t.due < today ? '已逾期' : '今日到期'}:${t.text}`,
          }, 600);
        }
      }
    }
    checkDue();
    const dueTimer = setInterval(checkDue, 60000);

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('b', { style: { fontSize: '13.5px' } }, '任务'),
        el('span', { class: 'grow' }),
        el('button', {
          class: 'btn', title: '把当前清单导出到 /home/desktop/todo.txt',
          onClick: () => {
            const lines = ['# 任务清单 — ' + fmtDate(new Date())];
            for (const p of state.projects) {
              lines.push(`\n[${p}]`);
              for (const t of state.tasks.filter(t => t.project === p)) {
                lines.push(` ${t.done ? 'x' : ' '} [${prioOf(t.prio).name}] ${t.text}${t.due ? ' (截止 ' + t.due + ')' : ''}`);
              }
            }
            fs.write('/home/desktop/todo.txt', lines.join('\n') + '\n');
            bus.notify('已导出到桌面', '/home/desktop/todo.txt');
          },
        }, icon('download', 13), '导出到桌面')),
      el('div', { class: 'app-mid' }, side, list),
      el('div', { class: 'app-status' }, statusL, el('span', { class: 'grow' }), statusR)));

    // 跨实例同步:外部写入较新数据时仅采纳(要求其 seq 更大),避免双实例互相覆盖
    const syncTimer = setInterval(() => {
      try {
        const fresh = JSON.parse(localStorage.getItem(KEY));
        if (fresh && fresh.seq > state.seq) {
          state = fresh;
          render();
        }
      } catch { /* 忽略 */ }
    }, 1500);

    render();
    const offFs = subscribe('sys:fs-changed', () => { /* 桌面 todo.txt 由文件系统事件刷新 */ });
    return { onClose() { clearInterval(dueTimer); clearInterval(syncTimer); offFs(); return true; } };
  },
});


/** 重新挂载当前应用(登录状态变化后调用) */
function appRemount() {
  reopen('todo');
}
