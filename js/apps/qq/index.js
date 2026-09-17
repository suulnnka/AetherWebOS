/* ============================================================
 * 应用:QQ 经典版(仿 2005 年代即时通信)
 *
 * 登录界面(号码/昵称/头像)→ 好友分组列表 → 双击打开聊天窗格。
 * 好友都是虚拟机器人,有各自的性格化自动回复;
 * 支持表情面板、好友上线提醒(登录后延迟触发)、消息持久化。
 * ============================================================ */
import { el, escapeHtml, fmtTime } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import { accounts } from '../../core/accounts.js';

const KEY = 'webos.qq.v1';
let keyUser = 'guest';                 // 登录时确定,Q Q 数据与该绑定一致
const userKey = () => `${KEY}::${keyUser}`;

const FRIENDS = [
  { qq: '10001', name: '小雨', avatar: '🌧', color: '#5b9bd5', group: '好友',
    replies: ['在忙呢~', '嗯嗯,怎么了?', '哈哈,是吗 😄', '晚点聊,我在看剧', '你说啥?没看清'] },
  { qq: '10002', name: '大牛', avatar: '🐂', color: '#e07b39', group: '好友',
    replies: ['干哈呢老铁', '来一把?我等你', '666', '这事儿包我身上', '刚吃完饭,溜达呢'] },
  { qq: '10003', name: '静儿', avatar: '🌸', color: '#d478a8', group: '好友',
    replies: ['嗯…在听歌', '别闹~', '你也早点休息哦', '今天天气不错呢', '嘻嘻'] },
  { qq: '20001', name: '老张(经理)', avatar: '👔', color: '#8a6f4d', group: '同事',
    replies: ['方案发我看看', '明天例会别迟到', '好的,知道了', '这周加班排一下'], online: true },
  { qq: '30001', name: 'NEXUS 服务台', avatar: '🎧', color: '#6366f1', group: '系统服务',
    replies: ['您好,请问有什么可以帮您?', '已收到您的问题,正在处理中。', '您可以试试重启一下 :)'] },
];

const loadState = () => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.user && s.history && typeof s.history === 'object') return s;
  } catch { /* 忽略 */ }
  return null;
};

