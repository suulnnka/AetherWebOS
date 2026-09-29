/* ============================================================
 * 应用:Markdown 编辑器
 *
 * 基于 js/lib/mdedit.js 的所见即所得组件(Typora 式):单栏即写即
 * 现,没有独立的预览页 —— 阅读与书写是同一份渲染。应用层加「编辑」
 * 键解锁:默认只读浏览(整篇渲染),点「编辑」后方可落笔,再点一次
 * 「完成」回到只读;文件不可写(无写权限 / 未登录)时编辑键置灰。
 * 文件读写走虚拟文件系统(ctx.fs),支持 .md 双击直达(文件管家/
 * 桌面/终端 edit 命令均已分流)、导出自包含 HTML。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './mdedit.css';
import { modal, confirmBox } from '../../core/ui.js';
import { openMdLink } from '../../core/mdopen.js';
import { createMdEditor } from '../../lib/mdedit.js';
import { render } from '../../lib/md.js';

/** 导出 HTML 的自包含模板(内联样式,任意浏览器可开;跟随系统亮暗) */
function htmlDoc(title, body) {
  const t = title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<style>
body{max-width:820px;margin:40px auto;padding:0 20px;font:15px/1.75 -apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2328;background:#fff}
h1,h2{border-bottom:1px solid #d8dee4;padding-bottom:.2em;line-height:1.3}h1{font-size:1.7em}h2{font-size:1.4em}h3{font-size:1.18em}
p{margin:.45em 0}a{color:#0969da}img{max-width:100%}
blockquote{border-left:3px solid #0969da;margin:.6em 0;padding:.1em 1em;color:#57606a}
pre{background:#f6f8fa;padding:12px 14px;border-radius:8px;overflow:auto;font-size:13px;line-height:1.6}
code{font-family:ui-monospace,Consolas,monospace;background:#f6f8fa;padding:1px 5px;border-radius:4px;font-size:.92em}
pre code{padding:0;background:none}
table{border-collapse:collapse}th,td{border:1px solid #d8dee4;padding:5px 11px}th{background:#f6f8fa}
li{line-height:1.7}li.md-task-item{list-style:none;margin-left:-1.3em}
.md-check{display:inline-block;width:14px;height:14px;border:1.5px solid #6e7781;border-radius:4px;vertical-align:-2px;margin-right:7px}
.md-check.on{background:#0969da;border-color:#0969da;position:relative}
.md-check.on::after{content:'✓';color:#fff;font-size:10px;position:absolute;inset:0;text-align:center;line-height:12px}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#388bfd}h1,h2,th,td{border-color:#30363d}pre,code,th{background:#161b22}blockquote{border-color:#388bfd;color:#8b949e}.md-check{border-color:#8b949e}}
</style></head><body>
${body}
</body></html>`;
}

register({
  ...manifest,
  mount({ root, bus, params, setTitle, fs }) {
    let path = params.path || null;   // null = 未保存的新文档
    let dirty = false;

    const ed = createMdEditor({
      toolbar: true,                                          // 固定操作栏:不懂语法也能套样式
      placeholder: '空文档 · 点「编辑」开始书写',
      onInput: () => { dirty = true; refreshChrome(); },
    });

    const nameEl = el('span', { class: 'dim', style: { fontSize: '12.5px', marginLeft: '8px' } });
    const stat = el('span', {}, '');

    /* 编辑锁:默认只读浏览,「编辑」键解锁(无独立预览页,同一份渲染) */
    let editing = false;
    const editBtn = el('button', { class: 'btn', onClick: () => setEditing(!editing) });
    /** 未保存的新文档可写(可另存);已有文件按执行用户的写权限判定 */
    const writable = () => (path ? fs.can(path, 'w') : true);

    function setEditing(on) {
      if (on && !writable()) return;                        // 置灰兜底(权限可能在会话中变化)
      editing = on;
      ed.preview(!on);
      ed.placeholder(on ? '输入 / 唤起命令;# 、- 、> 等语法即输即转' : '空文档 · 点「编辑」开始书写');
      editBtn.classList.toggle('primary', on);
      editBtn.replaceChildren(icon(on ? 'check' : 'pencil', 13), on ? '完成' : '编辑');
      if (on) setTimeout(() => ed.focus(), 30);
      refreshChrome();
    }

    function refreshChrome() {
      const name = path ? fs.basename(path) : '未命名';
      nameEl.textContent = path || '尚未保存到文件系统';
      setTitle((dirty ? '● ' : '') + name + ' — Markdown 编辑器');
      editBtn.disabled = editing ? false : !writable();     // 编辑中保持可点(「完成」退出)
      editBtn.title = editing ? '退出编辑,回到只读'
        : writable() ? '点击开始编辑' : '当前用户对此文件无写权限';
      const md = ed.get();
      const chars = md.length;
      const lines = md.split('\n').length;
      const words = (md.match(/[\u4e00-\u9fff\u3040-\u30ff]|[a-zA-Z0-9]+/g) || []).length;
      stat.textContent = `${chars} 字符 · ${words} 词 · ${lines} 行`;
    }

    async function loadPath(p) {
      const c = fs.read(p);
      if (c == null) { bus.notify('无法打开', `文件不存在或无读权限:${p}`); return; }
      if (dirty && !(await confirmBox(root, '放弃未保存的更改?', `打开「${fs.basename(p)}」将丢弃当前未保存的修改。`))) return;
      path = p;
      ed.set(c);
      dirty = false;
      setEditing(false);                                    // 打开即只读浏览
      refreshChrome();
    }

    async function openFile() {
      const def = `${fs.homePath() || '/home'}/documents/`;
      const p = await modal(document.body, {
        title: '打开 Markdown 文件',
        input: { placeholder: def, value: def },
        body: '输入文件路径(.md)',
      });
      if (p == null) return;
      const t = fs.normPath(p.trim() || '');
      if (t && t !== '/') loadPath(t);
    }

    async function save(as = false) {
      let target = path;
      if (as || !target) {
        const def = `${fs.homePath() || '/home'}/documents/未命名.md`;
        const p = await modal(document.body, {
          title: '保存文件',
          input: { placeholder: def, value: target || def },
          body: '输入文件保存路径(自动创建目录)',
        });
        if (p == null) return false;
        target = fs.normPath(p.trim() || '');
        if (!target || target === '/') return false;
      }
      if (!fs.write(target, ed.get())) {
        bus.notify('保存失败', `无写入权限或路径无效:${target}`);
        return false;
      }
      path = target;
      dirty = false;
      refreshChrome();
      bus.notify('文件已保存', path);
      return true;
    }

    async function exportHtml() {
      const md = ed.get();
      const base = path ? path.replace(/\.md$/i, '') : `${fs.homePath() || '/home'}/documents/未命名`;
      const def = base + '.html';
      const p = await modal(document.body, {
        title: '导出 HTML',
        input: { placeholder: def, value: def },
        body: '导出为自包含 HTML(内联样式,任意浏览器可打开)',
      });
      if (p == null) return;
      const target = fs.normPath(p.trim() || '');
      if (!target || target === '/') return;
      const doc = htmlDoc(path ? fs.basename(path) : '未命名', render(md));
      if (!fs.write(target, doc)) { bus.notify('导出失败', `无写入权限或路径无效:${target}`); return; }
      bus.notify('已导出 HTML', target);
    }

    /* 文中超链接:本地路径按系统规则打开(相对路径按本文档目录解析),网址走系统浏览器 */
    ed.el.addEventListener('mdlink', (e) => openMdLink(e.detail, path));

    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      }
    }, true);

    root.append(el('div', { class: 'app mdedit-app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn', onClick: openFile }, icon('folder', 13), '打开'),
        el('button', { class: 'btn', onClick: () => save(false) }, icon('save', 13), '保存'),
        el('button', { class: 'btn', onClick: () => save(true) }, icon('filePlus', 13), '另存为'),
        el('button', { class: 'btn', onClick: exportHtml }, icon('external', 13), '导出 HTML'),
        editBtn,
        el('span', { class: 'grow' }),
        nameEl),
      ed.el,
      el('div', { class: 'app-status' }, stat,
        el('span', { class: 'grow' }),
        el('span', {}, '所见即所得 · 「编辑」解锁修改 · Ctrl+S 保存'))));

    /* 打开已有文件(文件管家 / 桌面 / 终端推送):默认只读浏览 */
    if (path) {
      const content = fs.read(path);
      if (content == null) { bus.notify('文件不存在', path); path = null; }
      else ed.set(content);
    }
    setEditing(false);

    const off = bus.on('params', (p) => { if (p?.path) loadPath(p.path); });

    return {
      onClose() {
        if (!dirty) { off(); return true; }
        const done = (a) => {
          mask.remove();
          if (a === 'save') save(false).then((ok) => { if (ok) { off(); dirty = false; bus.close(); } });
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
        return false;
      },
    };
  },
});
