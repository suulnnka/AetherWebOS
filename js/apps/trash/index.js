/* ============ 应用:回收站(还原 / 彻底删除 / 清空) ============ */
import { el, fmtDate, formatBytes } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './trash.css';
import { restoreItems, purgeItems, emptyTrash, listTrash } from '../../core/trash.js';

/** 与文件管家同口径的条目图标(简化版:目录 / 图片 / 音视频 / 文本) */
function itemIcon(it) {
  if (it.dir) return { name: 'folder', color: '#4f9cf9' };
  const ext = it.name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return { name: 'image', color: '#a78bfa' };
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return { name: 'music', color: '#34d399' };
  if (['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(ext)) return { name: 'film', color: '#f472b6' };
  return { name: 'fileText', color: '#8a94a8' };
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return fmtDate(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

register({
  ...manifest,
  mount({ root, bus, user, dialogs }) {
    let selected = null;   // 当前选中的条目 key
    const list = el('div', { class: 'app-body', style: { display: 'block', overflowY: 'auto', padding: '8px 10px' } });
    const status = el('span', {}, '');

    /** 条目行 */
    function row(it) {
      const ic = itemIcon(it);
      return el('button', {
        class: 'tr-item' + (selected === it.key ? ' selected' : ''),
        dataset: { key: it.key },
        onClick: (e) => {
          selected = selected === it.key ? null : it.key;
          list.querySelectorAll('.tr-item').forEach(n =>
            n.classList.toggle('selected', n.dataset.key === selected));
        },
        onDblClick: () => restoreItems([it.key], user),
      },
        el('span', { class: 'tr-ico', style: { color: ic.color } }, icon(ic.name, 22)),
        el('span', { class: 'tr-main' },
          el('div', { class: 'tr-name' }, it.name),
          el('div', { class: 'tr-meta' },
            el('span', { class: 'mono', title: it.orig }, '原位置:' + (it.orig || '未知')),
            ' · ' + fmtTime(it.at) + ' · ' + formatBytes(it.size || 0))),
        el('span', { class: 'tr-act' },
          el('button', { class: 'btn', onClick: (e) => { e.stopPropagation(); restoreItems([it.key], user); } }, icon('restore', 12), '还原'),
          el('button', { class: 'btn danger', onClick: async (e) => {
            e.stopPropagation();
            const ok = await dialogs.confirm({
              title: '彻底删除', danger: true, okText: '删除',
              message: `确定彻底删除「${it.name}」吗?此操作不可恢复。`,
            });
            if (ok) purgeItems([it.key], user);
          } }, icon('trash', 12), '删除')));
    }

    function render() {
      const items = listTrash(user);
      if (!items.some(i => i.key === selected)) selected = null;
      list.innerHTML = '';
      if (!items.length) {
        list.append(el('div', { class: 'tr-empty' }, icon('trash', 44), '回收站为空'));
      } else {
        for (const it of items) list.append(row(it));
      }
      const bytes = items.reduce((s, i) => s + (i.size || 0), 0);
      status.textContent = `${items.length} 个项目 · 共 ${formatBytes(bytes)}` + (selected ? ' · 已选择 1 项' : '');
    }

    const selKey = () => selected;
    const selName = () => listTrash(user).find(i => i.key === selected)?.name;

    const restoreBtn = el('button', {
      class: 'btn icon', title: '还原选中项到原位置',
      onClick: () => {
        if (!selKey()) { bus.notify('还原', '请先选中一个条目'); return; }
        restoreItems([selKey()], user);
      },
    }, icon('restore', 14));
    const delBtn = el('button', {
      class: 'btn icon', title: '彻底删除选中项',
      onClick: async () => {
        if (!selKey()) { bus.notify('彻底删除', '请先选中一个条目'); return; }
        const name = selName();
        const ok = await dialogs.confirm({
          title: '彻底删除', danger: true, okText: '删除',
          message: `确定彻底删除「${name}」吗?此操作不可恢复。`,
        });
        if (ok) purgeItems([selKey()], user);
      },
    }, icon('trash', 14));
    const emptyBtn = el('button', {
      class: 'btn icon danger', title: '清空回收站',
      onClick: async () => {
        if (!listTrash(user).length) return;
        const ok = await dialogs.confirm({
          title: '清空回收站', danger: true, okText: '清空',
          message: '将彻底删除回收站中的全部项目,此操作不可恢复。确定继续吗?',
        });
        if (ok) emptyTrash(user);
      },
    }, icon('close', 14));

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('b', { style: { fontSize: '13.5px' } }, '回收站'),
        el('span', { class: 'tb-sep', style: { height: '20px', margin: '0 4px' } }),
        restoreBtn, delBtn, emptyBtn,
        el('span', { class: 'grow' }),
        el('span', { class: 'dim', style: { fontSize: '11.5px' } }, '删除即入筒 · 双击条目快速还原')),
      list,
      el('div', { class: 'app-status' }, status)));

    // 回收站内容变化(fs-changed 覆盖还原/删除后的目录变化,双保险)
    const off1 = bus.onSys('trash-changed', () => render());
    const off2 = bus.onSys('fs-changed', () => render());
    render();
    return { onClose() { off1(); off2(); return true; } };
  },
});
