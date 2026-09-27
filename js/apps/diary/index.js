/* ============================================================
 * 应用:日记(Diary)
 *
 * 按日期记录每一天:左侧月历导航(有日记的日子带圆点标记,
 * 已加密的日子带 🔒;点击切换日期,跨月自动翻页),右侧编辑正文
 * 并选择心情;输入即自动保存(防抖),「今天」一键回位。
 * 与账号无关:数据落在共享页加密库 /home/shared/appdata/diary.awdb
 * (旧 localStorage 键与旧按用户库自动一次性迁入)。
 *
 * 按天加密(AES-GCM,复用 core/crypto):
 *  - 「加密本页」为当天日记设密码,存储为密文;
 *  - 查看加密日需先解锁,解锁后可继续编辑,自动保存时以同一密码
 *    透明重加密(密码仅保存在本次会话内存);
 *  - 「解除加密」在解锁状态下可恢复明文存储;忘记密码无法找回。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './diary.css';
import { isEncrypted, encryptText, decryptText } from '../../core/crypto.js';
import { adoptSharedState, saveSharedState } from '../../core/appdata.js';
import { createMdEditor } from '../../lib/mdedit.js';

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
  try {
    const adopted = await adoptSharedState('diary', (s) =>
      Object.values(s?.entries || {}).filter((e) => e?.text).length);
    if (adopted) return normalize(adopted);
    /* 旧 localStorage 遗留键(历史版本按用户命名)一次性迁入 */
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(KEY)) continue;
      try {
        const data = normalize(JSON.parse(localStorage.getItem(k)));
        if (Object.keys(data.entries).length) { await saveSharedState('diary', data); return data; }
      } catch { /* 坏键跳过 */ }
    }
    return null;
  } catch (e) {
    console.warn('[diary] 加载失败', e);
    return null;
  }
}

let saveT;
/** 落盘前序列化:本会话解锁的加密日,正文用解锁密码透明重加密 */
const persist = () => {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    if (!state) return;
    try {
      const out = { seq: state.seq, entries: {} };
      for (const [k, e] of Object.entries(state.entries)) {
        if (e.lock && unlocked.has(k) && e.text) {
          try { out.entries[k] = { ...e, text: await encryptText(e.text, unlocked.get(k)) }; continue; }
          catch { /* 加密失败按原文保存(仍是此前密文之外的情形,极少见) */ }
        }
        out.entries[k] = e;
      }
      await saveSharedState('diary', out);
    } catch (e) {
      console.warn('[diary] 持久化失败', e);
    }
  }, 200);
};

/** 本会话已解锁的加密日:key → 密码(仅内存) */
let unlocked = new Map();

