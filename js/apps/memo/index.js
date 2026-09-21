/* ============================================================
 * 应用:笔记(Notes,由备忘录升级)
 *
 * 卡片式笔记:新增 / 编辑 / 删除 / 置顶 / 颜色标记 / 分类过滤,
 * 每条笔记可单独加密(AES-GCM,复用 core/crypto):
 *  - 加密后存储为密文,列表只显示锁标与标题;
 *  - 打开需输入密码,解锁后可查看与编辑(保存即重新加密);
 *  - 忘记密码无法找回(无后门),但可删除重建。
 * 数据持久化到 localStorage(webos.memo.v1::<user>)。
 * ============================================================ */
import { el, escapeHtml } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './memo.css';
import { isEncrypted, encryptText, decryptText } from '../../core/crypto.js';
import { accounts } from '../../core/accounts.js';
import { requireLogin, logoutButton } from '../../core/loginpanel.js';
import { reopen } from '../../core/wm.js';

const KEY = 'webos.memo.v1';
const CATS = ['默认', '工作', '生活', '学习'];

let state = null;
function load() {
  const userKey = accounts.userKey(KEY);
  if (!userKey) return null;
  try {
    const s = JSON.parse(localStorage.getItem(userKey));
    if (s && Array.isArray(s.memos)) return s;
  } catch { /* 忽略 */ }
  return {
    seq: 1,
    memos: [
      { id: 'm1', title: '购物清单', body: '牛奶、鸡蛋、咖啡豆', color: '#fde68a', pinned: true, created: Date.now() - 86400e3 },
      { id: 'm2', title: '小提示', body: '新的「日记」应用可以按日期记录每天;右键本卡片可体验笔记加密。', color: '#bbf7d0', pinned: false, created: Date.now() - 3600e3 },
    ],
  };
}
let saveT;
const persist = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const userKey = accounts.userKey(KEY);
    if (!userKey) return;
    try { localStorage.setItem(userKey, JSON.stringify(state)); } catch (e) { console.warn('[memo] 持久化失败', e); }
  }, 200);
};

