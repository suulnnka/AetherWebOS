/* ============================================================
 * mdedit.js —— 自研所见即所得 Markdown 编辑组件(Notion/Typora 式)
 *
 * 模型:md 源字符串是唯一事实;编辑面是整篇渲染结果(单个
 * contenteditable,.md-surface > .md-block[])。没有"源码态/渲染态"
 * 切换:点击即原生精确定位光标,跨块选区、富文本续打全部原生。
 * 输入 → domToSrc() 把 DOM 反序列化回 markdown → 重解析;仅当光标
 * 所在块的解析签名变化(段落敲成标题、**合拢**成粗体等)才局部重渲
 * 染该块(rAF 离场做,避免 Chrome 输入期换 DOM 导致插入点错位),
 * 光标经"源偏移 ↔ DOM 位置"映射无损还原。光标离开块时落定渲染。
 *
 * 结构键:Enter 拆块(列表续项/引用续行/``` 开代码块、--- 分隔线),
 * Backspace 块首并块或降级(标题→段落),Tab/Shift+Tab 列表层级,
 * Ctrl+B/I/K 行内标记,Ctrl+Z/Y 自研 undo(native undo 在 DOM 重建后
 * 不可靠)。中文输入法:composition 期间只同步源码不重渲染。
 *
 * Milkdown 式增强:行内输入规则(**x** 等闭合组合敲成即渲染)、
 * 斜杠命令菜单(输入 / 唤起,方向键+回车,应用时剥除 /query)、
 * 选区浮动工具栏(B/I/S/行内码/链接,Crepe 同款)。样式内续打
 * 保持样式(Notion/ProseMirror stored-marks 同款行为)。
 *
 * API:
 *   createMdEditor({ value, placeholder, compact, onInput })
 *     → { el, get(), set(text), focus(), preview(on), undo(), redo(), exec(cmd) }
 *   同时挂在 el.$md 上,宿主应用与 e2e 可直接取用。
 *   preview(true) 为只读态:宿主应用以此为默认浏览态,由应用层的
 *   「编辑」按钮解锁进入编辑(无独立预览页)。
 *
 * 已知取舍(编辑会规整化源码):Setext 标题→ATX、引用式链接→行内式、
 * 链接定义(def 块)以原文形式展示编辑、字面 markdown 字符不做穷举转义。
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

/** 光标(或任意 range 端点)在容器内可见文本的字符偏移。
 *  端点可能落在文本节点(偏移=字符数)或元素节点(偏移=子节点下标) */
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

/** 选区 [起, 止](折叠时二者相等);不在容器内返回 null */
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

/** 把光标放到 node 内累计可见偏移 off 处(node 可为元素或文本节点;
 *  偏移按文本节点长度累计,br 跳过)。焦点必须落在 contenteditable
 *  宿主上(focus 普通-div 无效,后续打字会飘到别处) */
function setCaret(node, off) {
  let host = node?.nodeType === 1 ? node : node?.parentElement;
  while (host && host.contentEditable !== 'true' && host.contentEditable !== 'plaintext-only') host = host.parentElement;
  host?.focus?.();
  const sel = document.getSelection();
  const r = document.createRange();
  let hit = null, pos = 0;
  const walk = (n) => {
    if (n.nodeType === 3) {
      if (off <= n.data.length) { hit = n; pos = off; return true; }
      off -= n.data.length;
      return false;
    }
    if (n.nodeName === 'BR') return false;
    for (const c of n.childNodes) if (walk(c)) return true;
    return false;
  };
  walk(node);
  if (hit == null) { hit = node; pos = node.nodeType === 1 ? node.childNodes.length : node.data.length; }
  r.setStart(hit, pos);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 选中 [a, z) 可见文本(格式命令插入占位符后便于直接键入替换) */
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

/* ============================================================
 * DOM → markdown 反序列化(渲染面回源)
 *
 * 每个块产出"源段"序列:{node,start,len,text}(真实文本节点片段)或
 * {text}(虚拟段:标记、前缀等)。段文本顺序连接即该块 markdown 源;
 * 段同时承担 光标DOM位置↔源偏移 的双向映射。
 * ============================================================ */

const td = (node, start, len) => ({ node, start, len, text: node.data.slice(start, start + len).replace(/\u00a0/g, ' ').replace(/\u200b/g, '') });
const vd = (text, host) => ({ text, ...(host ? { host } : {}) });

/** 行内子树 → 源段序列 */
function serInline(el, out) {
  for (const ch of el.childNodes) {
    if (ch.nodeType === 3) {
      if (ch.data === '\u200b') { out.push(vd('', ch.parentElement)); continue; }   // 空行 zwsp 占位:虚拟段(带宿主)
      out.push(td(ch, 0, ch.data.length));
      continue;
    }
    switch (ch.nodeName) {
      case 'BR': out.push(vd('  \n')); break;                       // 硬换行
      case 'STRONG': wrapMk(ch, '**', '**', out); break;
      case 'EM': wrapMk(ch, '*', '*', out); break;
      case 'S': wrapMk(ch, '~~', '~~', out); break;
      case 'CODE': {
        const t = ch.textContent;
        if (!t) break;
        const fence = t.includes('`') ? '``' : '`';
        out.push(vd(fence));
        const tn = [...ch.childNodes].find((n) => n.nodeType === 3);
        out.push(tn ? td(tn, 0, tn.data.length) : vd(t));
        out.push(vd(fence));
        break;
      }
      case 'A': {
        out.push(vd('['));
        serInline(ch, out);
        const href = ch.getAttribute('href') || '';
        const title = ch.getAttribute('title');
        out.push(vd('](' + href + (title ? ` "${title}"` : '') + ')'));
        break;
      }
      case 'IMG': {
        const alt = ch.getAttribute('alt') || '';
        const src = ch.getAttribute('src') || '';
        const title = ch.getAttribute('title');
        out.push(vd(`![${alt}](${src}${title ? ` "${title}"` : ''})`));
        break;
      }
      default: serInline(ch, out);                                  // span / 未知标签:透传子树
    }
  }
}

/** 强调类元素:边缘空白移到标记外(** x ** 不合法);全空则丢弃 */
function wrapMk(el, l, r, out) {
  const segs = [];
  serInline(el, segs);
  const txt = segs.map((s) => s.text).join('');
  if (!txt.trim()) return;
  const lead = txt.match(/^\s*/)[0];
  const trail = txt.match(/\s*$/)[0];
  if (lead) out.push(vd(lead));
  out.push(vd(l));
  trimSegs(segs, lead.length, trail.length, out);
  out.push(vd(r));
  if (trail) out.push(vd(trail));
}

/** 把段序列首/尾的空白字符改由虚拟段承载(不动文本节点本身) */
function trimSegs(segs, lead, trail, out) {
  let rest = lead;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const cutL = Math.min(rest, s.text.length);
    rest -= cutL;
    let len = s.text.length - cutL;
    if (i === segs.length - 1) len -= Math.min(trail, len);
    if (len > 0) {
      if (s.node) out.push(td(s.node, s.start + cutL, len));
      else out.push(vd(s.text.slice(cutL, cutL + len)));
    }
  }
}

