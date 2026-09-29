/* ============================================================
 * 应用:文件预览 —— Markdown / 图片 / 音频 / 视频 / PDF / 文本
 *
 * 数据来源:
 *  - 本地资源双击打开(params.file 为 File 对象,引用直传);
 *  - 虚拟文件系统文件(params.path,二进制感知,按扩展名定 MIME);
 *  - 把文件直接拖到本窗口;
 *  - 其他应用 wm.open('viewer', { params: { file } })。
 * 文本提供「在记事本中编辑」、Markdown 提供「在 Markdown 编辑器中编辑」:
 * 保存到虚拟文件系统后调起对应应用。
 * ============================================================ */
import { el, formatBytes } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './viewer.css';
import '../../lib/mdedit.css';                 // .md-view 渲染排版(与编辑组件共用)
import { open } from '../../core/wm.js';
import { openMdLink } from '../../core/mdopen.js';
import { render as mdRender } from '../../lib/md.js';

const TEXT_EXT = ['txt', 'md', 'json', 'js', 'css', 'html', 'xml', 'csv', 'log', 'ini', 'yml', 'conf'];

/** 扩展名 → MIME(VFS 来源的文件没有类型信息,按名补齐) */
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  md: 'text/markdown', markdown: 'text/markdown',
  txt: 'text/plain', json: 'application/json', js: 'text/javascript', css: 'text/css',
  html: 'text/html', xml: 'application/xml', csv: 'text/csv',
  log: 'text/plain', ini: 'text/plain', yml: 'text/plain', conf: 'text/plain',
};

function route(file) {
  const type = file.type || '';
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return 'md';
  if (type.startsWith('text/') || TEXT_EXT.includes(ext)) return 'text';
  return 'unknown';
}

