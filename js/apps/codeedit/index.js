/* ============================================================
 * 应用:代码编辑器
 *
 * 基于 js/lib/cedit.js 的自研编辑组件(透明 textarea + 高亮层双层
 * 方案)+ js/lib/chl.js 自研语法高亮,支持 AetherJS / CSS / HTML /
 * JSON 四种语言(.ajs/.js/.css/.html/.json 双击直达,文件管家/终端
 * edit 命令均已分流)。
 *
 * 集成运行:AetherJS 经 core/ascript.js 的 Worker 运行器执行(死循环
 * 超时强杀,页面不卡死),print 输出与程序值进底部输出面板;编译错误
 * 带行列号,点击错误行跳转光标,行号槽标红;输入停顿 450ms 后实时
 * 语法检查。「在终端运行」把脚本交给终端的 node 命令(先保存)。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './codeedit.css';
import { modal, confirmBox } from '../../core/ui.js';
import { open } from '../../core/wm.js';
import { createCodeEditor } from '../../lib/cedit.js';
import { langOf, LANG_LABELS } from '../../lib/chl.js';
import { runAether, checkAether, formatAetherValue } from '../../core/ascript.js';
import { packExe } from '../../core/aexe.js';

register({
  ...manifest,
  mount({ root, bus, params, setTitle, fs }) {
    let path = params.path || null;   // null = 未保存的新缓冲
    let dirty = false;
    let langManual = false;           // 手动切过语言则不再按扩展名覆盖
    let lang = path ? langOf(fs.basename(path)) : 'ajs';

    /* ---------- 输出面板 ---------- */
    const outBody = el('div', { class: 'ce-out-body' });
    const outPanel = el('div', { class: 'ce-out hidden' },
      el('div', { class: 'ce-out-head' },
        icon('play', 12), '输出',
        el('span', { class: 'grow' }),
        el('button', {
          class: 'btn icon', title: '清空输出',
          onClick: () => { outBody.replaceChildren(); },
        }, icon('trash', 12)),
        el('button', {
          class: 'btn icon', title: '收起面板',
          onClick: () => showOut(false),
        }, icon('close', 12))),
      outBody);

    function showOut(on) { outPanel.classList.toggle('hidden', !on); }

    /** 追加一行输出;jump={line,col} 时可点击跳转光标 */
    function outLine(text, cls = '', jump = null) {
      const d = el('div', { class: `o-line ${cls}${jump ? ' o-jump' : ''}` }, String(text));
      if (jump) d.title = '点击跳转到该位置';
      d.addEventListener('click', () => {
        if (!jump) return;
        ed.setPos(jump.line, jump.col ?? 1);
      });
      outBody.append(d);
      outBody.scrollTop = outBody.scrollHeight;
    }

    /* ---------- 语法检查(输入停顿后,仅 AetherJS) ---------- */
    const synEl = el('span', { class: 'dim', title: '' }, '');
    let checkTimer = 0;
    function setSyn(err) {
      synEl.className = err ? 'ce-syn-bad' : 'dim';
      synEl.textContent = err
        ? `● 语法:行 ${err.line ?? '?'}:${err.col ?? '?'} ${err.message}`
        : '';
      synEl.title = err ? `${err.kind}: ${err.message}` : '';
    }
    function scheduleCheck() {
      clearTimeout(checkTimer);
      if (running) return;                      // 运行中不排检查:排了也只会排在脚本后面
      if (lang !== 'ajs') { setSyn(null); ed.markError(0); return; }
      const src = ed.get();
      if (!src.trim()) { setSyn(null); ed.markError(0); return; }
      checkTimer = setTimeout(async () => {
        const r = await checkAether(src);
        if (ed.get() !== src || lang !== 'ajs') return;   // 结果过期
        if (r.ok) { setSyn(null); ed.markError(0); return; }
        setSyn(r.error);
        ed.markError(r.error.line || 0);
      }, 450);
    }

    /* ---------- 编辑器 ---------- */
    const caretEl = el('span', {}, '行 1,列 1');
    const ed = createCodeEditor({
      lang,
      value: '',
      placeholder: '开始输入代码…(Tab 缩进 · Ctrl+/ 注释 · F5 运行)',
      onChange: () => { dirty = true; refresh(); scheduleCheck(); },
      onCaret: (line, col) => { caretEl.textContent = `行 ${line},列 ${col}`; },
    });

    /* ---------- 运行 ---------- */
    let running = false;
    const runBtn = el('button', {
      class: 'btn primary ce-run',
      title: '在 Worker 沙盒中运行当前缓冲(F5 / Ctrl+Enter);死循环 5s 超时强杀',
      onClick: () => run(),
    }, icon('play', 13), '运行');

    async function run() {
      if (running) return;
      if (lang !== 'ajs') {
        bus.notify('无法运行', `当前语言是 ${LANG_LABELS[lang] || lang},只有 AetherJS 脚本可以运行`);
        return;
      }
      running = true;
      runBtn.disabled = true;
      clearTimeout(checkTimer);   // 未决的语法检查作废(它排不进忙碌的 Worker)
      const src = ed.get();
      const name = path ? fs.basename(path) : '未保存缓冲';
      outBody.replaceChildren();
      showOut(true);
      outLine(`▶ 运行「${name}」· ${new Date().toLocaleTimeString()}`, 'o-dim');
      const r = await runAether(src, { print: (t) => outLine(t) });
      if (r.ok) {
        if (r.value !== undefined) outLine(`→ ${formatAetherValue(r.value)}`, 'o-val');
        outLine(`✓ 完成 · ${r.ms.toFixed(1)}ms`, 'o-ok');
        setSyn(null);
        ed.markError(0);
      } else {
        const { kind, message, line, col } = r.error;
        const pos = line ? `(行 ${line}${col != null ? `:${col}` : ''})` : '';
        outLine(`✗ ${kind}: ${message} ${pos}`.trim(), 'o-err', line ? { line, col } : null);
        if (line) ed.markError(line);
        if (kind === 'syntax') setSyn(r.error);   // 运行期错误不进状态栏
      }
      running = false;
      runBtn.disabled = false;
    }

    /** 「在终端运行」:保存后交给终端的 node 命令跑同一份脚本 */
    async function runInTerminal() {
      if (lang !== 'ajs') {
        bus.notify('无法运行', `当前语言是 ${LANG_LABELS[lang] || lang},只有 AetherJS 脚本可以在终端运行`);
        return;
      }
      if (!path || dirty) {
        if (dirty && path && !(await confirmBox(root, '保存后在终端运行?', `「${fs.basename(path)}」有未保存的修改,运行前需要先保存。`))) return;
        if (!(await save(false))) return;
      }
      open('terminal', { params: { startup: `node ${path}` } });
    }

    /** 「打包 EXE」:当前缓冲加密打包为可直接执行的 exe(随机密钥自动
     *  加密、混淆携带在文件内 —— cat 只见密文;终端 ./xxx.exe 免 node 直跑)。
     *  已保存的文件自动打包到同名 .exe,未保存的询问输出路径 */
    async function packToExe() {
      if (lang !== 'ajs') {
        bus.notify('无法打包', `当前语言是 ${LANG_LABELS[lang] || lang},只有 AetherJS 脚本可以打包为 exe`);
        return;
      }
      const src = ed.get();
      if (!src.trim()) { bus.notify('空脚本', '先写点代码再打包'); return; }
      let target = path ? path.replace(/\.[^.]+$/, '') + '.exe' : null;
      if (!target) {
        const def = `${fs.homePath() || '/home'}/documents/未命名.exe`;
        const p = await modal(document.body, {
          title: '打包为 EXE',
          input: { placeholder: def, value: def },
          body: '输入 exe 输出路径(源码加密打包,终端里 ./文件名 直接运行,无需 node)',
        });
        if (p == null) return;
        target = fs.normPath(p.trim() || '');
        if (!target || target === '/') return;
      }
      const content = await packExe(src);
      if (!fs.write(target, content)) {
        bus.notify('打包失败', `无写入权限或路径无效:${target}`);
        return;
      }
      bus.notify('已打包 EXE', `${target} —— 终端输入 ./${fs.basename(target)} 直接运行`);
    }

    /* ---------- 文件 ---------- */
    const nameEl = el('span', { class: 'dim', style: { fontSize: '12.5px', marginLeft: '8px' } });
    const statEl = el('span', {}, '');

    function refresh() {
      const name = path ? fs.basename(path) : '未命名';
      nameEl.textContent = path || '尚未保存到文件系统';
      setTitle(`${dirty ? '● ' : ''}${name} — 代码编辑器`);
      const code = ed.get();
      statEl.textContent = `${code.length} 字符 · ${code.split('\n').length} 行`;
      langSel.value = lang;
    }

    async function loadPath(p, askDiscard = true) {
      const c = fs.read(p);
      if (c == null) { bus.notify('无法打开', `文件不存在或无读权限:${p}`); return; }
      if (askDiscard && dirty
        && !(await confirmBox(root, '放弃未保存的更改?', `打开「${fs.basename(p)}」将丢弃当前未保存的修改。`))) return;
      path = p;
      langManual = false;
      setLang(langOf(fs.basename(p)));
      ed.set(c);
      dirty = false;
      setSyn(null);
      ed.markError(0);
      refresh();
    }

    async function openFile() {
      const def = `${fs.homePath() || '/home'}/documents/`;
      const p = await modal(document.body, {
        title: '打开文件',
        input: { placeholder: def, value: def },
        body: '输入文件路径(.ajs .js .css .html .json)',
      });
      if (p == null) return;
      const t = fs.normPath(p.trim() || '');
      if (t && t !== '/') loadPath(t);
    }

    async function newFile() {
      const def = `${fs.homePath() || '/home'}/documents/脚本.ajs`;
      const p = await modal(document.body, {
        title: '新建文件',
        input: { placeholder: def, value: def },
        body: '输入新文件路径(.ajs 脚本 / .css / .html / .json);文件不存在会创建',
      });
      if (p == null) return;
      const t = fs.normPath(p.trim() || '');
      if (!t || t === '/') return;
      if (fs.exists(t)) { loadPath(t); return; }
      if (!fs.write(t, '')) { bus.notify('创建失败', `无写入权限或路径无效:${t}`); return; }
      await loadPath(t);
    }

    async function save(as = false) {
      let target = path;
      if (as || !target) {
        const def = `${fs.homePath() || '/home'}/documents/未命名.ajs`;
        const p = await modal(document.body, {
          title: '保存文件',
          input: { placeholder: def, value: path || def },
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
      const extChanged = path !== target;
      path = target;
      dirty = false;
      if (extChanged && !langManual) setLang(langOf(fs.basename(target)));
      refresh();
      bus.notify('文件已保存', path);
      return true;
    }

    function setLang(l) {
      lang = l;
      ed.setLang(l);
      refresh();
      scheduleCheck();
    }

    const langSel = el('select', {
      class: 'select',
      title: '语言(按扩展名自动识别,可手动切换)',
      onChange: () => { langManual = true; setLang(langSel.value); },
    },
      ...Object.entries(LANG_LABELS).map(([v, label]) => el('option', { value: v }, label)));

    /* ---------- 输出面板拖拽调高 ---------- */
    const split = el('div', { class: 'ce-split', title: '拖拽调整输出面板高度' });
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = outPanel.getBoundingClientRect().height;
      const move = (ev) => {
        const h = Math.min(Math.max(startH + (startY - ev.clientY), 80), root.clientHeight * 0.7);
        outPanel.style.height = `${h}px`;
      };
      const up = () => {
        split.releasePointerCapture(e.pointerId);
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', up);
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up);
    });

    /* ---------- 快捷键 ---------- */
    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      } else if (e.key === 'F5' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        run();
      }
    }, true);

    /* ---------- 装配 ---------- */
    root.append(el('div', { class: 'app codeedit-app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn', onClick: newFile }, icon('filePlus', 13), '新建'),
        el('button', { class: 'btn', onClick: openFile }, icon('folder', 13), '打开'),
        el('button', { class: 'btn ce-save', onClick: () => save(false) }, icon('save', 13), '保存'),
        el('button', { class: 'btn', onClick: () => save(true) }, icon('external', 13), '另存为'),
        el('span', { style: { width: '6px' } }),
        runBtn,
        el('button', {
          class: 'btn ce-term-run', title: '保存后在终端的 node 命令中执行',
          onClick: runInTerminal,
        }, icon('terminal', 13), '在终端运行'),
        el('button', {
          class: 'btn ce-exe', title: '加密打包为可直接执行的 exe(随机密钥自动加密,终端 ./文件名 直跑)',
          onClick: packToExe,
        }, icon('lock', 13), '打包 EXE'),
        el('span', { class: 'grow' }),
        langSel,
        nameEl),
      ed.el,
      split,
      outPanel,
      el('div', { class: 'app-status' },
        caretEl,
        el('span', {}, ' · '),
        statEl,
        el('span', {}, ' · '),
        synEl,
        el('span', { class: 'grow' }),
        el('span', { class: 'dim' }, 'F5 运行 · Ctrl+S 保存 · Tab 缩进 · Ctrl+/ 注释'))));

    /* 打开已有文件(文件管家 / 桌面 / 终端 edit 推送) */
    if (path) {
      const content = fs.read(path);
      if (content == null) { bus.notify('文件不存在', path); path = null; }
      else ed.set(content);
    }
    refresh();
    setLang(path ? langOf(fs.basename(path)) : 'ajs');
    setTimeout(() => ed.focus(), 50);

    return {
      onClose() {
        clearTimeout(checkTimer);
        if (!dirty) return true;
        const done = (a) => {
          mask.remove();
          if (a === 'save') save(false).then((ok) => { if (ok) { dirty = false; bus.close(); } });
          else if (a === 'discard') { dirty = false; bus.close(); }
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
