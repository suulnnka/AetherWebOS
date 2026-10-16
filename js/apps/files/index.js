/* ============ 应用:文件管家(File Station) ============ */
import { el, fmtDate, escapeHtml } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './files.css';
import { open } from '../../core/wm.js';
import { showMenu } from '../../core/menu.js';
import { isEncrypted, encryptText, decryptText } from '../../core/crypto.js';
import { unzip, listEntries, extract, zip } from '../../core/zip.js';
import { isAppLink, appLinkApp, createAppLink, appLinkMenuItems, flatColor, hoverPrefetch } from '../../core/applink.js';
import { inplaceRename } from '../../core/rename.js';
import { CODE_EXT_RE } from '../../lib/chl.js';
import { moveToTrash } from '../../core/trash.js';
import * as clip from '../../core/clipboard.js';
import { openFs, askOpenWith, PREVIEW_EXT } from '../../core/openwith.js';

/** 快捷入口:随执行用户家目录变化 */
function quickPlaces(home) {
  return [
    { name: '主目录', path: home, icon: 'home' },
    { name: '桌面', path: `${home}/desktop`, icon: 'monitor' },
    { name: '文档', path: `${home}/documents`, icon: 'fileText' },
    { name: '图片', path: `${home}/pictures`, icon: 'image' },
    { name: '音乐', path: `${home}/music`, icon: 'music' },
    { name: '下载', path: `${home}/downloads`, icon: 'download' },
    { name: '系统 /bin', path: '/bin', icon: 'terminal' },
    // 「应用 /app」不设侧栏入口:应用包是 root 私有(用户不可列/读/写),列了也进不去
  ];
}

