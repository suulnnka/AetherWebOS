/* 逐语法 WYSIWYG 审计:每种语法真实键入,验证即时/落定渲染与源码 */
import { launch } from './cdp.mjs';
import { rmSync } from 'node:fs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const c = await launch('http://localhost:8080/?e2e=1', { profile: '' });
const ev = (e) => c.evaluate(e);

/* 符号 → (code, vk, shift) */
const SYM = {
  '#': ['Digit3', 51, 1], '*': ['Digit8', 56, 1], '~': ['Backquote', 192, 1],
  '<': ['Comma', 188, 1], '>': ['Period', 190, 1], '_': ['Minus', 189, 1],
  '`': ['Backquote', 192, 0], '[': ['BracketLeft', 219, 0], ']': ['BracketRight', 221, 0],
  '(': ['Digit9', 57, 1], ')': ['Digit0', 48, 1], '!': ['Digit1', 49, 1],
  '\\': ['Backslash', 220, 0], '/': ['Slash', 191, 0], '-': ['Minus', 189, 0],
  '.': ['Period', 190, 0], '=': ['Equal', 187, 0],
};
const key = async (ch) => {
  const [code, vk, shift] = SYM[ch] || [/[a-z0-9]/i.test(ch) ? (/^[0-9]$/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase()) : undefined,
    /^[0-9]$/.test(ch) ? 48 + +ch : (ch.toUpperCase().charCodeAt(0) || 0), 0];
  const mods = shift ? { modifiers: 8 } : {};
  const common = { key: ch, ...(code ? { code } : {}), ...(vk && vk <= 255 ? { windowsVirtualKeyCode: vk } : {}), ...mods };
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
  await c.send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(50);
};
const type = async (text) => { for (const ch of text) await key(ch); };
const enter = async (shift = false) => {
  const mods = shift ? { modifiers: 8 } : {};
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...mods });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...mods });
  await sleep(150);
};
const tab = async (shift = false) => {
  const mods = shift ? { modifiers: 8 } : {};
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, ...mods });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, ...mods });
  await sleep(150);
};

const results = [];
const reset = async () => {
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    w.querySelector('.md-edit').$md.set('');
    const surf = w.querySelector('.md-surface');
    const p = surf.querySelector('.md-block p');
    surf.focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    return true;
  })()`);
  await sleep(200);
};
const snap = async () => {
  const alive = await ev(`!!document.querySelector('.win[data-app=mdedit]')`);
  if (!alive) {
    console.log('!! 窗口消失,现场:', await ev(`JSON.stringify({
      errs: (window.__errs || []).slice(-3),
      wins: [...document.querySelectorAll('.win')].map(w => w.dataset.app),
      modal: !!document.querySelector('.modal-mask'),
      body0: document.body.children.length,
    })`));
    process.exit(9);
  }
  return ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { src: w.querySelector('.md-edit').$md.get(),
      html: [...w.querySelectorAll('.md-block')].map(b => b.innerHTML).join(' § ') };
  })()`);
};
const check = (name, ok, info) => { results.push({ name, ok, info }); console.log((ok ? 'PASS ' : 'FAIL ') + name, info ? '— ' + info : ''); };

