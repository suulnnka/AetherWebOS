/* ============================================================
 * 应用:短信 —— 会话式虚拟短信客户端
 * 左侧会话列表(未读徽标)· 右侧聊天气泡;
 * 验证码自动识别一键复制;清空会话;作者 API 自动回信演示。
 * ============================================================ */
import { el, escapeHtml, fmtTime, fmtDate } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './sms.css';
import sms from '../../core/sms.js';
import { settings } from '../../core/store.js';
import { subscribe } from '../../core/bus.js';

/** 从文本中提取 4-8 位验证码 */
const CODE_RX = /\b([A-Z0-9]{4,8})\b/;
const extractCode = (t) => { const m = CODE_RX.exec(t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248))); return m ? m[1] : null; };

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let selAddr = null;

    const side = el('div', { class: 'app-side sms-side' });
    const pane = el('div', { class: 'sms-pane' });
    const statusL = el('span', {}, '');

    function refreshTitle() {
      const n = sms.unreadTotal();
      setTitle(n ? `短信 (${n} 未读)` : '短信');
    }

    function renderSide() {
      side.innerHTML = '';
      const list = sms.chats();
      side.append(el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '4px 10px 8px' } }, '会话'));
      if (!list.length) side.append(el('div', { class: 'dim', style: { fontSize: '12px', padding: '8px 10px' } }, '暂无会话'));
      for (const c of list) {
        const last = c.msgs[c.msgs.length - 1];
        side.append(el('button', {
          class: 'sms-chat' + (c.addr === selAddr ? ' active' : ''),
          onClick: () => { selAddr = c.addr; sms.markRead(c.addr); render(); },
        },
          c.unread ? el('span', { class: 'sms-badge' }, String(c.unread)) : el('span', { class: 'sms-badge-empty' }),
          el('div', { class: 'sms-chat-main' },
            el('div', { class: 'sms-chat-name' }, escapeHtml(c.name)),
            el('div', { class: 'sms-chat-prev' }, escapeHtml((last?.dir === 'out' ? '你: ' : '') + (last?.text || '')).slice(0, 30))),
          last ? el('span', { class: 'sms-chat-time' }, fmtTime(new Date(last.date))) : null));
      }
      if (list.length) {
        side.append(el('button', {
          class: 'btn', style: { marginTop: 'auto' },
          onClick: () => { sms.removeChat(selAddr); selAddr = null; render(); },
        }, icon('trash', 13), '删除当前会话'));
      }
    }

    function renderPane() {
      pane.innerHTML = '';
      const c = selAddr && sms.chat(selAddr);
      if (!c) {
        pane.append(el('div', { class: 'empty', style: { flex: 1 } }, icon('message', 40), '选择一个会话'));
        return;
      }
      const stream = el('div', { class: 'sms-stream' });
      let lastDay = '';
      for (const m of c.msgs) {
        const day = fmtDate(new Date(m.date));
        if (day !== lastDay) {
          stream.append(el('div', { class: 'sms-day' }, day));
          lastDay = day;
        }
        const code = m.dir === 'in' ? extractCode(m.text) : null;
        const bubble = el('div', { class: 'sms-bubble ' + m.dir },
          el('div', { class: 'sms-text' }, escapeHtml(m.text)),
          code ? el('button', {
            class: 'sms-code',
            title: '点击复制验证码',
            onClick: async (e) => {
              try { await navigator.clipboard.writeText(code); } catch { /* 无权限时忽略 */ }
              e.currentTarget.textContent = `✓ ${code} 已复制`;
              setTimeout(() => render(), 1200);
            },
          }, `复制验证码 ${code}`) : null,
          el('div', { class: 'sms-time' }, fmtTime(new Date(m.date), true)));
        stream.append(el('div', { class: 'sms-row ' + m.dir }, bubble));
      }
      pane.append(stream);

      const input = el('input', { class: 'input sms-input', placeholder: `发短信给 ${c.name}…` });
      const doSend = () => {
        const text = input.value.trim();
        if (!text) return;
        sms.send(c.addr, text);
        input.value = '';
        render();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
      pane.append(el('div', { class: 'sms-compose' }, input,
        el('button', { class: 'btn primary icon', title: '发送', onClick: doSend }, icon('send', 14))));
      stream.scrollTop = stream.scrollHeight;
      statusL.textContent = `${c.name} · ${c.msgs.length} 条消息`;
    }

    function render() {
      renderSide();
      renderPane();
      refreshTitle();
    }

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('b', { style: { fontSize: '13.5px' } }, '短信'),
        el('span', { class: 'grow' }),
        el('span', { class: 'badge-pill mono' }, `${settings.get('username')}@aetherwebos`)),
      el('div', { class: 'app-mid' }, side, pane),
      el('div', { class: 'app-status' }, statusL, el('span', { class: 'grow' }), el('span', {}, '验证码可一键复制'))));

    const offNew = subscribe('sms:new', (p) => {
      if (!selAddr || p?.addr === selAddr) { sms.markRead(p?.addr || selAddr); }
      render();
    });
    const offChanged = subscribe('sms:changed', () => render());
    render();
    return { onClose() { offNew(); offChanged(); return true; } };
  },
});
