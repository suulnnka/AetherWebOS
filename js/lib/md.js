/* ============================================================
 * md.js —— 自研 Markdown 解析渲染库
 *
 * 为什么自研:本项目坚持零运行时依赖(见 package.json,devDependencies
 * 只有 Vite),marked/markdown-it 一类外部库不可用;浏览器也没有内置的
 * Markdown 渲染能力。按"当前实际需要的子集"实现,与 minimap 同思路。
 *
 * 覆盖范围(CommonMark/GFM 实用子集):
 *  - 块级:ATX/Setext 标题、段落、围栏代码(``` 与 ~~~,含语言标签)、
 *    缩进代码、分隔线、嵌套引用(含懒延续)、嵌套列表(有序/无序/
 *    任务列表)、GFM 表格(对齐)、链接引用定义
 *  - 行内:粗斜体(* 与 _,含词内规则)、~~删除线~~、行内代码(多反引号)、
 *    链接/图片(行内式 + 引用式)、自动链接(<url> / <邮箱>)、
 *    反斜杠转义、硬换行(行尾两空格或反斜杠)
 *
 * 明确不做:原始 HTML 透传(安全考虑,全部转义)、脚注、数学公式。
 *
 * 安全:输出只含本库生成的标签;所有文本全量 HTML 转义;链接协议白名单
 * (http/https/mailto/相对路径/锚点,图片额外允许 data:image/)。
 *
 * API(纯字符串→HTML,无 DOM 依赖,可在 node 中直接运行 tools/md-smoke.mjs):
 *   parse(src)                 → { blocks, defs, lines }  顶层块(带源码行区间 s/e)
 *   render(src)                → 整篇 HTML
 *   renderBlocks(blocks, defs) → 多块 HTML(编辑器/预览复用)
 *   blockHtml(block, defs)     → 单块 HTML(mdedit 活动块落定时用)
 *   inlineHtml(text, defs)     → 行内 HTML
 *
 * 块对象带 s/e(源码行号,s 含 e 不含),供 Typora 式编辑器把
 * "一个顶层块 = 一个可编辑单元"对齐到源文本 —— 这是 js/lib/mdedit.js
 * 的依赖约定,改动行区间语义前先看那边的注释。
 * ============================================================ */

/* ---------- 基础工具 ---------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/** CommonMark 定义的 ASCII 标点(转义与强调侧翼判断用) */
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const isWs = (c) => c == null || /\s/.test(c);

/** 制表符按 4 空格展开(语法识别与代码围栏缩进剥离用) */
const expand = (l) => l.replace(/\t/g, '    ');