register({
  ...manifest,
  mount({ root, setTitle, bus, dialogs }) {
    state = { seq: 1, entries: {} };
    unlocked = new Map();
    loadAsync().then((s) => {
      if (s) { state = s; render(); }
    });

    let sel = new Date();                     // 当前选中的日期
    let viewY = sel.getFullYear();            // 月历正在显示的年月
    let viewM = sel.getMonth();

    const entryOf = (k) => state.entries[k] || null;
    const textOf = (k) => entryOf(k)?.text || '';
    const isLocked = (k) => !!entryOf(k)?.lock;
    const isOpen = (k) => isLocked(k) && unlocked.has(k);       // 锁定但本会话已解锁

    /** 把编辑器当前内容写回 state(空正文且无心情时清除占位条目);
     *  锁定且未解锁的日子没有编辑器,保留密文不动 */
    function flush() {
      const k = keyOf(sel);
      const cur = entryOf(k);
      if (cur?.lock && !unlocked.has(k)) return;
      const text = textIn.get();
      const mood = cur?.mood ?? null;
      if (!text && mood == null) {
        if (cur) delete state.entries[k];
        return;
      }
      state.entries[k] = { ...(cur || {}), text, mood, updated: Date.now() };
    }

    /** 有内容的日记数(标题/状态栏用) */
    const count = () => Object.values(state.entries).filter((e) => e.text).length;

    /* ---------- DOM ---------- */
    const calTitle = el('span', { class: 'diary-cal-title' });
    const daysGrid = el('div', { class: 'diary-days' });
    const dateHead = el('h3', { class: 'diary-date' }, '');
    const moodRow = el('div', { class: 'diary-moods' });
    /* 正文:所见即所得 Markdown(共享 js/lib/mdedit.js 组件) */
    const textIn = createMdEditor({
      placeholder: '今天过得怎么样?支持 Markdown…',
      onInput: () => {
        flush();
        persist();
        // 首次写入出现/清空消失:圆点/锁标跟随
        const cell = [...daysGrid.children].find(c => c.dataset.key === keyOf(sel));
        const has = !!textIn.get();
        const mark = cell?.querySelector('.dot, .lockmark');
        if (has && !mark) cell?.append(markOf(keyOf(sel)));
        if (!has && mark) mark.remove();
        refreshChrome();
      },
    });
    textIn.el.classList.add('diary-text');
    const lockCard = el('div', { class: 'diary-lock card' });
    const statusL = el('span', {}, '');

    /** 日历角标:加密日 🔒,普通有内容日圆点 */
    function markOf(k) {
      return isLocked(k)
        ? el('span', { class: 'lockmark' }, '🔒')
        : el('span', { class: 'dot' });
    }

    const lockBtn = el('button', { class: 'btn', onClick: () => (isLocked(keyOf(sel)) ? unlockPermanent() : lockToday()) }, '🔒 加密本页');

    function refreshChrome() {
      setTitle(`日记 — ${count()} 篇`);
      const chars = Object.values(state.entries)
        .reduce((s, e) => s + (e.lock && isEncrypted(e.text) ? 0 : (e.text?.length || 0)), 0);
      const locks = Object.values(state.entries).filter((e) => e.lock).length;
      statusL.textContent = `${count()} 篇日记 · 共 ${chars} 字${locks ? ` · 🔒${locks} 页加密` : ''}`;
      const k = keyOf(sel);
      const cur = entryOf(k);
      if (cur?.lock) {
        lockBtn.hidden = !unlocked.has(k);
        lockBtn.textContent = '🔓 解除加密';
      } else {
        lockBtn.hidden = !cur?.text;
        lockBtn.textContent = '🔒 加密本页';
      }
    }

    /* ---------- 按天加密 ---------- */

    async function lockToday() {
      const k = keyOf(sel);
      flush();
      const e = entryOf(k);
      if (!e?.text || e.lock) return;
      const pw1 = await dialogs.password({ title: '加密本页日记', message: '为这一天的日记设置密码' });
      if (pw1 == null) return;
      if (!pw1) { dialogs.error({ title: '加密失败', message: '密码不能为空' }); return; }
      const pw2 = await dialogs.password({ title: '确认密码', message: '再输入一次上面的密码' });
      if (pw2 !== pw1) { dialogs.error({ title: '加密失败', message: '两次输入不一致' }); return; }
      state.entries[k].lock = true;
      unlocked.set(k, pw1);
      persist();
      render();
      bus.notify('本页日记已加密 🔒', '解锁后可继续编辑,保存时自动重新加密');
    }

    function unlockPermanent() {
      const k = keyOf(sel);
      if (!isLocked(k) || !unlocked.has(k)) return;
      state.entries[k].lock = false;
      unlocked.delete(k);
      persist();
      render();
      bus.notify('已解除加密', `${fmtLong(sel)} 的日记已恢复明文保存`);
    }

    /** 解锁当天(密码仅存会话内存;正文在内存中转明文,落盘时再加密) */
    async function tryUnlock(pw) {
      const k = keyOf(sel);
      const e = entryOf(k);
      if (!e?.lock) return;
      try {
        const plain = await decryptText(e.text, pw);
        state.entries[k] = { ...e, text: plain };
        unlocked.set(k, pw);
        render();
      } catch {
        dialogs.error({ title: '解锁失败', message: '密码错误或数据已损坏' });
      }
    }

    function renderLockCard() {
      lockCard.innerHTML = '';
      const pwIn = el('input', { class: 'input', type: 'password', placeholder: '输入本页密码…', style: { width: '220px' } });
      const go = () => { if (pwIn.value) tryUnlock(pwIn.value); };
      pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      lockCard.append(
        el('div', { style: { fontSize: '30px', textAlign: 'center' } }, '🔒'),
        el('div', { style: { fontWeight: 700, margin: '8px 0 4px', textAlign: 'center' } }, '这一天的日记已加密'),
        el('div', { class: 'dim', style: { fontSize: '12px', textAlign: 'center', marginBottom: '12px' } }, '输入密码解锁后可查看与编辑;忘记密码则无法找回'),
        el('div', { class: 'row', style: { justifyContent: 'center' } },
          pwIn,
          el('button', { class: 'btn primary', onClick: go }, '解锁')));
      setTimeout(() => pwIn.focus(), 60);
    }

    /* ---------- 月历 ---------- */

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
        if (has) cell.append(markOf(k));
        daysGrid.append(cell);
      }
    }

    function renderEditor() {
      dateHead.textContent = fmtLong(sel);
      const k = keyOf(sel);
      const cur = entryOf(k);
      const locked = !!cur?.lock && !unlocked.has(k);

      moodRow.style.display = locked ? 'none' : '';
      textIn.el.style.display = locked ? 'none' : '';
      lockCard.style.display = locked ? '' : 'none';
      if (locked) { renderLockCard(); return; }

      moodRow.innerHTML = '';
      for (const m of MOODS) {
        moodRow.append(el('button', {
          class: 'diary-mood' + (cur?.mood === m ? ' on' : ''),
          title: '心情',
          onClick: () => {
            const want = cur?.mood === m ? null : m;   // 再点一次取消
            if (!state.entries[k] && want == null) return;
            state.entries[k] = { ...(state.entries[k] || {}), text: textIn.get(), mood: want, updated: Date.now() };
            if (!state.entries[k].text && state.entries[k].mood == null) delete state.entries[k];
            persist();
            render();
          },
        }, m));
      }
      textIn.set(cur?.text || '');
    }

    function render() {
      renderCalendar();
      renderEditor();
      refreshChrome();
    }

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
        lockBtn,
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
          textIn.el,
          lockCard)),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '按日期记录,输入即自动保存;单页可加密'))));

    render();
    return { onClose() { return true; } };
  },
});