register({
  id: 'qq',
  name: 'QQ',
  icon: 'message',
  color: 'linear-gradient(135deg,#3b82f6,#1d4ed8)',
  neon: { a: '#60a5fa', b: '#22d3ee' },
  width: 620, height: 500,
  min: { w: 480, h: 380 },
  singleton: true,
  order: 2.9,
  mount({ root, setTitle, bus }) {
    root.classList.add('qq-app');
    let saved = loadState();
    let user = saved?.user || null;
    let history = saved?.history || {};      // qq -> [{ dir, text, time }]
    let onlineSet = saved?.onlineSet || {};
    let activeChat = null;                    // friend 对象
    let shownMsgIds = new Set();

    const persist = () => {
      try { localStorage.setItem(userKey(), JSON.stringify({ user, history, onlineSet })); } catch { /* 忽略 */ }
    };

    /* ---------------- 登录页 ---------------- */
    function renderLogin() {
      setTitle('QQ — 登录');
      root.innerHTML = '';
      root.append(el('div', { class: 'qq-login' },
        el('div', { class: 'qq-logo' }, icon('message', 34)),
        el('h2', {}, 'QQ'),
        el('div', { class: 'qq-login-tip' }, '回味 2005 的 Messaging 时光'),
        el('label', {}, 'QQ号', el('input', { class: 'input', id: 'qq-num', value: '88888888' })),
        el('label', {}, '昵称', el('input', { class: 'input', id: 'qq-name', value: 'webos 用户', placeholder: '昵称' })),
        el('button', {
          class: 'btn primary qq-login-btn',
          onClick: async () => {
            const num = root.querySelector('#qq-num').value.trim() || '88888888';
            const name = root.querySelector('#qq-name').value.trim() || 'QQ 用户';
            // 同步到系统账号(尽力而为:密码=号码;与既有账号冲突时跳过)
            try {
              if (accounts.current() !== name) {
                const reg = await accounts.register(name, num, { displayName: name });
                if (!reg.ok) await accounts.login(name, num);
              }
            } catch { /* QQ 自有用户体系,系统账号同步失败不影响使用 */ }
            keyUser = 'qq-' + num;
            user = { qq: num, name, avatar: '🐧' };
            // 首次登录:初始化在线状态(随机几个在线)
            for (const f of FRIENDS) {
              if (!(f.qq in onlineSet)) onlineSet[f.qq] = f.online ?? Math.random() > 0.4;
            }
            persist();
            renderMain();
            // 好友上线提醒(延迟)
            setTimeout(() => {
              const f = FRIENDS[0];
              onlineSet[f.qq] = true;
              persist();
              bus.notify('QQ', `好友 ${f.name} 上线了`);
              renderMain();
            }, 6000);
          },
        }, '登录'),
        el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '10px' } }, '演示账号:任意号码均可登录')));
    }

    /* ---------------- 主界面 ---------------- */
    function renderMain() {
      setTitle(`QQ — ${user.name}(${user.qq})`);
      root.innerHTML = '';

      /* 顶部:自己的头像与状态 */
      const top = el('div', { class: 'qq-top' },
        el('span', { class: 'qq-avatar me' }, user.avatar),
        el('div', { class: 'qq-me-info' },
          el('b', {}, user.name),
          el('div', { class: 'dim', style: { fontSize: '11px' } }, user.qq)),
        el('button', { class: 'btn', style: { marginLeft: 'auto' }, title: '退出登录', onClick: () => { user = null; renderLogin(); } }, icon('power', 13)));

      /* 好友分组 */
      const groups = {};
      for (const f of FRIENDS) (groups[f.group] ??= []).push(f);

      const list = el('div', { class: 'qq-list' });
      for (const [gname, members] of Object.entries(groups)) {
        const onCount = members.filter(f => onlineSet[f.qq]).length;
        list.append(el('div', { class: 'qq-group' },
          el('div', { class: 'qq-group-head' }, `▾ ${gname} (${onCount}/${members.length})`)));
        for (const f of members) {
          const online = onlineSet[f.qq];
          const unread = (history[f.qq] || []).filter(m => m.dir === 'in' && !m.read).length;
          list.append(el('button', {
            class: 'qq-friend' + (online ? ' online' : ' offline'),
            onDblClick: () => openChat(f),
            onClick: () => {},   // 单击不打开(还原 QQ 双击体验)
            title: `${f.name}(${f.qq})`,
          },
            el('span', { class: 'qq-avatar' }, f.avatar),
            el('span', { class: 'qq-friend-name' }, f.name),
            unread ? el('span', { class: 'qq-unread' }, String(unread)) : null,
            el('span', { class: 'qq-status-dot' })));
        }
      }

      root.append(el('div', { class: 'app' }, top, list));

      // 登录后若有未读,恢复最近会话提示
      const lastQQ = Object.keys(history).filter(q => (history[q] || []).some(m => m.dir === 'in' && !m.read)).pop();
      if (lastQQ) {
        const f = FRIENDS.find(x => x.qq === lastQQ);
        if (f) openChat(f);
      }
    }

    /* ---------------- 聊天窗格 ---------------- */
    function openChat(f) {
      activeChat = f;
      // 标记已读
      (history[f.qq] || []).forEach(m => m.read = true);
      persist();
      renderChat(f);
    }

    function renderChat(f) {
      setTitle(`与 ${f.name} 聊天中 — QQ`);
      root.innerHTML = '';
      const back = el('button', { class: 'btn', style: { marginRight: '8px' }, onClick: () => { activeChat = null; renderMain(); } }, '← 好友列表');

      const msgs = el('div', { class: 'qq-msgs' });
      const log = history[f.qq] || [];
      if (!log.length) msgs.append(el('div', { class: 'qq-sys' }, `你和 ${f.name} 已经是好友了,开始聊天吧!`));
      for (const m of log) {
        shownMsgIds.add(m.time + m.text);
        msgs.append(el('div', { class: `qq-msg ${m.dir}` },
          m.dir === 'in' ? el('span', { class: 'qq-avatar' }, f.avatar) : null,
          el('div', { class: `qq-bubble ${m.dir}` },
            el('div', { class: 'qq-bubble-text' }, m.text.split(/\n/).map(l => escapeHtml(l)).join('<br>')),
            el('div', { class: 'qq-bubble-time' }, fmtTime(new Date(m.time)))),
          m.dir === 'out' ? el('span', { class: 'qq-avatar me' }, user.avatar) : null));
      }
      msgs.scrollTop = msgs.scrollHeight;

      // 表情面板
      const EMO = ['😊', '😄', '😏', '😭', '😎', '😡', '👍', '🌹', '❤️', '🍺', '🌞', '🐷'];
      const emoPanel = el('div', { class: 'qq-emo', hidden: '' },
        ...EMO.map(e => el('button', {
          class: 'qq-emo-item',
          onClick: () => { input.value += e; emoPanel.hidden = true; input.focus(); },
        }, e)));

      const input = el('textarea', { class: 'qq-input', rows: '3', placeholder: '输入消息…(Ctrl+Enter 发送)' });

      const send = () => {
        const text = input.value.trim();
        if (!text || !activeChat) return;
        pushMsg(f.qq, { dir: 'out', text, time: Date.now(), read: true });
        input.value = '';
        renderChat(f);
        // 对方"正在输入"→ 回复
        setTimeout(() => {
          if (activeChat !== f) return;
          const typing = el('div', { class: 'qq-typing' }, `${f.name} 正在输入...`);
          msgs.append(typing);
          msgs.scrollTop = msgs.scrollHeight;
        }, 500);
        const delay = 900 + Math.random() * 1500;
        setTimeout(() => {
          const reply = f.replies[Math.floor(Math.random() * f.replies.length)];
          const text2 = reply + (text.includes('?') ? '(回答你的问题:问得好!)' : '');
          pushMsg(f.qq, { dir: 'in', text: text2, time: Date.now(), read: activeChat === f });
          if (activeChat === f) renderChat(f);
          else { bus.notify('QQ', `${f.name}:${text2.slice(0, 30)}`); renderMain(); }
        }, delay + 1200);
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
      });

      root.append(el('div', { class: 'app' },
        el('div', { class: 'app-toolbar' }, back,
          el('b', {}, `${f.name}(${f.qq})`),
          el('span', { class: 'qq-online-tag' }, onlineSet[f.qq] ? '● 在线' : '○ 离线'),
          el('span', { class: 'grow' })),
        msgs,
        el('div', { class: 'qq-compose' },
          el('div', { class: 'qq-tools' },
            el('button', { class: 'icon-btn', title: '表情', onClick: (e) => { emoPanel.hidden = !emoPanel.hidden; } }, icon('star', 15)),
            emoPanel),
          input,
          el('div', { class: 'row', style: { justifyContent: 'flex-end' } },
            el('button', { class: 'btn primary', onClick: send }, '发送(Ctrl+Enter)')))));
    }

    function pushMsg(qq, m) {
      (history[qq] ??= []).push(m);
      persist();
    }

    /* ---------------- 入口 ---------------- */
    // 恢复:存在任一 QQ 会话数据则尝试用其 user 自动登录
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith(KEY + '::qq-'));
      if (!user && keys.length) {
        for (const k of keys) {
          const s = JSON.parse(localStorage.getItem(k) || 'null');
          if (s?.user) { keyUser = k.split('::')[1]; user = s.user; history = s.history || {}; onlineSet = s.onlineSet || {}; break; }
        }
      }
    } catch { /* 忽略 */ }
    if (user) renderMain();
    else renderLogin();
  },
});