register({
  ...manifest,
  mount({ root, setTitle, bus, params, fs, user }) {
    let url = null;              // 当前对象 URL(关闭时回收)
    const stage = el('div', { class: 'viewer-stage' });
    const infoL = el('span', {}, '拖放文件到此处');
    const infoR = el('span', { class: 'mono' }, '');
    const editLabel = el('span', {}, '在记事本中编辑');
    const editBtn = el('button', { class: 'btn', hidden: '', onClick: () => toEditor() }, icon('pencil', 13), editLabel);
    let currentFile = null;
    let editKind = null;         // 'text' → 记事本;'md' → Markdown 编辑器
    let curPath = null;          // 来源为虚拟文件系统时的路径(链接相对解析用)

    const revoke = () => { if (url) { URL.revokeObjectURL(url); url = null; } };

    const empty = () => {
      revoke();
      currentFile = null;
      editKind = null;
      curPath = null;
      stage.innerHTML = '';
      stage.classList.remove('pdf');
      stage.append(el('div', { class: 'viewer-empty' }, icon('image', 42),
        el('div', { style: { fontWeight: 600 } }, '文件预览'),
        el('div', { class: 'dim', style: { fontSize: '12.5px' } },
          '支持 Markdown / 图片 / 音频 / 视频 / PDF / 文本。从「本地资源」双击文件、文件管家打开,或直接拖到这里。')));
      infoL.textContent = '拖放文件到此处';
      infoR.textContent = '';
      editBtn.hidden = true;
      setTitle('文件预览');
    };

    /** 转入编辑器:文本 → 记事本,Markdown → Markdown 编辑器(先存入虚拟文件系统) */
    async function toEditor() {
      if (!currentFile || !editKind) return;
      const text = await currentFile.file.text();
      const path = (fs.homePath() || '/home') + '/downloads/' + (currentFile.name.replace(/[\/\\]/g, '_'));
      if (!fs.write(path, text)) {
        bus.notify('写入失败', '无写入权限或路径无效');
        return;
      }
      open(editKind === 'md' ? 'mdedit' : 'notes', { params: { path } });
      bus.notify(editKind === 'md' ? '已转入 Markdown 编辑器' : '已转入记事本', path);
    }

    /** 虚拟文件系统来源:读字节 + 按扩展名补 MIME,再走统一管线 */
    function loadPath(path) {
      const name = fs.basename(path);
      const data = fs.read(path);
      if (data == null) {
        bus.notify('无法读取', `文件不存在或无读权限:${path}`);
        empty();
        return;
      }
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const mime = MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
      curPath = path;
      load(new File([bytes], name, { type: mime }), name);
    }

    async function load(file, name) {
      revoke();
      curPath = null;
      currentFile = { file, name: name || file.name || '未命名' };
      const kind = route(file);
      url = URL.createObjectURL(file);
      stage.innerHTML = '';
      stage.classList.remove('pdf');
      infoR.textContent = `${file.type || '未知类型'} · ${formatBytes(file.size)}`;
      infoL.textContent = currentFile.name;
      setTitle(`${currentFile.name} — 文件预览`);
      editKind = null;
      editBtn.hidden = true;

      if (kind === 'image') {
        stage.append(el('img', { src: url, alt: currentFile.name }));
      } else if (kind === 'video') {
        stage.append(el('video', { src: url, controls: '', autoplay: '' }));
      } else if (kind === 'audio') {
        stage.append(el('div', { class: 'viewer-audio' }, icon('music', 40),
          el('div', { style: { fontWeight: 600 } }, currentFile.name),
          el('audio', { src: url, controls: '', style: { marginTop: '12px' } })));
      } else if (kind === 'pdf') {
        stage.classList.add('pdf');
        stage.append(el('iframe', { src: url, title: currentFile.name }));
      } else if (kind === 'md') {
        const text = await file.text();
        const box = el('div', { class: 'viewer-md' });
        box.innerHTML = mdRender(text.slice(0, 500000));   // md.js 输出已全量转义
        stage.append(box);
        editKind = 'md';
        editBtn.hidden = false;
        editLabel.textContent = '在 Markdown 编辑器中编辑';
        infoR.textContent = `markdown · ${formatBytes(file.size)} · ${text.split('\n').length} 行`;
      } else if (kind === 'text') {
        const text = await file.text();
        stage.append(el('pre', { class: 'viewer-pre' }, text.slice(0, 200000)));
        editKind = 'text';
        editBtn.hidden = false;
        editLabel.textContent = '在记事本中编辑';
        infoR.textContent = `${(file.type || 'text')} · ${formatBytes(file.size)} · ${text.split('\n').length} 行`;
      } else {
        stage.append(el('div', { class: 'viewer-empty' }, icon('file', 42),
          el('div', { style: { fontWeight: 600 } }, currentFile.name),
          el('div', { class: 'dim', style: { fontSize: '12.5px' } },
            `暂不支持预览该格式(${file.type || '未知类型'})。`)));
      }
    }

    /* Markdown 里的链接:本地路径按系统规则打开,网址走系统浏览器
     * (必须阻止默认 —— 否则会真的导航整个页面) */
    stage.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      openMdLink(a.getAttribute('href') || '', curPath);
    });

    /* 拖放 */
    root.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); root.classList.add('dragover'); });
    root.addEventListener('dragleave', () => root.classList.remove('dragover'));
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.classList.remove('dragover');
      const f = e.dataTransfer?.files?.[0];
      if (f) load(f);
    });

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '文件预览'),
        el('span', { class: 'grow' }),
        editBtn,
        el('button', { class: 'btn', onClick: empty }, icon('close', 13), '清空')),
      stage,
      el('div', { class: 'app-status' }, infoL, el('span', { class: 'grow' }), infoR)));

    empty();
    if (params?.file) load(params.file, params.name);
    else if (params?.path) loadPath(params.path);
    return {
      onParams(p) {                                            // 单例复用时;当前为多窗口模式
        if (p?.file) load(p.file, p.name);
        else if (p?.path) loadPath(p.path);
      },
      onClose() { revoke(); return true; },
    };
  },
});