const COLORS = ['#fef3c7', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff', '#e2e8f0'];

register({
  ...manifest,
  /* dialogs 来自 ctx:应用绑定弹框,默认二级(应用模态,只锁本应用) */
  mount({ root, setTitle, bus, onContextMenu, dialogs }) {
    if (requireLogin(root, '笔记', () => { root.innerHTML = ''; appRemount(); })) return;
    state = load();
    if (!state) {
      state = { seq: 1, memos: [
        { id: 'm1', title: '欢迎使用笔记', body: '右键或按钮均可新建。每条笔记可单独加密。', color: '#fef3c7', pinned: false, created: Date.now() },
      ] };
      persist();
    }

    // 应用内右键:卡片 → 置顶 / 编辑 / 删除(与卡片按钮同一套操作)
    onContextMenu(({ target }) => {
      const card = target.closest?.('.memo-card');
      if (!card) return null;
      const m = state.memos.find(x => x.id === card.dataset.id);
      if (!m) return null;
      return [
        { label: m.pinned ? '取消置顶' : '置顶', icon: 'arrowUp', fn: () => { m.pinned = !m.pinned; persist(); render(); } },
        { label: '编辑', icon: 'pencil', fn: () => editMemo(m) },
        { sep: true },
        { label: '删除笔记', icon: 'trash', danger: true, fn: () => { state.memos = state.memos.filter(x => x.id !== m.id); persist(); render(); } },
      ];
    });
    let query = '';
    let catFilter = '全部';
    let plainCache = {};   // 本次解锁会话内的明文缓存 { id: body }

    // 单例重开时重读持久化数据(其他窗口/注入可能已更新)
    state = load();

    const grid = el('div', { class: 'memo-grid' });
    const statusL = el('span', {}, '');

    function refreshTitle() {
      const n = state.memos.length;
      const locked = state.memos.filter(m => isEncrypted(m.body)).length;
      setTitle(`笔记 — ${n} 条${locked ? `(🔒${locked})` : ''}`);
    }

    /** 编辑器:新建或编辑(加密条目需先解锁) */
    async function editMemo(memo) {
      let body = memo?.body ?? '';
      let encryptedAgain = false;
      if (memo && isEncrypted(body)) {
        const pw = await dialogs.password({ title: '笔记已加密', message: `输入「${memo.title}」的密码` });
        if (pw == null) return;
        try { body = await decryptText(body, pw); encryptedAgain = true; }
        catch (e) { dialogs.error({ title: '解锁失败', message: String(e.message) }); return; }
      }

      const titleIn = el('input', { class: 'input', value: memo?.title ?? '', placeholder: '标题', style: { width: '100%' } });
      const bodyIn = el('textarea', { class: 'input', rows: '8', placeholder: '内容…', style: { width: '100%', resize: 'vertical' } });
      bodyIn.value = body;
      let color = memo?.color ?? COLORS[state.seq % COLORS.length];
      let doLock = false;

      const swatches = el('div', { class: 'row', style: { flexWrap: 'wrap' } },
        ...COLORS.map(c => el('button', {
          class: 'memo-swatch' + (c === color ? ' on' : ''),
          style: { background: c },
          onClick: (e) => {
            color = c;
            e.currentTarget.parentElement.querySelectorAll('.memo-swatch').forEach(s => s.classList.remove('on'));
            e.currentTarget.classList.add('on');
          },
        })));
      const catSel = el('select', { class: 'select', style: { width: 'auto' } },
        ...CATS.map(c => el('option', { value: c, selected: (memo?.cat ?? CATS[0]) === c }, c)));
      const lockCheck = el('input', { type: 'checkbox', onChange: (e) => { doLock = e.target.checked; } });
      if (memo && encryptedAgain) lockCheck.checked = true;

      const box = el('div', { class: 'memo-editor' },
        titleIn,
        bodyIn,
        el('div', { class: 'row', style: { margin: '10px 0' } },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '颜色'), swatches,
          el('span', { class: 'grow' }),
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '分类'), catSel),
        el('label', { class: 'row', style: { gap: '7px', fontSize: '12.5px' } },
          lockCheck, icon('lock', 13), '保存时加密(需密码)'),
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn', onClick: () => box.remove() }, '取消'),
          el('button', {
            class: 'btn primary',
            onClick: async () => {
              const title = titleIn.value.trim() || '无标题';
              let finalBody = bodyIn.value;
              if (lockCheck.checked) {
                const pw = await dialogs.password({ title: '加密笔记', message: '设置密码' });
                if (pw == null) return;
                if (!pw) { dialogs.error({ title: '加密失败', message: '密码不能为空' }); return; }
                finalBody = await encryptText(finalBody, pw);
              }
              if (memo) {
                memo.title = title; memo.body = finalBody; memo.color = color; memo.cat = catSel.value;
              } else {
                state.memos.unshift({
                  id: 'm' + (state.seq++), title, body: finalBody,
                  color, cat: catSel.value, pinned: false, created: Date.now(),
                });
              }
              delete plainCache[memo?.id];
              persist();
              box.remove();
              render();
              bus.notify(lockCheck.checked ? '已加密保存 🔒' : '笔记已保存', title);
            },
          }, '保存')));

      const mask = el('div', { class: 'modal-mask' }, box);
      mask.addEventListener('pointerdown', (e) => { if (e.target === mask) box.remove(); });
      document.body.append(mask);
      setTimeout(() => titleIn.focus(), 50);
    }

    /** 查看:解密(若加密)后在对话框中显示 */
    async function viewMemo(memo) {
      let body = memo.body;
      if (isEncrypted(body)) {
        const pw = await dialogs.password({ title: '笔记已加密', message: `输入「${memo.title}」的密码` });
        if (pw == null) return;
        try { body = await decryptText(body, pw); plainCache[memo.id] = body; }
        catch (e) { dialogs.error({ title: '解锁失败', message: String(e.message) }); return; }
      } else {
        plainCache[memo.id] = body;
      }
      const box = el('div', { class: 'modal-box', style: { width: 'min(460px, 90%)' } },
        el('h3', {}, memo.title),
        el('div', { class: 'm-body', style: { whiteSpace: 'pre-wrap', maxHeight: '300px', overflowY: 'auto' } }, body),
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn', onClick: () => box.remove() }, '关闭'),
          el('button', { class: 'btn primary', onClick: () => { box.remove(); editMemo(memo); } }, icon('pencil', 12), '编辑')));
      const mask = el('div', { class: 'modal-mask' }, box);
      mask.addEventListener('pointerdown', (e) => { if (e.target === mask) box.remove(); });
      document.body.append(mask);
    }

    function render() {
      grid.innerHTML = '';
      const q = query.trim().toLowerCase();
      const memos = [...state.memos]
        .filter(m => catFilter === '全部' || (m.cat ?? CATS[0]) === catFilter)
        .filter(m => !q || m.title.toLowerCase().includes(q) || (plainCache[m.id] || '').toLowerCase().includes(q))
        .sort((a, b) => (b.pinned - a.pinned) || (b.created - a.created));

      statusL.textContent = `${state.memos.length} 条笔记`;
      if (!memos.length) {
        grid.append(el('div', { class: 'empty', style: { gridColumn: '1/-1' } }, icon('fileText', 40), '暂无笔记,点击左上角新建'));
      }
      for (const m of memos) {
        const locked = isEncrypted(m.body);
        const card = el('div', { class: 'memo-card', style: { background: m.color }, dataset: { id: m.id } },
          el('div', { class: 'memo-card-head' },
            el('span', { class: 'memo-title' }, (locked ? '🔒 ' : '') + escapeHtml(m.title)),
            el('button', {
              class: 'icon-btn memo-pin' + (m.pinned ? ' on' : ''), title: m.pinned ? '取消置顶' : '置顶',
              onClick: () => { m.pinned = !m.pinned; persist(); render(); },
            }, icon('arrowUp', 12))),
          el('div', { class: 'memo-body', style: locked ? { filter: 'blur(3px)', userSelect: 'none' } : {} },
            locked ? '加密内容(点击查看)' : escapeHtml(m.body).slice(0, 120)),
          el('div', { class: 'memo-foot' },
            el('span', { class: 'memo-cat' }, m.cat ?? CATS[0]),
            el('span', { class: 'dim' }, new Date(m.created).toLocaleDateString('zh-CN')),
            el('span', { class: 'grow' }),
            el('button', { class: 'icon-btn', title: locked ? '解锁查看' : '查看', onClick: () => viewMemo(m) }, icon(locked ? 'lock' : 'search', 13)),
            el('button', { class: 'icon-btn', title: '编辑', onClick: () => editMemo(m) }, icon('pencil', 13)),
            el('button', {
              class: 'icon-btn', title: '删除',
              onClick: async () => {
                const ok = await dialogs.confirm({ title: '删除笔记', message: `删除「${m.title}」?`, danger: true, okText: '删除' });
                if (!ok) return;
                state.memos = state.memos.filter(x => x.id !== m.id);
                persist(); render();
              },
            }, icon('trash', 12))));
        card.addEventListener('dblclick', () => viewMemo(m));
        grid.append(card);
      }
    }

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn primary', onClick: () => editMemo(null) }, icon('plus', 13), '新建'),
        logoutButton(() => { root.innerHTML = ''; appRemount(); }),
        el('input', {
          class: 'input', placeholder: '搜索标题…', style: { width: '170px' },
          onInput: (e) => { query = e.target.value; render(); },
        }),
        el('select', {
          class: 'select', style: { width: 'auto' },
          onChange: (e) => { catFilter = e.target.value; render(); },
        },
          el('option', { value: '全部' }, '全部'),
          ...CATS.map(c => el('option', { value: c }, c))),
        el('span', { class: 'grow' }),
        el('span', { class: 'badge-pill' }, '支持加密')),
      grid,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '加密笔记以 🔒 显示,点击解锁'))));

    render();
    return { onClose() { return true; } };
  },
});

function appRemount() {
  reopen('memo');
}