function fileIcon(item, encrypted = false) {
  if (item.dir) return { name: 'folder', color: '#4f9cf9', size: 34 };
  if (isAppLink(item.name)) {
    const app = appLinkApp(item.path);
    return { name: app?.icon || 'file', color: app ? flatColor(app) : '#8a94a8', size: 30 };
  }
  if (encrypted) return { name: 'lock', color: '#a855f7', size: 30 };
  if (/\.zip$/i.test(item.name)) return { name: 'download', color: '#eab308', size: 30 };
  const ext = item.name.split('.').pop().toLowerCase();
  if (['txt', 'md', 'log', 'json', 'js', 'css', 'html'].includes(ext)) return { name: 'fileText', color: '#8a94a8', size: 30 };
  if (ext === 'axl') return { name: 'grid', color: '#12a150', size: 30 };
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
  ...manifest,
  /* dialogs / fs 来自 ctx:应用绑定弹框与执行用户鉴权的文件 API */
  mount({ root, bus, params, setTitle, dialogs, fs, user }) {
    /** 对话框封装:输入(返回 string|null) */
    const modalPrompt = (title, placeholder, value) =>
      dialogs.prompt({ title, message: '输入名称:', placeholder, value });

    const home = fs.homePath() || '/home';
    let cwd = params.path && fs.isDir(params.path)
      ? fs.normPath(params.path)
      : home;
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
      selected = null;   // 打开即取消选中(双击/右键打开一致):图标不停留在选中态
      grid.querySelectorAll('.fitem.selected').forEach(x => x.classList.remove('selected'));
      renderStatus();
      if (item.dir) nav(item.path);
      else if (isAppLink(item.name)) {
        // 应用快捷方式:启动目标应用(单实例应用复用已有窗口)
        const app = appLinkApp(item.path);
        if (app) open(app.id);
        else bus.notify('快捷方式失效', `「${item.name}」指向的应用不存在`);
      }
      else if (/\.zip$/i.test(item.name)) browseZip(item);   // ZIP:打开包内浏览器
      else if (isEncrypted(fs.read(item.path))) {
        // 加密文件:解锁后只读预览(不落盘明文)
        (async () => {
          const pw = await dialogs.password({ title: '文件已加密', message: `输入「${item.name}」的密码以查看` });
          if (pw == null) return;
          try {
            const plain = await decryptText(fs.read(item.path), pw);
            const tmp = (fs.homePath() || '/home') + '/downloads/.' + item.name + '.preview';
            fs.write(tmp, plain);
            open('viewer', { params: { file: new File([plain], item.name, { type: 'text/plain' }) } });
            fs.rm(tmp);
          } catch (e) {
            dialogs.error({ title: '解锁失败', message: String(e.message) });
          }
        })();
      } else {
        // 打开方式路由:用户默认关联 > 内置默认(md / 代码 / 预览 / 记事本)
        openFs(item.path);
      }
    }

    /** 加密 / 解密文件(密码经系统对话框输入) */
    async function toggleEncrypt(item) {
      const content = fs.read(item.path);
      if (content == null || item.dir) return;
      if (isEncrypted(content)) {
        const pw = await dialogs.password({ title: '解密文件', message: `输入「${item.name}」的密码` });
        if (pw == null) return;
        try {
          const plain = await decryptText(content, pw);
          fs.write(item.path, plain);
          bus.notify('已解密', item.name);
        } catch (e) {
          dialogs.error({ title: '解密失败', message: String(e.message) });
        }
      } else {
        const pw = await dialogs.password({ title: '加密文件', message: `为「${item.name}」设置密码` });
        if (pw == null) return;
        const pw2 = await dialogs.password({ title: '确认密码', message: '再次输入同一密码' });
        if (pw2 == null) return;
        if (pw !== pw2) { dialogs.error({ title: '加密失败', message: '两次输入的密码不一致' }); return; }
        if (!pw) { dialogs.error({ title: '加密失败', message: '密码不能为空' }); return; }
        fs.write(item.path, await encryptText(content, pw));
        bus.notify('已加密 🔒', item.name);
      }
      render();
    }

    /* ---- ZIP 支持 ---- */
    /** 存储文本 → 二进制(支持 ZIPB64 包装或原始文本) */
    async function blobFromText(text) {
      if (text.startsWith('\u0000ZIPB64:')) {
        const b64 = text.slice('\u0000ZIPB64:'.length);
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      }
      return new TextEncoder().encode(text);
    }

    /** 浏览压缩包内容(条目列表对话框 + 一键全部解压) */
    async function browseZip(item) {
      const data = await blobFromText(fs.read(item.path));
      let entries;
      try { entries = listEntries(data); }
      catch (e) { dialogs.error({ title: '无法打开压缩包', message: String(e.message) }); return; }
      const ok = await dialogs.confirm({
        title: `压缩包 · ${item.name}`,
        message: `包含 ${entries.length} 个条目,可全部解压到同名文件夹。`,
        detail: entries.map((e2) => `${e2.name}  (${e2.size}B, ${e2.method === 8 ? 'DEFLATE' : 'STORE'})`).join('\n').slice(0, 900),
        okText: `解压到 ${item.name.replace(/\.zip$/i, '')}/`,
        cancelText: '关闭',
      });
      if (!ok) return;
      await extractZip(item, item.name.replace(/\.zip$/i, ''));
    }

    /** 解压 ZIP 到目录(按包内路径重建结构) */
    async function extractZip(item, destName) {
      const dest = fs.joinPath(cwd, destName || item.name.replace(/\.zip$/i, ''));
      const data = await blobFromText(fs.read(item.path));
      try {
        const items = await unzip(data, { asText: true });
        for (const it of items) {
          const p = fs.joinPath(dest, it.name);
          if (it.dir) fs.mkdir(p);
          else fs.write(p, it.text ?? '');
        }
        bus.notify('解压完成', `${items.length} 个条目 → ${dest}`);
      } catch (e) {
        dialogs.error({ title: '解压失败', message: String(e.message) });
      }
      render();
    }

    /** 打包多个文件/文件夹为 ZIP(目录递归) */
    async function compressItems(paths, zipName) {
      const items = [];
      const addDir = (dirPath, prefix) => {
        items.push({ name: prefix + '/' });
        for (const f of fs.list(dirPath) || []) {
          if (f.dir) addDir(f.path, prefix + '/' + f.name);
          else items.push({ name: prefix + '/' + f.name, data: fs.read(f.path) });
        }
      };
      for (const p of paths) {
        if (fs.isDir(p)) addDir(p, fs.basename(p));
        else items.push({ name: fs.basename(p), data: fs.read(p) });
      }
      const packed = await zip(items);
      // fs 存文本:二进制以 Base64 包装(带标记头),保证可持久化
      let bin = '';
      for (const b of packed) bin += String.fromCharCode(b);
      fs.write(fs.joinPath(cwd, zipName), '\u0000ZIPB64:' + btoa(bin));
      bus.notify('压缩完成', `${zipName}(${items.length} 个条目)`);
      render();
    }

    async function newItem(kind) {
      const name = await modalPrompt(kind === 'dir' ? '新建文件夹' : '新建文本文件', '名称', kind === 'dir' ? '新建文件夹' : '新建文件.txt');
      if (name == null || !name.trim()) return;
      const p = fs.joinPath(cwd, name.trim());
      if (kind === 'dir') fs.mkdir(p);
      else fs.write(p, '');
      bus.notify('已创建', name.trim());
    }

    /** 就地重命名(Mac 式):直接在条目名称上编辑真实文件名(主名预选) */
    function renameItem(item) {
      const label = grid.querySelector(`.fitem[data-path="${CSS.escape(item.path)}"] .f-name`);
      if (!label) return;
      inplaceRename(label, item.name, (next) => {
        const name = next.trim();
        if (!name || name === item.name) return;
        fs.rename(item.path, fs.joinPath(cwd, name));
        selected = null;
        render();
      });
    }

    /** 删除 = 移入回收站(可逆,免确认;彻底删除去回收站窗口) */
    function deleteItem(item) {
      if (!moveToTrash([item.path])) {
        dialogs.error({ title: '无法删除', message: `「${item.name}」可能已被移动,或你没有删除它的权限。` });
        return;
      }
      selected = null;
      render();
      bus.notify('已移入回收站', `${item.name}(可在回收站还原)`);
    }

    /** 粘贴剪贴板内容到当前目录 */
    async function pasteHere() {
      const r = await clip.pasteInto(cwd, user);
      if (r.copied + r.moved === 0) {
        bus.notify('粘贴', '剪贴板为空,或其中的项目已被移动/删除');
        return;
      }
      render();
      bus.notify('已粘贴', `${r.copied ? r.copied + ' 个复制' : ''}${r.copied && r.moved ? ' · ' : ''}${r.moved ? r.moved + ' 个移动' : ''}`);
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
      if (!items) {
        const h = fs.homePath();
        if (h && cwd !== h && fs.isDir(h)) cwd = h;
        else if (cwd !== '/') cwd = '/';
        else return;
        return render();
      }
      if (!items.length) {
        grid.append(el('div', { class: 'empty', style: { gridColumn: '1/-1' } }, icon('folderOpen', 40), '此文件夹为空'));
      }
      for (const item of items) {
        const encrypted = !item.dir && isEncrypted(fs.read(item.path) || '');
        const fi = fileIcon(item, encrypted);
        const node = el('button', {
          class: 'fitem' + (selected === item.path ? ' selected' : '') + (clip.isCut(item.path) ? ' cut' : ''),
          dataset: { path: item.path },
          title: encrypted ? '🔒 已加密' : '',
          onClick: () => { selected = selected === item.path ? null : item.path; renderStatus(); grid.querySelectorAll('.fitem').forEach(x => x.classList.toggle('selected', x.dataset.path === selected)); },
          onDblClick: () => openItem(item),
          onContextmenu: (e) => {
            e.preventDefault();
            selected = item.path;
            renderStatus();
            showMenu(e.clientX, e.clientY, [
              { label: '打开', icon: 'folderOpen', fn: () => openItem(item) },
              ...(!item.dir && !isAppLink(item.name) ? [{ label: '打开方式…', icon: 'external', fn: () => askOpenWith(item.path) }] : []),
              ...(item.dir ? [] : [
                ...(PREVIEW_EXT.test(item.name)
                  ? [{ label: '预览', icon: 'image', fn: () => open('viewer', { params: { path: item.path } }) }]
                  : []),
                (/\.md$/i.test(item.name)
                  ? { label: '用 Markdown 编辑器打开', icon: 'pencil', fn: () => open('mdedit', { params: { path: item.path } }) }
                  : CODE_EXT_RE.test(item.name)
                    ? { label: '用代码编辑器打开', icon: 'code', fn: () => open('codeedit', { params: { path: item.path } }) }
                    : { label: '用记事本打开', icon: 'fileText', fn: () => open('notes', { params: { path: item.path } }) }),
                { label: encrypted ? '解密…' : '加密…', icon: 'lock', fn: () => toggleEncrypt(item) },
              ]),
              ...(item.dir ? [] : (/\.zip$/i.test(item.name)
                ? [{ label: '解压到当前文件夹', icon: 'download', fn: () => extractZip(item, item.name.replace(/\.zip$/i, '')) }]
                : [{ label: '压缩为 ZIP', icon: 'download', fn: () => compressItems([item.path], item.name.replace(/\.[^.]+$/, '') + '.zip') }])),
              { sep: true },
              { label: '复制', icon: 'copy', fn: () => { clip.setFiles('copy', [item.path]); renderGrid(); } },
              { label: '剪切', icon: 'scissors', fn: () => { clip.setFiles('cut', [item.path]); renderGrid(); } },
              { sep: true },
              { label: '重命名', icon: 'pencil', fn: () => renameItem(item) },
              { label: '删除(移入回收站)', icon: 'trash', danger: true, fn: () => deleteItem(item) },
            ]);
          },
        },
          el('span', { class: 'f-ico', style: { color: fi.color } }, icon(fi.name, fi.size)),
          el('span', { class: 'f-name', title: item.path }, (encrypted ? '🔒 ' : '') + item.name));
        // .app 快捷方式也是启动入口:悬停预读目标应用 chunk
        if (!item.dir && isAppLink(item.name)) {
          const linkApp = appLinkApp(item.path);
          if (linkApp) hoverPrefetch(node, linkApp.id);
        }
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
      setTitle('文件管家 — ' + (cwd === '/' ? '根目录' : cwd));
    }

    // IPC:监听文件系统变化实时刷新;响应其他应用的刷新请求
    const offFs = bus.onSys('fs-changed', () => render());
    const offClip = bus.onSys('clipboard-changed', () => render());
    const offReq = bus.on('refresh', (p, msg) => { render(); msg.reply?.({ ok: true }); });
    const offParams = bus.on('params', (p) => { if (p?.path && fs.isDir(p.path)) { cwd = fs.normPath(p.path); render(); } });

    // 键盘:Ctrl+C/X 复制剪切选中项,Ctrl+V 粘贴到当前目录
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'c' && k !== 'x' && k !== 'v') return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable=""]')) return;   // 输入框里的复制粘贴归输入框
      e.preventDefault();
      if (k === 'v') { pasteHere(); return; }
      if (!selected) return;
      clip.setFiles(k === 'c' ? 'copy' : 'cut', [selected]);
      renderGrid();
    };
    root.addEventListener('keydown', onKey);

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        backBtn, upBtn, refreshBtn,
        el('div', { class: 'tb-sep', style: { height: '20px', margin: '0 4px' } }),
        crumbs,
        el('button', { class: 'btn icon', title: '新建文件夹', onClick: () => newItem('dir') }, icon('folderPlus', 15)),
        el('button', { class: 'btn icon', title: '新建文件', onClick: () => newItem('file') }, icon('filePlus', 15)),
        el('button', {
          class: 'btn icon', title: '粘贴剪贴板内容(Ctrl+V)', onClick: () => pasteHere(),
        }, icon('clipboard', 14)),
        el('button', {
          class: 'btn icon', title: '把选中项压缩为 ZIP', onClick: () => {
            const targets = selected
              ? [selected]
              : (fs.list(cwd) || []).filter(f => !f.dir).slice(0, 1).map(f => f.path);
            if (!targets.length) { bus.notify('压缩', '请先选中文件或文件夹'); return; }
            const base = fs.basename(targets[0]).replace(/\.[^.]+$/, '') || 'archive';
            compressItems(targets, base + '.zip');
          },
        }, icon('download', 14)),
      ),
      el('div', { class: 'app-mid' },
        el('div', { class: 'app-side' },
          el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '4px 10px 8px' } }, '快速访问'),
          el('div', { class: 'list' },
            ...quickPlaces(home).map(q => el('button', {
              class: 'list-item' + (cwd === q.path ? ' active' : ''),
              onClick: () => nav(q.path),
            }, el('span', { class: 'li-ico' }, icon(q.icon, 15)), q.name))),
          el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '12px 10px 8px' } }, '存储'),
          el('div', { class: 'list' },
            el('button', { class: 'list-item', onClick: () => open('trash') }, el('span', { class: 'li-ico' }, icon('trash', 15)), '回收站'),
            el('button', { class: 'list-item', onClick: () => nav('/') }, el('span', { class: 'li-ico' }, icon('hardDrive', 15)), '文件系统'))),
        el('div', { class: 'app-body', onClick: (e) => {
          if (e.target === grid || e.target === e.currentTarget) { selected = null; renderStatus(); renderGrid(); }
        }, onContextmenu: (e) => {
          if (e.target !== grid && e.target !== e.currentTarget) return;
          e.preventDefault();
          const cx = e.clientX, cy = e.clientY;
          showMenu(cx, cy, [
            { label: '新建文件夹', icon: 'folderPlus', fn: () => newItem('dir') },
            { label: '新建文本文件', icon: 'filePlus', fn: () => newItem('file') },
            { label: '新建应用快捷方式', icon: 'star',
              fn: () => showMenu(cx, cy, appLinkMenuItems((a) => {
                if (createAppLink(cwd, a.id)) bus.notify('已创建快捷方式', a.name);
              })) },
            ...(clip.hasFiles() ? [{ label: '粘贴', icon: 'clipboard', fn: () => pasteHere() }] : []),
            { sep: true },
            { label: '刷新', icon: 'refresh', fn: () => render() },
          ]);
        } }, grid)),
      el('div', { class: 'app-status' }, statusLeft,
        el('span', { class: 'grow' }),
        el('span', { class: 'mono' }, cwd))));

    render();
    return {
      onClose() {
        offFs(); offClip(); offReq(); offParams();
        root.removeEventListener('keydown', onKey);
        return true;
      },
    };
  },
});