/* ---------- 块级解析 ---------- */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?![^ \t])(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^ {0,3}([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const DEF_RE = /^ {0,3}\[([^\]]*)\]:[ \t]*(?:<([^>]*)>|(\S+))(?:[ \t]+(?:"([^\n]*)"|'([^\n]*)'|\(([^\n]*)\)))?[ \t]*$/;

const isHr = (l) => HR_RE.test(l);

/** 该行是否可以打断段落(块起始特征;缩进代码/表格/链接定义不在此列) */
function canInterrupt(l) {
  if (FENCE_RE.test(l) || ATX_RE.test(l) || isHr(l) || QUOTE_RE.test(l)) return true;
  const m = l.match(LIST_RE);
  if (!m) return false;
  if (!m[2] || !/[ \t]+\S/.test(l)) return false;             // 空列表项不打断
  if (/\d/.test(m[1]) && parseInt(m[1], 10) !== 1) return false; // 有序列表仅 1. 可打断
  return true;
}

/**
 * 解析源码为顶层块数组。
 * lines 为(可能已剥掉容器前缀的)行数组,base 是 lines[0] 对应的绝对行号;
 * 容器内每个内层行与外层行一一对应,故 s/e 全程用绝对行号。
 */
function parseBlocks(lines, base, defs) {
  const out = [];
  const n = lines.length;
  const L = (k) => expand(lines[k] ?? '');
  let i = 0;

  while (i < n) {
    const line = L(i);
    const abs = base + i;

    if (!line.trim()) { i++; continue; }                      // 空行

    /* 围栏代码 */
    let m = line.match(FENCE_RE);
    if (m) {
      const fenceCh = m[1][0], fenceLen = m[1].length;
      const indent = line.match(/^ */)[0].length;
      let end = n, closed = false;
      for (let k = i + 1; k < n; k++) {
        const c = L(k).match(CLOSE_FENCE_RE);
        if (c && c[1][0] === fenceCh && c[1].length >= fenceLen) { end = k; closed = true; break; }
      }
      const body = lines.slice(i + 1, end).map((l) => {
        const e = expand(l);
        const cut = Math.min(indent, e.match(/^ */)[0].length); // 剥掉与开栏一致的缩进
        return e.slice(cut);
      });
      out.push({ type: 'code', lang: m[2].trim().split(/\s+/)[0] || '', text: body.join('\n'), s: abs, e: base + (closed ? end + 1 : n) });
      i = closed ? end + 1 : n;
      continue;
    }

    /* ATX 标题 */
    m = line.match(ATX_RE);
    if (m) {
      out.push({ type: 'heading', level: m[1].length, text: (m[2] || '').replace(/[ \t]+#+[ \t]*$/, ''), s: abs, e: abs + 1 });
      i++;
      continue;
    }

    /* 分隔线 */
    if (isHr(line)) { out.push({ type: 'hr', s: abs, e: abs + 1 }); i++; continue; }

    /* 引用(含懒延续:段落续行可省略 > 前缀) */
    if (QUOTE_RE.test(line)) {
      const inner = [];
      let j = i;
      while (j < n) {
        const lj = L(j);
        if (QUOTE_RE.test(lj)) { inner.push(expand(lj).replace(/^ {0,3}> ?/, '')); j++; }
        else if (lj.trim() && inner.length && expand(inner[inner.length - 1]).trim() && !canInterrupt(lj)) {
          inner.push(lj); j++;                                // 懒延续
        } else break;
      }
      out.push({ type: 'quote', blocks: parseBlocks(inner, abs, defs), s: abs, e: base + j });
      i = j;
      continue;
    }

    /* 列表 */
    if (LIST_RE.test(line)) {
      const [block, next] = parseList(lines, i, base, defs);
      out.push(block);
      i = next;
      continue;
    }

    /* 表格:标题行含 | 且下一行是分隔行,列数一致 */
    if (line.includes('|') && i + 1 < n) {
      const head = splitRow(line);
      const delim = splitRow(L(i + 1));
      const isDelim = L(i + 1).includes('-') && delim.length >= 1 && delim.every((c) => /^:?-+:?$/.test(c.trim()));
      if (isDelim && delim.length === head.length) {
        const align = delim.map((c) => {
          const t = c.trim();
          return t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : '';
        });
        const rows = [];
        let j = i + 2;
        while (j < n) {
          const lj = L(j);
          if (!lj.trim() || !lj.includes('|')) break;
          rows.push(splitRow(lj));
          j++;
        }
        out.push({ type: 'table', align, head, rows, s: abs, e: base + j });
        i = j;
        continue;
      }
    }

    /* 链接引用定义(不产生渲染输出,但保留为可编辑单元) */
    m = line.match(DEF_RE);
    if (m && m[1].trim()) {
      defs[m[1].trim().toLowerCase()] = { url: (m[2] ?? m[3] ?? '').trim(), title: m[4] ?? m[5] ?? m[6] ?? '' };
      out.push({ type: 'def', s: abs, e: abs + 1 });
      i++;
      continue;
    }

    /* 缩进代码块(4 空格;尾部空行不吞) */
    if (/^ {4,}/.test(line)) {
      const body = [];
      let j = i;
      while (j < n) {
        const lj = L(j);
        if (!lj.trim()) {
          let k = j + 1;
          while (k < n && !L(k).trim()) k++;
          if (k < n && /^ {4,}/.test(L(k))) { body.push(''); j++; continue; }
          break;
        }
        if (!/^ {4}/.test(lj)) break;
        body.push(lj.slice(4));
        j++;
      }
      out.push({ type: 'code', lang: '', text: body.join('\n'), s: abs, e: base + j });
      i = j;
      continue;
    }

    /* 段落(可被 Setext 下划线收编为标题) */
    {
      const para = [lines[i]];
      let j = i + 1;
      let setext = 0;
      while (j < n) {
        const lj = L(j);
        if (!lj.trim()) break;
        const sm = lj.match(SETEXT_RE);
        if (sm) { setext = sm[1][0] === '=' ? 1 : 2; j++; break; }
        if (canInterrupt(lj)) break;
        para.push(lines[j]);
        j++;
      }
      if (setext) out.push({ type: 'heading', level: setext, text: para.map(expand).join('\n').trim(), s: abs, e: base + j });
      else out.push({ type: 'para', text: para.map(expand).join('\n'), s: abs, e: base + j });
      i = j;
    }
  }
  return out;
}

/**
 * 列表解析:items[].blocks 为条目内容递归解析的结果,task 为
 * undefined(非任务)/ true / false(GFM 任务列表,标记在条目首段行首)。
 */
function parseList(lines, i, base, defs) {
  const n = lines.length;
  const L = (k) => expand(lines[k] ?? '');
  const first = L(i).match(LIST_RE);
  const ordered = /\d/.test(first[1]);
  const start = ordered ? parseInt(first[1], 10) : 1;
  const bullet = first[1];                                   // 无序列表:换符号(- → *)即新列表
  const sameKind = (l) => {
    const m = l.match(LIST_RE);
    return !!m && /\d/.test(m[1]) === ordered && (ordered || m[1] === bullet);
  };
  const items = [];
  let tight = true;
  let j = i;

  while (j < n) {
    const line = L(j);
    const mm = line.match(LIST_RE);
    if (!mm || !sameKind(line)) break;
    const indent = line.match(/^ */)[0].length;
    const spaces = mm[2] ? Math.min(mm[2].length, 4) : 1;
    const contentIndent = indent + mm[1].length + spaces;
    const itemLines = [line.slice(Math.min(contentIndent, line.length))];
    const itemAbs = base + j;
    j++;

    /* 收集该条目的续行 */
    while (j < n) {
      const lj = L(j);
      if (!lj.trim()) {
        // 空行:向后看第一条非空行,若仍属于本列表(缩进够或同级新条目)则继续
        let k = j + 1;
        while (k < n && !L(k).trim()) k++;
        if (k >= n) { j = n; break; }
        const nk = L(k);
        if (nk.match(/^ */)[0].length >= contentIndent || sameKind(nk)) { tight = false; itemLines.push(''); j++; continue; }
        break;
      }
      const ind = lj.match(/^ */)[0].length;
      if (ind >= contentIndent) { itemLines.push(lj.slice(contentIndent)); j++; continue; }
      if (sameKind(lj)) break;                                // 同级新条目(异种标记/异符号 → 新列表)
      // 懒延续:条目末行非空且该行不是块起始 → 并入
      if (itemLines.length && expand(itemLines[itemLines.length - 1]).trim() && !canInterrupt(lj)) { itemLines.push(lj); j++; continue; }
      break;
    }
    while (itemLines.length && !expand(itemLines[itemLines.length - 1]).trim()) itemLines.pop();

    const blocks = parseBlocks(itemLines, itemAbs, defs);
    /* GFM 任务标记:[ ] / [x] 出现在条目首段行首(后随空白或行尾) */
    let task;
    if (blocks[0] && blocks[0].type === 'para') {
      const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(blocks[0].text);
      if (tm) {
        task = tm[1] !== ' ';
        blocks[0].text = blocks[0].text.slice(tm[0].length);
        if (!blocks[0].text.trim()) blocks.shift();
      }
    }
    items.push({ blocks, task, s: itemAbs, e: base + j });

    /* 条目间空行:其后仍是同类列表则跳过并记松散;尾部空行不属于列表,回退 */
    if (j < n && !L(j).trim()) {
      const save = j;
      while (j < n && !L(j).trim()) j++;
      if (j < n && sameKind(L(j))) tight = false;
      else j = save;
    }
  }
  return [{ type: 'list', ordered, start, tight, items, s: base + i, e: base + j }, j];
}

/** 表格行拆分:去掉首尾定界竖线,按未转义的 | 切开(转义 \| 留给行内处理) */
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

/* ---------- 行内解析(分隔符栈,参照 CommonMark 附录算法简化) ---------- */

/** 链接协议白名单;返回 null 表示拒绝(javascript: 一类) */
function safeUrl(url, isImg) {
  let u = url.trim();
  if (!u) return '';
  u = u.replace(/^<(.*)>$/, '$1');
  if (/[\u0000-\u001f]/.test(u) || /\s/.test(u)) return null;
  const m = u.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (m) {
    const s = m[1].toLowerCase();
    if (s === 'http' || s === 'https' || s === 'mailto') return u;
    if (isImg && s === 'data' && /^data:image\//i.test(u)) return u;
    return null;
  }
  return u;                                                   // 相对路径 / 锚点 / 协议相对
}

/** 生成 <a>/<img>;被拒绝的协议返回 null(调用方回退为字面文本) */
function linkHtml(inner, url, title, isImg, rich) {
  const u = safeUrl(url, isImg);
  if (u == null) return null;
  const t = title ? ` title="${esc(title)}"` : '';
  if (isImg) return `<img src="${esc(u)}" alt="${esc(inner)}"${t} loading="lazy">`;
  return `<a href="${esc(u)}"${t} target="_blank" rel="noopener">${rich ? inner : esc(inner)}</a>`;
}

/**
 * 行内解析。产出节点流:text / html(<code>、硬换行、链接等成品)/
 * delim(待配对的 * _ ~~),配对后输出 <em>/<strong>/<s>。
 */
function inline(text, defs, depth = 0) {
  const src = String(text ?? '');
  const nodes = [];
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', s: buf }); buf = ''; } };
  /** 分隔符 run 的前一个字符(决定 canClose;节点流里跨 text/html 时按标点近似) */
  const prevCh = () => {
    if (buf.length) return buf[buf.length - 1];
    const last = nodes[nodes.length - 1];
    if (!last) return null;
    if (last.t === 'delim') return last.ch;
    return ')';
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    /* 反斜杠:转义标点 / 行尾为硬换行 */
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { flush(); nodes.push({ t: 'html', s: '<br>' }); buf += '\n'; i += 2; continue; }
      if (nx && PUNCT.test(nx)) { buf += nx; i += 2; continue; }
      buf += ch; i++; continue;
    }

    /* 换行:行尾空格并入换行;软换行也渲染为 <br>(Typora/GFM 式,
     * 与编辑器"所见即所得"的换行观感一致) */
    if (ch === '\n') {
      const trail = buf.match(/ +$/);
      if (trail) buf = buf.slice(0, buf.length - trail[0].length);
      flush();
      nodes.push({ t: 'html', s: '<br>' });
      i++;
      continue;
    }

    /* 行内代码:等长反引号围栏,内容不再做行内解析 */
    if (ch === '`') {
      const run = /^`+/.exec(src.slice(i))[0].length;
      const close = src.slice(i + run).match(new RegExp('`{' + run + '}([^`]|$)'));
      if (close) {
        let c = src.slice(i + run, i + run + close.index);
        if (/^ .* $/.test(c) && c.trim()) c = c.slice(1, -1); // 两端单空格规则
        flush();
        nodes.push({ t: 'html', s: `<code>${esc(c).replace(/\n/g, ' ')}</code>` });
        i += run + close.index + run;
        continue;
      }
      buf += src.slice(i, i + run); i += run; continue;
    }

    /* 自动链接 <https://…> / <邮箱> */
    if (ch === '<') {
      const m = /^<(?:([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]+)|([^<>\s]+@[^<>\s]+))>/.exec(src.slice(i));
      if (m) {
        flush();
        const url = m[1] || ('mailto:' + m[2]);
        const shown = esc(m[1] || m[2]);
        const u = safeUrl(url, false);
        nodes.push({ t: 'html', s: u == null ? `&lt;${shown}&gt;` : `<a href="${esc(u)}" target="_blank" rel="noopener">${shown}</a>` });
        i += m[0].length;
        continue;
      }
    }

    /* 链接 / 图片 / 引用式链接 */
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const img = ch === '!';
      const open = i + (img ? 1 : 0);
      const close = matchBracket(src, open);
      if (close > 0) {
        const inner = src.slice(open + 1, close);
        const after = src.slice(close + 1);
        /* 行内式 (url "title") */
        if (after[0] === '(') {
          const m = /^\(\s*(?:<([^<>]*)>|(\S*?))(?:\s+(?:"([^\n]*)"|'([^\n]*)'|\(([^\n]*)\)))?\s*\)/.exec(after);
          if (m && depth < 8) {
            const html = linkHtml(
              img ? inner : inline(inner, defs, depth + 1),
              m[1] ?? m[2] ?? '', m[3] ?? m[4] ?? m[5] ?? '', img, !img);
            if (html != null) { flush(); nodes.push({ t: 'html', s: html }); i = close + 1 + m[0].length; continue; }
          }
        }
        /* 引用式 [label] / 简写 [text] */
        const rm = /^\[([^\]]*)\]/.exec(after);
        const def = defs && defs[normalizeLabel(rm ? rm[1] : inner)];
        if (def && depth < 8) {
          const html = linkHtml(
            img ? inner : inline(inner, defs, depth + 1),
            def.url, def.title, img, !img);
          if (html != null) {
            flush();
            nodes.push({ t: 'html', s: html });
            i = close + 1 + (rm ? rm[0].length : 0);
            continue;
          }
        }
        /* 不构成链接:中括号按字面,内部继续解析(粗体等仍生效) */
        if (img) buf += '!';
        buf += '[';
        flush();
        if (depth < 8) nodes.push({ t: 'html', s: inline(inner, defs, depth + 1) });
        else buf += esc(inner);
        buf += ']';
        i = close + 1;
        continue;
      }
    }

    /* 强调分隔符 run(* _ ~~) */
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = /(.)\1*/.exec(src.slice(i))[0].length;
      const nx = src[i + run];
      const pv = prevCh();
      if (ch === '~' && run !== 2) { buf += src.slice(i, i + run); i += run; continue; }
      const left = !isWs(nx), right = !isWs(pv);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = left && (!right || PUNCT.test(pv));
        canClose = right && (!left || PUNCT.test(nx));
      } else {
        canOpen = left;
        canClose = right;
      }
      flush();
      nodes.push({ t: 'delim', ch, count: run, canOpen, canClose });
      i += run;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return serialize(processDelims(nodes));
}

/** 找与 open 位置 [ 配对的 ](跳过转义与等长反引号代码段),失败返回 -1 */
function matchBracket(src, open) {
  let depth = 0;
  let i = open;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0].length;
      const close = src.slice(i + run).match(new RegExp('`{' + run + '}([^`]|$)'));
      i = close ? i + run + close.index + run : i + run;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (!depth) return i; }
    i++;
  }
  return -1;
}

const normalizeLabel = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** 分隔符配对:就近开符包裹 <em>/<strong>/<s>(简化版 CommonMark 附录算法) */
function processDelims(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (closer.t !== 'delim' || !closer.canClose) { ci++; continue; }
    let opener = null;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const d = nodes[oi];
      if (d.t === 'delim' && d.ch === closer.ch && d.canOpen) { opener = d; break; }
    }
    if (!opener) { ci++; continue; }
    const use = closer.ch === '~' ? 2 : (opener.count > 1 && closer.count > 1 ? 2 : 1);
    if (opener.count < use || closer.count < use) { ci++; continue; }

    opener.count -= use;
    closer.count -= use;
    const tag = closer.ch === '~' ? 's' : (use === 2 ? 'strong' : 'em');
    const openIdx = nodes.indexOf(opener);
    nodes.splice(ci, 0, { t: 'html', s: `</${tag}>` });       // 先插闭标签(靠后的下标)
    nodes.splice(openIdx + 1, 0, { t: 'html', s: `<${tag}>` });

    if (closer.count <= 0) nodes.splice(nodes.indexOf(closer), 1);   // 留在原 ci 重新配对余量
    else ci = nodes.indexOf(closer);
    if (opener.count <= 0) {
      const oi2 = nodes.indexOf(opener);
      nodes.splice(oi2, 1);
      if (oi2 < ci) ci--;
    }
  }
  return nodes;
}

function serialize(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += esc(nd.s);
    else if (nd.t === 'html') out += nd.s;
    else out += esc(nd.ch.repeat(nd.count));
  }
  return out;
}

/* ---------- 块渲染 ---------- */

const alignAttr = (a) => (a ? ` style="text-align:${a}"` : '');

export function blockHtml(b, defs) {
  switch (b.type) {
    case 'heading':
      return `<h${b.level}>${inline(b.text, defs)}</h${b.level}>`;
    case 'para':
      return `<p>${inline(b.text, defs)}</p>`;
    case 'hr':
      return '<hr>';
    case 'code': {
      const lang = b.lang ? ` data-lang="${esc(b.lang)}"` : '';
      return `<pre class="md-code"${lang}><code>${esc(b.text.replace(/\n$/, ''))}</code></pre>`;
    }
    case 'quote':
      return `<blockquote>${renderBlocks(b.blocks, defs)}</blockquote>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      const lis = b.items.map((it) => {
        const cb = it.task === undefined ? '' : `<span class="md-check${it.task ? ' on' : ''}" role="checkbox"></span>`;
        const only = it.blocks.length === 1 && it.blocks[0].type === 'para' && b.tight && it.task === undefined;
        const inner = only ? inline(it.blocks[0].text, defs) : renderBlocks(it.blocks, defs);
        return `<li${it.task !== undefined ? ' class="md-task-item"' : ''}>${cb}${inner}</li>`;
      }).join('');
      return `<${tag}${start}>${lis}</${tag}>`;
    }
    case 'table': {
      const th = b.head.map((c, k) => `<th${alignAttr(b.align[k])}>${inline(c, defs)}</th>`).join('');
      const trs = b.rows.map((r) => `<tr>${r.map((c, k) => `<td${alignAttr(b.align[k])}>${inline(c, defs)}</td>`).join('')}</tr>`).join('');
      return `<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
    }
    case 'def':
      return '';
    default:
      return '';
  }
}

export function renderBlocks(blocks, defs) {
  return blocks.map((b) => blockHtml(b, defs)).join('');
}

/* ---------- 对外 API ---------- */

export function parse(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  const defs = Object.create(null);
  const lines = text.split('\n');
  const blocks = parseBlocks(lines, 0, defs);
  return { blocks, defs, lines };
}

export function render(src) {
  const { blocks, defs } = parse(src);
  return renderBlocks(blocks, defs);
}

export { inline as inlineHtml };
