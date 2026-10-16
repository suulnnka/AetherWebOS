/* ============================================================
 * AetherWebOS e2e 用例组 · 编辑器 · 数据 · 商店(T48 T49 T50 T57 T61)
 * 自原 e2e.mjs 单文件按域拆出;公共助手见 tools/e2e-harness.mjs。
 * 本文件只做 group() 注册(被入口 tools/e2e.mjs import),不要直接运行。
 * ============================================================ */
import { group, t, ev, c, fresh, sleep, waitFor, needApps, termType, nav, bashType, bashOut, ctxClick, typeReal, pressEnter, clickReal, wipeAppData, wipeSharedAppData } from '../e2e-harness.mjs';

group('T48', 'Markdown 编辑器(自研解析库 / 所见即所得 / .md 分流)', async () => {
  /* ---- T48 Markdown:md.js 库渲染 + mdedit 应用 + 文件管家分流 ---- */
  await fresh();
  await ev(`WebOS.wm.open('mdedit')`);
  await sleep(700);
  // 标记首窗口:后续多窗口步骤按标记区分,不依赖 DOM 顺序(聚焦会重排 z 序)
  await ev(`document.querySelector('.win[data-app=mdedit]').__first = true`);

  // 骨架:固定操作栏;只读起步(编辑面只读,操作栏置灰),编辑键可点
  const s0 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    const eb = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑'));
    const surf = w.querySelector('.md-surface');
    return { edit: !!w.querySelector('.md-edit'), ro: surf?.contentEditable,
             btns: w.querySelectorAll('.md-tbtn').length, blocks: w.querySelectorAll('.md-block').length,
             eb: !!eb, ebOn: eb ? !eb.disabled : false };
  })()`);
  t('T48 编辑器骨架(操作栏;只读起步,编辑键可点)', s0.edit && s0.ro === 'false' && s0.btns >= 15 && s0.blocks === 1 && s0.eb && s0.ebOn, JSON.stringify(s0));

  // 语法渲染全景:编辑键解锁写入 →「完成」回只读,整篇渲染断言
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑')).click();
    w.querySelector('.md-edit').$md.set('# 标题一\\n\\n正文 **加粗** 与 \`行内码\`\\n\\n- [ ] 任务 A\\n- [x] 任务 B\\n\\n> 引用一行\\n\\n| 甲 | 乙 |\\n| --- | --- |\\n| 1 | 2 |');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('完成')).click();
  })()`);
  await sleep(250);
  const s1 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return {
      h1: w.querySelector('.md-block h1')?.textContent,
      strong: w.querySelector('.md-block strong')?.textContent,
      code: w.querySelector('.md-block p code')?.textContent,
      checks: w.querySelectorAll('.md-check').length,
      on: w.querySelectorAll('.md-check.on').length,
      quote: w.querySelector('.md-block blockquote')?.textContent,
      table: w.querySelector('.md-block table')?.textContent,
      blocks: w.querySelectorAll('.md-block').length,
      head5: w.querySelector('.md-edit').$md.get().slice(0, 5),
    };
  })()`);
  t('T48.1 语法渲染(标题/粗体/行内码)', s1.h1 === '标题一' && s1.strong === '加粗' && s1.code === '行内码', JSON.stringify(s1));
  t('T48.2 任务/引用/表格渲染', s1.checks === 2 && s1.on === 1 && s1.quote.includes('引用一行') && s1.table.includes('乙') && s1.blocks === 5, '');
  t('T48.3 源串即事实($md.get 原文可回)', s1.head5 === '# 标题一', s1.head5);

  // 任务勾选 → 回写 markdown 源码:先点「编辑」解锁,再点复选框(组件监听 pointerdown)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑')).click();
  })()`);
  await sleep(200);
  await ev(`(() => {
    document.querySelector('.win[data-app=mdedit] .md-check')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  })()`);
  await sleep(150);
  const s2 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { src: w.querySelector('.md-edit').$md.get(), on: w.querySelectorAll('.md-check.on').length };
  })()`);
  t('T48.4 勾选回写源码', s2.src.includes('[x] 任务 A') && s2.on === 2, JSON.stringify(s2.src.match(/- \\[.\\] 任务 A/)));

  // 渲染态直编:解锁后真实输入 # 实时标题 → 即时变标题(Notion/Typora 式)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    w.querySelector('.md-edit').$md.set('');
    const surf = w.querySelector('.md-surface');
    surf.focus();
    const p = surf.querySelector('.md-block p');
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertText', false, '# 实时标题');
    return true;
  })()`);
  await sleep(350);                                            // rAF 局部重渲染
  const s2b = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    const blk = w.querySelector('.md-block');
    const h = blk.querySelector('h1');
    return { h1: h?.textContent, src: w.querySelector('.md-edit').$md.get(),
             clean: getComputedStyle(blk).boxShadow === 'none',
             ce: w.querySelector('.md-surface').contentEditable };
  })()`);
  t('T48.4a 输入即转标题(渲染态直编 / 块无装饰)',
    s2b.h1 === '实时标题' && s2b.src === '# 实时标题' && s2b.clean && s2b.ce === 'true', JSON.stringify(s2b));

  // 回归:桌面图标选中态下在编辑器内回车,不得打开桌面选中项(曾致弹窗不止)
  await ev(`(() => {
    document.querySelector('.dicon')?.classList.add('selected');
    const surf = document.querySelector('.win[data-app=mdedit] .md-surface');
    surf.focus();
    surf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);;
  await sleep(300);
  const s2c = await ev(`(() => {
    document.querySelectorAll('.dicon.selected').forEach(d => d.classList.remove('selected'));
    return { apps: [...document.querySelectorAll('.win')].map(w => w.dataset.app),
             src: document.querySelector('.win[data-app=mdedit] .md-edit').$md.get() };
  })()`);
  t('T48.4b 编辑器内回车不触发桌面选中项',
    s2c.apps.filter(a => a === 'mdedit').length === 1 && !s2c.apps.includes('files') && !s2c.apps.includes('notes')
    && s2c.src.includes('\n'), JSON.stringify(s2c.apps));

  // 行内输入规则(Milkdown 式):**乙** 一经敲成闭合组合,块内立即渲染粗体
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    w.querySelector('.md-edit').$md.set('');
    const surf = w.querySelector('.md-surface');
    const p = surf.querySelector('.md-block p');
    surf.focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertText', false, '甲**乙**');
    return true;
  })()`);
  await sleep(400);
  const s2d = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { strong: w.querySelectorAll('.md-block strong').length,
      txt: w.querySelector('.md-block strong')?.textContent,
      src: w.querySelector('.md-edit').$md.get() };
  })()`);
  t('T48.4c 行内输入规则(** 闭合即渲染)', s2d.strong === 1 && s2d.txt === '乙' && s2d.src === '甲**乙**', JSON.stringify(s2d));

  // 斜杠命令菜单:/ 唤起 → 输入过滤 → 回车应用(/query 从源码剥除)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    w.querySelector('.md-edit').$md.set('');
    const surf = w.querySelector('.md-surface');
    const p = surf.querySelector('.md-block p');
    surf.focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertText', false, '/');   // 先敲 /:菜单在 / 键入瞬间唤起
    document.execCommand('insertText', false, 'h3');
    return true;
  })()`);
  await sleep(400);
  const s2e = await ev(`(() => ({
    open: !!document.querySelector('.md-slash'),
    n: document.querySelectorAll('.md-slash-item').length,
  }))()`);
  await ev(`(() => {
    document.querySelector('.win[data-app=mdedit] .md-surface')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await sleep(400);
  const s2f = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { h3: w.querySelectorAll('.md-block h3').length,
      src: w.querySelector('.md-edit').$md.get(),
      closed: !document.querySelector('.md-slash') };
  })()`);
  t('T48.4d 斜杠命令菜单(唤起/过滤/回车应用)',
    s2e.open && s2e.n === 1 && s2f.h3 === 1 && s2f.src === '### ' && s2f.closed, JSON.stringify({ s2e, s2f }));

  // 选区浮动工具栏:选中文字 → 工具栏出现 → 点粗体 → 标记包裹选区
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    w.querySelector('.md-edit').$md.set('一段文字');
    return true;
  })()`);
  await sleep(300);
  await ev(`(() => {
    const surf = document.querySelector('.win[data-app=mdedit] .md-surface');
    const tn = surf.querySelector('.md-block p').firstChild;
    surf.focus();
    const r = document.createRange(); r.setStart(tn, 1); r.setEnd(tn, 3);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    return true;
  })()`);
  await sleep(300);
  const s2g = await ev(`!!document.querySelector('.md-selbar')`);
  await ev(`(() => { [...document.querySelectorAll('.md-selbar-btn')][0].click(); return true; })()`);
  await sleep(400);
  const s2h = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { src: w.querySelector('.md-edit').$md.get(), strong: w.querySelectorAll('.md-block strong').length };
  })()`);
  t('T48.4e 选区浮动工具栏(选中→粗体)',
    s2g === true && s2h.src === '一**段文**字' && s2h.strong === 1, JSON.stringify(s2h));

  // 图片策略:互联网图片不拉取(占位芯片),本地路径正常出图;编辑往返源码不丢
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    const done = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('完成'));
    if (done) done.click();   // 归一到只读态(上一步可能仍在编辑)
    const two = String.fromCharCode(10) + String.fromCharCode(10);
    w.querySelector('.md-edit').$md.set(['网图 ![外链图](https://a.b/i.png)', '本地图 ![本图](images/x.png)'].join(two));
    return true;
  })()`);
  await sleep(300);
  const s2i = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { chip: w.querySelectorAll('.md-block .md-img').length,
             chipSrc: w.querySelector('.md-block .md-img')?.dataset.src,
             imgs: w.querySelectorAll('.md-block img').length };
  })()`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑')).click();
  })()`);
  await sleep(250);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('完成')).click();
  })()`);
  await sleep(250);
  const s2j = await ev(`document.querySelector('.win[data-app=mdedit] .md-edit').$md.get()`);
  t('T48.4f 图片策略(互联网占位芯片 / 本地图 / 编辑往返不丢源)',
    s2i.chip === 1 && s2i.chipSrc === 'https://a.b/i.png' && s2i.imgs === 1
      && s2j.includes('![外链图](https://a.b/i.png)') && s2j.includes('![本图](images/x.png)'),
    JSON.stringify({ s2i, s2j }));

  // 操作栏:不懂语法点按钮 —— 选中文字点粗体按钮 → 标记包裹选区
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    const done = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('完成'));
    if (done) done.click();   // 归一到只读态
    const edit = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑'));
    edit.click();             // 本用例需要编辑态
    w.querySelector('.md-edit').$md.set('一段文字');
    return true;
  })()`);
  await sleep(300);
  await ev(`(() => {
    const surf = document.querySelector('.win[data-app=mdedit] .md-surface');
    const tn = surf.querySelector('.md-block p').firstChild;
    surf.focus();
    const r = document.createRange(); r.setStart(tn, 1); r.setEnd(tn, 3);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    return true;
  })()`);
  await sleep(250);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    [...w.querySelectorAll('.md-tbtn')].find(b => b.title.includes('粗体')).click();
    return true;
  })()`);
  await sleep(400);
  const s2k = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { src: w.querySelector('.md-edit').$md.get(), strong: w.querySelectorAll('.md-block strong').length };
  })()`);
  t('T48.4g 操作栏按钮套用样式(选中→粗体)',
    s2k.src === '一**段文**字' && s2k.strong === 1, JSON.stringify(s2k));

  // 安全:拒绝 javascript: 链接、不透传原始 HTML
  const s3 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    w.querySelector('.md-edit').$md.set('[点我](javascript:alert(1)) <script>alert(2)<\\/script> **粗**\\n\\n尾段');
    return true;
  })()`);
  await sleep(250);
  const s3b = await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    return { a: [...w.querySelectorAll('.md-block a')].map(a => a.getAttribute('href')),
             script: !!w.querySelector('.md-block script'), strong: !!w.querySelector('.md-block strong') };
  })()`);
  t('T48.5 安全(协议白名单 / HTML 转义)', s3 === true && s3b.a.length === 0 && !s3b.script && s3b.strong, JSON.stringify(s3b));

  // 另存为 .md → 虚拟文件系统;文件管家双击分流回编辑器
  const mdPath = (await ev(`WebOS.fs.homePath()`)) + '/documents/md-e2e.md';
  // profile 持久:清上一轮残留(上一轮 T48.9 曾把该文件 chmod 成只读)
  await ev(`WebOS.fs.rm(${JSON.stringify(mdPath)})`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mdedit]');
    w.querySelector('.md-edit').$md.set('# 保存测试\\n\\n内容 **在这里**');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('另存为')).click();
  })()`);
  await sleep(300);
  await ev(`(() => {
    const i = document.querySelector('.modal-mask input');
    i.value = ${JSON.stringify(mdPath)};
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(400);
  const saved = await ev(`WebOS.fs.read(${JSON.stringify(mdPath)})`);
  t('T48.6 另存为 .md 到虚拟文件系统', typeof saved === 'string' && saved.includes('# 保存测试') && saved.includes('**在这里**'), String(saved).slice(0, 24));

  await ev(`WebOS.wm.open('files')`);
  await sleep(500);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    [...w.querySelectorAll('.fitem')].find(f => f.textContent.trim().startsWith('documents')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(400);
  await ev(`(() => {
    [...document.querySelectorAll('.win[data-app=files] .fitem')].find(f => f.textContent.includes('md-e2e')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(600);
  const s4 = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=mdedit]')];
    const w2 = wins.find(w => !w.__first);
    if (w2) w2.__second = true;
    return { wins: wins.length, md: w2 ? w2.querySelector('.md-edit').$md.get() : null };
  })()`);
  t('T48.7 文件管家双击 .md → Markdown 编辑器(只读装载)', s4.wins === 2 && s4.md.includes('保存测试'), JSON.stringify(s4.md).slice(0, 30));

  // 编辑键切换:第二窗口只读起步 → 解锁可编辑 → 完成回只读渲染
  await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => x.__second);
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑')).click();
  })()`);
  await sleep(200);
  const s5a = await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => x.__second);
    return { ce: w.querySelector('.md-surface').contentEditable };
  })()`);
  await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => x.__second);
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('完成')).click();
  })()`);
  await sleep(200);
  const s5 = await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => x.__second);
    return { ce: w.querySelector('.md-surface').contentEditable, h1: w.querySelectorAll('.md-block h1').length };
  })()`);
  t('T48.8 编辑键切换(解锁可编辑 / 完成回只读)', s5a.ce === 'true' && s5.ce === 'false' && s5.h1 >= 1, JSON.stringify({ s5a, s5 }));

  // 文件不可写:chmod 去写权限后新开窗口 → 编辑键置灰,内容仍可读
  await ev(`(() => {
    WebOS.fs.chmod(${JSON.stringify(mdPath)}, 'r--r--');
    WebOS.wm.open('mdedit', { params: { path: ${JSON.stringify(mdPath)} } });
  })()`);
  await waitFor(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => !x.__first && !x.__second);
    return !!w && !![...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑'));
  })()`, 5000);
  const s6 = await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => !x.__first && !x.__second);
    const eb = [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑'));
    return { dis: eb ? eb.disabled : null, h1: w.querySelectorAll('.md-block h1').length,
             ce: w.querySelector('.md-surface').contentEditable };
  })()`);
  t('T48.9 文件不可写 → 编辑键置灰(内容仍可读)', s6.dis === true && s6.h1 >= 1 && s6.ce === 'false', JSON.stringify(s6));
  await ev(`WebOS.fs.chmod(${JSON.stringify(mdPath)}, 'rw-r--')`);   // 还原权限,不污染后续轮次

  // 链接路由:网页 → 系统浏览器;本地 .md → Markdown 编辑器新窗口装载
  await ev(`window.__lt = WebOS.fs.homePath() + '/documents/md-e2e.md'; true`);
  await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => !x.__first && !x.__second);
    const two = String.fromCharCode(10) + String.fromCharCode(10);
    w.querySelector('.md-edit').$md.set(['[网页链接](https://example.com)', '[本地文档](' + window.__lt + ')'].join(two));
    return true;
  })()`);
  await sleep(250);
  await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => !x.__first && !x.__second);
    [...w.querySelectorAll('.md-block a')].find(a => a.getAttribute('href') === 'https://example.com').click();
  })()`);
  await sleep(800);
  const s7a = await ev(`(() => ({
    hasBrowser: !!document.querySelector('.win[data-app=browser]'),
    addr: document.querySelector('.win[data-app=browser] .vw-addr')?.value,
  }))()`);
  await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=mdedit]')].find(x => !x.__first && !x.__second);
    [...w.querySelectorAll('.md-block a')].find(a => a.getAttribute('href').endsWith('md-e2e.md')).click();
  })()`);
  await sleep(800);
  const s7b = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=mdedit]')];
    const last = wins[wins.length - 1];
    return { n: wins.length, md: last?.querySelector('.md-edit')?.$md?.get()?.slice(0, 10) };
  })()`);
  t('T48.9b 链接路由(网页→系统浏览器 / 本地 .md→编辑器)',
    s7a.hasBrowser && String(s7a.addr).includes('example.com') && String(s7b.md).includes('保存测试'),
    JSON.stringify({ s7a, s7b }));
  // 清理本步打开的窗口,不影响后续轮次
  await ev(`(() => {
    document.querySelectorAll('.win[data-app=browser]').forEach(w => WebOS.wm.close(w.dataset.id));
    const wins = [...document.querySelectorAll('.win[data-app=mdedit]')];
    wins.slice(3).forEach(w => WebOS.wm.close(w.dataset.id));
    return true;
  })()`);
  await sleep(300);

  const errs = await ev(`window.__errs.length`);
  t('T48.10 全程无错误', errs === 0, `errs=${errs}`);
  await c.shot('t48-mdedit');
});

