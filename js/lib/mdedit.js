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
 * 结构键:Enter 拆块(列表续项/引用续行/``` 开代码块),Backspace
 * 块首并块或降级(标题→段落),Tab/Shift+Tab 列表层级,Ctrl+B/I/K
 * 行内标记,Ctrl+Z/Y 自研 undo(native undo 在 DOM 重建后不可靠)。
 * 中文输入法:composition 期间只同步源码不重渲染,结束后收尾。
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
    const html = blockHtml(b, doc.defs) || '<p><br></p>';
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
    const vis = caretOffset(blk);
    if (vis == null) return [i, 0];
    const segs = blockSegs(i);
    for (const s of segs) {
      if (s.node) {
        const end = s.domStart + s.node.data.length;
        if (vis >= s.domStart && vis <= end) return [i, s.srcStart + Math.min(vis - s.domStart, s.text.length)];
      } else if (s.host && s.text === '' && vis === s.domStart) return [i, s.srcStart];   // 光标在 zwsp 占位上
    }
    return [i, segs.reduce((a, s2) => a + s2.text.length, 0)];
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
      /* 块级结构变化(段落敲成标题/列表)才即时重渲染;行内(** 等)
       * 不在打字中途转换 —— 部分闭合(**x*)会渲染成 em 吸住后续输入,
       * 行内样式在离开块时落定(Obsidian Live Preview 同款策略)。
       * 代码块/表格同样推迟到回车或离开块 */
      const defer = nb && ob?.type === 'para' && ['code', 'table', 'def'].includes(nb.type);
      if (!defer && lastSig[p[0]] !== sigOf(nb)) {
        renderBlock(p[0]);
        afterRender(p[0], p[1]);
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
      const off = p[1] + 3;
      if (sigOf(blocks()[p[0]]) === lastSig[p[0]]) placeCaret(p[0], off);
      else { renderBlock(p[0]); afterRender(p[0], off); }
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
    const text = blockText(b);
    const sr = selectionRange(surface.children[p[0]]) || [p[1], p[1]];
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

  surface.addEventListener('input', () => { if (composing) onSurfaceInput(); else scheduleSync(); });
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
      const sr = p ? selectionRange(surface.children[p[0]]) : null;
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
