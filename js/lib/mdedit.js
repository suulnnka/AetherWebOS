/* ============================================================
 * mdedit.js —— 自研所见即所得 Markdown 编辑组件(Typora 式)
 *
 * 模型:md 源字符串是唯一事实;文档 = 顶层块序列(js/lib/md.js 的
 * parse() 给出每块的源码行区间 s/e)的 DOM 投影。任意时刻只有一个
 * "活动块":显示该块的 markdown 原文(contenteditable 壳),其余块
 * 全部渲染为富文本;光标移走(点击别的块 / 拆块)后活动块"落定"
 * 为渲染态 —— Typora-lite:活动块内语法标记不隐藏,但整篇文档即写
 * 即现。输入时只重解析受影响行,块边界稳定则 DOM 完全不动,光标
 * 天然保留;边界变化(段落敲成标题等)才整体重建并按行号重新锚定
 * 活动块。
 *
 * 结构键:Enter 拆块/列表续项/引用续行,Backspace/Delete 首尾并块,
 * ↑↓ 跨块(保持列),Tab/Shift+Tab 缩进(列表内=层级,配合重解析
 * 天然换父),Ctrl+B/I/K 行内标记,Ctrl+Z/Y 自研 undo(native undo
 * 在 DOM 重建后不可靠)。中文输入法:composition 期间不重建 DOM。
 *
 * API:
 *   createMdEditor({ value, placeholder, toolbar, compact, onInput })
 *     → { el, get(), set(text), focus(), preview(on), undo(), redo(), exec(cmd) }
 *   同时挂在 el.$md 上,宿主应用与 e2e 可直接取用。
 *
 * 依赖:仅 js/lib/md.js 与同目录 mdedit.css(不 import core,保持
 * 自研库自包含,与 minimap 同约定)。
 * ============================================================ */
import { parse, blockHtml } from './md.js';
import './mdedit.css';

/* ---------- 轻量 DOM 助手(避免依赖 core/utils) ---------- */

function h(tag, cls, ...children) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const c of children) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}

/* contenteditable="plaintext-only" 支持探测(Chrome/新 Firefox 支持,
 * 旧浏览器回退 contenteditable=true 并在每次输入后做结构归一化) */
let PLAIN_OK = null;
function plainOk() {
  if (PLAIN_OK == null) {
    const d = document.createElement('div');
    try { d.contentEditable = 'plaintext-only'; PLAIN_OK = d.contentEditable === 'plaintext-only'; }
    catch { PLAIN_OK = false; }
  }
  return PLAIN_OK;
}

/** contenteditable 内容 → 纯文本(br / 块级元素按换行计) */
function getText(el) {
  if (el.childNodes.length === 0) return '';
  if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) return el.childNodes[0].data;
  let out = '';
  const walk = (n) => {
    if (n.nodeType === 3) out += n.data;
    else if (n.nodeName === 'BR') out += '\n';
    else {
      if (/^(DIV|P|LI)$/.test(n.nodeName) && out && !out.endsWith('\n')) out += '\n';
      n.childNodes.forEach(walk);
    }
  };
  el.childNodes.forEach(walk);
  return out;
}

const setText = (el, text) => { el.textContent = text; };

/** 光标(或任意 range 端点)在壳文本中的字符偏移。
 *  端点可能落在文本节点(偏移=字符数)或元素节点(偏移=子节点下标,
 *  全选即此),后者需换算成前 pos 个子节点的文本总长 */
function offsetOf(el, container, pos) {
  const textLen = (n) => {
    if (n.nodeType === 3) return n.data.length;
    if (n.nodeName === 'BR') return 1;
    let s = 0;
    for (const c of n.childNodes) s += textLen(c);
    return s;
  };
  let off = 0, hit = false;
  const walk = (n) => {
    if (hit) return;
    if (n === container) {
      hit = true;
      if (n.nodeType === 3) off += pos;
      else for (let i = 0; i < pos && i < n.childNodes.length; i++) off += textLen(n.childNodes[i]);
      return;
    }
    if (n.nodeType === 3) { off += n.data.length; return; }
    if (n.nodeName === 'BR') { off += 1; return; }
    n.childNodes.forEach(walk);
  };
  walk(el);
  return hit ? off : null;
}