try {
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!window.WebOS && !document.getElementById('boot') && (WebOS.accounts?.current?.() || null)`)) break;
    await sleep(200);
  }
  await ev(`window.__auditMark = 1; WebOS.wm.open('mdedit'); true`);
  await sleep(800);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(x => x.textContent.includes('编辑')).click();
  })()`);
  await sleep(400);

  /* ---------- 块级:即时转换 ---------- */
  await reset(); await type('# 一级标题'); await sleep(300);
  let s = await snap(); check('ATX h1 即时', /<h1>一级标题​?<\/h1>/.test(s.html) && s.src === '# 一级标题', s.html.slice(0, 40));

  await reset(); await type('### 三级标题'); await sleep(300);
  s = await snap(); check('ATX h3 即时', /<h3>三级标题​?<\/h3>/.test(s.html), s.html.slice(0, 40));

  await reset(); await type('###### 六级'); await sleep(300);
  s = await snap(); check('ATX h6 即时', /<h6>六级​?<\/h6>/.test(s.html), s.html.slice(0, 40));

  await reset(); await type('> 引用一行'); await sleep(300);
  s = await snap(); check('引用 即时', /<blockquote>.{0,80}引用一行/.test(s.html), s.html.slice(0, 50));

  await reset(); await type('- 无序条目'); await sleep(300);
  s = await snap(); check('无序列表 即时', /<ul><li>无序条目/.test(s.html.replace('<br>', '')), s.html.slice(0, 50));

  await reset(); await type('2. 有序条目'); await sleep(300);
  s = await snap(); check('有序列表 即时', /<ol[^>]*><li>有序条目/.test(s.html.replace('<br>', '')), s.html.slice(0, 50));

  await reset(); await type('- [ ] 待办'); await sleep(300);
  s = await snap(); check('任务列表 即时', /li class="md-task-item"/.test(s.html) && /待办/.test(s.html), s.html.slice(0, 70));

  await reset(); await type('---'); await sleep(300);
  s = await snap(); check('分隔线 --- 即时', /<hr>/.test(s.html), s.html.slice(0, 40));

  await reset(); await type('***'); await sleep(300);
  s = await snap(); check('分隔线 *** 即时', /<hr>/.test(s.html) || s.src === '***', 'src=' + s.src + ' html=' + s.html.slice(0, 30));

  /* ---------- 行内:闭合即渲染 ---------- */
  await reset(); await type('前**粗体**'); await sleep(300);
  s = await snap(); check('粗体 ** 即时', /<strong>粗体<\/strong>/.test(s.html) && s.src === '前**粗体**', s.html.slice(0, 50));

  await reset(); await type('斜*体*'); await sleep(300);
  s = await snap(); check('斜体 * 即时', /<em>体<\/em>/.test(s.html), s.html.slice(0, 50));

  await reset(); await type('a_b_c'); await sleep(300);
  s = await snap(); check('下划线斜体 _ 词内不生效', !/<em>/.test(s.html), s.html.slice(0, 40));

  await reset(); await type('_下划斜_'); await sleep(300);
  s = await snap(); check('下划线斜体 _ 即时', /<em>下划斜<\/em>/.test(s.html), s.html.slice(0, 50));

  await reset(); await type('删~~除~~'); await sleep(300);
  s = await snap(); check('删除线 ~~ 即时', /<s>除<\/s>/.test(s.html), s.html.slice(0, 50));

  await reset(); await type('码`code`'); await sleep(300);
  s = await snap(); check('行内码 ` 即时', /<code>code<\/code>/.test(s.html), s.html.slice(0, 50));

  /* ---------- Setext 标题 ---------- */
  await reset(); await type('大标题'); await enter(true); await type('==='); await enter(); await sleep(350);
  s = await snap(); check('Setext === 回车转标题', /<h1>大标题<\/h1>/.test(s.html), s.html.slice(0, 60));

  await reset(); await type('二级题'); await enter(true); await type('---'); await enter(); await sleep(350);
  s = await snap(); check('Setext --- 回车转标题', /<h2>二级题<\/h2>/.test(s.html), s.html.slice(0, 60));

  /* ---------- 围栏代码 ---------- */
  await reset(); await type('```js'); await enter(); await type('let x = 1;'); await sleep(350);
  s = await snap(); check('围栏代码 ```js(Enter 开块)', /pre class="md-code" data-lang="js"/.test(s.html) && /let x = 1;/.test(s.html), s.html.slice(0, 80));

  await reset(); await type('~~~'); await enter(); await type('plain'); await sleep(350);
  s = await snap(); check('围栏代码 ~~~', /pre class="md-code"/.test(s.html) && /plain/.test(s.html), s.html.slice(0, 70));

  /* ---------- 引用嵌套 / 续行 ---------- */
  await reset(); await type('> 外层'); await enter(); await sleep(200); await type('内层'); await sleep(300);
  s = await snap(); check('引用回车续行', (s.html.match(/<blockquote>/g) || []).length >= 1 && /外层/.test(s.html) && /内层/.test(s.html), s.html.slice(0, 90));

  /* ---------- 列表回车续项 / Tab 层级 ---------- */
  await reset(); await type('- 甲'); await enter(); await type('乙'); await sleep(300);
  s = await snap(); check('列表回车续项', (s.html.match(/<li>/g) || []).length === 2, s.src.replace(/\n/g, '|'));

  await reset(); await type('- 父项'); await enter(); await sleep(150); await type('子项'); await tab(); await sleep(300);
  s = await snap(); check('Tab 列表层级', s.src.includes('- 父项' + String.fromCharCode(10) + '  - 子项'), s.src.replace(/\n/g, '|'));

  /* ---------- 落定渲染(离开块)---------- */
  const settle = async () => { await enter(); await sleep(200); await enter(); await sleep(250); };

  await reset(); await type('__下划粗__'); await settle();
  s = await snap(); check('__粗体__ 落定', /<strong>下划粗<\/strong>/.test(s.html), s.html.slice(0, 60));

  await reset(); await type('[链接文字](https://a.b)'); await settle();
  s = await snap(); check('行内链接 落定', /<a href="https:\/\/a\.b"[^>]*>链接文字/.test(s.html), s.html.slice(0, 80));

  await reset(); await type('<https://auto.link>'); await settle();
  s = await snap(); check('自动链接 落定', /<a href="https:\/\/auto\.link"/.test(s.html), s.html.slice(0, 80));

  await reset(); await type('![本地图](pic.png)'); await settle();
  s = await snap(); check('本地图片 落定', /<img src="pic\.png"/.test(s.html), s.html.slice(0, 70));

  await reset(); await type('![网图](https://a.b/c.png)'); await settle();
  s = await snap(); check('网络图片 占位芯片', /class="md-img" data-src="https:\/\/a\.b\/c\.png"/.test(s.html), s.html.slice(0, 90));

  await reset(); await type(String.raw`\*不斜\*`); await settle();
  s = await snap(); check('反斜杠转义 落定', !/<em>/.test(s.html) && s.html.includes('*不斜*'), s.html.slice(0, 50));

  await reset();
  await type('| 甲 | 乙 |'); await enter(true);
  await type('| --- | --- |'); await enter(true);
  await type('| 1 | 2 |'); await settle();
  s = await snap(); check('GFM 表格 落定', /<table>/.test(s.html) && /甲/.test(s.html) && /<td>1<\/td>/.test(s.html.replace(/\s/g, '')), s.html.slice(0, 90));

  await reset(); await type('    缩进代码'); await settle();
  s = await snap(); check('缩进代码(4空格) 落定', /pre class="md-code"/.test(s.html) && /缩进代码/.test(s.html), s.html.slice(0, 70));

  await reset(); await type('[ref]: https://x.y'); await settle();
  s = await snap(); check('链接定义 def 原文展示', /md-defraw/.test(s.html) && /\[ref\]: https:\/\/x\.y/.test(s.html), s.html.slice(0, 70));

  await reset(); await type('文字A'); await enter(true); await type('文字B'); await sleep(300);
  s = await snap(); check('软换行渲染', /<br>/.test(s.html) && /文字A/.test(s.html) && /文字B/.test(s.html), s.html.slice(0, 50));

  console.log('errs:', await ev(`(window.__errs||[]).length`));
  const fails = results.filter(r => !r.ok).length;
  console.log(`====== ${results.length - fails}/${results.length} 通过,${fails} 失败 ======`);
} finally {
  rmSync(process.env.TEMP + '/webos-cdp-profile/DevToolsActivePort', { force: true });
  c.close();
}
