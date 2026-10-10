/* ============================================================
 * cedit —— 自研代码编辑器组件(零依赖,js/lib 自包含,仅依赖同目录 chl.js)
 * ------------------------------------------------------------
 * 结构:透明 textarea 盖在高亮 <pre> 上(经典双层方案,完全自研):
 *   .cedit
 *   ├─ .cedit-gutter > .cedit-gutter-in   行号(含当前行/错误行标记)
 *   └─ .cedit-main
 *      ├─ .cedit-caretline                当前行底色(按行高定位)
 *      ├─ .cedit-hl                       高亮层(innerHTML = chl 产物)
 *      └─ .cedit-ta                       文本层(透明字/可见光标,承载滚动)
 *
 *  - 编辑/选区/输入法/撤销全部走原生 textarea(中文 IME 无损);
 *    高亮层只读展示,滚动时 scrollTop/transform 双向对齐;
 *  - 键盘增强:Tab/Shift+Tab 缩进(含块缩进)、Enter 自动缩进
 *    ({ 后加一级,与闭括号三行式)、括号引号自动补全/跳过/退格消对、
 *    Ctrl+/ 按语言注释(ajs 行注释,css/html 块注释);
 *    修改经 execCommand('insertText') 落盘,原生撤销栈不破。
 * ============================================================ */
import { highlight } from './chl.js';

const LH = 20;        // 行高(px,与 CSS 严格一致)
const PAD_TOP = 8;    // 顶部内边距(px,与 CSS 严格一致)
const INDENT = '  ';  // 缩进单位:两个空格(AetherJS 样例风格)
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };

const nl = (tag, cls, attrs, ...children) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const ch of children) if (ch != null) n.append(ch);
  return n;
};

/**
 * @param {{lang?:string, value?:string, placeholder?:string,
 *          onChange?:()=>void, onCaret?:(line:number,col:number)=>void}} opts
 */