group('T49', '数据库(SQL 只读查询 / 分页)', async () => {
  /* ---- T49 dbviewer:任意 .awdb 库的只读 SQL 查询(地址 + 密码 → SELECT → 分页) ---- */
  await fresh();
  // 前置:登录测试账号,并在页面上下文建一个 35 行的明文测试库
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current() !== 'dbver' && !(await accounts.login('dbver', 'dbvpass')).ok) {
      await accounts.register('dbver', 'dbvpass');
      await accounts.login('dbver', 'dbvpass');
    }
    WebOS.fs.rm('/home/dbver/documents/e2e-db.awdb', { as: 'dbver' });
    const { open, createFileBackend } = await import('./vendor/AetherWebDatabase/src/index.js');
    const db = await open('e2eseed-' + Date.now(), {
      storage: createFileBackend(WebOS.fs, '/home/dbver/documents/e2e-db.awdb', { as: 'dbver' }),
    });
    await db.createCollection('entries');
    await db.collection('entries').insertMany(
      Array.from({ length: 35 }, (_, i) => ({ id: 'e' + i, cat: 'c' + (i % 3), v: i })));
    await db.createCollection('people');
    await db.collection('people').insertMany([
      { id: 'z', name: '张伟', note: '负责浏览器 项目的收藏功能' },
      { id: 'l', name: '李雷', note: '邮件应用的最近联系人' },
      { id: 'c', name: '陈静', note: '浏览器 历史与 项目 数据' },
    ]);
    db.close();
    await WebOS.fs.flush();
    return true;
  })()`);
  await needApps('dbviewer');   // 安装按用户:须在登录切换后再装

  await ev(`WebOS.wm.open('dbviewer')`);
  await sleep(600);
  const conn = await ev(`!!document.querySelector('.win[data-app=dbviewer] .dbv-connect-card')`);
  t('T49.1 连接屏(地址 + 密码 + 打开)', conn);

  // 输入路径(明文库,密码留空)→ 打开
  await ev(`(() => {
    document.querySelector('.win[data-app=dbviewer] .dbv-path-input').value = '/home/dbver/documents/e2e-db.awdb';
    [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-connect-card .btn.primary')]
      .find(b => b.textContent.includes('打开')).click();
  })()`);
  const sideOk = await waitFor(`(() => {
    const item = [...document.querySelectorAll('.win[data-app=dbviewer] .nav-item')]
      .find(b => b.textContent.includes('entries'));
    return !!item && item.textContent.includes('35');
  })()`);
  t('T49.2 打开库:侧栏集合与行数(35)', sideOk === true);

  // 点击集合 → 填入模板 → 执行
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .nav-item')]
    .find(b => b.textContent.includes('entries')).click()`);
  const filled = await ev(`document.querySelector('.win[data-app=dbviewer] .dbv-sql').value`);
  t('T49.3 集合点击填入查询模板', filled.includes('SELECT * FROM entries'), filled);
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-editor .btn.primary')]
    .find(b => b.textContent.includes('执行')).click()`);
  const pg1 = await waitFor(`(() => {
    const n = document.querySelectorAll('.win[data-app=dbviewer] .dbv-table tbody tr').length;
    return n === 10 ? document.querySelector('.win[data-app=dbviewer] .dbv-page-ind')?.textContent : false;
  })()`);
  t('T49.4 首页 10 行 + 页码 1/4', pg1 === '第 1 / 4 页', String(pg1));

  // 翻页:第 2 页内容应与第 1 页不同
  const firstP1 = await ev(`document.querySelector('.win[data-app=dbviewer] .dbv-table tbody tr td')?.textContent`);
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-pager .btn')]
    .find(b => b.textContent.includes('下一页')).click()`);
  const pg2 = await ev(`(() => ({
    rows: document.querySelectorAll('.win[data-app=dbviewer] .dbv-table tbody tr').length,
    ind: document.querySelector('.win[data-app=dbviewer] .dbv-page-ind')?.textContent,
    first: document.querySelector('.win[data-app=dbviewer] .dbv-table tbody tr td')?.textContent,
  }))()`);
  t('T49.5 翻页到 2/4(内容随页变化)', pg2.rows === 10 && /2 \/ 4/.test(pg2.ind || '') && pg2.first !== firstP1,
    JSON.stringify(pg2));

  // 连翻到末页:35 行 → 末页 5 行
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-pager .btn')]
    .filter(b => b.textContent.includes('下一页')).pop().click()`);
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-pager .btn')]
    .filter(b => b.textContent.includes('下一页')).pop().click()`);
  const pg4 = await ev(`(() => ({
    rows: document.querySelectorAll('.win[data-app=dbviewer] .dbv-table tbody tr').length,
    ind: document.querySelector('.win[data-app=dbviewer] .dbv-page-ind')?.textContent,
  }))()`);
  t('T49.6 末页 5 行(35 条按每页 10)', pg4.rows === 5 && /4 \/ 4/.test(pg4.ind || ''), JSON.stringify(pg4));

  // 聚合查询
  await ev(`(() => {
    const ta = document.querySelector('.win[data-app=dbviewer] .dbv-sql');
    ta.value = 'SELECT cat, COUNT(*) AS n FROM entries GROUP BY cat ORDER BY cat';
    [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-editor .btn.primary')]
      .find(b => b.textContent.includes('执行')).click();
  })()`);
  const agg = await waitFor(`(() => {
    const rows = [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-table tbody tr')].map(r => r.textContent);
    return rows.length === 3 ? rows.join('|') : false;
  })()`);
  t('T49.7 聚合查询(3 组,12/12/11)', /12/.test(agg) && /11/.test(agg), String(agg));

  // 非 SELECT 拒绝(只读)
  await ev(`(() => {
    const ta = document.querySelector('.win[data-app=dbviewer] .dbv-sql');
    ta.value = 'DELETE FROM entries';
    [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-editor .btn.primary')]
      .find(b => b.textContent.includes('执行')).click();
  })()`);
  const rej = await waitFor(`document.querySelector('.win[data-app=dbviewer] .dbv-error')?.textContent.includes('SELECT')`);
  t('T49.8 非 SELECT 语句被拒(只读)', rej === true);
  const rowsAfter = await ev(`(async () => {
    const { open, createFileBackend } = await import('./vendor/AetherWebDatabase/src/index.js');
    const db = await open('e2echeck-' + Date.now(), {
      storage: createFileBackend(WebOS.fs, '/home/dbver/documents/e2e-db.awdb', { as: 'dbver' }),
    });
    const n = await db.collection('entries').count();
    db.close();
    return n;
  })()`);
  t('T49.9 拒绝写入后数据未变(仍 35 行)', rowsAfter === 35, `rows=${rowsAfter}`);

  /* ---- 新特性经 Worker 全链路:MATCH 全文 / 拼音排序 / CASE ---- */
  const runSql = (sql) => ev(`(() => {
    const ta = document.querySelector('.win[data-app=dbviewer] .dbv-sql');
    ta.value = ${JSON.stringify(sql)};
    [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-editor .btn.primary')]
      .find(b => b.textContent.includes('执行')).click();
  })()`);
  /* 排序规则切换:设置 UI 已撤(排序跟剧情语言走,不再暴露给用户),e2e
   * 经 WebOS.settings 写页面同一模块实例(裸 import('./js/core/store.js')
   * 是无 ?t= 版本号的另一份实例,改了页面也看不见),回读确认写入生效 */
  const setSortLocale = (v) => ev(`(() => {
    WebOS.settings.set({ sortLocale: ${JSON.stringify(v)} });
    return WebOS.settings.get('sortLocale');
  })()`);

  /* 连续查询防读到上一查询的旧表:轮询直到行内容精确等于期望 */
  const waitRowsEq = (expected) => waitFor(`(() => {
    const rows = [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-table tbody tr')].map(r => r.textContent);
    return rows.join('|') === ${JSON.stringify(expected)};
  })()`);

  await runSql("SELECT id FROM people WHERE note MATCH '项目 数据'");
  t('T49.9a MATCH 全文(空白分词全命中 → 仅陈静)', (await waitRowsEq('c')) === true);

  await setSortLocale('zh');   // 归位(上一轮若以码点序收尾,localStorage 会粘到本轮页面启动)
  await runSql('SELECT id FROM people ORDER BY name');
  t('T49.9b 拼音排序(陈→李→张,码点序会是张李陈)', (await waitRowsEq('c|l|z')) === true);

  const swBin = await setSortLocale('');
  await runSql('SELECT id FROM people ORDER BY name');
  t('T49.9b2 切码点序后同查询换序(张李陈)', swBin === '' && (await waitRowsEq('z|l|c')) === true);
  await setSortLocale('zh');   // 还原,防 '' 粘到下一轮
  await runSql("SELECT id, CASE WHEN note MATCH '项目' THEN '相关' ELSE '无关' END AS tag FROM people ORDER BY id");
  t('T49.9c CASE + MATCH 组合', (await waitRowsEq('c相关|l无关|z相关')) === true);

  /* ---- 生成器(纯 GUI 构建 SQL)---- */
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .seg-btn')]
    .find(b => b.textContent.includes('生成器')).click()`);
  const hasBuilder = await waitFor(`!!document.querySelector('.win[data-app=dbviewer] .dbv-builder')`);
  t('T49.10 生成器面板(纯点选构建)', hasBuilder === true);

  // 条件行:t.cat = 'c1'(字段 → 值;操作符默认 =)
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-builder .btn')]
    .find(b => b.textContent.includes('添加条件')).click()`);
  await waitFor(`!!document.querySelector('.win[data-app=dbviewer] .dbv-rows .dbv-brow select')`);
  await ev(`(() => {
    const row = document.querySelector('.win[data-app=dbviewer] .dbv-rows .dbv-brow');
    const fs = row.querySelector('select');
    fs.value = 't.cat';
    fs.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(150);
  await ev(`(() => {
    const vi = document.querySelector('.win[data-app=dbviewer] .dbv-rows .dbv-brow input.dbv-val');
    vi.value = 'c1';
    vi.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const pv1 = await waitFor(`(() => {
    const p = document.querySelector('.win[data-app=dbviewer] .dbv-preview')?.textContent || '';
    return p.includes("t.cat = 'c1'") ? p : false;
  })()`);
  t('T49.11 条件行 → SQL 预览实时生成', pv1.startsWith('SELECT * FROM entries t') && pv1.includes('LIMIT 100'), pv1);

  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-builder .btn.primary')]
    .find(b => b.textContent.includes('执行')).click()`);
  const bpg = await waitFor(`(() => {
    const ind = document.querySelector('.win[data-app=dbviewer] .dbv-page-ind')?.textContent || '';
    return ind.includes('1 / 2') ? ind : false;
  })()`);
  t('T49.12 生成器执行(cat=c1 → 12 行 2 页)', bpg !== false, String(bpg));

  // 排序:v 降序 → 首行 e34(c1 中 v 最大 34)
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-builder .btn')]
    .filter(b => b.textContent.includes('添加排序')).pop().click()`);
  await sleep(250);
  await ev(`(() => {
    const oh = document.querySelectorAll('.win[data-app=dbviewer] .dbv-rows')[1];   // 条件 / 排序 / 聚合
    const sels = oh.querySelectorAll('select');
    sels[0].value = 't.v';
    sels[0].dispatchEvent(new Event('change', { bubbles: true }));
    sels[1].value = '1';
    sels[1].dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(150);
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-builder .btn.primary')]
    .find(b => b.textContent.includes('执行')).click()`);
  const firstCell = await waitFor(`(() => {
    const c = document.querySelector('.win[data-app=dbviewer] .dbv-table tbody tr td');
    return c ? c.textContent : false;
  })()`);
  t('T49.13 排序(v 降序首行 e34)', firstCell === 'e34', String(firstCell));

  // 分组 + 默认 COUNT(*)(先重置,清掉上面的条件与排序)
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-builder .btn')]
    .find(b => b.textContent === '重置').click()`);
  await sleep(300);
  await ev(`(() => {
    const gs = [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-builder select')]
      .find(s => [...s.options].some(o => o.textContent === '(不分组)'));
    gs.value = 't.cat';
    gs.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .dbv-builder .btn.primary')]
    .find(b => b.textContent.includes('执行')).click()`);
  const grp = await waitFor(`(() => {
    const rows = [...document.querySelectorAll('.win[data-app=dbviewer] .dbv-table tbody tr')].map(r => r.textContent);
    return rows.length === 3 ? rows.join('|') : false;
  })()`);
  const grpHead = await ev(`document.querySelector('.win[data-app=dbviewer] .dbv-table thead')?.textContent || ''`);
  t('T49.14 分组聚合(3 组 12/12/11 + count_all 列)',
    grp !== false && /12/.test(grp) && /11/.test(grp) && grpHead.includes('count_all'),
    `${grp} head=${grpHead}`);

  // 换库回连接屏
  await ev(`[...document.querySelectorAll('.win[data-app=dbviewer] .app-toolbar .btn')]
    .find(b => b.textContent.includes('换库')).click()`);
  const back = await ev(`!!document.querySelector('.win[data-app=dbviewer] .dbv-connect-card')`);
  t('T49.15 换库回连接屏', back);

  const errs = await ev(`window.__errs.length`);
  t('T49.16 全程无错误', errs === 0, `errs=${errs}`);
  await c.shot('t49-dbviewer');
});

group('T50', '软件商店(未安装门禁 / 安装 / 卸载 / 菜单桌面联动)', async () => {
  /* ---- T50 软件商店:store 应用默认未安装,安装后才进开始菜单与桌面 ---- */
  await ev(`WebOS.apps.uninstall('map')`);   // 幂等清场(其他组可能装过)
  await sleep(400);

  // a. 未安装:不在开始菜单、无桌面快捷方式
  const s0 = await ev(`(() => ({
    installed: WebOS.apps.isInstalled('map'),
    sm: document.querySelectorAll('.sm-item[data-search*="map"]').length,
    desk: WebOS.fs.exists(WebOS.fs.desktopPath() + '/地图.app'),
  }))()`);
  t('T50 未安装:开始菜单/桌面均无入口', s0.installed === false && s0.sm === 0 && s0.desk === false, JSON.stringify(s0));

  // b. 打开门禁:未安装应用被拦,弹窗引导去软件商店
  await ev(`WebOS.wm.open('map')`);
  await sleep(500);
  const gate = await ev(`(() => ({
    dialog: !!document.querySelector('.win[data-app=sysdialog]'),
    msg: (document.querySelector('.win[data-app=sysdialog]')?.textContent || '').includes('需要先在软件商店安装'),
    win: !!document.querySelector('.win[data-app=map]'),
  }))()`);
  t('T50.1 打开未安装应用被门禁拦截', gate.dialog && gate.msg && !gate.win, JSON.stringify(gate));
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] button')].find(b => b.textContent.trim() === '打开软件商店').click()`);
  await sleep(900);
  const jump = await ev(`(() => ({
    store: !!document.querySelector('.win[data-app=appstore]'),
    flash: !!document.querySelector('.st-card[data-app=map].flash'),
  }))()`);
  t('T50.2 门禁一键直达商店并高亮卡片', jump.store && jump.flash, JSON.stringify(jump));
  await c.shot('t50-store-gate');

  // c. 商店目录:在售卡片 / 头部横幅 / 分类导航(在售数动态取,新增商店应用不必改断言)
  const ui = await ev(`(() => ({
    storeN: WebOS.apps.list().filter(a => a.store === true).length,
    cards: document.querySelectorAll('.st-card').length,
    installs: document.querySelectorAll('.st-install').length,
    hero: !!document.querySelector('.st-hero'),
    nav: [...document.querySelectorAll('.st-nav .nav-item')].map(n => n.dataset.cat),
  }))()`);
  t('T50.3 商店目录(卡片/横幅/分类)', ui.cards === ui.storeN && ui.storeN > 0 && ui.installs > 0 && ui.hero && ui.nav.includes('游戏') && ui.nav.includes('mine'), JSON.stringify(ui));

  // d. GUI 安装:点「安装」→ 进度动画 → 打开;开始菜单/桌面/持久化全部就位
  await ev(`document.querySelector('.st-card[data-app=map] .st-install').click()`);
  const opened1 = await waitFor(`!!document.querySelector('.st-card[data-app=map] .st-open')`, 4000);
  const s1 = await ev(`(() => ({
    installed: WebOS.apps.isInstalled('map'),
    sm: document.querySelectorAll('.sm-item[data-search*="map"]').length,
    desk: WebOS.fs.exists(WebOS.fs.desktopPath() + '/地图.app'),
    persisted: (JSON.parse(localStorage.getItem('webos.installed.v2') || '{}')[WebOS.accounts.current()] || []).includes('map'),
  }))()`);
  t('T50.4 安装后:开始菜单+桌面快捷方式+持久化', opened1 && s1.installed && s1.sm === 1 && s1.desk && s1.persisted, JSON.stringify(s1));
  await c.shot('t50-installed');

  // d2. 真实资源下载:安装即把应用包拉到 /app/<id>/(root 私有,须以 root 视角查看)
  const pkg1 = await ev(`(async () => {
    const list = WebOS.fs.list('/app/map', { as: 'root' }) || [];
    let bytes = 0;
    for (const f of list) bytes += (await WebOS.fs.stat('/app/map/' + f.name, { as: 'root' }))?.size || 0;
    return { dir: WebOS.fs.isDir('/app/map'), files: list.length, bytes };
  })()`);
  t('T50.4b 安装即真实下载:包资源落盘 /app/map(非空)', pkg1.dir && pkg1.files >= 2 && pkg1.bytes > 0, JSON.stringify(pkg1));

  // d3. 包资源对普通用户不可见:/app 用户不可列、不可读、stat 也不给
  const pkg3 = await ev(`(async () => {
    const list = WebOS.fs.list('/app/map');
    const anyFile = (WebOS.fs.list('/app/map', { as: 'root' }) || [])[0];
    const read = anyFile ? WebOS.fs.read('/app/map/' + anyFile.name) : 'no-file';
    const stat = anyFile ? WebOS.fs.stat('/app/map/' + anyFile.name) : 'no-file';
    const write = WebOS.fs.write('/app/map/hack.txt', 'x');
    return { listDenied: list === null, readDenied: read === null, statDenied: stat === null, writeDenied: write === false };
  })()`);
  t('T50.4c 包资源用户不可见(列/读/stat/写全被拒)',
    pkg3.listDenied && pkg3.readDenied && pkg3.statDenied && pkg3.writeDenied, JSON.stringify(pkg3));

  // e. 安装后从商店「打开」直达应用
  await ev(`document.querySelector('.st-card[data-app=map] .st-open').click()`);
  await sleep(700);
  t('T50.5 安装后可从商店打开', await ev(`!!document.querySelector('.win[data-app=map]')`) === true);

  // f. 卸载语义:打开中的窗口被关闭、任务栏固定解除、商店卡片实时回退
  await ev(`WebOS.settings.set({ pinnedApps: ['files', 'terminal', 'map'] })`);
  await ev(`WebOS.apps.uninstall('map')`);
  await sleep(600);
  const s15 = await ev(`(() => ({
    win: !!document.querySelector('.win[data-app=map]'),
    pinned: WebOS.settings.get('pinnedApps').includes('map'),
    installed: WebOS.apps.isInstalled('map'),
    installBtn: !!document.querySelector('.st-card[data-app=map] .st-install'),
    sm: document.querySelectorAll('.sm-item[data-search*="map"]').length,
  }))()`);
  t('T50.6 卸载:关窗口/解固定/菜单与卡片回退', s15.win === false && s15.pinned === false && s15.installed === false && s15.installBtn && s15.sm === 0, JSON.stringify(s15));

  // f2. 末位卸载回收:包资源 /app/map 的存在性 ⟺ 仍有用户装着它
  // (同 worker 轮内各组共用 profile,别组的安装状态也在内,故断言不变量而非具体状态)
  const pkg2 = await ev(`(() => {
    const v2 = JSON.parse(localStorage.getItem('webos.installed.v2') || '{}');
    const anyone = Object.values(v2).some(a => a.includes('map'));
    return { gone: !WebOS.fs.exists('/app/map'), anyone };
  })()`);
  t('T50.6b 末位卸载回收包资源(无人安装 ⟺ /app/map 移除)', pkg2.gone === !pkg2.anyone, JSON.stringify(pkg2));

  // g. API 安装:商店窗口开着也能实时刷新卡片(总线联动)
  await ev(`WebOS.apps.install('map', { silent: true })`);
  await sleep(600);
  t('T50.7 API 安装实时反映到商店', await ev(`!!document.querySelector('.st-card[data-app=map] .st-open')`) === true);

  // h. 搜索过滤
  await ev(`(() => { const i = document.querySelector('.st-search'); i.value = '地图'; i.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  t('T50.8 搜索过滤到目标应用', await ev(`document.querySelectorAll('.st-card').length`) === 1);
  await ev(`(() => { const i = document.querySelector('.st-search'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(200);

  // i. 分类导航:游戏分类只显示游戏
  await ev(`document.querySelector('.st-nav .nav-item[data-cat="游戏"]').click()`);
  await sleep(300);
  const catv = await ev(`(() => ({
    cards: document.querySelectorAll('.st-card').length,
    allGame: [...document.querySelectorAll('.st-card')].every(c => (c.querySelector('.st-line')?.textContent || '').startsWith('游戏')),
  }))()`);
  t('T50.9 分类导航(游戏)', catv.cards >= 10 && catv.allGame, JSON.stringify(catv));
  await ev(`document.querySelector('.st-nav .nav-item[data-cat="all"]').click()`);
  await sleep(200);

  // j. 棋类应用(desktopIcon:false)安装进桌面「棋类游戏」文件夹
  await ev(`WebOS.apps.install('go', { silent: true })`);
  await sleep(600);
  const chess = await ev(`(() => ({
    installed: WebOS.apps.isInstalled('go'),
    folder: WebOS.fs.isDir(WebOS.fs.desktopPath() + '/棋类游戏'),
    link: WebOS.fs.exists(WebOS.fs.desktopPath() + '/棋类游戏/围棋.app'),
    storeBtn: !!document.querySelector('.st-card[data-app=go] .st-open'),
  }))()`);
  t('T50.10 棋类安装进桌面文件夹', chess.installed && chess.folder && chess.link && chess.storeBtn, JSON.stringify(chess));

  // k. GUI 卸载:确认对话框 → 入口全移除
  await ev(`document.querySelector('.st-card[data-app=map] .st-uninstall').click()`);
  await sleep(500);
  const dlgOk = await ev(`(() => ({
    dialog: !!document.querySelector('.win[data-app=sysdialog]'),
    msg: (document.querySelector('.win[data-app=sysdialog]')?.textContent || '').includes('应用数据保留'),
  }))()`);
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] button')].find(b => b.textContent.trim() === '卸载').click()`);
  await sleep(600);
  const s2 = await ev(`(() => ({
    installed: WebOS.apps.isInstalled('map'),
    sm: document.querySelectorAll('.sm-item[data-search*="map"]').length,
    desk: WebOS.fs.exists(WebOS.fs.desktopPath() + '/地图.app'),
    installBtn: !!document.querySelector('.st-card[data-app=map] .st-install'),
  }))()`);
  t('T50.11 GUI 卸载(确认框+入口移除)', dlgOk.dialog && dlgOk.msg && s2.installed === false && s2.sm === 0 && s2.desk === false && s2.installBtn, JSON.stringify({ dlgOk, s2 }));
  await c.shot('t50-store');

  // k2. 失效快捷方式同一口径:指向「未安装应用」(map)与指向「不存在的应用」
  //     的快捷方式同样处理 —— 图标退灰、双击同报「快捷方式失效」,
  //     不再走安装门禁引导去商店(门禁只保留给直开路径,见 b 节)。
  //     先最小化所有窗口露出桌面(商店窗口盖着图标,真实双击会点在窗口上);
  //     不用 closeAll —— 后面 m 节还要查商店卡片 DOM(最小化仅 display:none)
  await ev(`WebOS.wm.taskList().forEach(t => WebOS.wm.minimize(t.id))`);
  await ev(`WebOS.fs.write(WebOS.fs.desktopPath() + '/失效链.app', 'map', { as: WebOS.accounts.current() })`);
  await ev(`WebOS.fs.write(WebOS.fs.desktopPath() + '/幽灵链.app', 'no-such-app', { as: WebOS.accounts.current() })`);
  await sleep(400);
  const broken = await ev(`(() => {
    const tile = (name) => document.querySelector('.dicon[data-key="fs:' + WebOS.fs.desktopPath() + '/' + name + '.app"] .tile');
    const gray = (n) => (getComputedStyle(tile(n)).getPropertyValue('--tile-bg') || '').includes('#94a3b8');
    return { uninst: gray('失效链'), ghost: gray('幽灵链'), lnk: !!tile('失效链')?.querySelector('.lnk-badge') };
  })()`);
  const dblBroken = async (name) => {
    const q = JSON.stringify(name);
    // 真实双击偶发被桌面重渲染吞掉(两次点击之间节点被替换则不成 dblclick):
    // waitFor 等对话框出现,没等到就再点一次
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = await ev(`(() => {
        const n = document.querySelector('.dicon[data-key="fs:' + WebOS.fs.desktopPath() + '/' + ${q} + '.app"]');
        const r = n.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await clickReal(p.x, p.y, 2);
      if (await waitFor(`!!document.querySelector('.win[data-app=sysdialog]')`, 1500)) break;
    }
    const r = await ev(`(() => {
      const d = document.querySelector('.win[data-app=sysdialog]');
      return { dlg: !!d, invalid: (d?.textContent || '').includes('快捷方式失效'),
        noStore: !(d?.textContent || '').includes('软件商店') };
    })()`);
    await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] button')].find(b => b.textContent.trim() === '确定')?.click()`);
    await waitFor(`!document.querySelector('.win[data-app=sysdialog]')`, 2000);
    await sleep(250);   // 关窗动画(170ms)走完再进行下一处点击
    return r;
  };
  const b1 = await dblBroken('失效链');   // 目标 = 已注册但未安装的 map
  const b2 = await dblBroken('幽灵链');   // 目标 = 从未注册的应用 ID
  await ev(`WebOS.fs.rm(WebOS.fs.desktopPath() + '/失效链.app'); WebOS.fs.rm(WebOS.fs.desktopPath() + '/幽灵链.app');`);
  t('T50.11b 失效快捷方式统一口径(未安装=不存在:退灰图标 + 双击同报「快捷方式失效」,不引导去商店)',
    broken.uninst && broken.ghost && broken.lnk && b1.dlg && b1.invalid && b1.noStore && b2.dlg && b2.invalid && b2.noStore,
    JSON.stringify({ broken, b1, b2 }));

  // l. 安装按用户:新建用户(不切会话)从系统预装起步,本人装过的商店应用他没有
  await ev(`(async () => { await WebOS.accounts.createUser('storeuser', 'storepass'); return true; })()`);
  await sleep(600);   // 'created' → applink 预播种 storeuser 桌面
  const perUser = await ev(`(() => {
    const d = '/home/storeuser/desktop';
    const cur = WebOS.accounts.current();
    return {
      goMine: WebOS.apps.isInstalled('go'),
      goOther: WebOS.apps.isInstalled('go', 'storeuser'),
      otherApps: (WebOS.fs.list(d, { as: 'root' }) || []).filter(f => f.name.endsWith('.app')).map(f => f.name),
      otherChess: WebOS.fs.exists(d + '/棋类游戏/围棋.app'),
      v2HasGo: (JSON.parse(localStorage.getItem('webos.installed.v2') || '{}')[cur] || []).includes('go'),
    };
  })()`);
  t('T50.12 安装按用户(新用户从预装起步)',
    perUser.goMine === true && perUser.goOther === false && perUser.otherChess === false
    && perUser.otherApps.includes('系统设置.app') && !perUser.otherApps.includes('围棋.app')
    && perUser.v2HasGo === true,
    JSON.stringify(perUser));

  // m. 给他人安装/卸载不影响本人
  await ev(`WebOS.apps.install('weather', { user: 'storeuser', silent: true })`);
  await sleep(500);
  const other = await ev(`(() => ({
    mine: WebOS.apps.isInstalled('weather'),
    other: WebOS.apps.isInstalled('weather', 'storeuser'),
    myDesk: WebOS.fs.exists(WebOS.fs.desktopPath() + '/天气.app'),
    otherDesk: WebOS.fs.exists('/home/storeuser/desktop/天气.app'),
    sm: document.querySelectorAll('.sm-item[data-search*="weather"]').length,
    storeBtn: !!document.querySelector('.st-card[data-app=weather] .st-install'),
  }))()`);
  await ev(`WebOS.apps.uninstall('weather', { user: 'storeuser', silent: true })`);
  await sleep(300);
  const otherBack = await ev(`WebOS.apps.isInstalled('weather', 'storeuser') === false && WebOS.fs.exists('/home/storeuser/desktop/天气.app') === false`);
  await ev(`(async () => { await WebOS.accounts.remove('storeuser', 'storepass'); return true; })()`);   // 清理测试账号
  t('T50.13 给他人安装/卸载不影响本人',
    other.mine === false && other.other === true && other.myDesk === false && other.otherDesk === true
    && other.sm === 0 && other.storeBtn === true && otherBack === true,
    JSON.stringify(other));

  const errs50 = await ev(`window.__errs.length`);
  t('T50.14 全程无错误', errs50 === 0, `errs=${errs50}`);
});

group('T57', '代码编辑器(自研高亮四语言 / AetherJS 运行输出 / 终端 node / 死循环强杀)', async () => {
  /* ---- T57 代码编辑器:cedit 自研编辑组件 + chl 高亮 + ascript Worker 运行 ---- */
  await fresh();
  const HOME = await ev(`WebOS.fs.homePath()`);

  /* 四语言样例文件(评分统计取自语言规格样张) */
  const AJS_SRC = [
    '// 评分统计',
    'let scores = [72, 91, 55];',
    'let total = 0;',
    'for (const s of scores) { total += s; }',
    'const mean = total / scores.length;',
    '',
    'class Grader {',
    '  cutoff = 60;',
    '  constructor(c) { this.cutoff = c; }',
    '  grade(m) {',
    '    if (m >= this.cutoff) { return "及格"; }',
    '    return "不及格";',
    '  }',
    '}',
    '',
    'const g = new Grader(60);',
    'print("平均 " + fixed(mean, 1) + " · " + g.grade(mean));',
    'mean;',
  ].join('\n');
  const CSS_SRC = [
    '/* 卡片 */',
    '.card:hover {',
    '  color: #ff8800;',
    '  margin: 4px 2em;',
    '}',
    '@media (max-width: 600px) { .card { display: none; } }',
  ].join('\n');
  const HTML_SRC = [
    '<div class="card" title="卡片">{{user.name + "!"}}</div>',
    '{{#if ok}}可见{{else}}隐藏{{/if}}',
    '<!-- 模板注释 -->',
  ].join('\n');
  const JSON_SRC = '{\n  "name": "aether",\n  "list": [1, 2.5, true, null]\n}\n';
  const P = {
    ajs: HOME + '/documents/e2e-评分.ajs',
    css: HOME + '/documents/e2e-样式.css',
    html: HOME + '/documents/e2e-页面.html',
    json: HOME + '/documents/e2e-配置.json',
  };
  await ev(`(() => {
    for (const p of ${JSON.stringify(Object.values(P))}) WebOS.fs.rm(p);
    WebOS.fs.write(${JSON.stringify(P.ajs)}, ${JSON.stringify(AJS_SRC)});
    WebOS.fs.write(${JSON.stringify(P.css)}, ${JSON.stringify(CSS_SRC)});
    WebOS.fs.write(${JSON.stringify(P.html)}, ${JSON.stringify(HTML_SRC)});
    WebOS.fs.write(${JSON.stringify(P.json)}, ${JSON.stringify(JSON_SRC)});
    return true;
  })()`);

  /* 打开 .ajs:等 textarea 装载;标记主窗口便于多窗步骤定位 */
  await ev(`WebOS.wm.open('codeedit', { params: { path: ${JSON.stringify(P.ajs)} } })`);
  await waitFor(`!!document.querySelector('.win[data-app=codeedit] .cedit-ta')?.value.includes('Grader')`);
  await sleep(250);   // 等 rAF 首帧渲染(高亮层/行号槽)
  await ev(`document.querySelector('.win[data-app=codeedit]').__tag = 'main'`);
  const W = () => `[...document.querySelectorAll('.win[data-app=codeedit]')].find(w => w.__tag === 'main')`;
  const setBuf = async (src) => {
    await ev(`(() => {
      const ta = (${W()}).querySelector('.cedit-ta');
      ta.value = ${JSON.stringify(src)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);   // rAF 重渲染高亮
  };
  const outExpr = () => `(${W()})?.querySelector('.ce-out-body')?.textContent || ''`;
  const outText = () => ev(outExpr());

  // 1) 打开与装载:内容入编辑器、语言识别 AetherJS、行号槽就位
  const s1 = await ev(`(() => {
    const w = ${W()};
    return {
      val: w.querySelector('.cedit-ta').value.includes('cutoff = 60'),
      lang: w.querySelector('.select')?.value,
      gutter: w.querySelectorAll('.cedit-gutter-in > div').length,
      caret: w.querySelector('.app-status span').textContent,
    };
  })()`);
  t('T57 打开 .ajs(内容/语言识别/行号/状态栏)',
    s1.val && s1.lang === 'ajs' && s1.gutter === AJS_SRC.split('\n').length && /^行 1,列 1$/.test(s1.caret),
    JSON.stringify(s1));

  // 2) AetherJS 高亮:关键字/字符串/注释/数字/类字段/内建(字面量单独验,主样例没有)
  const s2 = await ev(`(() => {
    const hl = (${W()}).querySelector('.cedit-hl');
    return {
      kw: !!hl.querySelector('.tk-kw'),        // let/class/if…
      str: !!hl.querySelector('.tk-str'),      // "及格"
      com: !!hl.querySelector('.tk-com'),      // // 评分统计
      num: !!hl.querySelector('.tk-num'),      // 72 / 60
      prop: !!hl.querySelector('.tk-prop'),    // this.cutoff(.成员)
      bi: !!hl.querySelector('.tk-bi'),        // fixed/print
    };
  })()`);
  await setBuf('let pass = true;\nconst none = null;\n');
  const s2lit = await ev(`!!(${W()}).querySelector('.cedit-hl .tk-lit')`);
  t('T57.1 AetherJS 高亮(七类词法着色)', Object.values(s2).every(Boolean) && s2lit, JSON.stringify(s2));

  // 3) 禁字标红:var/==/模板串反引号,title 提示禁用理由(AetherJS 特色)
  await setBuf('let a = 1;\nvar b = a == 2;\nlet c = `x`;\n');
  const s3 = await ev(`(() => {
    const errs = [...(${W()}).querySelectorAll('.cedit-hl .tk-err')];
    return {
      n: errs.length,
      varTip: errs.some(e => e.textContent === 'var' && e.title.includes('禁止 var')),
      eqTip: errs.some(e => e.textContent === '==' && e.title.includes('宽松相等')),
      tick: errs.some(e => e.textContent === '\\u0060' && e.title.includes('不支持该字符')),
    };
  })()`);
  t('T57.2 禁用总表标红(var / == / 反引号 + 悬停理由)',
    s3.n >= 3 && s3.varTip && s3.eqTip && s3.tick, JSON.stringify(s3));

  // 4) 实时语法检查:输入停顿后状态栏报错、行号槽标红;改正后恢复
  await setBuf('let x = ;\nlet y = 2;\n');
  await waitFor(`!!(${W()})?.querySelector('.ce-syn-bad')`, 4000);
  const s4 = await ev(`(() => {
    const w = ${W()};
    return {
      syn: w.querySelector('.ce-syn-bad')?.textContent || '',
      mark: !!w.querySelector('.cedit-gutter-in .cedit-err-line'),
    };
  })()`);
  await setBuf('let x = 1;\n');
  await sleep(700);
  const s4b = await ev(`!!(${W()}).querySelector('.ce-syn-bad')`);
  t('T57.3 实时语法检查(状态栏 + 行号标记,改正即恢复)',
    s4.syn.includes('行 1') && s4.mark && !s4b, JSON.stringify(s4));

  // 5) 运行:print 输出 + 程序值(→)+ 耗时;输出面板自动展开
  await setBuf(AJS_SRC);
  await ev(`(${W()}).querySelector('.ce-run').click()`);
  await waitFor(`(${outExpr()}).includes('平均')`, 8000);
  const s5 = await ev(`(() => {
    const w = ${W()};
    const lines = [...w.querySelectorAll('.ce-out-body .o-line')].map(l => l.textContent);
    return {
      out: lines.join('\\n'),
      hasVal: lines.some(l => l.startsWith('→ 72.')),
      done: lines.some(l => l.includes('完成 ·')),
      visible: !w.querySelector('.ce-out').classList.contains('hidden'),
      syn: w.querySelector('.ce-syn-bad') ? 'bad' : 'ok',
    };
  })()`);
  t('T57.4 运行输出(print 行 / → 程序值 / 完成 / 语法状态复位)',
    s5.out.includes('平均 72.7 · 及格') && s5.hasVal && s5.done && s5.visible && s5.syn === 'ok',
    JSON.stringify(s5.out));

  // 6) 运行期错误:严格类型检查的 type 错误进输出面板
  await setBuf('let x = "a" + 1;\nprint(x);\n');
  await ev(`(${W()}).querySelector('.ce-run').click()`);
  await waitFor(`(${outExpr()}).includes('type')`, 5000);
  const s6 = await outText();
  t('T57.5 运行期错误(type: 运算符 + 要求同型)', s6.includes('type') && s6.includes('运算符'), s6.slice(-120));

  // 7) 编译错误:行列号在输出里,点击错误行跳转光标
  await setBuf('let x = ;\nlet y = 2;\n');
  await ev(`(${W()}).querySelector('.ce-run').click()`);
  await waitFor(`(${outExpr()}).includes('syntax')`, 5000);
  await ev(`[...(${W()}).querySelectorAll('.ce-out-body .o-err')].pop().click()`);
  await sleep(150);
  const s7 = await ev(`(${W()}).querySelector('.app-status span').textContent`);
  t('T57.6 编译错误定位(输出带行列,点击跳转光标)', /^行 1,列 9$/.test(s7), s7);

  // 8) 保存:改内容 → 保存 → 文件落盘、标题去脏标记
  await setBuf(AJS_SRC + '\n// 已保存的修改\n');
  await ev(`(${W()}).querySelector('.ce-save').click()`);
  await sleep(200);
  const s8 = await ev(`({
    disk: WebOS.fs.read(${JSON.stringify(P.ajs)}).includes('已保存的修改'),
    dirty: (${W()}).querySelector('.win-title')?.textContent.includes('●'),
  })`);
  t('T57.7 保存落盘(内容写回 / 脏标记清除)', s8.disk && !s8.dirty, JSON.stringify(s8));

  // 9) 三语言窗口:CSS/HTML/JSON 各自的词法类
  const langs = [
    ['css', P.css, CSS_SRC, ['.card', '.tk-cls'], ['color', '.tk-prop'], ['@media', '.tk-kw'], [':hover', '.tk-pseudo']],
    ['html', P.html, HTML_SRC, ['div', '.tk-tag'], ['class', '.tk-attr'], ['{{', '.tk-tpl'], ['#if', '.tk-kw']],
    ['json', P.json, JSON_SRC, ['"name"', '.tk-prop'], ['2.5', '.tk-num'], ['true', '.tk-lit'], ['"aether"', '.tk-str']],
  ];
  const langOk = {};
  for (const [id, path, src, ...pairs] of langs) {
    await ev(`WebOS.wm.open('codeedit', { params: { path: ${JSON.stringify(path)} } })`);
    await waitFor(`[...document.querySelectorAll('.win[data-app=codeedit] .cedit-ta')].some(t => t.value === ${JSON.stringify(src)})`, 4000);
    await ev(`(() => {
      const ws = document.querySelectorAll('.win[data-app=codeedit]');
      ws[ws.length - 1].__tag = ${JSON.stringify(id)};
    })()`);
    await sleep(250);   // 等 rAF 首帧渲染高亮层
    langOk[id] = await ev(`(() => {
      const w = [...document.querySelectorAll('.win[data-app=codeedit]')].find(x => x.__tag === ${JSON.stringify(id)});
      const checks = ${JSON.stringify(pairs)}.map(([txt, sel]) =>
        [...w.querySelectorAll('.cedit-hl ' + sel)].some(e => e.textContent === txt));
      return { lang: w.querySelector('.select')?.value, checks };
    })()`);
  }
  t('T57.8 CSS/HTML/JSON 高亮与语言识别',
    langOk.css.lang === 'css' && langOk.css.checks.every(Boolean)
    && langOk.html.lang === 'html' && langOk.html.checks.every(Boolean)
    && langOk.json.lang === 'json' && langOk.json.checks.every(Boolean),
    JSON.stringify(langOk));

  // 10) 终端 node:执行脚本 / -e 内联 / -v / 不存在的文件
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(600);
  await ev(`(() => {
    const ws = document.querySelectorAll('.win[data-app=terminal]');
    ws[ws.length - 1].__tag = 't57';
  })()`);
  const TW = () => `[...document.querySelectorAll('.win[data-app=terminal]')].find(w => w.__tag === 't57')`;
  const termRun = async (cmd) => {
    await ev(`(() => {
      const inp = (${TW()}).querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
  };
  const termExpr = () => `(${TW()})?.querySelector('.term-out')?.textContent || ''`;
  const termText = () => ev(termExpr());
  await termRun(`node ${P.ajs}`);
  await waitFor(`(${termExpr()}).includes('平均 72.7')`, 8000);
  await termRun(`node -e "print(40 + 2);"`);
  await waitFor(`(${termExpr()}).includes('42')`, 5000);
  await termRun(`node -v`);
  await sleep(400);
  await termRun(`node /tmp/不存在.ajs`);
  await sleep(400);
  const s10 = await termText();
  t('T57.9 终端 node(执行脚本 / -e 内联 / -v / 缺文件报错)',
    s10.includes('平均 72.7 · 及格') && s10.includes('AetherJS v0.2')
    && s10.includes('没有那个文件或目录'), JSON.stringify(s10.match(/node[^\n]*/g)?.slice(-4)));

  // 11) edit 命令分流:代码文件进代码编辑器
  await termRun(`edit ${P.json}`);
  await waitFor(`[...document.querySelectorAll('.win[data-app=codeedit] .select')].some(s => s.value === 'json'
    && s.closest('.win').querySelector('.cedit-ta').value.includes('aether'))`, 4000);
  t('T57.10 edit 命令分流(.json 进代码编辑器)', true, '');

  // 12) 「在终端运行」:保存后推给新终端的 node 自动执行
  await setBuf(AJS_SRC);
  await ev(`(${W()}).querySelector('.ce-save').click()`);
  await sleep(200);
  await ev(`(${W()}).querySelector('.ce-term-run').click()`);
  await waitFor(`(() => {
    const ws = [...document.querySelectorAll('.win[data-app=terminal]')].filter(w => w.__tag !== 't57');
    return ws.length === 1 && (ws[0].querySelector('.term-out')?.textContent || '').includes('平均 72.7');
  })()`, 8000);
  t('T57.11 在终端运行按钮(自动保存 + 终端执行)', true, '');

  // 13) 死循环强杀:worker 超时终止,页面仍活着(语言不防死循环,宿主 Worker 兜底)
  await setBuf('while (true) { }\n');
  await ev(`(${W()}).querySelector('.ce-run').click()`);
  const killed = await waitFor(`(${outExpr()}).includes('执行超时')`, 9000);
  const alive = await ev(`WebOS.accounts.current() !== null`);
  t('T57.12 死循环超时强杀(Worker terminate,页面不卡死)', killed && alive, `killed=${killed}`);

  // 14) 收尾:无运行错误
  const errs57 = await ev(`JSON.stringify(window.__errs).slice(0, 400)`);
  t('T57.13 全程无运行错误', errs57 === '[]', String(errs57));

  /* 收尾:清样例文件 */
  await ev(`(() => {
    for (const p of ${JSON.stringify(Object.values(P))}) WebOS.fs.rm(p);
    return true;
  })()`);
  await c.shot('t57-codeedit');
});

/* ============================================================
 * T61 电子表格:纯表格编辑器(无公式 / 行高固定)
 * 覆盖:网格骨架、单元格编辑(双击/打字即编/Esc)、四样式位 +
 * 文字色 + 单元格色(调色板真实 UI)、框选批量(锚点取反语义)、
 * 整行/整列选、列宽拖拽(缩放坐标反算)、真实缩放、列排序(数字<
 * 文本<空垫底、整行连动、拼音序、指示器随编辑清除、sort 入档)、
 * .axl 存取与打开方式路由。经验:窗口开场动画 950ms,须等足再交互;
 * 合成 PointerEvent 要带元素中心坐标(hitCell 走 elementFromPoint)。
 * ============================================================ */
group('T61', '电子表格(编辑 / 样式 / 列排序 / 固定行 / 缩放 / .axl 存取)', async () => {
  await fresh();
  const HOME = await ev(`WebOS.fs.homePath()`);
  const FILE = HOME + '/documents/e2e-sheet.axl';
  await ev(`WebOS.fs.rm(${JSON.stringify(FILE)})`);
  await ev(`WebOS.wm.open('sheet')`);
  await sleep(1200);   // 开场动画 950ms + 应用 chunk 按需加载

  // 骨架:50×20 网格、表头 A/1、工具栏齐全、100% 缩放、无状态栏
  const s0 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=sheet]');
    return {
      win: !!w,
      rows: w.querySelectorAll('.sheet-table tbody tr').length,
      cols: w.querySelectorAll('.sheet-table thead th').length - 1,
      headA: w.querySelector('.sheet-table thead th:nth-child(2)')?.textContent,
      rowh1: w.querySelector('.sheet-table tbody th.rowh')?.textContent,
      btns: w.querySelectorAll('.app-toolbar .btn').length,
      zoom: w.querySelector('.sheet-zoom-label')?.textContent,
      title: w.querySelector('.win-title')?.textContent,
      noStatus: !w.querySelector('.app-status'),
    };
  })()`);
  t('T61 骨架(50×20 / 表头 A·1 / 工具栏 / 100% / 无状态栏)',
    s0.win && s0.rows === 50 && s0.cols === 20 && s0.headA.startsWith('A') && s0.rowh1 === '1'
    && s0.btns >= 11 && s0.zoom === '100%' && s0.title.includes('未命名') && s0.noStatus,
    JSON.stringify(s0));

  // 编辑链:双击 B2 写字 → Enter 提交并下移;打字即编 → Esc 取消
  const s1 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const cell = td(1, 1);
    pd(cell);
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = cell.querySelector('input.cell-in');
    if (!input) return { edit: false };
    input.value = '季度数据';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const committed = cell.textContent;
    const moved = td(2, 1).classList.contains('cur');   // 提交后选区下移到 B3
    // 打字即编 + Esc 取消:选 A1,派发可打印字符键
    const wrap = w.querySelector('.sheet-wrap');
    pd(td(0, 0));
    wrap.focus();
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: '首', bubbles: true }));
    const inp2 = td(0, 0).querySelector('input.cell-in');
    const typed = inp2 && inp2.value;
    inp2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { edit: true, committed, moved, typed, esc: td(0, 0).textContent === '' };
  })()`);
  t('T61.1 编辑(双击写入 → Enter 提交下移 B3)', s1.edit && s1.committed === '季度数据' && s1.moved === true, JSON.stringify(s1));
  t('T61.2 打字即编与 Esc 取消', s1.typed === '首' && s1.esc, JSON.stringify({ typed: s1.typed, esc: s1.esc }));

  // 样式:四开关 + 调色板真实 UI(文字红 / 底黄)
  const s2 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const btn = (t) => [...w.querySelectorAll('.app-toolbar .btn')]
      .find(b => ((b.title || '') + '|' + b.textContent.trim()).includes(t));
    const cell = td(1, 1);
    pd(cell);
    btn('加粗').click(); btn('斜体').click(); btn('下划线').click(); btn('删除线').click();
    const fmt = ['b','i','u','k'].every(f => cell.classList.contains(f));
    btn('文字颜色').click();
    w.querySelector('.sheet-palette .pal-sw[title="#e11d48"]').click();
    btn('单元格颜色').click();
    w.querySelector('.sheet-palette .pal-sw[title="#facc15"]').click();
    return {
      fmt,
      fg: cell.style.color, bg: cell.style.backgroundColor,
      palClosed: !w.querySelector('.sheet-palette'),
      boldBtnOn: btn('加粗').classList.contains('on'),
    };
  })()`);
  t('T61.3 单元格样式(粗/斜/下划/删除线 + 文字色 + 底色)',
    s2.fmt && s2.fg === 'rgb(225, 29, 72)' && s2.bg === 'rgb(250, 204, 21)' && s2.palClosed && s2.boldBtnOn,
    JSON.stringify(s2));

  // 框选批量:选 B2(锚点已粗体)→ shift 扩到 D4 → 点加粗 = 按锚点取反 → 取消 9 格粗
  // 再点(锚点已无粗体)= 9 格全粗;整列/整行头选择
  const s3 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const btn = (t) => [...w.querySelectorAll('.app-toolbar .btn')]
      .find(b => ((b.title || '') + '|' + b.textContent.trim()).includes(t));
    const nBold = () => { let n = 0; for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) if (td(r, c).classList.contains('b')) n++; return n; };
    pd(td(1, 1));
    pd(td(3, 3), { shiftKey: true });
    const curB2 = td(1, 1).classList.contains('cur');   // 锚点仍在 B2
    const sel9 = w.querySelectorAll('td.sel').length;
    btn('加粗').click();
    const afterOff = nBold();
    btn('加粗').click();
    const afterOn = nBold();
    pd(w.querySelector('thead th[data-c="2"]'));
    const colSel = w.querySelectorAll('td.sel').length;
    pd(w.querySelector('tbody th.rowh[data-r="0"]'));
    const rowSel = w.querySelectorAll('td.sel').length;
    return { curB2, sel9, afterOff, afterOn, colSel, rowSel };
  })()`);
  t('T61.4 框选批量样式(锚点取反:先取消 0/9,再加满 9/9)',
    s3.curB2 && s3.sel9 === 9 && s3.afterOff === 0 && s3.afterOn === 9,
    JSON.stringify(s3));
  t('T61.5 整列/整行选择(列头 50 格 / 行头 20 格)',
    s3.colSel === 50 && s3.rowSel === 20, JSON.stringify({ colSel: s3.colSel, rowSel: s3.rowSel }));

  // 列宽拖拽(+80px)+ 缩放(120% 行高 34px → 标签点击复位)
  const s4 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    td(0, 0).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const handle = w.querySelector('thead th[data-c="1"] .col-resize');
    const col = w.querySelectorAll('colgroup col')[2];
    const w0 = parseInt(col.style.width);
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 200, clientY: 10 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 10 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const w1 = parseInt(col.style.width);
    const zoomBtn = [...w.querySelectorAll('.app-toolbar .btn')].find(b => (b.title || '').includes('放大'));
    zoomBtn.click(); zoomBtn.click();
    const zoom = w.querySelector('.sheet-zoom-label').textContent;
    const rowH = getComputedStyle(w.querySelector('.sheet-table tbody td')).height;
    w.querySelector('.sheet-zoom-label').click();
    return { w0, w1, zoom, rowH, back: w.querySelector('.sheet-zoom-label').textContent };
  })()`);
  t('T61.6 列宽拖拽(+80px)', s4.w1 - s4.w0 === 80, JSON.stringify(s4));
  t('T61.7 缩放(120% 行高 34px,标签复位 100%)', s4.zoom === '120%' && s4.rowH === '34px' && s4.back === '100%', JSON.stringify(s4));

  // 保存 .axl(真实保存对话框)→ 落盘内容与格式断言
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=sheet]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => (b.title || '').startsWith('保存')).click();
  })()`);
  await sleep(300);
  await ev(`(() => {
    const input = document.querySelector('.modal-mask .modal-box input');
    input.value = ${JSON.stringify(FILE)};
    [...document.querySelectorAll('.modal-mask .modal-actions .btn')].find(b => b.textContent === '保存').click();
  })()`);
  await sleep(400);
  const s5 = await ev(`(() => {
    const raw = WebOS.fs.read(${JSON.stringify(FILE)});
    let d = null; try { d = JSON.parse(raw); } catch {}
    const c = d && d.cells && d.cells['1,1'];
    const title = document.querySelector('.win[data-app=sheet] .win-title').textContent;
    return { raw: !!raw, axl: d && d.axl, cell: c && { t: c.t, b: c.b, i: c.i, u: c.u, k: c.k, fg: c.fg, bg: c.bg },
             colw: d && d.colw && d.colw[1], title };
  })()`);
  t('T61.8 保存 .axl(版本标记/文本/样式位/两色/列宽/标题去脏点)',
    s5.raw && s5.axl === 1 && s5.cell.t === '季度数据' && s5.cell.b === 1 && s5.cell.i === 1
    && s5.cell.u === 1 && s5.cell.k === 1 && s5.cell.fg === '#e11d48' && s5.cell.bg === '#facc15'
    && s5.colw === 176 && !s5.title.includes('●'),
    JSON.stringify(s5));

  // 重开同一文件(params.path)→ 内容/样式/列宽全恢复;打开方式路由 .axl→sheet
  await ev(`WebOS.wm.open('sheet', { params: { path: ${JSON.stringify(FILE)} } })`);
  await sleep(1200);
  const s6 = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=sheet]')];
    const w2 = wins[wins.length - 1];
    const c = w2.querySelector('td[data-r="1"][data-c="1"]');
    return {
      title: w2.querySelector('.win-title').textContent,
      text: c.textContent, bold: c.classList.contains('b'),
      colw: w2.querySelectorAll('colgroup col')[2].style.width,
      route: WebOS.openwith ? WebOS.openwith.defaultFor('报表.axl') : null,
    };
  })()`);
  t('T61.9 重开载入(文本/粗体/列宽 176px/标题含文件名)',
    s6.title.includes('e2e-sheet.axl') && s6.text === '季度数据' && s6.bold && s6.colw === '176px',
    JSON.stringify(s6));
  t('T61.10 打开方式路由(.axl 内置默认 → 电子表格)', s6.route === 'sheet', String(s6.route));

  // 排序:列头 ↕ 小钮弹菜单选升/降(空恒垫底、整行连动)+ 中文拼音序 + 指示器随编辑清除。
  // 注意 sortCol 会整格重建表头,排序钮须每次重查,旧引用已脱离 DOM
  const s7 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const edit = (r, c, text) => {
      pd(td(r, c));
      td(r, c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const i = td(r, c).querySelector('input.cell-in');
      i.value = text;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const col = (c) => [0, 1, 2, 3].map((r) => td(r, c).textContent);
    const sbtn = (c) => w.querySelector('thead th[data-c="' + c + '"] .col-sort');
    const sortVia = async (c, label) => {              // 列头 ↕ → 弹菜单 → 点对应项
      sbtn(c).click();
      await sleep(80);
      const item = [...w.querySelectorAll('.sheet-pop .pop-item')].find(b => b.textContent.includes(label));
      if (item) item.click();
      await sleep(80);
      return !!item;
    };
    // A 列行标记 a1..a4;B 列 92/78/(空)/88;C 列 张三/李四/陈五/(空)
    ['a1', 'a2', 'a3', 'a4'].forEach((t, i) => edit(i, 0, t));
    edit(0, 1, '92'); edit(1, 1, '78'); edit(3, 1, '88');
    edit(0, 2, '张三'); edit(1, 2, '李四'); edit(2, 2, '陈五');
    const ok1 = await sortVia(1, '升序');                // B 升:78 88 92 空
    const asc = { A: col(0), B: col(1), mark: sbtn(1).textContent };
    const ok2 = await sortVia(1, '降序');                // B 降:92 88 78 空
    const desc = { A: col(0), B: col(1), mark: sbtn(1).textContent };
    const ok3 = await sortVia(2, '升序');                // C 升(拼音:陈 chen < 李 li < 张 zhang)
    const zhAsc = col(2);
    // 任一格内容再编辑 → 排序状态不可信,指示器清除
    edit(0, 3, 'x');
    return { asc, desc, zhAsc, cleared: !w.querySelector('.col-sort.on'), menu: ok1 && ok2 && ok3 };
  })()`);
  t('T61.11 列排序(列头菜单升/降:数字序、空恒垫底、整行连动、▲/▼ 指示)',
    s7.menu && s7.asc.B.join(',') === '78,88,92,' && s7.asc.A.join(',') === 'a2,a4,a1,a3' && s7.asc.mark === '▲'
    && s7.desc.B.join(',') === '92,88,78,' && s7.desc.A.join(',') === 'a1,a4,a2,a3' && s7.desc.mark === '▼',
    JSON.stringify(s7));
  t('T61.12 中文拼音序 + 编辑清指示(陈李张;码点序会是张李陈)',
    s7.zhAsc.slice(0, 3).join(',') === '陈五,李四,张三' && s7.cleared,
    JSON.stringify({ zhAsc: s7.zhAsc, cleared: s7.cleared }));

  // 排序状态随 .axl 入档:再排一次(菜单)→ 保存(已有路径不弹框)→ 读档断言 sort 字段
  await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    w.querySelector('thead th[data-c="1"] .col-sort').click();
    await sleep(100);
    [...w.querySelectorAll('.sheet-pop .pop-item')].find(b => b.textContent.includes('升序')).click();
    await sleep(150);
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => (b.title || '').startsWith('保存')).click();
  })()`);
  await sleep(400);
  const s8 = await ev(`(() => {
    const d = JSON.parse(WebOS.fs.read(${JSON.stringify(FILE)}));
    return { sort: d.sort, mark: document.querySelector('.win[data-app=sheet] thead th[data-c="1"] .col-sort')?.textContent };
  })()`);
  t('T61.13 排序状态入档(.axl sort 字段 + 列头 ▲)',
    s8.sort && s8.sort.c === 1 && s8.sort.dir === 1 && s8.mark === '▲', JSON.stringify(s8));

  // 固定表头行:工具栏下拉设 2 → 前两行冻结(钉顶不随滚动)、不参与排序、随档保存
  const s9 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const edit = (r, c, text) => {
      pd(td(r, c));
      td(r, c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const i = td(r, c).querySelector('input.cell-in');
      i.value = text;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    // 打开固定行下拉 → 选「固定前 2 行」
    const fbtn = [...w.querySelectorAll('.app-toolbar .btn')].find(b => (b.title || '').includes('固定表头行'));
    fbtn.click();
    await sleep(120);
    const picked = [...w.querySelectorAll('.sheet-pop .pop-item')].find(b => b.textContent.includes('2 行'));
    picked.click();
    await sleep(150);
    const cls = { r0: td(0, 0).className, r1: td(1, 0).className, r2: td(2, 0).className,
                  rowh0: w.querySelector('tbody th.rowh').className, label: fbtn.textContent };
    // 滚动钉顶:滚 300px 后固定行仍贴在列头正下方,普通行滚走
    const wrap = w.querySelector('.sheet-wrap');
    wrap.scrollTop = 300;
    await sleep(100);
    const headBottom = w.querySelector('.sheet-table thead th').getBoundingClientRect().bottom;
    const fzTop = td(0, 0).getBoundingClientRect().top;
    const fz1Top = td(1, 0).getBoundingClientRect().top;
    const normalTop = td(20, 0).getBoundingClientRect().top;
    const sticky = fzTop >= headBottom - 1.5 && fzTop <= headBottom + 1.5 && fz1Top - fzTop < 32 && normalTop > fzTop + 50;
    wrap.scrollTop = 0;
    // 排序跳过固定行:D 列 0/1 行放 H1/H2(文本),2..4 行放 30/10/20(数字)→ 升序
    edit(0, 3, 'H1'); edit(1, 3, 'H2'); edit(2, 3, '30'); edit(3, 3, '10'); edit(4, 3, '20');
    w.querySelector('thead th[data-c="3"] .col-sort').click();
    await sleep(100);
    [...w.querySelectorAll('.sheet-pop .pop-item')].find(b => b.textContent.includes('升序')).click();
    await sleep(150);
    const colD = [0, 1, 2, 3, 4].map((r) => td(r, 3).textContent).join(',');
    return { cls, sticky, colD };
  })()`);
  t('T61.14 固定表头行(下拉选 2:fz 类 + 行号着色 + 钉顶不随滚动)',
    s9.cls.r0.includes('fz') && s9.cls.r1.includes('fz-last') && !s9.cls.r2.includes('fz')
    && s9.cls.rowh0.includes('fz') && s9.cls.label.includes('2') && s9.sticky,
    JSON.stringify(s9));
  t('T61.15 固定行不参与排序(H1/H2 原位,下方数字序 10,20,30)',
    s9.colD === 'H1,H2,10,20,30', s9.colD);
  // 固定行入档
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=sheet]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => (b.title || '').startsWith('保存')).click();
  })()`);
  await sleep(400);
  const s10 = await ev(`JSON.parse(WebOS.fs.read(${JSON.stringify(FILE)})).fixed`);
  t('T61.16 固定行入档(.axl fixed 字段 = 2)', s10 === 2, String(s10));

  // 单元格剪贴板(非编辑态 Ctrl+C/V):值+样式随块、虚线标记随粘清、
  // 整列选择不接管、越界粘贴自动扩列
  const s11 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const edit = (r, c, text) => {
      pd(td(r, c));
      td(r, c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const i = td(r, c).querySelector('input.cell-in');
      i.value = text;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const btn = (t) => [...w.querySelectorAll('.app-toolbar .btn')]
      .find(b => ((b.title || '') + '|' + b.textContent.trim()).includes(t));
    const wrap = w.querySelector('.sheet-wrap');
    const key = (k, opt = {}) => wrap.dispatchEvent(new KeyboardEvent('keydown',
      { key: k, bubbles: true, cancelable: true, ...opt }));
    // 源数据:A1=甲 B1=乙(锚点取反确保加粗) A2=丙。B1 可能带着此前
    // 用例经排序迁移来的样式,故记录取反前后态,断言改为"样式随复制走"
    edit(0, 0, '甲'); edit(0, 1, '乙'); edit(1, 0, '丙');
    pd(td(0, 1));
    const beforeBold = td(0, 1).classList.contains('b');
    btn('加粗').click();
    const srcBold = td(0, 1).classList.contains('b');
    // 选 A1:B2 → Ctrl+C(4 格虚线标记)
    pd(td(0, 0));
    pd(td(1, 1), { shiftKey: true });
    key('c', { ctrlKey: true });
    const marked = w.querySelectorAll('td.copy-src').length;
    // 点 D4 → Ctrl+V(值+样式覆盖粘贴,标记清除)
    pd(td(3, 3));
    key('v', { ctrlKey: true });
    await sleep(150);
    const pasted = {
      d4: td(3, 3).textContent, e4: td(3, 4).textContent, d5: td(4, 3).textContent,
      styleFollows: td(3, 4).classList.contains('b') === srcBold,
      markCleared: !w.querySelector('.copy-src'),
    };
    // 越界粘贴(先做,此时剪贴板仍是 A1:B2):T1(最后一列)粘 2 列宽 → 网格扩到 21 列
    pd(td(0, 19));
    const curAtPaste = w.querySelector('td.cur')?.dataset?.r + ',' + w.querySelector('td.cur')?.dataset?.c;
    key('v', { ctrlKey: true });
    await sleep(150);
    const grown = td(0, 20)?.textContent === '乙';
    const cols2 = w.querySelectorAll('.sheet-table thead th').length - 1;
    // 空列(无内容)→ Ctrl+C 不接管:粘贴清了标记,现在应仍为 0
    pd(w.querySelector('thead th[data-c="10"]'));
    key('c', { ctrlKey: true });
    const emptyNoCopy = w.querySelectorAll('td.copy-src').length === 0;
    // 整列(有内容):B 列头 → Ctrl+C → 裁剪到内容边界(标记有限且全在 B 列)
    pd(w.querySelector('thead th[data-c="1"]'));
    key('c', { ctrlKey: true });
    const colMarks = [...w.querySelectorAll('td.copy-src')];
    const colBounded = colMarks.length >= 1 && colMarks.length < 20
      && colMarks.every(m => m.dataset.c === '1');
    // 整行(有内容):行头 0 → 裁剪到内容边界,全在第 0 行
    pd(w.querySelector('tbody th.rowh[data-r="0"]'));
    key('c', { ctrlKey: true });
    const rowMarks = [...w.querySelectorAll('td.copy-src')];
    const rowBounded = rowMarks.length >= 1 && rowMarks.length < 25
      && rowMarks.every(m => m.dataset.r === '0');
    return { beforeBold, srcBold, marked, pasted, curAtPaste, grown, cols2,
      emptyNoCopy, colBounded, rowBounded, colN: colMarks.length, rowN: rowMarks.length };
  })()`);
  t('T61.17 单元格复制粘贴(非编辑态 Ctrl+C/V:值+样式随走、虚线标记随粘清)',
    s11.marked === 4 && s11.srcBold === !s11.beforeBold
    && s11.pasted.d4 === '甲' && s11.pasted.e4 === '乙' && s11.pasted.d5 === '丙'
    && s11.pasted.styleFollows && s11.pasted.markCleared,
    JSON.stringify(s11));
  t('T61.18 表头选择复制(整行/整列裁剪到内容边界;空列不接管;越界粘贴自动扩列 20→21)',
    s11.emptyNoCopy && s11.colBounded && s11.rowBounded && s11.cols2 === 21 && s11.grown,
    JSON.stringify({ emptyNoCopy: s11.emptyNoCopy, colBounded: s11.colBounded, colN: s11.colN,
      rowBounded: s11.rowBounded, rowN: s11.rowN, cols2: s11.cols2, grown: s11.grown, curAtPaste: s11.curAtPaste }));

  // 剪切:Ctrl+X 立即清源(粘到本应用或外部程序语义一致),粘贴后目标得值+样式、标记清
  const s12 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const edit = (r, c, text) => {
      pd(td(r, c));
      td(r, c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const i = td(r, c).querySelector('input.cell-in');
      i.value = text;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const btn = (t) => [...w.querySelectorAll('.app-toolbar .btn')]
      .find(b => ((b.title || '') + '|' + b.textContent.trim()).includes(t));
    const wrap = w.querySelector('.sheet-wrap');
    const key = (k, opt = {}) => wrap.dispatchEvent(new KeyboardEvent('keydown',
      { key: k, bubbles: true, cancelable: true, ...opt }));
    // 源 F6:G7(此前用例未触碰的净区),F6 锚点取反确保加粗
    edit(5, 5, 'x1'); edit(5, 6, 'x2'); edit(6, 5, 'x3');
    pd(td(5, 5));
    const beforeBold = td(5, 5).classList.contains('b');
    btn('加粗').click();
    const srcBold = td(5, 5).classList.contains('b');
    pd(td(5, 5));
    pd(td(6, 6), { shiftKey: true });
    key('x', { ctrlKey: true });
    const marked = w.querySelectorAll('td.copy-src').length;
    const clearedNow = { f6: td(5, 5).textContent, g6: td(5, 6).textContent, f7: td(6, 5).textContent };
    // 粘到 I9 → 目标得值带样式(剪切不落下内容),标记随粘清
    pd(td(8, 8));
    key('v', { ctrlKey: true });
    await sleep(150);
    return { beforeBold, srcBold, marked, clearedNow,
      dest: { i9: td(8, 8).textContent, j9: td(8, 9).textContent, i10: td(9, 8).textContent,
              styleFollows: td(8, 8).classList.contains('b') === srcBold },
      markCleared: !w.querySelector('.copy-src') };
  })()`);
  t('T61.19 剪切(X 立即清源 → 粘贴后目标得值+样式、标记清)',
    s12.marked === 4 && s12.clearedNow.f6 === '' && s12.clearedNow.g6 === '' && s12.clearedNow.f7 === ''
    && s12.dest.i9 === 'x1' && s12.dest.j9 === 'x2' && s12.dest.i10 === 'x3'
    && s12.dest.styleFollows && s12.srcBold === !s12.beforeBold && s12.markCleared,
    JSON.stringify(s12));

  // 行高自适应 + 行/列拖拽移动(表头按住拖 ≥5px;以内仍是点选)
  const s13 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const edit = (r, c, text) => {
      pd(td(r, c));
      td(r, c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const i = td(r, c).querySelector('input.cell-in');
      i.value = text;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const wrap = w.querySelector('.sheet-wrap');
    const dragTo = (fromEl, toEl) => {
      const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
      fromEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: a.x + a.width / 2, clientY: a.y + a.height / 2, pointerId: 1, isPrimary: true }));
      wrap.dispatchEvent(new PointerEvent('pointermove', { bubbles: true,
        clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, pointerId: 1 }));
      wrap.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    };
    // 行高:短文 28 → 长文撑到 50 封顶(截断 2 行)→ 改短回 28
    const H = (r) => getComputedStyle(td(r, 0)).height;
    edit(6, 0, '短');
    const hShort = H(6);
    edit(6, 0, '这是一段很长很长很长很长很长很长很长很长的文字内容用来撑高行');
    const hLongPx = parseInt(H(6));
    const lc = getComputedStyle(td(6, 0).querySelector('.cell-txt')).webkitLineClamp;
    edit(6, 0, '短');
    const hBack = H(6);
    // 列拖移:B 列头拖到 D 列头 → 数据换位(表头字母按位置恒定:A C B D 序)
    edit(6, 1, 'b1'); edit(6, 2, 'c1'); edit(6, 3, 'd1');
    dragTo(w.querySelector('thead th[data-c="1"]'), w.querySelector('thead th[data-c="3"]'));
    await sleep(200);
    const colMoved = { p1: td(6, 1).textContent, p2: td(6, 2).textContent, p3: td(6, 3).textContent };
    // 行拖移:行头 8 拖到行头 7 → 两行标记换位
    edit(7, 5, 'm7'); edit(8, 5, 'm8');
    dragTo(w.querySelector('tbody th.rowh[data-r="8"]'), w.querySelector('tbody th.rowh[data-r="7"]'));
    await sleep(200);
    const rowMoved = { r7: td(7, 5).textContent, r8: td(8, 5).textContent };
    return { hShort, hLongPx, hBack, lc, colMoved, rowMoved };
  })()`);
  t('T61.20 行高自适应(短 28 → 长文封顶 5 行 + 截断 → 改短回 28)',
    s13.hShort === '28px' && s13.hLongPx >= 85 && s13.hLongPx <= 115 && s13.hBack === '28px' && s13.lc === '5',
    JSON.stringify(s13));
  t('T61.21 行/列拖拽移动(列数据换位;行标记换位)',
    s13.colMoved.p1 === 'c1' && s13.colMoved.p2 === 'b1' && s13.colMoved.p3 === 'd1'
    && s13.rowMoved.r7 === 'm8' && s13.rowMoved.r8 === 'm7',
    JSON.stringify(s13));

  // 选区内拖动 = 整块移动(源清、目标得值、选区随块走);原地点击 = 收缩选区
  const s14 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el, opt = {}) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, ...opt })); };
    const edit = (r, c, text) => {
      pd(td(r, c));
      td(r, c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const i = td(r, c).querySelector('input.cell-in');
      i.value = text;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const wrap = w.querySelector('.sheet-wrap');
    const up = () => wrap.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    // 净区建块:G11:H12(rows 10-11 × cols 6-7)
    edit(10, 6, 'p1'); edit(10, 7, 'p2'); edit(11, 6, 'p3');
    pd(td(10, 6));
    pd(td(11, 7), { shiftKey: true });
    const selCount = w.querySelectorAll('td.sel').length;
    // 拖动:从选区内 (10,6) 按下 → 拖到 (13,8) 松手
    pd(td(10, 6));
    const b = td(13, 8).getBoundingClientRect();
    wrap.dispatchEvent(new PointerEvent('pointermove', { bubbles: true,
      clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, pointerId: 1 }));
    up();
    await sleep(200);
    const moved = {
      src: [td(10, 6).textContent, td(10, 7).textContent, td(11, 6).textContent].join(','),
      dest: [td(13, 8).textContent, td(13, 9).textContent, td(14, 8).textContent].join(','),
      curAt: w.querySelector('td.cur')?.dataset?.r + ',' + w.querySelector('td.cur')?.dataset?.c,
    };
    // 原地点击选区内:收缩为该格
    pd(td(14, 9));
    up();
    await sleep(100);
    const collapsed = { selN: w.querySelectorAll('td.sel').length,
      cur: w.querySelector('td.cur')?.dataset?.r + ',' + w.querySelector('td.cur')?.dataset?.c };
    return { selCount, moved, collapsed };
  })()`);
  t('T61.22 选区整块拖动移动(源清、目标得值、选区随块走;原地点击收缩)',
    s14.selCount === 4 && s14.moved.src === ',,' && s14.moved.dest === 'p1,p2,p3'
    && s14.moved.curAt === '13,8' && s14.collapsed.selN === 1 && s14.collapsed.cur === '14,9',
    JSON.stringify(s14));

  // 自动保存开关:默认按下(.on 底色)→ 改动 1.5s 后静默落盘、标题去脏点;
  // 关闭后改动不落盘(标题保持 ●);文件三钮已纯图标化(title 提示)
  const s15 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = document.querySelector('.win[data-app=sheet]');
    const td = (r, c) => w.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const pd = (el) => { const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true })); };
    const edit = (r, c, text) => {
      pd(td(r, c));
      td(r, c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const i = td(r, c).querySelector('input.cell-in');
      i.value = text;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const asBtn = [...w.querySelectorAll('.app-toolbar .btn')].find(b => (b.title || '').startsWith('自动保存'));
    const defOn = asBtn.classList.contains('on');
    const fileBtns = [...w.querySelectorAll('.app-toolbar .btn')]
      .filter(b => ['打开', '保存', '另存为'].some(t => (b.title || '').startsWith(t))).length;
    // 开:编辑 → 2.3s 后已静默落盘、标题无 ●
    edit(16, 0, 'auto1');
    await sleep(2300);
    const on1 = WebOS.fs.read(${JSON.stringify(FILE)}).includes('auto1')
      && !w.querySelector('.win-title').textContent.includes('●');
    // 关:编辑 → 不落盘、标题带 ●
    asBtn.click();
    const offState = !asBtn.classList.contains('on');
    edit(16, 0, 'auto2');
    await sleep(2300);
    const off1 = !WebOS.fs.read(${JSON.stringify(FILE)}).includes('auto2')
      && w.querySelector('.win-title').textContent.includes('●');
    asBtn.click();   // 还原默认开
    return { defOn, fileBtns, on1, offState, off1 };
  })()`);
  t('T61.23 自动保存开关(默认按下;开=1.5s 静默落盘去脏点;关=不落盘;文件钮纯图标)',
    s15.defOn && s15.fileBtns === 3 && s15.on1 && s15.offState && s15.off1,
    JSON.stringify(s15));
  await c.shot('t61-sheet');
  await ev(`WebOS.fs.rm(${JSON.stringify(FILE)})`);
});