/** 块级元素 → 若干 markdown 行(每行为源段序列) */
function serBlockEl(el, lines) {
  const tag = el.nodeName;
  if (/^H[1-6]$/.test(tag)) {
    const segs = [vd('#'.repeat(+tag[1]) + ' ', el)];
    serInline(el, segs);
    lines.push(segs);
  } else if (tag === 'P') {
    const segs = [];
    serInline(el, segs);
    lines.push(segs);
  } else if (tag === 'HR') {
    lines.push([vd('---')]);
  } else if (tag === 'BLOCKQUOTE') {
    const inner = [];
    serContainer(el, inner);
    for (const segs of inner) lines.push([vd('> '), ...segs]);
  } else if (tag === 'UL' || tag === 'OL') {
    serList(el, tag === 'OL', lines);
  } else if (tag === 'PRE' && el.classList.contains('md-code')) {
    const lang = el.getAttribute('data-lang') || '';
    const body = el.textContent.replace(/\n$/, '');
    lines.push([vd('```' + lang, el)]);
    for (const ln of body.split('\n')) lines.push([vd(ln)]);
    lines.push([vd('```')]);
  } else if (tag === 'PRE' && el.classList.contains('md-defraw')) {
    for (const ln of (el.dataset.src || '').split('\n')) lines.push([vd(ln)]);
  } else if (tag === 'DIV' && el.classList.contains('md-table-wrap')) {
    serTable(el.querySelector('table'), lines);
  } else {                                                           // 兜底:按纯文本行
    for (const ln of el.textContent.split('\n')) lines.push([vd(ln)]);
  }
}

/** 列表(含嵌套列表 / 任务项 / 多块条目) */
function serList(el, ordered, lines) {
  let n = parseInt(el.getAttribute('start') || '1', 10) || 1;
  const multi = [...el.children].some((li) => itemBlocks(li) > 1);
  [...el.children].forEach((li, idx) => {
    const check = li.querySelector(':scope > .md-check');
    const mk = check ? (check.classList.contains('on') ? '- [x] ' : '- [ ] ')
      : ordered ? `${n++}. ` : '- ';
    const segs = [vd(mk, li)];
    const kids = itemChildren(li);
    const blockEls = kids.filter((x) => x.nodeType === 1);
    if (blockEls.length <= 1) {
      serNodes(kids, segs);                                  // 紧凑条目:裸文本或单 P,一律行内
      lines.push(segs);
    } else {
      const inner = [];
      for (const b of blockEls) serBlockEl(b, inner);
      lines.push(segs.concat(inner[0] || [vd('')]));
      for (let k = 1; k < inner.length; k++) {
        for (const s of inner[k]) lines.push([vd(' '.repeat(mk.length)), s]);
      }
    }
    if (multi && idx < el.children.length - 1) lines.push([vd('')]);
  });
}

/** 节点序列 → 行内源段(文本节点 / P 解包 / 其余按行内规则) */
function serNodes(kids, out) {
  for (const ch of kids) {
    if (ch.nodeType === 3) { out.push(td(ch, 0, ch.data.length)); continue; }
    if (ch.nodeName === 'P') serInline(ch, out);
    else serInline(ch, out);
  }
}

/** li 的内容子节点(去掉任务复选框 span) */
function itemChildren(li) {
  return [...li.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('md-check')));
}
/** li 内顶层块数量(p/ul/pre…) */
function itemBlocks(li) {
  return itemChildren(li).filter((n) => n.nodeType === 1).length || 1;
}

/** 表格:表头/分隔(对齐从 th 的 style text-align 还原)/数据行 */
function serTable(table, lines) {
  const cell = (c) => {
    const segs = [];
    serInline(c, segs);
    return segs;
  };
  const ths = [...table.querySelectorAll('thead th')];
  const alignOf = (th) => {
    const t = (th.getAttribute('style') || '').match(/text-align:\s*(\w+)/)?.[1];
    return t === 'center' ? ':---:' : t === 'right' ? '---:' : t === 'left' ? ':---' : '---';
  };
  lines.push(pipeRow(ths.map(cell)));
  lines.push([vd('| ' + ths.map(alignOf).join(' | ') + ' |')]);
  for (const tr of table.querySelectorAll('tbody tr')) {
    lines.push(pipeRow([...tr.children].map(cell)));
  }
}
function pipeRow(cells) {
  const segs = [vd('| ')];
  cells.forEach((c, i) => {
    if (i) segs.push(vd(' | '));
    segs.push(...c);
  });
  segs.push(vd(' |'));
  return segs;
}

/** 容器(blockquote)内全部块 → 行段序列 */
function serContainer(el, out) {
  for (const ch of el.children) serBlockEl(ch, out);
}

/* ============================================================
 * 编辑器本体
 * ============================================================ */

/** 行内输入规则:闭合组合一经敲成(光标前的文本以完整标记收尾),
 *  立即重渲染该块显示样式。规则只触发"提前渲染",渲染结果始终以
 *  md.js 解析为准,误触发也无副作用。 */