export function createCodeEditor(opts = {}) {
  let lang = opts.lang || '';
  let errLine = 0;

  const ta = nl('textarea', 'cedit-ta', {
    wrap: 'off', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    autocorrect: 'off', 'aria-label': '代码编辑区',
  });
  ta.placeholder = opts.placeholder || '';
  const hl = nl('pre', 'cedit-hl');
  const hlCode = nl('code', '', {});
  hl.append(hlCode);
  const gutterIn = nl('div', 'cedit-gutter-in');
  const gutter = nl('div', 'cedit-gutter', {}, gutterIn);
  const caretLine = nl('div', 'cedit-caretline');
  const main = nl('div', 'cedit-main', {}, caretLine, hl, ta);
  const root = nl('div', 'cedit', {}, gutter, main);

  if (opts.value != null) ta.value = opts.value;

  /* ---------- 渲染:高亮层 + 行号 + 当前行 ---------- */

  let rafPending = false;
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const code = ta.value;
      // 末尾补一个换行:保证高亮层高度 ≥ 文本层(pre 的末行换行保守处理)
      hlCode.innerHTML = highlight(code, lang) + '\n';
      const lines = code.split('\n').length;
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= lines; i++) {
        const d = nl('div', '', {});
        d.textContent = String(i);
        if (i === errLine) d.classList.add('cedit-err-line');
        frag.append(d);
      }
      gutterIn.replaceChildren(frag);
      gutter.style.width = `${Math.max(3, String(lines).length + 2)}ch`;
      updateCaret();
      syncScroll();
    });
  }

  let curLine = 1;
  function updateCaret() {
    const idx = ta.selectionStart;
    const before = ta.value.slice(0, idx);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = idx - (before.lastIndexOf('\n') + 1) + 1;
    if (line !== curLine) {
      curLine = line;
      [...gutterIn.children].forEach((c, i) => c.classList.toggle('cedit-cur', i === line - 1));
    }
    caretLine.style.top = `${PAD_TOP + (line - 1) * LH - ta.scrollTop}px`;
    opts.onCaret?.(line, col);
  }

  function syncScroll() {
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
    gutterIn.style.transform = `translateY(${-ta.scrollTop}px)`;
    caretLine.style.top = `${PAD_TOP + (curLine - 1) * LH - ta.scrollTop}px`;
  }

  ta.addEventListener('scroll', syncScroll);

  /* ---------- 编辑辅助 ---------- */

  /** 经撤销栈插入文本(替换当前选区) */
  function insertText(text) {
    ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.setRangeText(text, s, e, 'end');
    }
  }

  function lineBounds(i) {
    const v = ta.value;
    const start = v.lastIndexOf('\n', i - 1) + 1;
    let end = v.indexOf('\n', i);
    if (end < 0) end = v.length;
    return { start, end };
  }

  /** 块缩进/反缩进:作用于选区覆盖的整行 */
  function indentBlock(back) {
    const v = ta.value;
    const s0 = lineBounds(ta.selectionStart).start;
    const e0 = lineBounds(ta.selectionEnd).end;
    const block = v.slice(s0, e0);
    const lines = block.split('\n');
    const next = lines.map((l) => back
      ? l.replace(/^(\t| {1,2})/, '')
      : INDENT + l);
    ta.setSelectionRange(s0, e0);
    insertText(next.join('\n'));
    ta.setSelectionRange(s0, s0 + next.join('\n').length);
  }

  function commentToggle() {
    const spec = lang === 'ajs' ? { line: '//' }
      : lang === 'css' ? { block: ['/* ', ' */'] }
        : lang === 'html' ? { block: ['<!-- ', ' -->'] } : null;
    if (!spec) return;
    const v = ta.value;
    const { start, end } = lineBounds(ta.selectionStart);
    if (spec.line) {
      // 行注释:选区覆盖的每一行,已注释则去掉
      const e0 = lineBounds(ta.selectionEnd).end;
      const lines = v.slice(start, e0).split('\n');
      const commented = lines.filter((l) => l.trim()).every((l) => l.trim().startsWith('//'));
      const next = lines.map((l) => (commented
        ? l.replace(/^(\s*)\/\/ ?/, '$1')
        : (l.trim() ? l.replace(/^(\s*)/, '$1// ') : l)));
      ta.setSelectionRange(start, e0);
      insertText(next.join('\n'));
      return;
    }
    const [open, close] = spec.block;
    if (ta.selectionStart !== ta.selectionEnd
      && v.slice(start, end).startsWith(open.trim()) && v.slice(start, end).endsWith(close.trim())) {
      const inner = v.slice(start + open.trim().length, end - close.trim().length);
      ta.setSelectionRange(start, end);
      insertText(inner);
    } else {
      const sel = v.slice(ta.selectionStart, ta.selectionEnd);
      insertText(`${open}${sel}${close}`);
      ta.setSelectionRange(ta.selectionStart - sel.length - close.length, ta.selectionStart - close.length);
    }
  }

  ta.addEventListener('keydown', (e) => {
    if (e.isComposing) return;                    // 输入法组合期间一律放行
    if (e.key === 'Tab') {
      e.preventDefault();
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel.includes('\n')) indentBlock(e.shiftKey);
      else if (e.shiftKey) indentBlock(true);     // 单行 Shift+Tab 也反缩进
      else insertText(INDENT);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); commentToggle(); return; }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const v = ta.value;
      const s = ta.selectionStart;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const before = v.slice(lineStart, s);
      const indent = (before.match(/^[ \t]*/) || [''])[0];
      const opens = /[{([]\s*$/.test(before);
      const nextCh = v[ta.selectionEnd] || '';
      if (opens && PAIRS[nextCh]) {
        // 三行式:{ 换行缩进一级,光标停中行,闭括号跟到第三行
        const mid = `${indent}${INDENT}`;
        insertText(`\n${mid}\n${indent}`);
        ta.setSelectionRange(s + 1 + mid.length, s + 1 + mid.length);
      } else {
        insertText(`\n${indent}${opens ? INDENT : ''}`);
      }
      return;
    }
    // 自动补全/包裹/跳过/退格消对(仅无修饰键)
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const closer = PAIRS[e.key];
    if (closer && s === en) {
      e.preventDefault();
      insertText(e.key + closer);
      ta.setSelectionRange(s + 1, s + 1);
      return;
    }
    if (closer && s !== en) {                     // 有选区:包裹
      e.preventDefault();
      const sel = v.slice(s, en);
      insertText(e.key + sel + closer);
      ta.setSelectionRange(s + 1, s + 1 + sel.length);
      return;
    }
    if (s === en && v[s] === e.key && Object.values(PAIRS).includes(e.key)) {
      e.preventDefault();                        // 跳过紧邻的闭括号/引号
      ta.setSelectionRange(s + 1, s + 1);
      return;
    }
    if (e.key === 'Backspace' && s === en && s > 0
      && PAIRS[v[s - 1]] === v[s]) {
      e.preventDefault();                        // 空对退格:一并删除
      ta.setSelectionRange(s - 1, s + 1);
      insertText('');
    }
  });

  ['input', 'keyup', 'click'].forEach((ev) => ta.addEventListener(ev, () => {
    if (ev === 'input') opts.onChange?.();
    render();
  }));
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === ta) updateCaret();
  });

  render();

  return {
    el: root,
    get lang() { return lang; },
    setLang(l) { lang = l; render(); },
    get: () => ta.value,
    set(v) {
      ta.value = v;
      ta.setSelectionRange(0, 0);   // 装载文件光标归零(赋 value 会落到末尾)
      render();
    },
    focus: () => ta.focus(),
    /** 1 基行列 → 设光标并滚动到可视区 */
    setPos(line, col = 1) {
      const lines = ta.value.split('\n');
      let idx = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) idx += lines[i].length + 1;
      idx += Math.min(Math.max(col - 1, 0), (lines[line - 1] || '').length);
      ta.focus();
      ta.setSelectionRange(idx, idx);
      ta.scrollTop = Math.max(0, (line - 1) * LH - ta.clientHeight / 2);
      syncScroll();
      updateCaret();
    },
    pos: () => {
      const before = ta.value.slice(0, ta.selectionStart);
      return {
        line: (before.match(/\n/g) || []).length + 1,
        col: before.length - before.lastIndexOf('\n'),
      };
    },
    /** 错误行标记(0 清除):行号标红 */
    markError(line) { errLine = line || 0; render(); },
  };
}
