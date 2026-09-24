/* ============================================================
 * 应用:文件预览 —— 图片 / 视频 / 音频 / PDF / 文本
 *
 * 数据来源:
 *  - 本地资源双击打开(params.file 为 File 对象,引用直传);
 *  - 把文件直接拖到本窗口;
 *  - 其他应用 wm.open('viewer', { params: { file } })。
 * 文本另提供「在记事本中编辑」:保存到虚拟文件系统后调起记事本。
 * ============================================================ */
import { el, formatBytes } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './viewer.css';
import { open } from '../../core/wm.js';

const TEXT_EXT = ['txt', 'md', 'json', 'js', 'css', 'html', 'xml', 'csv', 'log', 'ini', 'yml', 'conf'];

function route(file) {
  const type = file.type || '';
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
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
    const editBtn = el('button', {
      class: 'btn', hidden: '',
      onClick: async () => {
        if (!currentFile) return;
        const text = await currentFile.file.text();
        const path = (fs.homePath() || '/home') + '/downloads/' + (currentFile.name.replace(/[\/\\]/g, '_'));
        if (!fs.write(path, text)) {
          bus.notify('写入失败', '无写入权限或路径无效');
          return;
        }
        open('notes', { params: { path } });
        bus.notify('已转入记事本', path);
      },
    }, icon('pencil', 13), '在记事本中编辑');
    let currentFile = null;

    const revoke = () => { if (url) { URL.revokeObjectURL(url); url = null; } };

    const empty = () => {
      revoke();
      currentFile = null;
      stage.innerHTML = '';
      stage.append(el('div', { class: 'viewer-empty' }, icon('image', 42),
        el('div', { style: { fontWeight: 600 } }, '文件预览'),
        el('div', { class: 'dim', style: { fontSize: '12.5px' } },
          '支持图片 / 视频 / 音频 / PDF / 文本。从「本地资源」双击文件,或直接拖到这里。')));
      infoL.textContent = '拖放文件到此处';
      infoR.textContent = '';
      editBtn.hidden = true;
      setTitle('文件预览');
    };

    async function load(file, name) {
      revoke();
      currentFile = { file, name: name || file.name || '未命名' };
      const kind = route(file);
      url = URL.createObjectURL(file);
      stage.innerHTML = '';
      infoR.textContent = `${file.type || '未知类型'} · ${formatBytes(file.size)}`;
      infoL.textContent = currentFile.name;
      setTitle(`${currentFile.name} — 文件预览`);
      editBtn.hidden = kind !== 'text';

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
      } else if (kind === 'text') {
        const text = await file.text();
        stage.classList.remove('pdf');
        stage.append(el('pre', { class: 'viewer-pre' }, text.slice(0, 200000)));
        infoR.textContent = `${(file.type || 'text')} · ${formatBytes(file.size)} · ${text.split('\n').length} 行`;
      } else {
        stage.append(el('div', { class: 'viewer-empty' }, icon('file', 42),
          el('div', { style: { fontWeight: 600 } }, currentFile.name),
          el('div', { class: 'dim', style: { fontSize: '12.5px' } },
            `暂不支持预览该格式(${file.type || '未知类型'})。`)));
      }
    }

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
    return {
      onParams(p) { if (p?.file) load(p.file, p.name); },   // 单例复用时;当前为多窗口模式
      onClose() { revoke(); return true; },
    };
  },
});