const INLINE_RULES = [
  /\*\*[^*\n]+\*\*$/,          // **粗体**
  /(?<![*\w])\*[^*\n]+\*$/,    // *斜体*
  /~~[^~\n]+~~$/,              // ~~删除线~~
  /`[^`\n]+`$/,                // `代码`
  /(?<![\w])_[^_\n]+_$/,       // _斜体_
];

/** 斜杠命令项(应用走 exec) */
const SLASH_ITEMS = [
  { cmd: 'h1', label: '标题 1', hint: '#', icon: 'H1' },
  { cmd: 'h2', label: '标题 2', hint: '##', icon: 'H2' },
  { cmd: 'h3', label: '标题 3', hint: '###', icon: 'H3' },
  { cmd: 'ul', label: '无序列表', hint: '- 条目', icon: '•' },
  { cmd: 'ol', label: '有序列表', hint: '1. 条目', icon: '1.' },
  { cmd: 'task', label: '任务列表', hint: '- [ ] 条目', icon: '☑' },
  { cmd: 'quote', label: '引用', hint: '> 引用', icon: '❝' },
  { cmd: 'codeblock', label: '代码块', hint: '```', icon: '{ }' },
  { cmd: 'table', label: '表格', hint: '| 列 | 列 |', icon: '⊞' },
  { cmd: 'hr', label: '分隔线', hint: '---', icon: '―' },
  { sep: true },
  { cmd: 'bold', label: '粗体', hint: '**文字**', icon: 'B' },
  { cmd: 'italic', label: '斜体', hint: '*文字*', icon: 'I' },
  { cmd: 'strike', label: '删除线', hint: '~~文字~~', icon: 'S' },
  { cmd: 'code', label: '行内代码', hint: '`代码`', icon: '‹›' },
  { cmd: 'link', label: '链接', hint: '[文字](url)', icon: '🔗' },
];

/** 选区工具栏按钮 */
const SELBAR_BTNS = [
  ['bold', 'B', '粗体 (Ctrl+B)'],
  ['italic', 'I', '斜体 (Ctrl+I)'],
  ['strike', 'S', '删除线'],
  ['code', '‹›', '行内代码'],
  ['link', '🔗', '链接 (Ctrl+K)'],
];

