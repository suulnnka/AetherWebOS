/* ============================================================
 * chl —— 自研语法高亮(零依赖,支持 AetherJS / CSS / HTML / JSON)
 * ------------------------------------------------------------
 * 纯函数:highlight(code, lang) → HTML 字符串。
 *  - 产物只含 <span class="tk-*"> 与转义后的文本,可安全 innerHTML;
 *    产物的字符序列与源码逐字符一致(编辑器高亮层与文本层对齐的前提);
 *  - 类名约定:tk-kw 关键字 / tk-lit 字面量 / tk-str 字符串 / tk-num 数字
 *    / tk-com 注释 / tk-bi 内建 / tk-op 运算符 / tk-prop 属性名
 *    / tk-err 禁字与非法记号(AetherJS 特色:禁用总表直接标红,
 *      title 提示禁用理由)/ tk-tag 标签 / tk-attr 属性 / tk-ent 实体
 *    / tk-tpl 模板插值定界 / tk-id ID 选择器 / tk-cls 类选择器
 *    / tk-pseudo 伪类;纯文本不包 span(减小 DOM)。
 *  - 高亮是容错的:未闭合的注释/字符串/标签按该类型染到末尾,
 *    不做任何语法校验(校验走 AetherJS 编译器,见 core/ascript.js)。
 *
 * HTML 模式额外支持 AetherWebFramework 模板语法({{插值}}、
 * {{#if}}/{{#each}} 指令,插值内部复用 AetherJS 词法着色)与
 * <style>/<script> 内嵌内容按对应语言着色。
 * ============================================================ */

/* ---------- 公共:扩展名 → 语言 ---------- */

export const CODE_EXT_RE = /\.(ajs|js|css|html?|json)$/i;

export const LANG_LABELS = { ajs: 'AetherJS', css: 'CSS', html: 'HTML', json: 'JSON', '': '纯文本' };

/** 文件名 → 语言 id;不认识返回 ''(纯文本,不高亮) */
export function langOf(name) {
  if (/\.(ajs|js)$/i.test(name)) return 'ajs';
  if (/\.css$/i.test(name)) return 'css';
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.json$/i.test(name)) return 'json';
  return '';
}

/* ---------- 公共:词元 → HTML ---------- */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 收集器:相邻纯文本合并,末尾一次性拼 HTML */
function sink() {
  const out = [];
  let plain = '';
  return {
    push(cls, text, title) {
      if (!text) return;
      if (!cls) { plain += text; return; }
      if (plain) { out.push(esc(plain)); plain = ''; }
      out.push(`<span class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`);
    },
    html() {
      if (plain) { out.push(esc(plain)); plain = ''; }
      return out.join('');
    },
  };
}

/* ============================================================
 * AetherJS(规格:vendor/AetherWebFramework/docs/language-spec-v0.2.md)
 * ============================================================ */

const AJS_KEYWORDS = new Set([
  'let', 'const', 'function', 'class', 'if', 'else', 'while', 'for', 'of',
  'break', 'continue', 'return', 'throw', 'try', 'catch', 'new', 'this',
]);
const AJS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const AJS_BUILTINS = new Set([
  'Math', 'JSON', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'typeOf', 'str', 'num', 'keys', 'eq', 'copy', 'merge', 'fixed', 'print',
]);
/* 禁用总表(规格第 13 节):标红 + 悬停提示理由,词表与框架 lexer 对齐 */
const AJS_BANNED = {
  var: '禁止 var:只有 let/const,且必须初始化',
  typeof: '禁止 typeof 运算符:请用 typeOf()',
  switch: '禁止 switch:用 if-else 链改写',
  do: '禁止 do-while:用 while 改写',
  delete: '禁止 delete:可赋 undefined 替代',
  in: '禁止 in 运算符(含 for-in):用下标循环或 for-of',
  instanceof: '禁止 instanceof:类型判断请用 typeOf()',
  extends: '禁止 extends:没有继承,复用用组合',
  super: '禁止 super:没有继承',
  static: '保留字,不可用(无 static 成员)',
  enum: '保留字,不可用',
  async: '禁止 async/await:AetherJS 程序是同步的',
  await: '禁止 async/await:AetherJS 程序是同步的',
  yield: '禁止 yield:没有生成器',
  import: '禁止 import:不能引入外部代码',
  export: '禁止 export:AetherJS 脚本是单段程序',
  require: '禁止 require:不能引入外部代码',
  with: '禁止 with:作用域魔法',
  debugger: '禁止 debugger',
  arguments: '禁止 arguments:请用具名参数改写',
  eval: '禁止 eval:动态执行代码不在能力范围内',
  Function: '禁止 Function 构造器:它是 eval 的等价物',
  void: '禁止 void 运算符',
};

