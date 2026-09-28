#!/usr/bin/env node
/* ============================================================
 * md.js 解析渲染冒烟测试(纯函数,无需浏览器)
 *   node tools/md-smoke.mjs          全部用例
 *   npm run test:md                  同上(package.json 快捷方式)
 * 输出 PASS/FAIL 清单,任一失败退出码 1。
 * ============================================================ */
import { render, parse, blockHtml, renderBlocks } from '../js/lib/md.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = String(got), w = String(want);
  if (g === w) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      got  ${JSON.stringify(g)}\n      want ${JSON.stringify(w)}`); }
}

/* ---------- 标题 ---------- */
eq('ATX h1', render('# 标题'), '<h1>标题</h1>');
eq('ATX h3 收尾井号', render('### H3 ###'), '<h3>H3</h3>');
eq('ATX 无空格不算标题', render('#foo'), '<p>#foo</p>');
eq('ATX 七级井号不算标题', render('#######'), '<p>#######</p>');
eq('Setext h1', render('标题\n==='), '<h1>标题</h1>');
eq('Setext h2', render('副题\n---'), '<h2>副题</h2>');
eq('独立 --- 是分隔线', render('---'), '<hr>');
eq('- - - 也是分隔线', render('- - -'), '<hr>');
eq('*** 分隔线', render('***'), '<hr>');

/* ---------- 段落与换行 ---------- */
eq('单段落', render('你好'), '<p>你好</p>');
eq('两段落空行分隔', render('a\n\nb'), '<p>a</p><p>b</p>');
eq('软换行渲染为换行(Typora 式)', render('a\nb'), '<p>a<br>b</p>');
eq('行尾两空格硬换行', render('a  \nb'), '<p>a<br>b</p>');
eq('行尾反斜杠硬换行', render('a\\\nb'), '<p>a<br>\nb</p>');
eq('空文档', render(''), '');
eq('仅空行', render('\n\n\n'), '');

/* ---------- 行内强调 ---------- */
eq('粗体', render('**加粗**'), '<p><strong>加粗</strong></p>');
eq('斜体', render('*斜体*'), '<p><em>斜体</em></p>');
eq('下划线斜体', render('_斜_'), '<p><em>斜</em></p>');
eq('下划线词内不生效', render('a_b_c'), '<p>a_b_c</p>');
eq('嵌套强调', render('**a *b* c**'), '<p><strong>a <em>b</em> c</strong></p>');
eq('嵌套强调 2', render('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
eq('删除线', render('~~删除~~'), '<p><s>删除</s></p>');
eq('单个波浪号原样', render('~x~'), '<p>~x~</p>');
eq('星号转义', render('\\*不是斜体\\*'), '<p>*不是斜体*</p>');

/* ---------- 行内代码 ---------- */
eq('行内代码', render('`let x = 1`'), '<p><code>let x = 1</code></p>');
eq('行内代码嵌反引号', render('``a`b``'), '<p><code>a`b</code></p>');
eq('行内代码内不解析强调', render('`**b**`'), '<p><code>**b**</code></p>');

/* ---------- 链接 / 图片 ---------- */
eq('行内链接', render('[文本](https://a.b)'),
  '<p><a href="https://a.b" target="_blank" rel="noopener">文本</a></p>');
eq('链接带标题', render('[文本](https://a.b "提示")'),
  '<p><a href="https://a.b" title="提示" target="_blank" rel="noopener">文本</a></p>');
eq('图片', render('![替代](/img.png "题")'),
  '<p><img src="/img.png" alt="替代" title="题" loading="lazy"></p>');
eq('引用式链接', render('[go]: https://x.y "T"\n见 [go][go] 与 [go]'),
  '<p>见 <a href="https://x.y" title="T" target="_blank" rel="noopener">go</a> 与 <a href="https://x.y" title="T" target="_blank" rel="noopener">go</a></p>');
eq('自动链接', render('<https://x.y>'),
  '<p><a href="https://x.y" target="_blank" rel="noopener">https://x.y</a></p>');
eq('邮箱自动链接', render('<a@b.c>'),
  '<p><a href="mailto:a@b.c" target="_blank" rel="noopener">a@b.c</a></p>');
eq('未定义引用按字面', render('[无]'), '<p>[无]</p>');
eq('中括号内强调仍生效', render('[**粗**](x)'), '<p><a href="x" target="_blank" rel="noopener"><strong>粗</strong></a></p>');

/* ---------- 安全(不透传 HTML / 协议白名单) ---------- */
eq('拒绝 javascript: 链接', render('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
eq('拒绝 data: 链接', render('[x](data:text/html;base64,xxx)'), '<p>[x](data:text/html;base64,xxx)</p>');
eq('script 标签被转义', render('<script>alert(1)</script>'),
  '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
eq('文本中的尖括号转义', render('a < b > c'), '<p>a &lt; b &gt; c</p>');
eq('属性注入转义', render('["onx](y "z&quot;")'),
  '<p><a href="y" title="z&amp;quot;" target="_blank" rel="noopener">&quot;onx</a></p>');
eq('图片允许 data:image/', render('![](data:image/png;base64,AAA)'),
  '<p><img src="data:image/png;base64,AAA" alt="" loading="lazy"></p>');

/* ---------- 代码块 ---------- */
eq('围栏代码带语言', render('```js\nconst a = 1\n```'),
  '<pre class="md-code" data-lang="js"><code>const a = 1</code></pre>');
eq('波浪围栏', render('~~~\nx\n~~~'), '<pre class="md-code"><code>x</code></pre>');
eq('未闭合围栏到文末', render('```\nabc'), '<pre class="md-code"><code>abc</code></pre>');
eq('围栏内不解析', render('```\n# 不是标题\n**不是粗体**\n```'),
  '<pre class="md-code"><code># 不是标题\n**不是粗体**</code></pre>');