function caretOffset(el) {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  return offsetOf(el, r.startContainer, r.startOffset);
}

/** 选区 [起, 止](折叠时二者相等);不在壳内返回 null */
function selectionRange(el) {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const a = offsetOf(el, r.startContainer, r.startOffset);
  const z = offsetOf(el, r.endContainer, r.endOffset);
  if (a == null || z == null) return null;
  return [Math.min(a, z), Math.max(a, z)];
}

function setCaret(el, off) {
  el.focus();
  const sel = document.getSelection();
  const r = document.createRange();
  let node = null, pos = 0;
  const walk = (n) => {
    if (n.nodeType === 3) {
      if (off <= n.data.length) { node = n; pos = off; return true; }
      off -= n.data.length;
      return false;
    }
    for (const c of n.childNodes) if (walk(c)) return true;
    return false;
  };
  walk(el);
  if (node == null) { node = el; pos = el.childNodes.length; }
  r.setStart(node, pos);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 选中 [a, z) 文本(工具栏插入占位符后便于直接键入替换) */
function setSel(el, a, z) {
  el.focus();
  const sel = document.getSelection();
  const r = document.createRange();
  const find = (off) => {
    let node = null, pos = 0;
    const walk = (n) => {
      if (node) return;
      if (n.nodeType === 3) {
        if (off <= n.data.length) { node = n; pos = off; return; }
        off -= n.data.length;
      } else for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return node ? [node, pos] : [el, el.childNodes.length];
  };
  const [sn, sp] = find(a);
  const [en, ep] = find(z);
  r.setStart(sn, sp);
  r.setEnd(en, ep);
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------- 工具栏定义 ---------- */

const BTNS = [
  ['bold', 'B', '粗体 **(Ctrl+B)'],
  ['italic', 'I', '斜体 *(Ctrl+I)'],
  ['strike', 'S', '删除线 ~~'],
  ['code', '‹›', '行内代码 `'],
  ['h1', 'H1', '一级标题'],
  ['h2', 'H2', '二级标题'],
  ['h3', 'H3', '三级标题'],
  ['sep'],
  ['ul', '•', '无序列表'],
  ['ol', '1.', '有序列表'],
  ['task', '☑', '任务列表'],
  ['quote', '❝', '引用'],
  ['sep'],
  ['link', '🔗', '链接(Ctrl+K)'],
  ['image', '🖼', '图片'],
  ['table', '⊞', '表格'],
  ['codeblock', '{ }', '代码块'],
  ['hr', '―', '分隔线'],
];

/* ---------- 组件 ---------- */

export function createMdEditor(opts = {}) {
  const { placeholder = '', toolbar = true, compact = false, onInput = null } = opts;
  let src = String(opts.value ?? '').replace(/\r\n?/g, '\n');
  let doc = parse(src);
  let active = 0;             // 活动块下标(与 surface 子节点一一对应)
  let rawEl = null;           // 活动壳(任意时刻至多一个)
  let previewing = false;
  let composing = false;      // IME 组合输入中:不重建 DOM
  let pendingRebuild = null;
  let undoS = [], redoS = [];
  let undoT = 0;
  let nlPendingAt = -1;       // 代码/表格块行尾回车:先记位置,下一个字符到达时
                              // 物化换行(行尾换行后的光标会被浏览器归一化,直接插必丢)
  let ephLine = -1;           // 临时空段所在行:markdown 空行解析不出块,新块先用
                              // 零行占位(s===e),键入时 splice(s,0,…) 自然落进源码

  const surface = h('div', 'md-surface');
  if (placeholder) surface.setAttribute('data-ph', placeholder);
  const root = h('div', 'md-edit' + (compact ? ' compact' : '') + (toolbar ? '' : ' no-bar'));
  if (toolbar) root.append(makeToolbar());
  root.append(surface);

  /* ---------- 基础 ---------- */

  /** 块列表:解析结果 + 空文档的虚拟段 + 临时空段(回车新块/空列表退出) */
  function blocks() {
    if (doc.blocks.length === 0 && ephLine < 0) {
      return [{ type: 'para', text: '', s: Math.max(0, doc.lines.length - 1), e: doc.lines.length }];
    }
    const bs = [...doc.blocks];
    if (ephLine >= 0) {
      let at = bs.findIndex((b) => b.s >= ephLine);
      if (at < 0) at = bs.length;
      bs.splice(at, 0, { type: 'para', s: ephLine, e: ephLine, eph: true });
    }
    return bs;
  }
  const blockText = (b) => doc.lines.slice(b.s, b.e).join('\n');

  function reparse() { doc = parse(src); }

  /** 绝对行号 → 块下标(落在块间空行时取后一块/末块;临时空段按行命中) */
  function blockAt(line) {
    const bs = blocks();
    for (let i = 0; i < bs.length; i++) {
      if (bs[i].eph) { if (line <= bs[i].s) return i; continue; }
      if (line < bs[i].e) return i;
    }
    return bs.length - 1;
  }

  function rejoin() { src = doc.lines.join('\n'); }

  function refreshEmpty() { root.classList.toggle('empty', !src.trim()); }

  function fireInput() {
    refreshEmpty();
    if (onInput) onInput(src);
    root.dispatchEvent(new CustomEvent('mdinput', { bubbles: true, detail: src }));
  }

  /* ---------- undo(native undo 在 DOM 重建后不可靠) ---------- */

  function snapshot() {
    return { src, line: blocks()[active]?.s ?? 0, off: rawEl ? (caretOffset(rawEl) ?? 0) : 0 };
  }
  function commit() {
    const snap = snapshot();
    if (!undoS.length || undoS[undoS.length - 1].src !== snap.src) {
      undoS.push(snap);
      if (undoS.length > 200) undoS.shift();
      redoS = [];
    }
  }
  function scheduleUndo() {
    clearTimeout(undoT);
    undoT = setTimeout(commit, 450);                       // 连续输入合并为一个撤销点
  }
  function applySnap(snap) {
    src = snap.src;
    ephLine = -1;
    reparse();
    const idx = blockAt(Math.min(snap.line, Math.max(0, doc.lines.length - 1)));
    renderAll(idx);
    setCaret(rawEl, snap.off);
  }
  function undo() {
    const cur = snapshot();
    while (undoS.length && undoS[undoS.length - 1].src === cur.src) undoS.pop();
    if (!undoS.length) return;
    redoS.push(cur);
    applySnap(undoS.pop());
    fireInput();
  }
  function redo() {
    const cur = snapshot();
    while (redoS.length && redoS[redoS.length - 1].src === cur.src) redoS.pop();
    if (!redoS.length) return;
    undoS.push(cur);
    applySnap(redoS.pop());
    fireInput();
  }

  /* ---------- 渲染 ---------- */

  function renderAll(activeIdx) {
    const keep = surface.scrollTop;
    surface.innerHTML = '';
    const bs = blocks();
    bs.forEach((b, i) => {
      const node = h('div', 'md-block' + (i === activeIdx ? ' active' : ''));
      node.dataset.i = i;
      if (i === activeIdx) node.append(makeRaw(b));
      else node.innerHTML = blockHtml(b, doc.defs);
      surface.append(node);
    });
    surface.scrollTop = keep;
    active = activeIdx;
  }

  function makeRaw(b) {
    rawEl = h('div', 'md-raw');
    rawEl.setAttribute('contenteditable', plainOk() ? 'plaintext-only' : 'true');
    rawEl.setAttribute('spellcheck', 'false');
    setText(rawEl, blockText(b));
    wireRaw(rawEl);
    return rawEl;
  }

  /** 激活块 i(落定原活动块),off 为壳内光标偏移(缺省末尾) */
  function activate(i, off) {
    if (previewing) return;
    const bs0 = blocks();
    if (bs0[active]?.eph && i !== active) ephLine = -1;      // 离开空临时段:回收
    const bs = blocks();
    i = Math.max(0, Math.min(i, bs.length - 1));
    if (rawEl && i !== active) {
      const cur = surface.children[active];
      const nv = h('div', 'md-block');
      nv.dataset.i = active;
      nv.innerHTML = blockHtml(bs[active], doc.defs);
      cur.replaceWith(nv);
    }
    active = i;
    const node = surface.children[i];
    node.classList.add('active');
    node.innerHTML = '';
    node.append(makeRaw(bs[i]));
    const t = blockText(bs[i]);
    requestAnimationFrame(() => { if (rawEl) setCaret(rawEl, off == null ? t.length : Math.min(off, t.length)); });
  }

  /** 预览模式:活动块也落定(只读浏览) */
  function deactivate() {
    if (!rawEl) return;
    if (blocks()[active]?.eph) ephLine = -1;
    const node = surface.children[active];
    node.classList.remove('active');
    const nv = h('div', 'md-block');
    nv.dataset.i = active;
    nv.innerHTML = blockHtml(blocks()[active], doc.defs);
    node.replaceWith(nv);
    rawEl = null;
  }

  /* ---------- 输入同步 ---------- */

  /** 把活动壳新文本写回源串并重解析;边界变化则重建(IME 中挂起) */
  function syncPipeline(text, caret) {
    const b = blocks()[active];
    const wasEph = !!b.eph;
    const nl = text.split('\n');
    if (wasEph && !nl.some((l) => l.trim())) {
      /* 临时空段仍为空:源码不动 */
    } else {
      doc.lines.splice(b.s, b.e - b.s, ...nl);               // eph 时 e-s=0,即插入
      if (wasEph) ephLine = -1;                              // 已落源码,转为真实块
    }
    rejoin();
    reparse();
    const line = b.s + text.slice(0, caret).split('\n').length - 1;   // 光标绝对行
    const idx = blockAt(line);
    const nb = blocks()[idx];
    if (idx === active && nb && nb.s === b.s && nb.e === b.s + nl.length) {
      /* 块边界稳定:DOM 不动(其余块内容未变,仅行号平移) */
    } else if (composing) {
      pendingRebuild = { idx, off: caret };
    } else {
      rebuildActiveAt(idx, caret);
    }
  }

  function rebuildActiveAt(idx, off) {
    renderAll(idx);
    const t = rawEl ? getText(rawEl) : '';
    requestAnimationFrame(() => { if (rawEl) setCaret(rawEl, Math.min(off ?? t.length, t.length)); });
  }

  function onRawInput() {
    normalizeShell();
    let text = getText(rawEl);
    let caret = caretOffset(rawEl) ?? text.length;
    /* 行尾换行物化:回车只记了位置,字符到达时把 \n 插到它前面 */
    if (nlPendingAt >= 0) {
      if (text.length > nlPendingAt && text[nlPendingAt] !== '\n') {
        const nt = text.slice(0, nlPendingAt) + '\n' + text.slice(nlPendingAt);
        let co = caret > nlPendingAt ? caret + 1 : caret;
        setText(rawEl, nt);
        setCaret(rawEl, co);
        text = nt;
        caret = co;
      }
      nlPendingAt = -1;
    }
    syncPipeline(text, caret);
    scheduleUndo();
    fireInput();
  }

  /** 旧浏览器回退:contenteditable=true 产生的 br/div 归一化为纯文本 */
  function normalizeShell() {
    if (!rawEl || !rawEl.querySelector('br,div,p')) return;
    const off = caretOffset(rawEl);
    const text = getText(rawEl);
    setText(rawEl, text);
    setCaret(rawEl, Math.min(off ?? text.length, text.length));
  }

  /** 在光标处插入文本(保持 undo 合并),光标落在插入文本末尾。
   *  插入尾随换行后,浏览器可能把光标归一化回换行前 —— rAF 再锚定一次 */
  function insertRaw(str) {
    const text = getText(rawEl);
    const off = caretOffset(rawEl) ?? text.length;
    const nt = text.slice(0, off) + str + text.slice(off);
    setText(rawEl, nt);
    setCaret(rawEl, off + str.length);
    requestAnimationFrame(() => rawEl && setCaret(rawEl, off + str.length));
    syncPipeline(nt, off + str.length);
    scheduleUndo();
    fireInput();
  }

  /* ---------- 结构键 ---------- */

  function handleEnter(shift, text, off) {
    /* 有选区:先按回车的原生语义删掉选中文本再分块 */
    const sr = selectionRange(rawEl);
    if (sr && sr[0] !== sr[1]) {
      text = text.slice(0, sr[0]) + text.slice(sr[1]);
      setText(rawEl, text);
      setCaret(rawEl, sr[0]);
      off = sr[0];
    }
    if (shift) {                                             // 硬换行
      const lineEnd = text.indexOf('\n', off);
      const at = lineEnd < 0 ? text.length : lineEnd;
      const nt = text.slice(0, at) + '  \n' + text.slice(at);
      setText(rawEl, nt);
      setCaret(rawEl, at + 3);
      syncPipeline(nt, at + 3);
      fireInput();
      return;
    }
    const b = blocks()[active];
    if (b.eph) return;                                       // 空临时段上回车:无操作(空段至多一个)
    if (b.type === 'quote') {
      /* 空引用行回车:退出引用(删掉空 > 行,引用后接临时空段) */
      const ls = text.split('\n');
      const lineNo = text.slice(0, off).split('\n').length - 1;
      if (!ls[lineNo].replace(/^\s*>\s?/, '').trim()) {
        const at = b.s + lineNo;
        doc.lines.splice(at, 1, '');
        rejoin(); reparse();
        ephLine = at + 1;
        renderAll(blockAt(at + 1));
        requestAnimationFrame(() => rawEl && setCaret(rawEl, 0));
        fireInput();
        return;
      }
      insertRaw('\n> ');
      return;
    }
    if (b.type === 'list') { listEnter(b, text, off); return; }
    /* 段落 / 标题 / 分割线:块拆分(前半落定,后半成为新块;
     * 后半为空时用临时空段占位 —— markdown 空行解析不出块) */
    const bl = text.slice(0, off).split('\n');
    const al = text.slice(off).split('\n');
    if (al[0] === '') al.shift();
    doc.lines.splice(b.s, b.e - b.s, ...[...bl, '', ...al]);
    rejoin(); reparse();
    if (!al.length) ephLine = b.s + bl.length + 1;
    renderAll(blockAt(b.s + bl.length + 1));
    requestAnimationFrame(() => rawEl && setCaret(rawEl, 0));
    fireInput();
  }

  /** 列表内回车:空条目行 → 退出列表;否则续条目(有序自增 / 任务重置) */
  function listEnter(b, text, off) {
    const ls = text.split('\n');
    const lineNo = text.slice(0, off).split('\n').length - 1;
    const line = ls[lineNo];
    if (/^\s*([-*+]|\d{1,9}[.)])\s*(\[[ xX]\]\s*)?$/.test(line)) {
      const at = b.s + lineNo;
      doc.lines.splice(at, 1, '');                           // 删空条目 → 列表后新段
      rejoin(); reparse();
      ephLine = at + 1;
      renderAll(blockAt(at + 1));
      requestAnimationFrame(() => rawEl && setCaret(rawEl, 0));
      fireInput();
      return;
    }
    const pm = line.match(/^(\s*)([-*+]|(\d{1,9})[.)])(\s+)(\[[ xX]\]\s+)?/);
    if (!pm) { insertRaw('\n'); return; }
    let prefix = pm[1] + pm[2] + pm[4];
    if (pm[3] != null) prefix = pm[1] + (parseInt(pm[3], 10) + 1) + pm[2].slice(pm[3].length) + pm[4];
    if (pm[5]) prefix += '[ ] ';
    insertRaw('\n' + prefix);
  }

  /** 首尾退格:并入前/后块(丢块间空行,合并结果由重解析决定) */
  function handleMerge(dir) {
    const bs = blocks();
    const b = bs[active];
    /* 临时空段:直接回收(向前退格=删除它回到上一块;向后=吞掉它) */
    if (dir < 0 && b?.eph) {
      ephLine = -1;
      const prev = active - 1;
      if (prev >= 0) {
        const pt = blockText(blocks()[prev]);
        renderAll(prev);
        requestAnimationFrame(() => rawEl && setCaret(rawEl, pt.length));
      } else renderAll(0);
      fireInput();
      return;
    }
    if (dir > 0 && bs[active + 1]?.eph) {
      ephLine = -1;
      const t = getText(rawEl || {});
      renderAll(active);
      requestAnimationFrame(() => rawEl && setCaret(rawEl, t.length));
      fireInput();
      return;
    }
    if (dir < 0 && active === 0) {
      if (b.type === 'heading') {                           // 首块行首退格:标题降级为段落
        doc.lines[b.s] = doc.lines[b.s].replace(/^ {0,3}#{1,6}\s+/, '');
        rejoin(); reparse();
        renderAll(blockAt(b.s));
        requestAnimationFrame(() => rawEl && setCaret(rawEl, 0));
        fireInput();
      }
      return;
    }
    const other = dir < 0 ? bs[active - 1] : bs[active + 1];
    if (!other) return;
    const first = dir < 0 ? other : b;
    const second = dir < 0 ? b : other;
    const ft = doc.lines.slice(first.s, first.e);
    const st = doc.lines.slice(second.s, second.e);
    const caret = ft.join('\n').length;
    doc.lines.splice(first.s, second.e - first.s, ...ft, ...st);
    rejoin(); reparse();
    renderAll(blockAt(first.s));
    requestAnimationFrame(() => rawEl && setCaret(rawEl, caret));
    fireInput();
  }

  /** Tab:列表内按行 ±2 空格(重解析天然改变层级);普通块插入两空格 */
  function handleTab(shift, text, off) {
    const b = blocks()[active];
    if (b.type !== 'list') { if (!shift) insertRaw('  '); return; }
    const sr = selectionRange(rawEl) || [off, off];
    const la = text.slice(0, sr[0]).split('\n').length - 1;
    const lb = text.slice(0, sr[1]).split('\n').length - 1;
    const caretLine = text.slice(0, off).split('\n').length - 1;
    const ls = text.split('\n');
    let delta = 0;
    for (let k = la; k <= lb; k++) {
      if (shift) {
        const cut = Math.min(2, ls[k].match(/^ */)[0].length);
        ls[k] = ls[k].slice(cut);
        if (k === caretLine) delta = -cut;
      } else {
        ls[k] = '  ' + ls[k];
        if (k === caretLine) delta = 2;
      }
    }
    const nt = ls.join('\n');
    setText(rawEl, nt);
    const no = Math.max(0, off + delta);
    setCaret(rawEl, no);
    syncPipeline(nt, no);
    scheduleUndo();
    fireInput();
  }

  /** ↑↓ 在壳首/末行时跨块移动(保持列) */
  function handleArrow(key, text, off, e) {
    const before = text.slice(0, off);
    const lineNo = before.split('\n').length - 1;
    const col = off - (before.lastIndexOf('\n') + 1);
    const last = text.split('\n').length - 1;
    const bs = blocks();
    if (key === 'ArrowUp' && lineNo === 0 && active > 0) {
      e.preventDefault();
      const pt = blockText(bs[active - 1]);
      const pl = pt.split('\n');
      const lastLen = pl[pl.length - 1].length;
      activate(active - 1, pt.length - lastLen + Math.min(col, lastLen));
    } else if (key === 'ArrowDown' && lineNo === last && active < bs.length - 1) {
      e.preventDefault();
      const nt = blockText(bs[active + 1]);
      const firstLen = nt.split('\n')[0].length;
      activate(active + 1, Math.min(col, firstLen));
    }
  }

  /* ---------- 工具栏命令(也供宿主 exec 调用) ---------- */

  function exec(cmd) {
    if (previewing || !rawEl) return;
    rawEl.focus();
    const b = blocks()[active];
    const text = getText(rawEl);
    const sr = selectionRange(rawEl) || [caretOffset(rawEl) ?? text.length, caretOffset(rawEl) ?? text.length];
    const [a, z] = sr;

    const apply = (nt, caret) => {
      setText(rawEl, nt);
      setCaret(rawEl, caret);
      syncPipeline(nt, caret);
      scheduleUndo();
      fireInput();
    };
    const wrap = (l, r, ph) => {
      const sel = z > a;
      const inner = sel ? text.slice(a, z) : ph;
      const nt = text.slice(0, a) + l + inner + r + text.slice(z);
      setText(rawEl, nt);
      setSel(rawEl, a + l.length, a + l.length + inner.length);   // 选中内容/占位符,键入即替换
      syncPipeline(nt, a + l.length + inner.length);
      scheduleUndo();
      fireInput();
    };

    switch (cmd) {
      case 'bold': wrap('**', '**', '加粗'); break;
      case 'italic': wrap('*', '*', '斜体'); break;
      case 'strike': wrap('~~', '~~', '删除线'); break;
      case 'code': wrap('`', '`', '代码'); break;
      case 'link': wrap('[', '](https://example.com)', '链接文字'); break;
      case 'image': wrap('![', '](https://example.com)', '替代文字'); break;
      case 'h1': case 'h2': case 'h3': {
        const lv = +cmd[1];
        const cur = doc.lines[b.s].match(/^ {0,3}(#{1,6})\s+/);
        doc.lines[b.s] = doc.lines[b.s].replace(/^ {0,3}#{1,6}\s+/, '');
        if (!cur || cur[1].length !== lv) doc.lines[b.s] = '#'.repeat(lv) + ' ' + doc.lines[b.s];
        rejoin(); reparse();
        renderAll(blockAt(b.s));
        requestAnimationFrame(() => rawEl && setCaret(rawEl, doc.lines[blockAt(b.s)].length));
        fireInput();
        break;
      }
      case 'quote': case 'ul': case 'ol': case 'task': {
        const ls = text.split('\n');
        const la = text.slice(0, a).split('\n').length - 1;
        const lb = text.slice(0, z).split('\n').length - 1;
        const old = [...ls];
        let n = cmd === 'ol' ? 1 : 0;
        for (let k = la; k <= lb; k++) {
          ls[k] = ls[k].replace(/^\s*(>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/, '');   // 先剥旧标记
          if (cmd === 'quote') ls[k] = '> ' + ls[k];
          else if (cmd === 'ul') ls[k] = '- ' + ls[k];
          else if (cmd === 'task') ls[k] = '- [ ] ' + ls[k];
          else ls[k] = (n++) + '. ' + ls[k];
        }
        const lineStart = ls.slice(0, la).join('\n').length + (la ? 1 : 0);
        const inLine = a - old.slice(0, la).join('\n').length - (la ? 1 : 0);
        apply(ls.join('\n'), Math.max(0, lineStart + Math.min(inLine, ls[la].length)));
        break;
      }
      case 'codeblock': insertBlockAfter(['```', '', '```'], 1); break;
      case 'table': insertBlockAfter(['| 列一 | 列二 |', '| --- | --- |', '| 内容 | 内容 |'], 1); break;
      case 'hr': {
        const bb = blocks()[active];
        doc.lines.splice(bb.e, 0, '', '---', '');
        rejoin(); reparse();
        ephLine = bb.e + 3;                                  // 分隔线后接临时空段
        renderAll(blockAt(ephLine));
        requestAnimationFrame(() => rawEl && setCaret(rawEl, 0));
        fireInput();
        break;
      }
    }
  }

  /** 在当前块后插入独立块并激活(off 为新块内光标行) */
  function insertBlockAfter(lines, line) {
    const b = blocks()[active];
    doc.lines.splice(b.e, 0, '', ...lines);
    rejoin(); reparse();
    const at = b.e + 1 + line;
    renderAll(blockAt(at));
    requestAnimationFrame(() => {
      if (!rawEl) return;
      const t = getText(rawEl);
      setCaret(rawEl, t.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0));
    });
    fireInput();
  }

  function makeToolbar() {
    const bar = h('div', 'md-toolbar');
    for (const item of BTNS) {
      if (item[0] === 'sep') { bar.append(h('span', 'md-tsep')); continue; }
      const [cmd, label, tip] = item;
      const btn = h('button', 'md-tbtn', label);
      btn.type = 'button';
      btn.title = tip;
      btn.addEventListener('pointerdown', (e) => e.preventDefault());   // 不抢活动壳焦点
      btn.addEventListener('click', () => exec(cmd));
      bar.append(btn);
    }
    return bar;
  }

  /* ---------- 任务勾选 / 点击定位 ---------- */

  /** 深度优先收集列表条目(DOM 中 li 顺序与之一致) */
  function collectItems(b, out) {
    if (b.type === 'list') {
      for (const it of b.items) { out.push(it); it.blocks.forEach((x) => collectItems(x, out)); }
    } else if (b.type === 'quote') b.blocks.forEach((x) => collectItems(x, out));
  }

  function toggleTask(checkEl) {
    const blockEl = checkEl.closest('.md-block');
    if (!blockEl) return;
    const i = +blockEl.dataset.i;
    const items = [];
    collectItems(blocks()[i], items);
    const lis = [...blockEl.querySelectorAll('li')];
    const idx = lis.indexOf(checkEl.closest('li'));
    const it = items[idx];
    if (!it) return;
    commit();
    const keep = rawEl ? caretOffset(rawEl) : null;
    doc.lines[it.s] = doc.lines[it.s].replace(/\[([ xX])\]/, (m, c) => (c === ' ' ? '[x]' : '[ ]'));
    rejoin(); reparse();
    renderAll(active);
    if (rawEl) setCaret(rawEl, keep ?? getText(rawEl).length);
    fireInput();
  }

  /** 点击渲染块 → 激活,光标按几何比例近似定位到源文本 */
  function locateOffset(blockEl, raw, e) {
    const rect = blockEl.getBoundingClientRect();
    if (rect.height < 4) return 0;
    const f = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return Math.round(f * raw.length);
  }

  surface.addEventListener('pointerdown', (e) => {
    if (previewing) return;                                 // 预览态只读
    const check = e.target.closest('.md-check');
    if (check) { e.preventDefault(); toggleTask(check); return; }
    const blk = e.target.closest('.md-block');
    if (!blk || blk.classList.contains('active')) return;   // 活动块内:原生光标
    e.preventDefault();
    const i = +blk.dataset.i;
    activate(i, locateOffset(blk, blockText(blocks()[i]), e));
  });

  /* ---------- 活动壳事件 ---------- */

  function wireRaw(el) {
    el.addEventListener('input', onRawInput);
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => {
      composing = false;
      if (pendingRebuild) {
        const p = pendingRebuild;
        pendingRebuild = null;
        rebuildActiveAt(p.idx, p.off);
      }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (t) document.execCommand('insertText', false, t.replace(/\r\n?/g, '\n'));
    });
    el.addEventListener('keydown', (e) => {
      if (composing) return;                                // IME 选词回车不接管
      const text = getText(el);
      const off = caretOffset(el) ?? 0;
      const sr = selectionRange(el);
      const collapsed = !!sr && sr[0] === sr[1];
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'b') { e.preventDefault(); commit(); exec('bold'); return; }
      if (mod && k === 'i') { e.preventDefault(); commit(); exec('italic'); return; }
      if (mod && k === 'k') { e.preventDefault(); commit(); exec('link'); return; }
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.key === 'Enter') {
        /* 代码/表格/定义块:行尾回车记延迟换行(光标稳定),行中则直接插 */
        const bt = blocks()[active]?.type;
        if (bt === 'code' || bt === 'table' || bt === 'def') {
          e.preventDefault();
          commit();
          const sr2 = selectionRange(el);
          if (off >= text.length && (!sr2 || sr2[0] === sr2[1])) {
            if (nlPendingAt < 0) nlPendingAt = text.length;  // 已挂起则不叠加
          } else insertRaw('\n');
          return;
        }
        e.preventDefault();
        commit();
        handleEnter(e.shiftKey, text, off);
        return;
      }
      if (e.key.length > 1) nlPendingAt = -1;                // 方向/退格等:待物化换行作废
      if (e.key === 'Backspace' && collapsed && sr[0] === 0) {
        e.preventDefault(); commit(); handleMerge(-1); return;
      }
      if (e.key === 'Delete' && collapsed && sr[0] === text.length) {
        e.preventDefault(); commit(); handleMerge(1); return;
      }
      if (e.key === 'Tab') { e.preventDefault(); commit(); handleTab(e.shiftKey, text, off); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { handleArrow(e.key, text, off, e); return; }
    });
  }

  /* ---------- 对外 ---------- */

  const api = {
    el: root,
    get: () => src,
    /** 整体替换(打开文件 / 切换日记日期):重置 undo 栈 */
    set(text) {
      src = String(text ?? '').replace(/\r\n?/g, '\n');
      ephLine = -1;
      reparse();
      undoS = []; redoS = []; pendingRebuild = null;
      renderAll(0);
      refreshEmpty();
    },
    focus() {
      if (previewing) return;
      if (rawEl) rawEl.focus();
      else activate(active, null);
    },
    /** 只读预览(全部落定为渲染态) */
    preview(on) {
      previewing = !!on;
      root.classList.toggle('preview', previewing);
      if (previewing) deactivate();
      else activate(active, null);
    },
    undo, redo, exec,
    destroy() { clearTimeout(undoT); },
  };
  root.$md = api;

  renderAll(0);
  refreshEmpty();
  return api;
}
