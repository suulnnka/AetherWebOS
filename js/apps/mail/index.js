/* ============================================================
 * 应用:邮件 —— 三栏虚拟邮件客户端
 * 文件夹(收件箱/已发送/草稿/垃圾箱)· 列表 · 阅读区,
 * 支持写信/回复/草稿/星标/删除,附件与正文链接联动
 * 浏览器(路径转换)与预览器。
 * ============================================================ */
import { el, escapeHtml } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './mail.css';
import { open, reopen } from '../../core/wm.js';
import mail from '../../core/mail.js';
import { settings } from '../../core/store.js';
import { subscribe } from '../../core/bus.js';
import { accounts } from '../../core/accounts.js';
import { requireLogin, logoutButton } from '../../core/loginpanel.js';

const FOLDERS = [
  { id: 'inbox', name: '收件箱', icon: 'mail' },
  { id: 'sent', name: '已发送', icon: 'send' },
  { id: 'drafts', name: '草稿箱', icon: 'fileText' },
  { id: 'trash', name: '垃圾箱', icon: 'trash' },
];

function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function openAttachment(att) {
  if (att.kind === 'proxy') open('browser', { params: { url: att.url } });
  else if (att.kind === 'fs') open(att.path.endsWith('/') || isDirish(att.path) ? 'files' : 'viewer', { params: { path: att.path } });
  else if (att.kind === 'text') open('notes', { params: { path: att.path } });
}
const isDirish = (p) => !/\.[a-z0-9]{1,6}$/i.test(p);