/* 词法(多字符运算符长者优先;== / != 是「保留 token 但 parser 拒绝」的禁用运算符) */
const AJS_TOKEN = new RegExp([
  '//[^\\n]*',                                        // 行注释
  '/\\*[\\s\\S]*?(?:\\*/|$)',                         // 块注释(未闭合染到末尾)
  "'(?:\\\\.|[^'\\\\\\n])*(?:'|(?=\\n)|$)",           // 单引号串(未闭合优雅染到行尾)
  '"(?:\\\\.|[^"\\\\\\n])*(?:"|(?=\\n)|$)',           // 双引号串
  '0[xX][0-9a-fA-F]+',                                // 进制整数
  '0[bB][01]+',
  '0[oO][0-7]+',
  '(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?',       // 数字
  '[A-Za-z_][A-Za-z0-9_]*',                           // 标识符
  '===', '!==', '==', '!=', '>=', '<=',               // 相等/比较类(== != 禁用)
  '\\*\\*=', '<<=', '>>=', '>>>=', '\\+\\+', '--',
  '\\+=', '-=', '\\*=', '/=', '%=', '&=', '\\|=', '\\^=',
  '<<', '>>>', '>>', '&&', '\\|\\|', '\\*\\*', '=>',  // 多字符运算符
  '[+\\-*/%<>=!~&|^?:;,.]',                           // 单字符运算符
  '[(){}\\[\\]]',                                     // 括号
  '\\s+',                                             // 空白
].join('|'), 'g');

const AJS_ILLEGAL_HINT = 'AetherJS 不支持该字符(模板字符串 / $ / 装饰器 / 私有字段等均不存在)';

function hlAjs(src, out) {
  let i = 0;
  let lastSig = '';   // 上一个非空白非注释词元(「.成员」着色依据)
  while (i < src.length) {
    AJS_TOKEN.lastIndex = i;
    const m = AJS_TOKEN.exec(src);
    if (!m || m.index > i) {                     // i 处是非法字符:标红一字符后继续
      out.push('tk-err', src[i], AJS_ILLEGAL_HINT);
      i++;
      continue;
    }
    const t = m[0];
    i = m.index + t.length;
    const c0 = t[0];
    if (c0 === '/' && t.length > 1) { out.push('tk-com', t); continue; }        // 注释不动 lastSig
    if (c0 === "'" || c0 === '"') { out.push('tk-str', t); lastSig = t; continue; }
    if (/\d/.test(c0) || (c0 === '.' && /\d/.test(t[1] || ''))) { out.push('tk-num', t); lastSig = t; continue; }
    if (/[A-Za-z_]/.test(c0)) {
      if (lastSig === '.') out.push('tk-prop', t);
      else if (AJS_KEYWORDS.has(t)) out.push('tk-kw', t);
      else if (AJS_LITERALS.has(t)) out.push('tk-lit', t);
      else if (AJS_BUILTINS.has(t)) out.push('tk-bi', t);
      else if (AJS_BANNED[t]) out.push('tk-err', t, `${AJS_BANNED[t]}(AetherJS 禁用)`);
      else out.push(null, t);
      lastSig = t;
      continue;
    }
    if (t === '==' || t === '!=') { out.push('tk-err', t, '禁止宽松相等:请用 === / !==(AetherJS 禁用)'); lastSig = t; continue; }
    if (/^\s+$/.test(t)) { out.push(null, t); continue; }                        // 空白不动 lastSig
    lastSig = t;
    if ('(){}[];,'.includes(t) || t === '.') out.push(null, t);
    else out.push('tk-op', t);
  }
}

/* ============================================================
 * CSS(状态机:选择器上下文 ⇄ 声明上下文,按花括号栈切换;
 *      @media 等嵌套规则体在栈里记 'rules',其内部仍是选择器)
 * ============================================================ */

const CSS_NUM = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px|em|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|ch|ex|fr|deg|grad|rad|turn|s|ms|Hz|kHz|%)?/;
/* 这些 at 规则的花括体是声明(无选择器),其余(@media/@keyframes…)是嵌套规则 */
const AT_DECL_RULES = new Set(['font-face', 'page', 'counter-style', 'property', 'viewport']);

