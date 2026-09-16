/* ============ 应用:文件管家(File Station) ============ */
import { el, fmtDate, escapeHtml } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { register } from '../core/registry.js';
import fs from '../core/fs.js';
import { open } from '../core/wm.js';
import { showMenu } from '../core/menu.js';
import { dialogs } from '../core/dialogs.js';

/** 系统对话框:输入(返回 string|null)与危险确认(返回 boolean) */
const modalPrompt = (title, placeholder, value) =>
  dialogs.prompt({ title, message: '输入名称:', placeholder, value });
const modalConfirm = (title, body, danger) =>
  dialogs.confirm({ title, message: body, danger, okText: '删除' });

const QUICK = [
  { name: '主目录', path: '/home', icon: 'home' },
  { name: '文档', path: '/home/documents', icon: 'fileText' },
  { name: '图片', path: '/home/pictures', icon: 'image' },
  { name: '音乐', path: '/home/music', icon: 'music' },
  { name: '下载', path: '/home/downloads', icon: 'download' },
];

function fileIcon(item) {
  if (item.dir) return { name: 'folder', color: '#4f9cf9', size: 34 };
  const ext = item.name.split('.').pop().toLowerCase();
  if (['txt', 'md', 'log', 'json', 'js', 'css', 'html'].includes(ext)) return { name: 'fileText', color: '#8a94a8', size: 30 };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return { name: 'image', color: '#a78bfa', size: 30 };
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return { name: 'music', color: '#34d399', size: 30 };
  return { name: 'file', color: '#8a94a8', size: 30 };
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return fmtDate(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

register({
  id: 'files',
  neon: { a: '#ffb400', b: '#ff5e00' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '文件管家',
  icon: 'folder',
  color: 'linear-gradient(135deg,#f59e0b,#f97316)',
  width: 880, height: 560,
  min: { w: 560, h: 360 },
  singleton: true,
  order: 1,
  mount({ root, bus, params }) {
    let cwd = params.path && fs.isDir(params.path) ? fs.normPath(params.path) : '/home';
    let selected = null;
    let history = [];

    const crumbs = el('div', { class: 'crumbs' });
    const grid = el('div', { class: 'fgrid' });
    const statusLeft = el('span', {}, '');
    const backBtn = el('button', { class: 'btn icon', title: '后退', onClick: () => {
      if (!history.length) return;
      cwd = history.pop();
      selected = null;
      render();
    } }, icon('arrowLeft', 15));
    const upBtn = el('button', { class: 'btn icon', title: '上一级', onClick: () => nav(fs.parentPath(cwd)) }, icon('arrowUp', 15));
    const refreshBtn = el('button', { class: 'btn icon', title: '刷新', onClick: () => render() }, icon('refresh', 14));

    function nav(p) {
      if (!fs.isDir(p)) return;
      history.push(cwd);
      cwd = fs.normPath(p);
      selected = null;
      render();
    }

    function openItem(item) {
      if (item.dir) nav(item.path);
      else open('notes', { params: { path: item.path } }); // IPC:通过参数把文件交给记事本
    }

    async function newItem(kind) {
      const name = await modalPrompt(kind === 'dir' ? '新建文件夹' : '新建文本文件', '名称', kind === 'dir' ? '新建文件夹' : '新建文件.txt');
      if (name == null || !name.trim()) return;
      const p = fs.joinPath(cwd, name.trim());
      if (kind === 'dir') fs.mkdir(p);
      else fs.write(p, '');
      bus.notify('已创建', name.trim());
    }

    async function renameItem(item) {
      const name = await modalPrompt('重命名', '新名称', item.name);
      if (name == null || !name.trim() || name.trim() === item.name) return;
      fs.rename(item.path, fs.joinPath(cwd, name.trim()));
      selected = null;
      render();
    }

    async function deleteItem(item) {
      const ok = await modalConfirm(`删除 ${item.dir ? '文件夹' : '文件'}`, `确定删除「${item.name}」吗?${item.dir ? '其中所有内容都会被删除。' : ''}`, true);
      if (!ok) return;
      fs.rm(item.path);
      selected = null;
      render();
      bus.notify('已删除', item.name);
    }

    function renderCrumbs() {
      crumbs.innerHTML = '';
      const segs = cwd.split('/').filter(Boolean);
      crumbs.append(el('button', { class: 'crumb' + (segs.length ? '' : ' cur'), onClick: () => nav('/') }, icon('hardDrive', 14)));
      segs.forEach((seg, i) => {
        crumbs.append(el('span', { class: 'crumb-sep' }, '/'));
        const path = '/' + segs.slice(0, i + 1).join('/');
        crumbs.append(el('button', {
          class: 'crumb' + (i === segs.length - 1 ? ' cur' : ''),
          onClick: () => nav(path),
        }, escapeHtml(seg)));
      });
    }

    function renderGrid() {
      grid.innerHTML = '';
      const items = fs.list(cwd);
      if (!items) { cwd = '/home'; return render(); }
      if (!items.length) {
        grid.append(el('div', { class: 'empty', style: { gridColumn: '1/-1' } }, icon('folderOpen', 40), '此文件夹为空'));
      }
      for (const item of items) {
        const fi = fileIcon(item);
        const node = el('button', {
          class: 'fitem' + (selected === item.path ? ' selected' : ''),
          dataset: { path: item.path },
          onClick: () => { selected = selected === item.path ? null : item.path; renderStatus(); grid.querySelectorAll('.fitem').forEach(x => x.classList.toggle('selected', x.dataset.path === selected)); },
          onDblClick: () => openItem(item),
          onContextmenu: (e) => {
            e.preventDefault();
            selected = item.path;
            renderStatus();
            showMenu(e.clientX, e.clientY, [
              { label: '打开', icon: 'folderOpen', fn: () => openItem(item) },
              ...(item.dir ? [] : [{ label: '用记事本打开', icon: 'fileText', fn: () => open('notes', { params: { path: item.path } }) }]),
              { sep: true },
              { label: '重命名', icon: 'pencil', fn: () => renameItem(item) },
              { label: '删除', icon: 'trash', danger: true, fn: () => deleteItem(item) },
            ]);
          },
        },
          el('span', { class: 'f-ico', style: { color: fi.color } }, icon(fi.name, fi.size)),
          el('span', { class: 'f-name', title: item.path }, item.name));
        grid.append(node);
      }
    }

    function renderStatus() {
      const items = fs.list(cwd) || [];
      const sel = selected ? items.find(i => i.path === selected) : null;
      statusLeft.textContent = `${items.length} 个项目` + (sel ? ` · 已选择 ${sel.name}` : '');
    }

    function render() {
      renderCrumbs();
      renderGrid();
      renderStatus();
      bus.setTitle('文件管家 — ' + (cwd === '/' ? '根目录' : cwd));
    }

    // IPC:监听文件系统变化实时刷新;响应其他应用的刷新请求
    const offFs = bus.onSys('fs-changed', () => render());
    const offReq = bus.on('refresh', (p, msg) => { render(); msg.reply?.({ ok: true }); });
    const offParams = bus.on('params', (p) => { if (p?.path && fs.isDir(p.path)) { cwd = fs.normPath(p.path); render(); } });

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        backBtn, upBtn, refreshBtn,
        el('div', { class: 'tb-sep', style: { height: '20px', margin: '0 4px' } }),
        crumbs,
        el('button', { class: 'btn icon', title: '新建文件夹', onClick: () => newItem('dir') }, icon('folderPlus', 15)),
        el('button', { class: 'btn icon', title: '新建文件', onClick: () => newItem('file') }, icon('filePlus', 15)),
      ),
      el('div', { class: 'app-mid' },
        el('div', { class: 'app-side' },
          el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '4px 10px 8px' } }, '快速访问'),
          el('div', { class: 'list' },
            ...QUICK.map(q => el('button', {
              class: 'list-item' + (cwd === q.path ? ' active' : ''),
              onClick: () => nav(q.path),
            }, el('span', { class: 'li-ico' }, icon(q.icon, 15)), q.name))),
          el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '12px 10px 8px' } }, '存储'),
          el('div', { class: 'list' },
            el('button', { class: 'list-item', onClick: () => nav('/') }, el('span', { class: 'li-ico' }, icon('hardDrive', 15)), '文件系统'))),
        el('div', { class: 'app-body', onClick: (e) => {
          if (e.target === grid || e.target === e.currentTarget) { selected = null; renderStatus(); renderGrid(); }
        }, onContextmenu: (e) => {
          if (e.target !== grid && e.target !== e.currentTarget) return;
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: '新建文件夹', icon: 'folderPlus', fn: () => newItem('dir') },
            { label: '新建文本文件', icon: 'filePlus', fn: () => newItem('file') },
            { sep: true },
            { label: '刷新', icon: 'refresh', fn: () => render() },
          ]);
        } }, grid)),
      el('div', { class: 'app-status' }, statusLeft,
        el('span', { class: 'grow' }),
        el('span', { class: 'mono' }, cwd))));

    render();
    return { onClose() { offFs(); offReq(); offParams(); return true; } };
  },
});