export function createMdEditor(opts = {}) {
  const { placeholder = '', compact = false, onInput = null } = opts;
  let src = String(opts.value ?? '').replace(/\r\n?/g, '\n');
  let doc = parse(src);
  let previewing = false;
  let composing = false;      // IME 组合输入中:只同步源码不重渲染
  let undoS = [], redoS = [];
  let undoT = 0;
  let syncRaf = 0;            // 待处理的离场同步
  let activeIdx = -1;         // 光标所在块(用于落定渲染与指示条)
  let lastSig = [];           // 每块解析签名:相同则不动 DOM(浏览器自编辑成立)
  let ephLine = -1;           // 空临时段行:markdown 空行解析不出块,新块用零行占位

  const surface = h('div', 'md-surface');
  if (placeholder) surface.setAttribute('data-ph', placeholder);
  const root = h('div', 'md-edit' + (compact ? ' compact' : ''));
  root.append(surface);

  /* ---------- 基础(沿用 md 源即事实的行号模型) ---------- */

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

  function rejoin() { src = doc.lines.join('\n'); }

  function refreshEmpty() { root.classList.toggle('empty', !src.trim()); }

  function fireInput() {
    refreshEmpty();
    if (onInput) onInput(src);
    root.dispatchEvent(new CustomEvent('mdinput', { bubbles: true, detail: src }));
  }

  /* ---------- 渲染 ---------- */

  const sigOf = (b) => b ? [b.type, b.level ?? '', b.e - b.s, b.items?.length ?? '',
    b.ordered ?? '', b.tight ?? '', b.lang ?? ''].join(':') : '';

  /** 块的可编辑渲染:def 块渲染为原文(否则反序列化会丢失);空段给
   *  <br>,让浏览器有可落笔的行(空 <p></p> 会导致文字插到块外) */
  function blockEditHtml(b) {
    if (b.type === 'def') {
      const raw = doc.lines.slice(b.s, b.e).join('\n');
      return `<pre class="md-defraw" data-src="${raw.replace(/"/g, '&quot;')}">${raw
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    }
    if (b.type === 'para' && !(b.text || '').trim()) return '<p>\u200b</p>';
    if (b.type === 'heading' && !(b.text || '').trim()) return `<h${b.level}>\u200b</h${b.level}>`;
    let html = blockHtml(b, doc.defs) || '<p>\u200b</p>';
    /* 段尾硬换行(两空格结尾):渲染尾部 <br> 开出新行;其后补一个
     * 零宽占位 —— 尾部 <br> 之后的光标会被 Chrome 归一化回 br 前,
     * 后续文本会插到换行符之前 */
    if (b.type === 'para' && / {2,}$/.test(b.text || '')) {
      html = html.replace(/<\/p>$/, '<br>\u200b</p>');
    }
    /* 空列表项补 <br>:无可落点的空元素会让 Chrome 把选区归一化到
     * 邻近文本(上一项),续项输入会串行 */
    return b.type === 'list' ? html.replace(/(<li[^>]*>(?:<span class="md-check[^"]*"[^>]*><\/span>)?)<\/li>/g, '$1\u200b</li>') : html;
  }

  function renderAll(keepScroll = true) {
    const keep = keepScroll ? surface.scrollTop : 0;
    const bs = blocks();
    surface.innerHTML = '';
    bs.forEach((b, i) => {
      const node = h('div', 'md-block' + (i === activeIdx ? ' active' : ''));
      node.dataset.i = i;
      node.innerHTML = blockEditHtml(b);
      surface.append(node);
    });
    surface.scrollTop = keep;
    lastSig = bs.map(sigOf);
  }

  /** 局部重渲染第 i 块(结构变化时);内容一致则跳过 —— 无谓的
   *  innerHTML 重写会让 Chrome 丢弃元素锚定的选区,后续输入落错位 */
  function renderBlock(i) {
    const node = surface.children[i];
    const b = blocks()[i];
    if (!node || !b) return;
    const html = blockEditHtml(b);
    lastSig[i] = sigOf(b);
    if (node.innerHTML === html) return;
    node.innerHTML = html;
  }

  /* ---------- 光标:块内源偏移 ↔ DOM 位置 ---------- */

  /** 第 i 块的源段序列(与反序列化同构) */
  function blockSegs(i) {
    const node = surface.children[i];
    if (!node) return [];
    const lines = [];
    for (const ch of node.children) serBlockEl(ch, lines);
    const out = [];
    lines.forEach((segs, k) => {
      if (k) out.push(vd('\n'));
      out.push(...segs);
    });
    /* 标注累计双坐标:domStart 按原始字符(含 nbsp/zwsp),srcStart 按
     *  源码文本 —— 光标 DOM↔源 映射的换算基础 */
    let dom = 0, srcof = 0;
    for (const s of out) {
      s.domStart = dom; s.srcStart = srcof;
      if (s.node) { dom += s.node.data.length; srcof += s.text.length; }
      else if (s.host && s.text === '') { dom += 1; }               // zwsp 占位:占 1 个可见字符,不进源码
      else srcof += s.text.length;
    }
    return out;
  }

  /** 光标(选区起点)→ [块下标, 块内源偏移];不在编辑面返回 null */
  function caretPos() {
    const sel = document.getSelection();
    if (!sel.rangeCount || !surface.contains(sel.focusNode)) return null;
    const holder = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
    const blk = holder?.closest('.md-block');
    if (!blk || !surface.contains(blk)) return null;
    const i = +blk.dataset.i;
    const off = pointToSrc(i, sel.focusNode, sel.focusOffset);
    return off == null ? [i, 0] : [i, off];
  }

  /** 光标锚到宿主元素开头(空元素锚其 <br>,否则 Chrome 会把选区
   *  归一化到邻近文本,续项输入串到上一项) */
  function caretAtHostStart(host) {
    if (!host) { surface.focus(); return; }
    surface.focus();
    const r = document.createRange();
    /* 优先锚到宿主内首个文本节点(空行的 zwsp 占位是真实文本节点,
     * 光标不会像空元素/br 那样被 Chrome 归一化到别处) */
    let tn = null;
    const walk = (n) => {
      if (tn || n.nodeName === 'BR') return;
      if (n.nodeType === 3) { if (n.data.length) tn = n; return; }
      n.childNodes.forEach(walk);
    };
    walk(host);
    const br = tn ? null : host.querySelector?.('br');
    r.setStart(tn ?? br ?? host, 0);
    r.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 块内源偏移 → DOM 光标。偏移落在文本段内取精确点;落在虚拟段
   *  (标记/前缀/空行占位)上:优先带宿主的段(行首标记/空行 → 进该
   *  行元素),否则下一文本段开头 / 上一文本段结尾 */
  function placeCaret(i, off) {
    const blk = surface.children[i];
    if (!blk) return;
    const segs = blockSegs(i);
    let lastNode = null, lastEnd = 0, nextNode = null, nextStart = 0;
    let vMatch = null;
    for (const s of segs) {
      const len = s.text.length;                       // 源坐标长度(nbsp/zwsp 已归零)
      if (s.node) {
        if (off >= s.srcStart && off <= s.srcStart + len) { setCaret(s.node, s.start + (off - s.srcStart)); return; }
        if (vMatch && !nextNode) { nextNode = s.node; nextStart = s.start; }
        lastNode = s.node; lastEnd = s.start + s.len;
      } else {
        if (off >= s.srcStart && off <= s.srcStart + len && (!vMatch || (s.host && !vMatch.host))) vMatch = s;
      }
    }
    if (vMatch) {
      if (vMatch.host) { caretAtHostStart(vMatch.host); return; }   // 行首标记 / 空行:进该行元素
      if (nextNode) { setCaret(nextNode, nextStart); return; }
      if (lastNode) { setCaret(lastNode, lastEnd); return; }
    }
    if (lastNode && off >= segs.reduce((a, s2) => a + s2.text.length, 0)) { setCaret(lastNode, lastEnd); return; }
    /* 空块:落到最深的文本宿主(UL→LI / 引用→内层 p),否则文字会
     * 插到列表/引用的元素层,序列化时丢失 */
    const host = blk.querySelector('p, h1, h2, h3, h4, h5, h6, li, td, th, code')
      ?? blk.firstElementChild;
    if (host) caretAtHostStart(host);
    else surface.focus();
  }

  /** 块内某 DOM 点(node,offset)→ 源偏移(经段映射,标记感知) */
  function pointToSrc(i, node, off) {
    const blk = surface.children[i];
    if (!blk) return null;
    const vis = offsetOf(blk, node, off);
    if (vis == null) return null;
    const segs = blockSegs(i);
    for (const s of segs) {
      if (s.node) {
        const end = s.domStart + s.node.data.length;
        if (vis >= s.domStart && vis <= end) return s.srcStart + Math.min(vis - s.domStart, s.text.length);
      } else if (s.host && s.text === '' && vis === s.domStart) return s.srcStart;
    }
    return segs.reduce((a, s2) => a + s2.text.length, 0);
  }

  /** 选区两端 → [起, 止] 源偏移;不在该块内返回 null */
  function selSrc(i) {
    const blk = surface.children[i];
    const sel = document.getSelection();
    if (!blk || !sel.rangeCount || !blk.contains(sel.anchorNode) || !blk.contains(sel.focusNode)) return null;
    const a = pointToSrc(i, sel.anchorNode, sel.anchorOffset);
    const z = pointToSrc(i, sel.focusNode, sel.focusOffset);
    if (a == null || z == null) return null;
    return [Math.min(a, z), Math.max(a, z)];
  }

  /** 光标放到块内最后一个行内样式元素之后(Notion 式:闭合转换后
   *  续打为普通文本)。元素边界旁的光标会被 Chrome 归一化回元素内,
   *  因此在其后插一个零宽空格文本节点作为稳定锚点(序列化时剥除)。 */
  function caretAfterLastMark(i) {
    const blk = surface.children[i];
    const host = blk?.querySelector('p, h1, h2, h3, h4, h5, h6, li');
    if (!host) { placeCaret(i, 1e9); return; }
    const last = host.lastElementChild;
    if (!last || last.nodeName === 'BR' || last.classList.contains('md-check')) { placeCaret(i, 1e9); return; }
    if (!(host.lastChild === last) || host.lastChild.nodeType !== 3 || host.lastChild.data !== '​') {
      host.append(document.createTextNode('​'));
    }
    setCaret(host.lastChild, 0);
  }

  /** 渲染后恢复光标:同步落位(结构键后紧接的按键不能落空),rAF 再确认 */
  function afterRender(i, off) {
    placeCaret(Math.max(0, Math.min(i, surface.children.length - 1)), off);
    requestAnimationFrame(() => placeCaret(Math.max(0, Math.min(i, surface.children.length - 1)), off));
  }

  /* ---------- undo(native undo 在 DOM 重建后不可靠) ---------- */

  function snapshot() {
    const p = caretPos();
    return { src, i: p ? p[0] : activeIdx, off: p ? p[1] : 0 };
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
    renderAll();
    afterRender(snap.i, snap.off);
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

  /* ---------- 输入同步:DOM → 源,结构变化局部重渲染 ---------- */

  function onSurfaceInput() {
    const prevBs = blocks();
    const prevCount = prevBs.length;
    src = domToSrc();
    reparse();
    if (composing) { fireInput(); refreshEmpty(); return; } // 组合中:源码跟随,渲染等收尾
    const p = caretPos();
    if (p && prevBs[p[0]]?.eph) ephLine = -1;                // 临时空段已落字:回收占位
    const bs = blocks();
    if (bs.length !== prevCount) {                          // 块数变化:全量重渲染
      const caret = p || [0, 0];
      if (caret[0] >= bs.length) ephLine = doc.lines.length;  // 光标块消失:尾部临时段兜底
      renderAll();
      afterRender(Math.min(caret[0], blocks().length - 1), caret[1]);
    } else if (p) {
      activeIdx = p[0];
      const nb = bs[p[0]];
      const ob = prevBs[p[0]];
      /* 块级结构变化(段落敲成标题/列表)才即时重渲染;代码块/表格
       * 推迟到回车或离开块(``` 敲到一半就被吸进围栏);裸列表标记
       * (- / * / 1.)无内容也不转,否则 --- 会被单 - 劫持进列表。 */
      const defer = nb && ob?.type === 'para'
        && (['code', 'table', 'def'].includes(nb.type)
          || (nb.type === 'list' && /^ {0,3}([-*+]|\d{1,9}[.)])$/.test(blockText(nb))));
      /* 行内输入规则(Milkdown/ProseMirror 式):**x** / *x* / ~~x~~ /
       * `x` 一经敲成完整组合,立即重渲染显示样式 —— 只在模式闭合时
       * 触发,部分闭合(**x*)不渲染,不会把后续输入吸进样式 */
      const before = blockText(nb).slice(0, p[1]);
      const inlineHit = nb && (nb.type === 'para' || nb.type === 'heading'
        || nb.type === 'list' || nb.type === 'quote')
        && INLINE_RULES.some((re) => re.test(before));
      if (!defer && (lastSig[p[0]] !== sigOf(nb) || inlineHit)) {
        renderBlock(p[0]);
        if (inlineHit && lastSig[p[0]] === sigOf(nb)) caretAfterLastMark(p[0]);   // 闭合转换:退出样式续打
        else afterRender(p[0], p[1]);
      }
      /* 斜杠命令:已开着 → 按光标前文本过滤/关闭(唤起在 input 事件同步做) */
      if (slash) {
        if (nb && nb.type !== 'code' && nb.type !== 'def') updateSlash(before);
        else closeSlash();
      }
    }
    refreshEmpty();
    scheduleUndo();
    fireInput();
  }

  /** 编辑面 DOM → markdown 源(行首标记后多余空白归一为单空格) */
  function domToSrc() {
    const out = [];
    [...surface.children].forEach((blk, i) => {
      if (i) out.push([]);
      for (const ch of blk.children) serBlockEl(ch, out);
    });
    return out.map((segs) => segs.map((s) => s.text).join('')).join('\n')
      .replace(/\s+$/, '')
      .replace(/^( {0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)]))[ \t]+/gm, '$1 ');
  }

  /** rAF 离场同步(输入临界区内不动 DOM) */
  function scheduleSync() {
    cancelAnimationFrame(syncRaf);
    syncRaf = requestAnimationFrame(() => { syncRaf = 0; onSurfaceInput(); });
  }

  /* ---------- 光标块跟踪:落定渲染 + 指示条 ---------- */

  function trackSelection() {
    if (previewing) return;
    const sel = document.getSelection();
    if (!sel.rangeCount || !surface.contains(sel.focusNode)) return;
    const holder = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
    const blk = holder?.closest('.md-block');
    if (!blk || !surface.contains(blk)) return;
    const i = +blk.dataset.i;
    trackSelbar();
    if (i === activeIdx) return;
    const prev = activeIdx;
    activeIdx = i;
    if (prev >= 0 && surface.children[prev]) surface.children[prev].classList.remove('active');
    blk.classList.add('active');
    /* 离开块时落定渲染。仅当内容确有差异才动 DOM —— 无谓的 innerHTML
     * 重写会丢掉元素锚定的选区(空段光标),导致后续输入落错位置 */
    if (prev >= 0 && prev !== i && surface.children[prev]) {
      const pb = blocks()[prev];
      if (pb && surface.children[prev].innerHTML !== blockEditHtml(pb)) renderBlock(prev);
    }
  }

  /* ---------- 斜杠命令菜单(Milkdown/Notion 式) ---------- */

  let slash = null;   // { i, off, query, items, selIdx, el }
  let slashDocHandler = null;

  function openSlash(i, off) {
    const sel = document.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const el = h('div', 'md-slash');
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - 240)) + 'px';
    el.style.top = Math.min(r.bottom + 6, innerHeight - 260) + 'px';
    document.body.append(el);
    slash = { i, off, query: '', items: SLASH_ITEMS.filter((x) => !x.sep), selIdx: 0, el };
    renderSlash();
    slashDocHandler = (e) => { if (!e.target.closest('.md-slash')) closeSlash(); };
    document.addEventListener('pointerdown', slashDocHandler, true);
  }

  function renderSlash() {
    if (!slash) return;
    slash.el.innerHTML = '';
    slash.items.forEach((item, k) => {
      const row = h('button', 'md-slash-item' + (k === slash.selIdx ? ' sel' : ''),
        h('span', 'md-slash-ico', item.icon), h('span', 'md-slash-label', item.label),
        h('span', 'md-slash-hint', item.hint));
      row.type = 'button';
      row.addEventListener('mousedown', (e) => e.preventDefault());   // 不抢编辑面焦点
      row.addEventListener('click', () => { slash.selIdx = k; slashApply(); });
      slash.el.append(row);
    });
    slash.el.children[slash.selIdx]?.scrollIntoView({ block: 'nearest' });
  }

  /** 按光标前文本过滤;/query 出现空格、换行或第二个 / 时关闭 */
  function updateSlash(before) {
    if (!slash) return;
    const q = before.slice(slash.off).toLowerCase();          // off = / 之后的光标位
    if (q.includes(' ') || q.includes('/') || q.includes('\n')) { closeSlash(); return; }
    slash.query = q;
    const hit = SLASH_ITEMS.filter((x) => !x.sep
      && (x.label.toLowerCase().includes(q) || x.cmd.includes(q) || x.hint.includes(q)));
    if (!hit.length) { closeSlash(); return; }
    slash.items = hit;
    slash.selIdx = 0;
    renderSlash();
  }

  function slashMove(d) {
    if (!slash) return;
    slash.selIdx = (slash.selIdx + d + slash.items.length) % slash.items.length;
    renderSlash();
  }

  /** 应用命令:先删掉 /query 文本,光标回到 / 处,再走 exec */
  function slashApply() {
    if (!slash) return;
    const item = slash.items[slash.selIdx];
    const st = { i: slash.i, off: slash.off };
    closeSlash();
    if (!item) return;
    const p = caretPos();
    const b = blocks()[st.i];
    if (!b || !p || p[0] !== st.i || p[1] <= st.off) return;
    const text = blockText(b);
    const nt = text.slice(0, st.off - 1) + text.slice(p[1]);   // 剥掉整个 /query(含 /)
    doc.lines.splice(b.s, b.e - b.s, ...nt.split('\n'));
    rejoin(); reparse();
    if (st.i >= blocks().length) ephLine = b.s;               // 删除后光标块落空:该行重建临时段
    renderBlock(st.i);
    placeCaret(st.i, st.off - 1);
    commit();
    exec(item.cmd);
  }

  function closeSlash() {
    if (!slash) return;
    slash.el.remove();
    slash = null;
    if (slashDocHandler) { document.removeEventListener('pointerdown', slashDocHandler, true); slashDocHandler = null; }
  }

  /* ---------- 选区浮动工具栏(Crepe 式) ---------- */

  let selbar = null;

  function hideSelbar() { if (selbar) { selbar.remove(); selbar = null; } }

  function trackSelbar() {
    if (previewing || composing) { hideSelbar(); return; }
    const sel = document.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { hideSelbar(); return; }
    const a = sel.anchorNode?.parentElement?.closest?.('.md-block');
    const f = sel.focusNode?.parentElement?.closest?.('.md-block');
    if (!a || !f || a !== f || !surface.contains(a)) { hideSelbar(); return; }   // 限单块
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) { hideSelbar(); return; }
    if (!selbar) {
      selbar = h('div', 'md-selbar');
      for (const [cmd, label, tip] of SELBAR_BTNS) {
        const btn = h('button', 'md-selbar-btn', label);
        btn.type = 'button';
        btn.title = tip;
        btn.addEventListener('mousedown', (e) => e.preventDefault());  // 保住选区
        btn.addEventListener('click', () => { exec(cmd); hideSelbar(); });
        selbar.append(btn);
      }
      document.body.append(selbar);
    }
    selbar.style.left = Math.max(8, Math.min(r.left + r.width / 2 - selbar.offsetWidth / 2, innerWidth - 8 - selbar.offsetWidth)) + 'px';
    selbar.style.top = Math.max(6, r.top - 40) + 'px';
  }

  /* ---------- 结构键(沿用源码行号模型) ---------- */

  function blockAt(line) {
    const bs = blocks();
    for (let i = 0; i < bs.length; i++) {
      if (bs[i].eph) { if (line <= bs[i].s) return i; continue; }
      if (line < bs[i].e) return i;
    }
    return bs.length - 1;
  }

  function handleEnter(shift, p) {
    const bs = blocks();
    const b = bs[p[0]];
    const text = blockText(b);
    if (b.eph) return;                                       // 空临时段上回车:无操作
    /* --- / *** / ___ 整段回车:分隔线 */
    if (b.type === 'para' && /^(-{3,}|\*{3,}|_{3,})$/.test(text.trim())) {
      doc.lines.splice(b.s, b.e - b.s, '---', '');
      rejoin(); reparse();
      ephLine = b.s + 2;
      renderAll();
      afterRender(blockAt(b.s + 2), 0);
      fireInput();
      return;
    }
    /* ``` / ~~~ 段落回车:开代码块 */
    const fm = b.type === 'para' && text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)$/);
    if (fm) {
      doc.lines.splice(b.s, b.e - b.s, fm[1] + (fm[2] || ''), '', fm[1]);
      rejoin(); reparse();
      renderAll();
      afterRender(blockAt(b.s + 1), 0);
      fireInput();
      return;
    }
    if (shift) {                                             // 硬换行
      const nt = text.slice(0, p[1]) + '  \n' + text.slice(p[1]);
      doc.lines.splice(b.s, b.e - b.s, ...nt.split('\n'));
      rejoin(); reparse();
      /* 必须强制重渲染:段尾硬换行不改变解析签名,若跳过渲染则 DOM
       * 里没有 <br>,下一次输入的 DOM 反序列化会把换行整个冲掉 */
      renderBlock(p[0]);
      if (!/\n/.test(blockText(blocks()[p[0]]).slice(p[1] + 3))) {
        /* 段尾换行:光标锚到 <br> 之后的零宽占位上,后续文本落新行 */
        const host = surface.children[p[0]]?.querySelector('p, h1, h2, h3, h4, h5, h6, li');
        const tn = host ? [...host.childNodes].filter((n) => n.nodeType === 3).pop() : null;
        if (tn) setCaret(tn, tn.data.length - 1 >= 0 && tn.data.endsWith('\u200b') ? tn.data.length - 1 : tn.data.length);
        else afterRender(p[0], p[1] + 3);
      } else afterRender(p[0], p[1] + 3);
      fireInput();
      return;
    }
    if (b.type === 'quote') {
      /* 空引用行回车:退出引用 */
      const ls = text.split('\n');
      const lineNo = text.slice(0, p[1]).split('\n').length - 1;
      if (!ls[lineNo].replace(/^\s*>\s?/, '').trim()) {
        const at = b.s + lineNo;
        doc.lines.splice(at, 1, '');
        rejoin(); reparse();
        ephLine = at + 1;
        renderAll();
        afterRender(blockAt(at + 1), 0);
        fireInput();
        return;
      }
      insertLines('\n> ', p);
      return;
    }
    if (b.type === 'list') { listEnter(b, text, p); return; }
    /* 段落 / 标题:块拆分(前半落定,后半新块;后半空用临时段占位) */
    const bl = text.slice(0, p[1]).split('\n');
    const al = text.slice(p[1]).split('\n');
    if (al[0] === '') al.shift();
    doc.lines.splice(b.s, b.e - b.s, ...[...bl, '', ...al]);
    rejoin(); reparse();
    if (!al.length) ephLine = b.s + bl.length + 1;
    renderAll();
    afterRender(blockAt(b.s + bl.length + 1), 0);
    fireInput();
  }

  /** 在光标处插入源码文本,光标落在插入文本末尾 */
  function insertLines(str, p) {
    const b = blocks()[p[0]];
    const text = blockText(b);
    const nt = text.slice(0, p[1]) + str + text.slice(p[1]);
    doc.lines.splice(b.s, b.e - b.s, ...nt.split('\n'));
    rejoin(); reparse();
    const off = p[1] + str.length;
    const idx = blockAt(b.s + nt.slice(0, off).split('\n').length - 1);
    if (sigOf(blocks()[idx]) === lastSig[idx]) placeCaret(idx, off);
    else { renderBlock(idx); afterRender(idx, off); }
    fireInput();
  }

  /** 列表内回车:空条目行 → 退出列表;否则续条目 */
  function listEnter(b, text, p) {
    const ls = text.split('\n');
    const lineNo = text.slice(0, p[1]).split('\n').length - 1;
    const line = ls[lineNo];
    if (/^\s*([-*+]|\d{1,9}[.)])\s*(\[[ xX]\]\s*)?$/.test(line)) {
      const at = b.s + lineNo;
      doc.lines.splice(at, 1, '');
      rejoin(); reparse();
      ephLine = at + 1;
      renderAll();
      afterRender(blockAt(at + 1), 0);
      fireInput();
      return;
    }
    const pm = line.match(/^(\s*)([-*+]|(\d{1,9})[.)])(\s+)(\[[ xX]\]\s+)?/);
    if (!pm) { insertLines('\n', p); return; }
    let prefix = pm[1] + pm[2] + pm[4];
    if (pm[3] != null) prefix = pm[1] + (parseInt(pm[3], 10) + 1) + pm[2].slice(pm[3].length) + pm[4];
    if (pm[5]) prefix += '[ ] ';
    insertLines('\n' + prefix, p);
  }

  /** 块首退格:并入前块 / 标题降级为段落 */
  function handleMerge(dir, p) {
    const bs = blocks();
    const b = bs[p[0]];
    if (dir < 0 && b?.eph) {
      ephLine = -1;
      const prev = p[0] - 1;
      renderAll();
      if (prev >= 0) afterRender(prev, blockText(bs[prev]).length);
      else afterRender(0, 0);
      fireInput();
      return;
    }
    if (dir < 0 && p[0] === 0) {
      if (b.type === 'heading') {                            // 首块行首退格:标题降级为段落
        doc.lines[b.s] = doc.lines[b.s].replace(/^ {0,3}#{1,6}\s+/, '');
        rejoin(); reparse();
        renderAll();
        afterRender(blockAt(b.s), 0);
        fireInput();
      }
      return;
    }
    const other = dir < 0 ? bs[p[0] - 1] : bs[p[0] + 1];
    if (!other) return;
    const first = dir < 0 ? other : b;
    const second = dir < 0 ? b : other;
    const ft = doc.lines.slice(first.s, first.e);
    const st = doc.lines.slice(second.s, second.e);
    const caret = ft.join('\n').length;
    doc.lines.splice(first.s, second.e - first.s, ...ft, ...st);
    rejoin(); reparse();
    renderAll();
    afterRender(blockAt(first.s), caret);
    fireInput();
  }

  /** Tab:列表内按行 ±2 空格;普通块插入两空格 */
  function handleTab(shift, p) {
    const b = blocks()[p[0]];
    if (b.type !== 'list') { if (!shift) insertLines('  ', p); return; }
    const text = blockText(b);
    const lineNo = text.slice(0, p[1]).split('\n').length - 1;
    const ls = text.split('\n');
    let delta = 0;
    if (shift) {
      const cut = Math.min(2, ls[lineNo].match(/^ */)[0].length);
      ls[lineNo] = ls[lineNo].slice(cut);
      delta = -cut;
    } else {
      ls[lineNo] = '  ' + ls[lineNo];
      delta = 2;
    }
    const nt = ls.join('\n');
    doc.lines.splice(b.s, b.e - b.s, ...nt.split('\n'));
    rejoin(); reparse();
    renderBlock(p[0]);
    afterRender(p[0], Math.max(0, p[1] + delta));
    fireInput();
  }

  /* ---------- 格式命令(Ctrl+B/I/K 与宿主 exec) ---------- */

  function exec(cmd) {
    if (previewing) return;
    surface.focus();
    const p = caretPos();
    if (!p) return;
    const b = blocks()[p[0]];
    if (!b) return;                                          // 块索引过期(渲染与解析错位)
    if (b.eph) ephLine = -1;                                 // 命令作用于临时空段:占位随之消费
    const text = blockText(b);
    const sr = selSrc(p[0]) || [p[1], p[1]];
    const [a, z] = sr;
    const apply = (nt, caret) => {
      doc.lines.splice(b.s, b.e - b.s, ...nt.split('\n'));
      rejoin(); reparse();
      renderBlock(p[0]);
      afterRender(p[0], caret);
      scheduleUndo();
      fireInput();
    };
    const wrap = (l, r, ph) => {
      const sel = z > a;
      const inner = sel ? text.slice(a, z) : ph;
      const nt = text.slice(0, a) + l + inner + r + text.slice(z);
      apply(nt, a + l.length + inner.length);
      requestAnimationFrame(() => {
        const blk = surface.children[p[0]];
        if (blk) setSel(blk, a + l.length, a + l.length + inner.length);   // 选中内容/占位符,键入即替换
      });
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
        renderBlock(p[0]);
        afterRender(p[0], doc.lines[b.s].length);
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
        const bb = blocks()[p[0]];
        doc.lines.splice(bb.e, 0, '', '---', '');
        rejoin(); reparse();
        ephLine = bb.e + 3;                                  // 分隔线后接临时空段
        renderAll();
        afterRender(blockAt(ephLine), 0);
        fireInput();
        break;
      }
    }
  }

  /** 在当前块后插入独立块并激活 */
  function insertBlockAfter(lines, line) {
    const p = caretPos() || [0, 0];
    const b = blocks()[p[0]];
    doc.lines.splice(b.e, 0, '', ...lines);
    rejoin(); reparse();
    const at = b.e + 1 + line;
    renderAll();
    afterRender(blockAt(at), 0);
    fireInput();
  }

  /* ---------- 任务勾选 ---------- */

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
    doc.lines[it.s] = doc.lines[it.s].replace(/\[([ xX])\]/, (m, c) => (c === ' ' ? '[x]' : '[ ]'));
    rejoin(); reparse();
    renderBlock(i);
    fireInput();
  }

  /* ---------- 事件 ---------- */

  surface.addEventListener('pointerdown', (e) => {
    if (previewing) return;                                 // 只读态:仅浏览
    const check = e.target.closest('.md-check');
    if (check) { e.preventDefault(); toggleTask(check); return; }
  });

  surface.addEventListener('input', () => {
    /* 斜杠唤起在输入事件里同步探测:光标前字符是 / 即开。不能等
     * rAF 合并 —— 快速连打时 / 后紧跟其他字符,中间态会被吞掉 */
    if (!composing && !slash && !previewing) {
      const sel = document.getSelection();
      const n = sel?.focusNode;
      if (n?.nodeType === 3 && n.data[sel.focusOffset - 1] === '/' && surface.contains(n)) {
        const blk = n.parentElement?.closest('.md-block');
        const bs = blocks();
        const bi = blk ? +blk.dataset.i : -1;
        const nb = bi >= 0 ? bs[bi] : null;
        if (nb && nb.type !== 'code' && nb.type !== 'def') {
          const pp = caretPos();
          if (pp) openSlash(pp[0], pp[1]);
        }
      }
    }
    if (composing) onSurfaceInput(); else scheduleSync();
  });
  surface.addEventListener('compositionstart', () => { composing = true; });
  surface.addEventListener('compositionend', () => {
    composing = false;
    onSurfaceInput();                                       // 收尾:结构变化一次性落定
  });
  surface.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (t) document.execCommand('insertText', false, t.replace(/\r\n?/g, '\n'));
  });
  surface.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = e.dataTransfer?.getData('text/plain');
    if (t) document.execCommand('insertText', false, t.replace(/\r\n?/g, '\n'));
  });
  surface.addEventListener('keydown', (e) => {
    if (composing) return;                                  // IME 选词回车不接管
    if (slash) {                                            // 斜杠菜单:方向键/回车/Esc 归菜单
      if (e.key === 'ArrowDown') { e.preventDefault(); slashMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashMove(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); slashApply(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
      if (e.key === 'Tab') { e.preventDefault(); return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'b') { e.preventDefault(); commit(); exec('bold'); return; }
    if (mod && k === 'i') { e.preventDefault(); commit(); exec('italic'); return; }
    if (mod && k === 'k') { e.preventDefault(); commit(); exec('link'); return; }
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      const p = caretPos();
      if (p) handleEnter(e.shiftKey, p);
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const p = caretPos();
      const sr = p ? selSrc(p[0]) : null;
      const collapsed = !!sr && sr[0] === sr[1];
      const atStart = !!p && collapsed && sr[0] === 0;
      const atEnd = !!p && collapsed && sr[0] === blockText(blocks()[p[0]]).length;
      if (e.key === 'Backspace' && atStart) { e.preventDefault(); commit(); handleMerge(-1, p); return; }
      if (e.key === 'Delete' && atEnd) { e.preventDefault(); commit(); handleMerge(1, p); return; }
      return;                                               // 其余退格:原生(DOM 编辑,源码随输入同步)
    }
    if (e.key === 'Tab') { e.preventDefault(); commit(); handleTab(e.shiftKey, caretPos() || [0, 0]); return; }
  });

  document.addEventListener('selectionchange', trackSelection);
  surface.addEventListener('blur', () => { closeSlash(); hideSelbar(); });

  /* ---------- 对外 ---------- */

  const api = {
    el: root,
    /** 当前源码;有挂起的输入同步先冲刷(宿主可能在同一任务里
     *  输入后立即读取,不能比 rAF 慢一帧) */
    get() {
      if (syncRaf) { cancelAnimationFrame(syncRaf); syncRaf = 0; onSurfaceInput(); }
      return src;
    },
    /** 整体替换(打开文件 / 切换日记日期):重置 undo 栈 */
    set(text) {
      src = String(text ?? '').replace(/\r\n?/g, '\n');
      ephLine = -1;
      activeIdx = -1;
      closeSlash(); hideSelbar();
      reparse();
      undoS = []; redoS = [];
      renderAll();
      refreshEmpty();
    },
    focus() {
      if (previewing) return;
      surface.focus();
      if (!caretPos()) afterRender(0, 0);
    },
    /** 只读预览:解除可编辑,整篇渲染 */
    preview(on) {
      previewing = !!on;
      root.classList.toggle('preview', previewing);
      surface.setAttribute('contenteditable', previewing ? 'false' : 'true');
      closeSlash(); hideSelbar();
      if (previewing) { activeIdx = -1; renderAll(); }
    },
    /** 更新占位文案(空文档提示;宿主可按只读/编辑态切换) */
    placeholder(text) {
      if (text) surface.setAttribute('data-ph', String(text));
      else surface.removeAttribute('data-ph');
    },
    undo, redo, exec,
    destroy() {
      clearTimeout(undoT);
      cancelAnimationFrame(syncRaf);
      closeSlash(); hideSelbar();
      document.removeEventListener('selectionchange', trackSelection);
    },
  };
  root.$md = api;

  surface.setAttribute('contenteditable', 'true');
  surface.setAttribute('spellcheck', 'false');
  renderAll();
  refreshEmpty();
  return api;
}
