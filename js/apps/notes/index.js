/* ============ 应用:记事本(Note Station) ============ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './notes.css';
import { modal } from '../../core/ui.js';

register({
  ...manifest,
  mount({ root, bus, params, setTitle, fs, user }) {
    let path = params.path || null;   // null = 未保存的新文档
    let dirty = false;

    const area = el('textarea', { class: 'notes-area', placeholder: '开始输入…', spellcheck: 'false' });
    const nameEl = el('span', { class: 'dim', style: { fontSize: '12.5px' } });
    const status = el('span', {}, '');

    function refreshTitle() {
      const name = path ? fs.basename(path) : '未命名';
      nameEl.textContent = path ? path : '尚未保存到文件系统';
      setTitle((dirty ? '● ' : '') + name + ' — 记事本');
      const n = area.value.length;
      const lines = area.value.split('\n').length;
      status.textContent = `${n} 字符 · ${lines} 行`;
    }

    async function save(as = false) {
      let target = path;
      if (as || !target) {
        const def = `${fs.homePath() || '/home'}/documents/未命名.txt`;
        const p = await modal(document.body, {
          title: '保存文件',
          input: { placeholder: def, value: target || def },
          body: '输入文件保存路径(自动创建目录)',
        });
        if (p == null) return false;
        target = fs.normPath(p.trim() || '');
        if (!target || target === '/') return false;
      }
      if (!fs.write(target, area.value)) {
        bus.notify('保存失败', `无写入权限或路径无效:${target}`);
        return false;
      }
      path = target;
      dirty = false;
      refreshTitle();
      bus.notify('文件已保存', path);
      return true;
    }

    area.addEventListener('input', () => { dirty = true; refreshTitle(); });
    area.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = area.selectionStart;
        area.setRangeText('  ', s, area.selectionEnd, 'end');
        dirty = true; refreshTitle();
      }
    });

    // 打开已有文件
    if (path) {
      const content = fs.read(path);
      if (content == null) {
        bus.notify('文件不存在', path);
        path = null;
      } else {
        area.value = content;
      }
    }

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn', onClick: () => save(false) }, icon('save', 13), '保存'),
        el('button', { class: 'btn', onClick: () => save(true) }, icon('filePlus', 13), '另存为'),
        el('span', { class: 'grow' }),
        nameEl),
      area,
      el('div', { class: 'app-status' }, status,
        el('span', { class: 'grow' }),
        el('span', {}, 'Ctrl+S 保存'))));

    refreshTitle();
    setTimeout(() => area.focus(), 50);

    // 外部(如文件管家)向已打开的记事本推送新文件
    const off = bus.on('params', (p) => {
      if (!p?.path) return;
      const c = fs.read(p.path);
      if (c == null) return;
      path = p.path;
      area.value = c;
      dirty = false;
      refreshTitle();
    });

    return {
      onClose() {
        if (!dirty) { off(); return true; }
        // 拦截关闭:三选一(保存 / 不保存 / 取消)
        const done = (a) => {
          mask.remove();
          if (a === 'save') save(false).then(() => { off(); dirty = false; bus.close(); });
          else if (a === 'discard') { off(); dirty = false; bus.close(); }
        };
        const box = el('div', { class: 'modal-box' },
          el('h3', {}, '有未保存的更改'),
          el('div', { class: 'm-body' }, `「${path ? fs.basename(path) : '未命名'}」尚未保存,关闭窗口将丢失这些更改。`),
          el('div', { class: 'modal-actions' },
            el('button', { class: 'btn', onClick: () => done('discard') }, '不保存'),
            el('button', { class: 'btn', onClick: () => done('cancel') }, '取消'),
            el('button', { class: 'btn primary', onClick: () => done('save') }, '保存并关闭')));
        const mask = el('div', { class: 'modal-mask' }, box);
        mask.addEventListener('pointerdown', (e) => { if (e.target === mask) done('cancel'); });
        document.body.append(mask);
        return false; // 先阻止关闭,交由异步流程处理
      },
    };
  },
});
