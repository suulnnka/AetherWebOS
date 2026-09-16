/* ============================================================
 * 应用:本地资源 —— 浏览本电脑真实文件
 *
 * 三种打开方式(全部只读,不经网络):
 *  1. 「打开文件夹」:File System Access API(showDirectoryPicker,
 *     Chromium),可逐级进入子目录;
 *  2. 兼容回退:<input webkitdirectory> 选择文件夹 / <input multiple>
 *     选择文件(按相对路径组织);
 *  3. 直接把文件或文件夹拖进窗口。
 * 双击文件 → 交给「文件预览」应用(对象引用直传,不落盘)。
 * ============================================================ */
import { el, formatBytes } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import { open } from '../../core/wm.js';

function extIcon(name, isDir) {
  if (isDir) return { name: 'folder', color: '#4f9cf9', size: 34 };
  const ext = name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return { name: 'image', color: '#a78bfa', size: 30 };
  if (['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(ext)) return { name: 'film', color: '#f472b6', size: 30 };
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return { name: 'music', color: '#34d399', size: 30 };
  if (['pdf'].includes(ext)) return { name: 'fileText', color: '#ef4444', size: 30 };
  if (['txt', 'md', 'json', 'js', 'css', 'html', 'xml', 'csv', 'log', 'ini', 'yml'].includes(ext)) return { name: 'fileText', color: '#8a94a8', size: 30 };
  return { name: 'file', color: '#8a94a8', size: 30 };
}

register({
  id: 'localfiles',
  name: '本地资源',
  icon: 'hardDrive',
  color: 'linear-gradient(135deg,#64748b,#334155)',
  neon: { a: '#60a5fa', b: '#93c5fd' },
  width: 880, height: 560,
  min: { w: 560, h: 360 },
  singleton: true,
  order: 1.5,
  mount({ root, setTitle }) {
    /** mode: 'fsaccess' | 'list' | null */
    let mode = null;
    let dirStack = [];        // fsaccess: 目录句柄栈
    let listFiles = [];       // list 模式的文件数组(含 __dir 相对路径)
    let cwdRel = '';          // list 模式当前子目录
    let lastCount = 0, lastBytes = 0;

    const grid = el('div', { class: 'fgrid' });
    const crumbs = el('div', { class: 'crumbs' });
    const statusL = el('span', {}, '未打开任何文件夹');
    const statusR = el('span', { class: 'mono' }, '');
    const hint = el('div', { class: 'loc-drop' },
      el('div', { class: 'empty' }, icon('hardDrive', 40),
        el('div', {}, '打开本电脑的文件'),
        el('div', { class: 'dim', style: { fontSize: '12px' } }, '点击上方「打开文件夹」,或把文件/文件夹直接拖到这里')));

    const dirInput = el('input', { type: 'file', webkitdirectory: '', style: { display: 'none' } });
    const fileInput = el('input', { type: 'file', multiple: '', style: { display: 'none' } });

    /* ---------- FS Access 模式 ---------- */
    async function openFolderPicker() {
      if (!window.showDirectoryPicker) { dirInput.click(); return; }
      try {
        const handle = await showDirectoryPicker();
        mode = 'fsaccess';
        dirStack = [handle];
        await render();
      } catch { /* 用户取消 */ }
    }

    async function listFSDir(handle) {
      const entries = [];
      for await (const [name, h] of handle.entries()) {
        let size = null;
        if (h.kind === 'file') { try { size = (await h.getFile()).size; } catch { /* 忽略 */ } }
        entries.push({ name, dir: h.kind === 'directory', handle: h, size });
      }
      return entries.sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
    }

    /* ---------- input 回退模式 ---------- */
    function adoptInputFiles(files, rootName) {
      mode = 'list';
      listFiles = [...files].map(f => ({ file: f, rel: (f.webkitRelativePath || f.name).replace(/^[^/]*\//, '') || f.name, size: f.size }));
      // input 选择的根名(去掉末级)
      listFiles.rootName = rootName;
      cwdRel = '';
      render();
    }

    function listRelDir() {
      const prefix = cwdRel ? cwdRel + '/' : '';
      const out = [];
      const seen = new Set();
      for (const it of listFiles) {
        if (!it.rel.startsWith(prefix)) continue;
        const rest = it.rel.slice(prefix.length);
        if (rest.includes('/')) {
          const d = rest.split('/')[0];
          if (!seen.has(d)) { seen.add(d); out.push({ name: d, dir: true }); }
        } else if (rest) {
          out.push({ name: rest, dir: false, size: it.size, file: it.file });
        }
      }
      return out.sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
    }

    /* ---------- 渲染 ---------- */
    async function render() {
      crumbs.innerHTML = '';
      grid.innerHTML = '';
      lastCount = 0; lastBytes = 0;
      let items = [];

      if (mode === 'fsaccess') {
        const cur = dirStack.at(-1);
        setTitle(`本地资源 — ${cur.name}`);
        crumbs.append(el('span', { class: 'crumb cur' }, cur.name));
        items = await listFSDir(cur);
      } else if (mode === 'list') {
        const rootName = listFiles.rootName || '已选文件';
        setTitle(`本地资源 — ${rootName}`);
        crumbs.append(el('span', { class: 'crumb cur' }, rootName + (cwdRel ? '/' + cwdRel : '')));
        items = listRelDir();
      } else {
        hint.style.display = '';
        grid.style.display = 'none';
        statusL.textContent = '未打开任何文件夹';
        statusR.textContent = '';
        return;
      }
      hint.style.display = 'none';
      grid.style.display = '';

      if (!items.length) grid.append(el('div', { class: 'empty', style: { gridColumn: '1/-1' } }, icon('folderOpen', 40), '空文件夹'));
      for (const item of items) {
        lastCount++;
        if (!item.dir) lastBytes += item.size || 0;
        const fi = extIcon(item.name, item.dir);
        grid.append(el('button', {
          class: 'fitem',
          onClick: () => { [...grid.children].forEach(c => c.classList.remove('selected')); grid.children[items.indexOf(item)]?.classList.add('selected'); },
          onDblClick: async () => {
            if (item.dir) {
              if (mode === 'fsaccess') dirStack.push(item.handle);
              else cwdRel = cwdRel ? cwdRel + '/' + item.name : item.name;
              render();
              return;
            }
            // 文件 → 交给预览器(引用直传)
            const file = item.file ?? (item.handle ? await item.handle.getFile() : null);
            if (file) open('viewer', { params: { file, name: item.name } });
          },
        },
          el('span', { class: 'f-ico', style: { color: fi.color } }, icon(fi.name, fi.size)),
          el('span', { class: 'f-name' }, item.name),
          el('span', { class: 'dim', style: { fontSize: '11px' } }, item.dir ? '文件夹' : formatBytes(item.size))));
      }
      statusL.textContent = `${items.length} 个项目`;
      statusR.textContent = lastBytes ? formatBytes(lastBytes) : '';
    }

    /* ---------- 拖放 ---------- */
    async function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      root.classList.remove('dragover');
      const dt = e.dataTransfer;
      if (!dt) return;
      // Chromium:优先取目录句柄(支持递归浏览)
      const firstItem = dt.items && dt.items[0];
      let dirHandle = null;
      try { const h = await firstItem?.getAsFileSystemHandle?.(); if (h?.kind === 'directory') dirHandle = h; } catch { /* 忽略 */ }
      if (dirHandle) {
        mode = 'fsaccess';
        dirStack = [dirHandle];
        await render();
        return;
      }
      if (dt.files && dt.files.length) {
        adoptInputFiles(dt.files, '拖入的文件');
      }
    }

    const toolbar = el('div', { class: 'app-toolbar' },
      el('button', { class: 'btn primary', onClick: openFolderPicker }, icon('folderOpen', 14), '打开文件夹'),
      el('button', { class: 'btn', onClick: () => fileInput.click() }, icon('file', 14), '选择文件'),
      el('button', {
        class: 'btn icon', title: '上一级', onClick: () => {
          if (mode === 'fsaccess' && dirStack.length > 1) { dirStack.pop(); render(); }
          else if (mode === 'list' && cwdRel) { cwdRel = cwdRel.split('/').slice(0, -1).join('/'); render(); }
        },
      }, icon('arrowUp', 15)),
      crumbs);

    dirInput.addEventListener('change', () => {
      if (!dirInput.files?.length) return;
      const root = dirInput.files[0].webkitRelativePath?.split('/')[0] || '已选文件夹';
      adoptInputFiles(dirInput.files, root);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files?.length) adoptInputFiles(fileInput.files, '已选文件'); });

    root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('dragover'); });
    root.addEventListener('dragleave', () => root.classList.remove('dragover'));
    root.addEventListener('drop', handleDrop);

    root.append(el('div', { class: 'app' },
      toolbar,
      el('div', { class: 'app-body', style: { display: 'flex', flexDirection: 'column' } },
        hint,
        grid),
      el('div', { class: 'app-status' }, statusL, el('span', { class: 'grow' }), statusR),
      dirInput, fileInput));
  },
});