register({
  ...manifest,
  mount({ root, setTitle, bus, accounts: _a }) {
    // ---- 账号门 ----
    if (requireLogin(root, '邮件', () => { root.innerHTML = ''; appRemount(); })) return;
    mail.setUser(accounts.current() || 'default');
    let folder = 'inbox';
    let selId = null;
    let composing = null;   // { to, subject, body, draftId } | null

    const side = el('div', { class: 'app-side mail-side' });
    const list = el('div', { class: 'mail-list' });
    const read = el('div', { class: 'mail-read' });
    const right = el('div', { class: 'mail-right' }, list, read);
    const statusL = el('span', {}, '');

    const unreadTotal = () => mail.stats().unread;

    function refreshTitle() {
      const n = unreadTotal();
      setTitle(`${n ? `(${n}) ` : ''}邮件 — ${FOLDERS.find(f => f.id === folder).name}`);
    }

    function renderSide() {
      side.innerHTML = '';
      const s = mail.stats();
      const counts = { inbox: s.inbox, sent: s.sent, drafts: s.drafts, trash: s.trash };
      side.append(el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '4px 10px 8px' } },
        `邮箱 · ${settings.get('username')}@webos`));
      side.append(el('div', { class: 'list' },
        ...FOLDERS.map(f => el('button', {
          class: 'list-item' + (f.id === folder ? ' active' : ''),
          onClick: () => { folder = f.id; selId = null; composing = null; render(); },
        },
          el('span', { class: 'li-ico' }, icon(f.icon, 15)),
          f.name,
          el('span', { class: 'badge-pill', style: { marginLeft: 'auto' } },
            f.id === 'inbox' && s.unread ? `${s.unread} 未读` : counts[f.id] || '')))));
    }

    function renderList() {
      list.innerHTML = '';
      const mails = mail.listBy(folder);
      statusL.textContent = `${mails.length} 封邮件`;
      if (!mails.length) {
        list.append(el('div', { class: 'empty' }, icon('mail', 38), '此文件夹为空'));
        return;
      }
      for (const m of mails) {
        const item = el('button', {
          class: 'mail-item' + (m.id === selId ? ' selected' : '') + (m.read ? '' : ' unread'),
          onClick: () => { selId = m.id; composing = null; mail.markRead(m.id); render(); },
        },
          el('span', { class: 'm-dot' }),
          el('div', { class: 'm-main' },
            el('div', { class: 'm-row' },
              el('span', { class: 'm-from' }, m.folder === 'sent' || m.folder === 'drafts' ? `收件人:${m.to}` : m.fromName),
              el('span', { class: 'm-time' }, fmtDate(m.date))),
            el('div', { class: 'm-subj' }, escapeHtml(m.subject)),
            el('div', { class: 'm-prev' }, m.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 46) || '(无正文)')),
          el('span', {
            class: 'm-star' + (m.starred ? ' active' : ''),
            title: '星标',
            onClick: (e) => { e.stopPropagation(); mail.toggleStar(m.id); render(); },
          }, icon('star', 13)),
          m.attachments?.length ? el('span', { class: 'm-attach-ico', title: '含附件' }, icon('download', 12)) : null);
        list.append(item);
      }
    }

    /** 正文里的链接 → 虚拟浏览器;附件 → 浏览器/预览器 */
    function wireBody(box) {
      box.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const href = a.getAttribute('href');
          if (/^(https?:)?\/\//.test(href) || !href.startsWith('/')) open('browser', { params: { url: href } });
        });
      });
    }

    function renderRead() {
      read.innerHTML = '';
      if (composing) return renderCompose();
      const m = selId && mail.get(selId);
      if (!m) {
        read.append(el('div', { class: 'empty' }, icon('mailOpen', 40), '选择一封邮件阅读'));
        return;
      }
      const head = el('div', { class: 'mail-head' },
        el('div', { class: 'mail-subject' }, escapeHtml(m.subject)),
        el('div', { class: 'mail-meta' },
          el('span', { class: 'mail-addr' }, m.folder === 'sent' || m.folder === 'drafts' ? `收件人 ${m.to}` : `${m.fromName} <${m.from}>`),
          el('span', { class: 'dim' }, new Date(m.date).toLocaleString('zh-CN'))),
        m.attachments?.length ? el('div', { class: 'mail-attach' },
          ...m.attachments.map(a => el('button', {
            class: 'btn mail-attach-chip',
            title: a.kind === 'proxy' ? a.url : a.path,
            onClick: () => openAttachment(a),
          }, icon(a.kind === 'proxy' ? 'globe' : 'file', 13), a.name))) : null);

      const body = el('div', { class: 'mail-body' });
      body.innerHTML = m.body;
      wireBody(body);
      read.append(head, body);
    }

    /* ---- 写信 / 回复 / 草稿 ---- */
    function renderCompose() {
      read.innerHTML = '';
      const to = el('input', { class: 'input mail-field', placeholder: '收件人,如 hint@nexus', value: composing.to || '' });
      const subj = el('input', { class: 'input mail-field', placeholder: '主题', value: composing.subject || '' });
      const body = el('textarea', { class: 'input mail-field mail-body-edit', placeholder: '正文…' });
      body.value = composing.body || '';
      const doSend = () => {
        if (!to.value.trim()) { bus.notify('邮件', '请填写收件人'); return; }
        if (composing.draftId) mail.move(composing.draftId, 'trash');
        mail.send({ to: to.value.trim(), subject: subj.value.trim() || '(无主题)', body: body.value });
        bus.notify('邮件已发送', `收件人:${to.value.trim()}`);
        composing = null;
        folder = 'sent'; selId = null;
        render();
      };
      read.append(el('div', { class: 'mail-compose' },
        el('div', { class: 'card-title' }, icon('send', 14), composing.draftId ? '编辑草稿' : '写邮件'),
        to, subj, body,
        el('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
          el('button', {
            class: 'btn', onClick: () => {
              mail.deliver({ folder: 'drafts', read: true, from: 'me@webos', fromName: '我', to: to.value.trim(), subject: subj.value.trim() || '(无主题)', body: body.value });
              if (composing.draftId) mail.move(composing.draftId, 'trash');
              bus.notify('已存入草稿箱', '');
              composing = null; folder = 'drafts'; render();
            },
          }, '存草稿'),
          el('button', { class: 'btn', onClick: () => { composing = null; render(); } }, '取消'),
          el('button', { class: 'btn primary', onClick: doSend }, icon('send', 13), '发送'))));
      setTimeout(() => to.focus(), 50);
    }

    function startCompose(base = {}) {
      composing = { to: '', subject: '', body: '', ...base };
      render();
    }

    /* ---- 工具栏 ---- */
    const replyBtn = el('button', {
      class: 'btn', onClick: () => {
        const m = selId && mail.get(selId);
        if (!m) return;
        startCompose({ to: m.from === 'me@webos' ? m.to : m.from, subject: 'Re: ' + m.subject, body: `\n\n---- 原始邮件 ----\n${m.body.replace(/<[^>]+>/g, '')}` });
      },
    }, icon('reply', 13), '回复');
    const delLabel = el('span', {}, '删除');
    const delBtn = el('button', {
      class: 'btn danger', onClick: () => {
        if (!selId) return;
        const m = mail.get(selId);
        mail.move(selId, 'trash');
        bus.notify(folder === 'trash' ? '已彻底删除' : '已移入垃圾箱', m?.subject || '');
        selId = null;
        render();
      },
    }, icon('trash', 13), delLabel);

    function render() {
      delLabel.textContent = folder === 'trash' ? '彻底删除' : '删除';
      renderSide(); renderList(); renderRead(); refreshTitle();
    }

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn primary', onClick: () => startCompose() }, icon('pencil', 13), '写邮件'),
        replyBtn, delBtn,
        el('button', { class: 'btn icon', title: '刷新', onClick: () => render() }, icon('refresh', 14)),
        el('span', { class: 'grow' }),
        logoutButton(() => { root.innerHTML = ''; appRemount(); }),
        el('span', { class: 'badge-pill mono' }, `${settings.get('username')}@webos`)),
      el('div', { class: 'app-mid' }, side, right),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '新邮件将自动送达并弹出通知'))));

    // 其他应用/系统投递新邮件时实时刷新
    const offNew = subscribe('mail:new', () => render());
    const offChanged = subscribe('mail:changed', () => render());
    render();
    return { onClose() { offNew(); offChanged(); return true; } };
  },
});


/** 重新挂载当前应用(登录状态变化后调用) */
function appRemount() {
  reopen('mail');
}