function hlCss(src, out) {
  let i = 0, n = src.length;
  const stack = [];        // 每个开括号:'decl' 声明体 | 'rules' 嵌套规则体
  let sawSelector = false; // 本层自上个 { } ; 以来是否出现选择子(决定下一个 { 的内容)
  let atPrelude = false;   // 处于 at 规则前导(@word 到 { 或 ; 之间,条件词不当选择子)
  const inDecl = () => stack.length > 0 && stack[stack.length - 1] === 'decl';
  const str = () => {
    const q = src[i];
    let j = i + 1;
    while (j < n && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
    out.push('tk-str', src.slice(i, Math.min(j + 1, n)));
    i = Math.min(j + 1, n);
  };
  while (i < n) {
    const rest = src.slice(i);
    let m;
    if (rest.startsWith('/*')) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out.push('tk-com', src.slice(i, stop)); i = stop; continue;
    }
    const c = src[i];
    if (c === '"' || c === "'") { str(); continue; }
    if (c === '{') {
      stack.push(sawSelector ? 'decl' : 'rules');
      sawSelector = false; atPrelude = false;
      out.push('tk-op', c); i++; continue;
    }
    if (c === '}') {
      stack.pop();
      sawSelector = false; atPrelude = false;
      out.push('tk-op', c); i++; continue;
    }
    if (c === ';') { atPrelude = false; out.push(null, c); i++; continue; }
    if (!inDecl()) {
      /* 选择器 / at-rule 前导 */
      if ((m = /^@[\w-]+/.exec(rest))) {
        out.push('tk-kw', m[0]);
        atPrelude = !AT_DECL_RULES.has(m[0].slice(1));
        sawSelector = sawSelector || !atPrelude;   // @font-face 体按声明处理
        i += m[0].length; continue;
      }
      if ((m = /^#[\w-]+/.exec(rest))) { out.push('tk-id', m[0]); sawSelector = true; i += m[0].length; continue; }
      if ((m = /^\.[\w-]+/.exec(rest))) { out.push('tk-cls', m[0]); sawSelector = true; i += m[0].length; continue; }
      if ((m = /^::?[\w-]+(?:\([^)]*\))?/.exec(rest))) { out.push('tk-pseudo', m[0]); sawSelector = true; i += m[0].length; continue; }
      if ((m = /^[a-zA-Z][\w-]*/.exec(rest))) {
        if (atPrelude) out.push(null, m[0]);       // 前导条件词(max-width 等)
        else { out.push('tk-tag', m[0]); sawSelector = true; }
        i += m[0].length; continue;
      }
      if ((m = /^\s+/.exec(rest))) { out.push(null, m[0]); i += m[0].length; continue; }
      out.push(null, c); i++; continue;
    }
    /* 声明体:属性名 / 数字+单位 / 十六进制色 / 函数名 / !important / 值裸词 */
    if ((m = /^[\w-]+(?=\s*:)/.exec(rest))) { out.push('tk-prop', m[0]); i += m[0].length; continue; }
    if ((m = /^!important/.exec(rest))) { out.push('tk-kw', m[0]); i += m[0].length; continue; }
    if ((m = /^#[0-9a-fA-F]{3,8}\b/.exec(rest))) { out.push('tk-num', m[0]); i += m[0].length; continue; }
    if ((m = CSS_NUM.exec(rest)) && /\d/.test(m[0])) { out.push('tk-num', m[0]); i += m[0].length; continue; }
    if ((m = /^[\w-]+(?=\()/.exec(rest))) { out.push('tk-bi', m[0]); i += m[0].length; continue; }
    if ((m = /^[\w-]+/.exec(rest))) { out.push(null, m[0]); i += m[0].length; continue; }
    if ((m = /^\s+/.exec(rest))) { out.push(null, m[0]); i += m[0].length; continue; }
    out.push('tk-op', c); i++;
  }
}

/* ============================================================
 * HTML(标签/属性/注释/实体 + AetherWebFramework 模板插值)
 * ============================================================ */

function hlHtml(src, out) {
  let i = 0, n = src.length;
  while (i < n) {
    const rest = src.slice(i);
    let m;
    if (rest.startsWith('<!--')) {
      const end = src.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      out.push('tk-com', src.slice(i, stop)); i = stop; continue;
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      const end = src.indexOf('>', i);
      const stop = end < 0 ? n : end + 1;
      out.push('tk-com', src.slice(i, stop)); i = stop; continue;
    }
    if (src[i] === '<' && /[a-zA-Z/]/.test(src[i + 1] || '')) {
      /* 标签:< 名 属性=值 … >;style/script 内嵌内容递归着色 */
      out.push(null, '<');
      i++;
      if (src[i] === '/') { out.push(null, '/'); i++; }
      const tm = /^[a-zA-Z][\w-]*/.exec(src.slice(i));
      if (!tm) { out.push('tk-err', src[i] || ''); i++; continue; }
      const tag = tm[0].toLowerCase();
      out.push('tk-tag', tm[0]);
      i += tm[0].length;
      let closed = false;
      while (i < n && !closed) {
        const r2 = src.slice(i);
        let am;
        if (r2.startsWith('/>')) { out.push(null, '/>'); i += 2; closed = true; break; }
        if (src[i] === '>') { out.push(null, '>'); i++; closed = true; break; }
        if ((am = /^\s+/.exec(r2))) { out.push(null, am[0]); i += am[0].length; continue; }
        if ((am = /^[\w-]+/.exec(r2))) { out.push('tk-attr', am[0]); i += am[0].length; continue; }
        if (src[i] === '=') { out.push(null, '='); i++; continue; }
        if (src[i] === '"' || src[i] === "'") {
          const q = src[i];
          let j = i + 1;
          while (j < n && src[j] !== q) j++;
          out.push('tk-str', src.slice(i, Math.min(j + 1, n))); i = Math.min(j + 1, n); continue;
        }
        out.push(null, src[i]); i++;
      }
      /* 内嵌样式/脚本:</style> 前按 CSS、</script> 前按 AetherJS */
      if (tag === 'style' || tag === 'script') {
        const close = src.toLowerCase().indexOf(`</${tag}`, i);
        const stop = close < 0 ? n : close;
        (tag === 'style' ? hlCss : hlAjs)(src.slice(i, stop), out);
        i = stop;
      }
      continue;
    }
    /* 文本:{{模板}} 插值/指令 + 实体 + 普通 */
    if (rest.startsWith('{{')) {
      const end = src.indexOf('}}', i + 2);
      const hasClose = end >= 0;
      const stop = hasClose ? end + 2 : n;
      const raw = src.slice(i + 2, hasClose ? end : n);
      out.push('tk-tpl', '{{');
      const dm = /^(\s*)(#if|#each|else|\/if|\/each)(?:(\s+)([\s\S]*?))?(\s*)$/.exec(raw);
      if (dm) {
        if (dm[1]) out.push(null, dm[1]);
        out.push('tk-kw', dm[2]);
        if (dm[3]) out.push(null, dm[3]);
        if (dm[4]) hlAjs(dm[4], out);        // 指令表达式
        if (dm[5]) out.push(null, dm[5]);
      } else {
        const lm = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
        if (lm[1]) out.push(null, lm[1]);
        hlAjs(lm[2], out);                   // 插值表达式
        if (lm[3]) out.push(null, lm[3]);
      }
      if (hasClose) out.push('tk-tpl', '}}');
      i = stop; continue;
    }
    if ((m = /^&#?\w+;/.exec(rest))) { out.push('tk-ent', m[0]); i += m[0].length; continue; }
    if ((m = /^[^<{&]+/.exec(rest))) { out.push(null, m[0]); i += m[0].length; continue; }
    out.push(null, src[i]); i++;
  }
}

/* ============================================================
 * JSON(字符串按「后跟冒号」区分为键)
 * ============================================================ */

function hlJson(src, out) {
  const re = /"(?:\\.|[^"\\])*"?|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|null/g;
  let m, last = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(null, src.slice(last, m.index));
    const t = m[0];
    if (t[0] === '"') {
      let j = re.lastIndex;
      while (j < src.length && /\s/.test(src[j])) j++;
      out.push(src[j] === ':' ? 'tk-prop' : 'tk-str', t);
    } else if (/[0-9]/.test(t[0])) out.push('tk-num', t);
    else out.push('tk-lit', t);
    last = re.lastIndex;
  }
  if (last < src.length) out.push(null, src.slice(last));
}

/* ---------- 入口 ---------- */

const FN = { ajs: hlAjs, css: hlCss, html: hlHtml, json: hlJson };

/** 源码 → 高亮 HTML(文本全部转义;lang 不认识按纯文本) */
export function highlight(code, lang) {
  const s = sink();
  const fn = FN[lang];
  if (fn) fn(String(code), s);
  else s.push(null, String(code));
  return s.html();
}