eq('缩进代码块', render('    indented'), '<pre class="md-code"><code>indented</code></pre>');

/* ---------- 引用 ---------- */
eq('引用', render('> 引用内容'), '<blockquote><p>引用内容</p></blockquote>');
eq('引用懒延续', render('> a\nb'), '<blockquote><p>a<br>b</p></blockquote>');
eq('嵌套引用', render('> > 深'), '<blockquote><blockquote><p>深</p></blockquote></blockquote>');
eq('引用内的列表', render('> - a\n> - b'), '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');

/* ---------- 列表 ---------- */
eq('无序列表', render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
eq('有序列表', render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
eq('有序起始编号', render('3. x'), '<ol start="3"><li>x</li></ol>');
eq('嵌套列表', render('- a\n  - b'), '<ul><li><p>a</p><ul><li>b</li></ul></li></ul>');
eq('松散列表', render('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
eq('列表懒延续', render('- a\nb'), '<ul><li>a<br>b</li></ul>');
eq('任务列表', render('- [ ] 待办\n- [x] 完成'),
  '<ul>'
  + '<li class="md-task-item"><span class="md-check" role="checkbox"></span><p>待办</p></li>'
  + '<li class="md-task-item"><span class="md-check on" role="checkbox"></span><p>完成</p></li>'
  + '</ul>');
eq('换标记符换列表', render('- a\n* b'), '<ul><li>a</li></ul><ul><li>b</li></ul>');
eq('无序转有序换列表', render('- a\n1. x'), '<ul><li>a</li></ul><ol><li>x</li></ol>');
eq('空任务项', render('- [ ]'), '<ul><li class="md-task-item"><span class="md-check" role="checkbox"></span></li></ul>');

/* ---------- 表格 ---------- */
eq('表格与对齐', render('| A | B |\n|---|:-:|\n| 1 | 2 |'),
  '<div class="md-table-wrap"><table><thead><tr><th>A</th><th style="text-align:center">B</th></tr></thead>'
  + '<tbody><tr><td>1</td><td style="text-align:center">2</td></tr></tbody></table></div>');
eq('表格单元格行内语法', render('| a *b* |\n|---|\n| `c` |'),
  '<div class="md-table-wrap"><table><thead><tr><th>a <em>b</em></th></tr></thead>'
  + '<tbody><tr><td><code>c</code></td></tr></tbody></table></div>');
eq('表格行含转义竖线', render('| a \\| b |\n|---|\n| c |'),
  '<div class="md-table-wrap"><table><thead><tr><th>a | b</th></tr></thead>'
  + '<tbody><tr><td>c</td></tr></tbody></table></div>');

/* ---------- 块级 API:行区间(编辑器依赖) ---------- */
{
  const src = '# 标题\n\n第一段\n续行\n\n- 甲\n- 乙\n\n```js\ncode\n```';
  const { blocks, lines } = parse(src);
  eq('行区间:标题', [blocks[0].s, blocks[0].e], [0, 1]);
  eq('行区间:段落', [blocks[1].s, blocks[1].e], [2, 4]);
  eq('行区间:列表', [blocks[2].s, blocks[2].e], [5, 7]);
  eq('行区间:围栏', [blocks[3].s, blocks[3].e], [8, 11]);
  eq('行区间:块原文可还原', lines.slice(blocks[1].s, blocks[1].e).join('\n'), '第一段\n续行');
  eq('单块渲染', blockHtml(blocks[0], {}), '<h1>标题</h1>');
  eq('多块渲染 = 整篇渲染', renderBlocks(blocks, parse(src).defs), render(src));
}

/* ---------- 崩溃兜底(奇怪输入不抛异常) ---------- */
{
  const weird = ['*', '**', '[', '](', '![', '~~', '`', '\\', '|', '>>>>', '##########', '1.', '- [] [x]', '[]()', '![]()', '&', '\u0000'];
  let ok = true;
  for (const w of weird) {
    try { render(w + '\n' + w); } catch (e) { ok = false; console.log(`      崩溃于 ${JSON.stringify(w)}: ${e.message}`); }
  }
  eq('奇怪输入不抛异常', ok, true);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
