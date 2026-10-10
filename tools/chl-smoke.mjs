/* ============================================================
 * chl 语法高亮库冒烟测试(node 直接跑,纯函数无 DOM):
 *   node tools/chl-smoke.mjs
 * 覆盖四语言词法类、禁字标红、未闭合容错,以及「产物去标签后
 * 与源码逐字符一致」的对齐不变量(编辑器双层方案的前提)。
 * ============================================================ */
import { highlight, langOf } from '../js/lib/chl.js';

const strip = (s) => s
  .replace(/<span[^>]*>/g, '')
  .replace(/<\/span>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&');

let fails = 0;
const ok = (name, cond) => { if (!cond) { fails++; console.log('FAIL', name); } };

/* 1) AetherJS */
const ajs = [
  '// 行注释',
  'let x = 42; /* 块注释 */',
  "const s = 'a\\nb';",
  'var y = 1 == 2;',
  'if (x >= 40 && x <= 99) { print(str(x)); }',
  'let t = `tpl`;',
].join('\n');
const h = highlight(ajs, 'ajs');
ok('ajs kw', h.includes('tk-kw">let'));
ok('ajs str', h.includes('tk-str">') );
ok('ajs com', h.includes('tk-com">// 行注释'));
ok('ajs num', h.includes('tk-num">42'));
ok('ajs banned var', h.includes('tk-err" title="禁止 var'));
ok('ajs banned ==', h.includes(')">==<'));
ok('ajs ge', h.includes('tk-op">&gt;='));
ok('ajs le', h.includes('tk-op">&lt;='));
ok('ajs bi', h.includes('tk-bi">print'));
ok('ajs backtick err', h.includes('tk-err" title="AetherJS 不支持'));
ok('ajs align', strip(highlight(ajs, 'ajs')) === ajs);

/* 未闭合字符串优雅到行尾 */
const unterm = "let a = 'abc\nlet b = 2;";
const hu = highlight(unterm, 'ajs');
ok('unterm str', hu.includes("tk-str\">'abc"));
ok('unterm align', strip(hu) === unterm);

/* 2) HTML + 模板 */
const html = '<div class="card" ref=hp>{{user.name + "!"}}{{#if score > 9}}金{{else}}普通{{/if}}'
  + '<!-- c -->&amp;<style>p { color: red; }</style>';
const h2 = highlight(html, 'html');
ok('html tag', h2.includes('tk-tag">div'));
ok('html attr', h2.includes('tk-attr">class'));
ok('html str', h2.includes('tk-str">&quot;card&quot;'));
ok('html tpl', h2.includes('tk-tpl">{{'));
ok('html if kw', h2.includes('tk-kw">#if'));
ok('html each kw', highlight('{{#each items as it}}', 'html').includes('tk-kw">#each'));
ok('html com', h2.includes('tk-com">&lt;!-- c --&gt;'));
ok('html ent', h2.includes('tk-ent">&amp;amp;'));
ok('html style css', h2.includes('tk-prop">color'));
ok('html align', strip(h2) === html);

/* 3) CSS */
const css = '/* c */ .card:hover, a { color: #ff0000; margin: 4px 2em none; } '
  + '@media (max-width: 600px) { a:hover { display: none !important; } } '
  + '@font-face { font-family: x; }';
const h3 = highlight(css, 'css');
ok('css cls', h3.includes('tk-cls">.card'));
ok('css pseudo', h3.includes('tk-pseudo">:hover'));
ok('css prop', h3.includes('tk-prop">color'));
ok('css hex', h3.includes('tk-num">#ff0000'));
ok('css unit', h3.includes('tk-num">4px'));
ok('css media kw', h3.includes('tk-kw">@media'));
ok('css media inner pseudo', /@media[\s\S]*tk-pseudo">:hover/.test(h3));
ok('css media inner prop', /@media[\s\S]*tk-prop">display/.test(h3));
ok('css important', h3.includes('tk-kw">!important'));
ok('css fontface prop', /@font-face[\s\S]*tk-prop">font-family/.test(h3));
ok('css value bareword plain', !/tk-op">n/.test(h3));
ok('css align', strip(h3) === css);

/* 4) JSON */
const json = '{ "name": "a", "n": [1, 2.5, true, null] }';
const h4 = highlight(json, 'json');
ok('json prop', h4.includes('tk-prop">&quot;name&quot;'));
ok('json str', h4.includes('tk-str">&quot;a&quot;'));
ok('json num', h4.includes('tk-num">2.5'));
ok('json lit', h4.includes('tk-lit">true'));
ok('json align', strip(h4) === json);

/* 5) 语言识别 */
ok('lang ajs', langOf('a.ajs') === 'ajs');
ok('lang js', langOf('b.js') === 'ajs');
ok('lang css', langOf('c.CSS') === 'css');
ok('lang html', langOf('d.html') === 'html' && langOf('e.htm') === 'html');
ok('lang json', langOf('f.json') === 'json');
ok('lang txt', langOf('g.txt') === '');

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
