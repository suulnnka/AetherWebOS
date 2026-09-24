/* ============================================================
 * 应用:日记(Diary)
 *
 * 按日期记录每一天:左侧月历导航(有日记的日子带圆点标记,
 * 点击切换日期,跨月自动翻页),右侧编辑正文并选择心情;
 * 输入即自动保存(防抖),「今天」一键回位。
 * 数据:加密页库 ~/appdata/diary;旧键自动迁移。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './diary.css';
import { accounts } from '../../core/accounts.js';
import { requireLogin, logoutButton } from '../../core/loginpanel.js';
import { reopen } from '../../core/wm.js';
import { loadState, saveState, migrateFromLocalStorage } from '../../core/appdata.js';

const KEY = 'webos.diary.v1';
const MOODS = ['😄', '🙂', '😐', '😢', '😠'];
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];          // 周一开局
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtLong = (d) => `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${WEEKDAY[d.getDay()]}`;

let state = null;

function normalize(raw) {
  if (raw && raw.entries) return { seq: raw.seq || 1, entries: raw.entries };
  return { seq: 1, entries: {} };
}

async function loadAsync() {
  const user = accounts.current();
  if (!user) return null;
  try {
    const data = await migrateFromLocalStorage('diary', accounts.userKey(KEY), normalize, user);
    return data ?? normalize(await loadState('diary', user));
  } catch (e) {
    console.warn('[diary] 加载失败', e);
    return null;
  }
}

let saveT;
const persist = () => {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const user = accounts.current();
    if (!user || !state) return;
    try { await saveState('diary', state, user); }
    catch (e) { console.warn('[diary] 持久化失败', e); }
  }, 200);
};

register({
  ...manifest,
  mount({ root, setTitle }) {
    if (requireLogin(root, '日记', () => { root.innerHTML = ''; appRemount(); })) return;

    state = { seq: 1, entries: {} };
    loadAsync().then((s) => {
      if (s) { state = s; render(); }
    });

    let sel = new Date();                     // 当前选中的日期
    let viewY = sel.getFullYear();            // 月历正在显示的年月
    let viewM = sel.getMonth();

    const entryOf = (k) => state.entries[k] || null;
    const textOf = (k) => entryOf(k)?.text || '';

    /** 把编辑器当前内容写回 state(空正文且无心情时清除占位条目) */
    function flush() {
      const k = keyOf(sel);
      const cur = entryOf(k);
      const text = textIn.value;
      const mood = cur?.mood ?? null;
      if (!text && mood == null) {
        if (cur) delete state.entries[k];
        return;
      }
      state.entries[k] = { ...(cur || {}), text, mood, updated: Date.now() };
    }

    /** 有内容的日记数(标题/状态栏用) */
    const count = () => Object.values(state.entries).filter(e => e.text).length;

    /* ---------- DOM ---------- */
    const calTitle = el('span', { class: 'diary-cal-title' });
    const daysGrid = el('div', { class: 'diary-days' });
    const dateHead = el('h3', { class: 'diary-date' }, '');
    const moodRow = el('div', { class: 'diary-moods' });
    const textIn = el('textarea', { class: 'diary-text', placeholder: '今天过得怎么样?写点什么吧…' });
    const statusL = el('span', {}, '');

    function refreshChrome() {
      setTitle(`日记 — ${count()} 篇`);
      const chars = Object.values(state.entries).reduce((s, e) => s + (e.text?.length || 0), 0);
      statusL.textContent = `${count()} 篇日记 · 共 ${chars} 字`;
    }

    function renderCalendar() {
      calTitle.textContent = `${viewY} 年 ${viewM + 1} 月`;
      daysGrid.innerHTML = '';
      const first = new Date(viewY, viewM, 1);
      const offset = (first.getDay() + 6) % 7;                       // 周一开局
      const start = new Date(viewY, viewM, 1 - offset);
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const k = keyOf(d);
        const out = d.getMonth() !== viewM;
        const has = !!entryOf(k)?.text;
        const cell = el('button', {
          class: 'diary-day'
            + (out ? ' out' : '')
            + (k === keyOf(new Date()) ? ' today' : '')
            + (k === keyOf(sel) ? ' sel' : ''),
          dataset: { key: k },
          onClick: () => {
            flush();
            sel = d;
            viewY = d.getFullYear(); viewM = d.getMonth();
            render();
          },
        }, String(d.getDate()));
        if (has) cell.append(el('span', { class: 'dot' }));
        daysGrid.append(cell);
      }
    }

    function renderEditor() {
      dateHead.textContent = fmtLong(sel);
      const cur = entryOf(keyOf(sel));
      moodRow.innerHTML = '';
      for (const m of MOODS) {
        moodRow.append(el('button', {
          class: 'diary-mood' + (cur?.mood === m ? ' on' : ''),
          title: '心情',
          onClick: () => {
            const k = keyOf(sel);
            const want = cur?.mood === m ? null : m;   // 再点一次取消
            if (!state.entries[k] && want == null) return;
            state.entries[k] = { ...(state.entries[k] || {}), text: textIn.value, mood: want, updated: Date.now() };
            if (!state.entries[k].text && state.entries[k].mood == null) delete state.entries[k];
            persist();
            render();
          },
        }, m));
      }
      textIn.value = cur?.text || '';
    }

    function render() {
      renderCalendar();
      renderEditor();
      refreshChrome();
    }

    textIn.addEventListener('input', () => {
      flush();
      persist();
      // 首次写入出现/清空消失:圆点标记与计数跟随
      const cell = [...daysGrid.children].find(c => c.dataset.key === keyOf(sel));
      const has = !!textIn.value;
      const dot = cell?.querySelector('.dot');
      if (has && !dot) cell?.append(el('span', { class: 'dot' }));
      if (!has && dot) dot.remove();
      refreshChrome();
    });

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('button', {
          class: 'btn', onClick: () => {
            flush();
            sel = new Date();
            viewY = sel.getFullYear(); viewM = sel.getMonth();
            render();
          },
        }, '今天'),
        logoutButton(() => { root.innerHTML = ''; appRemount(); }),
        el('span', { class: 'grow' }),
        el('span', { class: 'badge-pill' }, '自动保存')),
      el('div', { class: 'app-mid' },
        el('div', { class: 'app-side diary-side' },
          el('div', { class: 'diary-cal-head' },
            el('button', {
              class: 'icon-btn', title: '上个月',
              onClick: () => { viewM--; if (viewM < 0) { viewM = 11; viewY--; } renderCalendar(); },
            }, '‹'),
            calTitle,
            el('button', {
              class: 'icon-btn', title: '下个月',
              onClick: () => { viewM++; if (viewM > 11) { viewM = 0; viewY++; } renderCalendar(); },
            }, '›')),
          el('div', { class: 'diary-week' }, ...WEEK.map(w => el('span', {}, w))),
          daysGrid),
        el('div', { class: 'app-body diary-body' },
          dateHead,
          moodRow,
          textIn)),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '按日期记录,输入即自动保存'))));

    render();
    return { onClose() { return true; } };
  },
});

function appRemount() {
  reopen('diary');
}
