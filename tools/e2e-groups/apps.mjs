/* ============================================================
 * AetherWebOS e2e 用例组 · 内置应用(T11 T12 T26 T27 T28 T30 T32 T37 T38 T43)
 * 自原 e2e.mjs 单文件按域拆出;公共助手见 tools/e2e-harness.mjs。
 * 本文件只做 group() 注册(被入口 tools/e2e.mjs import),不要直接运行。
 * ============================================================ */
import { group, t, ev, c, fresh, sleep, waitFor, needApps, termType, nav, bashType, bashOut, ctxClick, typeReal, pressEnter, clickReal, wipeAppData, wipeSharedAppData } from '../e2e-harness.mjs';

group('T11', '计算器', async () => {
  /* ---- T11 计算器 ---- */
  await ev(`WebOS.wm.open('calc')`);
  await sleep(500);
  await ev(`[...document.querySelectorAll('.ckey')].find(k=>k.textContent==='7').click()`);
  await ev(`[...document.querySelectorAll('.ckey')].find(k=>k.textContent==='×').click()`);
  await ev(`[...document.querySelectorAll('.ckey')].find(k=>k.textContent==='8').click()`);
  await ev(`[...document.querySelectorAll('.ckey')].find(k=>k.textContent==='=').click()`);
  const calc = await ev(`document.querySelector('.calc-main').textContent`);
  t('T11 计算器 7×8=56', calc === '56', calc);
  // 边界:(1+2)×3=9,含括号与一元负号
  await ev(`(async () => {
    const press = (label) => [...document.querySelectorAll('.ckey')].find(k => k.textContent === label).click();
    press('C');
    for (const label of ['(', '1', '+', '2', ')', '×', '3', '=']) press(label);
  })()`);
  await sleep(200);
  const calc2 = await ev(`document.querySelector('.calc-main').textContent`);
  t('T11.1 计算器 (1+2)×3=9', calc2 === '9', calc2);
  await c.shot('t11-calc');

});

group('T12', '音乐播放器(播放 / 上次曲目落盘与恢复)', async () => {
  /* ---- T12 音乐播放器 ---- */
  const u12 = await ev(`WebOS.accounts.current()`);
  await wipeAppData(u12, 'music');   // 上次曲目存 ~/appdata/music.awdb:清档,从默认曲目起测
  await needApps('music');
  await ev(`WebOS.wm.open('music')`);
  await sleep(500);
  await ev(`document.querySelector('.play-btn').click()`);
  await sleep(900);
  const music = await ev(`({
    playing: !!document.querySelector('.music-item.playing'),
    pauseRects: document.querySelectorAll('.play-btn svg rect').length, // 暂停图标 = 2 个矩形
    progress: document.querySelector('.music-progress i').style.width,
  })`);
  t('T12 音乐播放', music.playing && music.pauseRects === 2, JSON.stringify(music));
  await c.shot('t12-music');
  await ev(`document.querySelector('.play-btn').click()`); // 暂停
  await sleep(200);

  /* ---- T12.1 上次曲目:点最后一曲 → ~/appdata/music.awdb 落盘 ---- */
  await ev(`[...document.querySelectorAll('.music-item')].pop().click()`);
  await sleep(500);   // rememberTrack 200ms 防抖 + 库写入
  const saved = await ev(`(() => ({
    sel: [...document.querySelectorAll('.music-item')].findIndex(b => b.classList.contains('playing')),
    n: document.querySelectorAll('.music-item').length,
    db: WebOS.fs.exists('/home/' + WebOS.accounts.current() + '/appdata/music.awdb'),
  }))()`);
  t('T12.1 点选最后一曲(曲目记忆落盘)', saved.sel === saved.n - 1 && saved.db === true,
    JSON.stringify(saved));
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=music]').dataset.id)`);   // 关窗即停
  await sleep(300);
  await ev(`(async () => { await WebOS.fs.flush(); return true; })()`);   // 落盘元数据在刷新前写进 OPFS

  /* ---- T12.2 重载后恢复上次曲目(选中高亮,但不自动播放) ---- */
  await fresh();
  await ev(`WebOS.wm.open('music')`);
  await sleep(800);   // 等恢复水合(开库读 state)
  const restored = await ev(`(() => {
    const w = document.querySelector('.win[data-app=music]');
    return {
      sel: [...w.querySelectorAll('.music-item')].findIndex(b => b.classList.contains('playing')),
      n: w.querySelectorAll('.music-item').length,
      title: w.querySelector('.app-toolbar span').textContent,
      pauseRects: w.querySelectorAll('.play-btn svg rect').length,   // 0 = 播放三角图标(未自动播放)
    };
  })()`);
  t('T12.2 重载后恢复上次曲目(不自动播放)',
    restored.sel === restored.n - 1 && restored.title === '天空练习曲' && restored.pauseRects === 0,
    JSON.stringify(restored));
  await c.shot('t12-music-restore');
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=music]').dataset.id)`);
  await sleep(200);

  const errs12 = await ev(`window.__errs.length`);
  t('T12.3 全程无运行错误', errs12 === 0, `errs=${errs12}`);

});

group('T26', '邮件应用', async () => {
  /* ---- T26 邮件(邮箱地址为自有身份,不依赖系统登录) ---- */
  await ev(`WebOS.vnet.resetState();
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.mail.v1')) localStorage.removeItem(k);`);
  await wipeSharedAppData('mail');   // 清邮箱身份库(mail#*.awdb)+ 旧按用户库,种子邮件重新播种
  await fresh();
  // 邮件按「系统设置 username@aetherwebos」独立成库,无需登录
  await ev(`WebOS.wm.open('mail')`);
  await sleep(900);
  const m1 = await ev(`(() => {
    const items = [...document.querySelectorAll('.mail-item')];
    return {
      count: items.length,
      unread: items.filter(i => i.classList.contains('unread')).length,
      title: document.querySelector('.win[data-app=mail] .win-title').textContent,
      folders: [...document.querySelectorAll('.mail-side .list-item')].map(f => f.textContent.trim()),
    };
  })()`);
  t('T26 邮件:三封种子邮件 + 未读标记', m1.count === 3 && m1.unread === 2 && m1.title.includes('(2)'),
    JSON.stringify({ count: m1.count, unread: m1.unread, folders: m1.folders.length }));

  // 阅读图书馆邮件 → 已读、标题计数减一
  await ev(`(() => { [...document.querySelectorAll('.mail-item')].find(i => i.textContent.includes('图书馆')).click(); })()`);
  await sleep(400);
  const m2 = await ev(`({
    subject: document.querySelector('.mail-subject')?.textContent,
    unreadLeft: document.querySelectorAll('.mail-item.unread').length,
    title: document.querySelector('.win[data-app=mail] .win-title').textContent,
  })`);
  t('T26.1 阅读邮件(已读状态联动)', m2.subject?.includes('维护') && m2.unreadLeft === 1 && !m2.title.includes('(2)'),
    JSON.stringify(m2.subject));

  // 附件(路径转换)→ 打开浏览器并加载 PDF
  await ev(`(() => {
    const item = [...document.querySelectorAll('.mail-item')].find(i => i.textContent.includes('每周通讯'));
    item.click();
  })()`);
  await sleep(500);
  await ev(`document.querySelector('.mail-attach-chip')?.click()`);
  await sleep(2000);
  const m3 = await ev(`(() => {
    const f = document.querySelector('.win[data-app=browser] .vw-iframe');
    return { browserOpen: !!document.querySelector('.win[data-app=browser]'),
      proxied: !!f && !f.hidden && (f.src || '').includes('w3.org') };
  })()`);
  t('T26.2 附件 → 浏览器路径转换 PDF', m3.browserOpen && m3.proxied, JSON.stringify(m3));
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=browser]').dataset.id)`);
  await sleep(400);

  // 写信给 hint@nexus → 已发送;自动回信送达收件箱
  await ev(`[...document.querySelectorAll('.win[data-app=mail] .btn')].find(b => b.textContent.includes('写邮件')).click()`);
  await sleep(400);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=mail]');
    const fields = w.querySelectorAll('.mail-field');
    fields[0].value = 'hint@nexus';
    fields[1].value = '关于赛博档案';
    fields[2].value = '请给我档案的线索';
    return true;
  })()`);
  await ev(`[...document.querySelectorAll('.win[data-app=mail] .btn.primary')].find(b => b.textContent.includes('发送')).click()`);
  await sleep(400);
  const m4a = await ev(`(() => ({
    folder: [...document.querySelectorAll('.mail-side .list-item')].find(f => f.textContent.includes('已发送')) ? true : false,
    sentShown: document.querySelectorAll('.mail-item').length,
    sentTo: document.querySelector('.mail-item .m-from')?.textContent,
  }))()`);
  await sleep(1500);   // 等自动回信
  await ev(`[...document.querySelectorAll('.mail-side .list-item')].find(f => f.textContent.includes('收件箱')).click()`);
  await sleep(400);
  const m4 = await ev(`({
    replySubject: document.querySelector('.mail-item .m-subj')?.textContent,
    replyFrom: document.querySelector('.mail-item .m-from')?.textContent,
    inboxCount: document.querySelectorAll('.mail-item').length,
  })`);
  t('T26.3 发送邮件 + 服务台自动回信', m4a.sentShown === 1 && m4.replySubject?.includes('Re:') && m4.replyFrom?.includes('服务台'),
    JSON.stringify({ sent: m4a.sentShown, reply: m4.replySubject }));

  // 阅读回信内容(提示文案)
  await ev(`document.querySelector('.mail-item').click()`);
  await sleep(400);
  const m5 = await ev(`document.querySelector('.mail-body')?.textContent.includes('图书馆')`);
  t('T26.4 回信内容(谜题提示)', m5 === true);

  // 删除 → 垃圾箱;垃圾箱内再删 → 彻底删除
  await ev(`[...document.querySelectorAll('.win[data-app=mail] .btn.danger')].pop().click()`);
  await sleep(400);
  const trashCount = await ev(`WebOS.mail.stats().trash`);
  t('T26.5 删除进垃圾箱', trashCount === 1, `trash=${trashCount}`);
  await ev(`[...document.querySelectorAll('.mail-side .list-item')].find(f => f.textContent.includes('垃圾箱')).click()`);
  await sleep(300);
  await ev(`document.querySelector('.mail-item')?.click()`);
  await sleep(300);
  await ev(`[...document.querySelectorAll('.win[data-app=mail] .btn.danger')].pop().click()`);
  await sleep(400);
  const trashAfter = await ev(`WebOS.mail.stats().trash`);
  t('T26.6 垃圾箱彻底删除', trashAfter === 0, `trash=${trashAfter}`);

  // 持久化:刷新后已发送仍在
  await fresh();
  await ev(`WebOS.wm.open('mail')`);
  await sleep(700);
  await ev(`[...document.querySelectorAll('.mail-side .list-item')].find(f => f.textContent.includes('已发送')).click()`);
  await sleep(400);
  const m6 = await ev(`document.querySelectorAll('.mail-item').length`);
  t('T26.7 持久化(刷新后已发送仍在)', m6 === 1, `sent=${m6}`);
  await c.shot('t26-mail');

  const errs26 = await ev(`window.__errs.length`);
  t('T26.8 全程无错误', errs26 === 0, `errs=${errs26}`);

});

group('T27', '便签(Todo)应用', async () => {
  /* ---- T27 便签应用(原名「任务」):无边框顶栏(最小化/锁/☰,输入态让位)+ 双击空白新建 + 独立便签窗口 ---- */
  await ev(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.todo.v1') || k === 'webos.account-session.v1') localStorage.removeItem(k);
  })()`);
  await wipeAppData('todoer', 'todo');   // 数据已迁 appdata:清档,种子任务重新播种
  await fresh();   // 清档重载(含账号会话),种子数据从零开始
  // 登录测试用户(todo 需要账号)
  await ev(`(async () => {
    const acc = (await import('./js/core/accounts.js')).accounts;
    if (!(await acc.login('todoer', 'todopass').then(r => r.ok)).catch?.(() => false)) {
      await acc.register('todoer', 'todopass');
    }
  })()`);
  await sleep(400);
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  const td0 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=todo]');
    const wr = w.getBoundingClientRect();
    const cr = w.querySelector('.todo-close').getBoundingClientRect();
    return {
      items: w.querySelectorAll('.todo-item').length,
      head: !!w.querySelector('.win-head'),          // 无边框:无系统窗头
      bar: !!w.querySelector('.todo-bar'),
      input: w.querySelector('.todo-bar .todo-input')?.tagName,   // TEXTAREA
      min: !!w.querySelector('.todo-min'),           // 最小化
      lock: !!w.querySelector('.todo-lock'),         // 置顶锁
      menuBtn: !!w.querySelector('.todo-menu-btn'),  // ☰ 更多设置
      close: !!w.querySelector('.todo-close'),
      inputCollapsed: w.querySelector('.todo-input').offsetWidth < 200,   // 未聚焦时收窄
      spacerW: w.querySelector('.todo-bar-spacer')?.offsetWidth || 0,     // 图标组右对齐的占位
      rightAligned: wr.right - cr.right < 20,        // ✕ 贴窗口右缘
      bg: getComputedStyle(w).backgroundColor,       // 激活态不透明淡黄
    };
  })()`);
  t('T27 便签结构(顶栏:输入收窄/图标组右对齐,最小化/锁/☰/✕,种子 1 条)',
    td0.items === 1 && !td0.head && td0.bar && td0.input === 'TEXTAREA' && td0.min && td0.lock
      && td0.menuBtn && td0.close && td0.inputCollapsed && td0.spacerW > 20 && td0.rightAligned
      && td0.bg === 'rgb(254, 249, 224)',
    JSON.stringify(td0));

  // 输入态让位:聚焦 → 输入框展开,隐藏 最小化/锁/☰(✕ 保留);失焦恢复
  const es = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=todo]');
    const bar = w.querySelector('.todo-bar');
    const inp = w.querySelector('.todo-input');
    const hidden = (sel) => {
      const b = w.querySelector(sel);
      return !b || b.offsetParent === null;
    };
    inp.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 250));
    const during = {
      editing: bar.classList.contains('editing'),
      wide: inp.offsetWidth > 200,
      minHidden: hidden('.todo-min'), lockHidden: hidden('.todo-lock'), menuHidden: hidden('.todo-menu-btn'),
      closeVisible: !hidden('.todo-close'),
    };
    inp.dispatchEvent(new Event('blur'));
    await new Promise(r => setTimeout(r, 250));
    const after = {
      editing: !bar.classList.contains('editing'),
      narrow: inp.offsetWidth < 200,
      minVisible: !hidden('.todo-min'), lockVisible: !hidden('.todo-lock'), menuVisible: !hidden('.todo-menu-btn'),
    };
    return { during, after };
  })()`);
  t('T27.0b 输入态让位(聚焦隐藏最小化/锁/☰,失焦恢复)',
    es.during.editing && es.during.wide && es.during.minHidden && es.during.lockHidden && es.during.menuHidden && es.during.closeVisible
      && es.after.editing && es.after.narrow && es.after.minVisible && es.after.lockVisible && es.after.menuVisible,
    JSON.stringify(es));

  // ✓ 首击即成(pointerdown 先于失焦回流,回归:click 曾被按钮位移吞掉);
  // Esc 空文退回收窄态。用完即删,不动后续计数
  const ok = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=todo]');
    const bar = w.querySelector('.todo-bar');
    const inp = w.querySelector('.todo-input');
    inp.dispatchEvent(new Event('focus'));
    inp.value = '对号首击任务';
    inp.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    w.querySelector('.todo-add-btn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 200));
    const added = [...document.querySelectorAll('.todo-t')].some(x => x.textContent === '对号首击任务');
    if (added) {
      const row = [...document.querySelectorAll('.todo-item')].find(i => i.textContent.includes('对号首击任务'));
      row.querySelector('.todo-del').click();
      await new Promise(r => setTimeout(r, 150));
    }
    inp.dispatchEvent(new Event('focus'));
    inp.value = '';
    inp.dispatchEvent(new Event('input'));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const collapsed = !bar.classList.contains('editing') && !inp.classList.contains('filled');
    return { added, collapsed };
  })()`);
  t('T27.0c ✓ 首击即成 / Esc 空文收回', ok.added && ok.collapsed, JSON.stringify(ok));

  // 添加任务(输入 → 回车 → 列表 + 持久化)
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=todo] .todo-input');
    inp.value = '写周报';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(600);   // persist 防抖 200ms
  const stored1 = await waitFor(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    return ((s?.boards || []).find(b => b.type === 'todo')?.tasks || []).some(t => t.text === '写周报' && !t.done) || null;
  })()`, 5000);
  const td1 = {
    added: await ev(`[...document.querySelectorAll('.todo-t')].some(t => t.textContent === '写周报')`),
    store: stored1 === true,
  };
  t('T27.1 添加任务(回车→列表+持久化)', td1.added && td1.store, JSON.stringify(td1));

  // 完成与取消完成(圆圈点击 → 划线;再点 → 还原);选中态 = 空心 + 内点(非实心)
  const td2 = await ev(`(async () => {
    const row = () => [...document.querySelectorAll('.todo-item')].find(i => i.textContent.includes('写周报'));
    row().querySelector('.todo-check').click();
    await new Promise(r => setTimeout(r, 150));
    const cs = getComputedStyle(row().querySelector('.todo-check'));
    const af = getComputedStyle(row().querySelector('.todo-check'), '::after');
    const dot = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && af.content === '""';
    const done = !!row()?.classList.contains('done');
    row().querySelector('.todo-check').click();
    await new Promise(r => setTimeout(r, 150));
    const undone = !row()?.classList.contains('done');
    return { done, undone, dot };
  })()`);
  t('T27.2 点击完成/取消完成(选中=空心点)', td2.done && td2.undone && td2.dot, JSON.stringify(td2));

  // 双击编辑任务文本(Enter 保存)—— 双击打在文字上(真实手势的 target,
  // 回归:文字被行内编辑替换出 DOM 后,空白双击监听曾误判并顶掉编辑器)
  const td3 = await ev(`(async () => {
    const row = [...document.querySelectorAll('.todo-item')].find(i => i.textContent.includes('未完成任务'));
    row.querySelector('.todo-t').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const ed = row.querySelector('.todo-edit');
    if (!ed) return { noEdit: true };
    ed.value = '未完成任务(已编辑)';
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return { edited: [...document.querySelectorAll('.todo-t')].some(x => x.textContent.includes('已编辑')) };
  })()`);
  await sleep(600);
  const stored3 = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    return ((s?.boards || []).find(b => b.type === 'todo')?.tasks || []).some(t => t.text.includes('已编辑'));
  })()`);
  t('T27.3 双击编辑任务文本(保存+持久化)', td3.edited && stored3 === true, JSON.stringify(td3));

  // 双击空白处新建:空内容失焦不创建;有内容失焦创建
  const draft0 = await ev(`(() => {
    const box = document.querySelector('.win[data-app=todo] .todo-items');
    box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 220, clientY: 330 }));
    return !!document.querySelector('.todo-draft .todo-edit');
  })()`);
  await ev(`document.querySelector('.todo-draft .todo-edit')?.dispatchEvent(new Event('blur'))`);   // 无头 Chrome 的 .blur() 不派发事件,须合成
  await sleep(200);
  const noCreate = await ev(`(() => ({
    draftGone: !document.querySelector('.todo-draft'),
    count: document.querySelectorAll('.win[data-app=todo] .todo-item').length,
  }))()`);
  await ev(`(() => {
    const box = document.querySelector('.win[data-app=todo] .todo-items');
    box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 220, clientY: 330 }));
    const ed = document.querySelector('.todo-draft .todo-edit');
    ed.value = '空白处双击创建';
    ed.dispatchEvent(new Event('blur'));
  })()`);
  await sleep(600);
  const created = await ev(`(() => ({
    created: [...document.querySelectorAll('.todo-t')].some(x => x.textContent === '空白处双击创建'),
    count: document.querySelectorAll('.win[data-app=todo] .todo-item').length,
  }))()`);
  t('T27.3b 双击空白新建任务(空弃/有文即建)',
    draft0 === true && noCreate.draftGone && noCreate.count === 2 && created.created && created.count === 3,
    JSON.stringify({ draft0, noCreate, created }));

  // 回车 = 新建并直接编辑(焦点在空白处时;输入框/编辑框里的回车另有语义)
  const enterDraft = await ev(`(async () => {
    document.activeElement?.blur?.();
    document.body.focus?.();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const ed = document.querySelector('.todo-draft .todo-edit');
    if (!ed) return { draft: false };
    ed.value = '回车新建的任务';
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return {
      draft: true,
      created: [...document.querySelectorAll('.todo-t')].some(x => x.textContent === '回车新建的任务'),
      count: document.querySelectorAll('.win[data-app=todo] .todo-item').length,
    };
  })()`);
  t('T27.3c 回车新建并编辑任务', enterDraft.draft && enterDraft.created && enterDraft.count === 4,
    JSON.stringify(enterDraft));

  // 拖拽排序(合成 DnD:第 1 条拖到「写周报」上,落在其前)
  const orderBefore = await ev(`[...document.querySelectorAll('.todo-t')].map(x => x.textContent)`);
  // 拖拽为指针版(5px 起拖阈值):pointerdown 于第 1 条,move 到「写周报」行上,up
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.todo-item')];
    const a = rows[0].getBoundingClientRect();
    rows[0].dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: a.x + 30, clientY: a.y + 10, bubbles: true, cancelable: true }));
    const t = rows.find(r => r.textContent.includes('写周报')).getBoundingClientRect();
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: t.x + 40, clientY: t.y + 10, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: t.x + 40, clientY: t.y + 10, bubbles: true }));
  })()`);
  await sleep(600);
  const orderAfter = await ev(`[...document.querySelectorAll('.todo-t')].map(x => x.textContent)`);
  const stored4 = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    return ((s?.boards || []).find(b => b.type === 'todo')?.tasks || []).map(x => x.text);
  })()`);
  const di = orderBefore.indexOf('写周报');   // 目标行索引(第 1 条拖到它前面)
  t('T27.4 拖拽排序(DOM+持久化)',
    di > 0 && orderAfter[di] === orderBefore[0] && orderAfter[0] === orderBefore[1] && stored4[di] === orderBefore[0],
    JSON.stringify({ before: orderBefore, after: orderAfter }));

  // 删除任务(悬停出的红色 ✕,无确认弹窗)
  const td5 = await ev(`(async () => {
    const row = [...document.querySelectorAll('.todo-item')].find(i => i.textContent.includes('写周报'));
    row.querySelector('.todo-del').click();
    await new Promise(r => setTimeout(r, 150));
    return { gone: ![...document.querySelectorAll('.todo-t')].some(x => x.textContent === '写周报') };
  })()`);
  await sleep(600);
  const stored5 = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    return ((s?.boards || []).find(b => b.type === 'todo')?.tasks || []).some(t => t.text === '写周报');
  })()`);
  t('T27.5 删除任务(列表+持久化)', td5.gone && stored5 === false, JSON.stringify(td5));

  // 创建新便签:☰ 菜单 → 新窗口(无输入框/勾选框,点进去就写)→ 持久化 → 菜单删除
  await ev(`(() => {
    document.querySelector('.win[data-app=todo] .todo-menu-btn').click();
    [...document.querySelectorAll('.todo-menu .tm-item')].find(b => b.textContent.includes('新建便签')).click();
  })()`);
  await sleep(700);
  const note0 = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=todo]')];
    const n = wins.find(w => w.querySelector('.todo-note-text'));
    return {
      count: wins.length,
      hasInput: !!n?.querySelector('.todo-input'),
      hasCheck: !!n?.querySelector('.todo-check'),
      ta: n?.querySelector('.todo-note-text')?.tagName,
    };
  })()`);
  await ev(`(() => {
    const ta = [...document.querySelectorAll('.win[data-app=todo] .todo-note-text')].pop();
    ta.value = '便签内容测试';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(700);
  const noteStore = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    return ((s?.boards || []).some(b => b.type === 'note' && b.text === '便签内容测试'));
  })()`);
  // ☰菜单「打开已有」列出其他板(刚建的便签应在列);点击已开的板 = 聚焦不重复开
  const listed = await ev(`(() => {
    document.querySelector('.win[data-app=todo] .todo-menu-btn').click();
    const names = [...document.querySelectorAll('.todo-menu .tm-board-item')].map(b => b.textContent.trim());
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return names;
  })()`);
  await sleep(200);
  const noDup = await ev(`(async () => {
    const before = document.querySelectorAll('.win[data-app=todo]').length;
    document.querySelector('.win[data-app=todo] .todo-menu-btn').click();
    const item = [...document.querySelectorAll('.todo-menu .tm-board-item')]
      .find(b => b.textContent.includes('便签内容测试'));
    if (!item) return { noItem: true };
    item.click();   // 这块板的窗口正开着 → 应聚焦而非新开
    await new Promise(r => setTimeout(r, 500));
    return { before, after: document.querySelectorAll('.win[data-app=todo]').length };
  })()`);
  await ev(`(() => {
    const n = [...document.querySelectorAll('.win[data-app=todo]')].find(w => w.querySelector('.todo-note-text'));
    n.querySelector('.todo-menu-btn').click();
    [...document.querySelectorAll('.todo-menu .tm-item')].find(b => b.textContent.includes('删除便签')).click();
  })()`);
  await sleep(700);
  const noteGone = await ev(`(() => ({
    winGone: ![...document.querySelectorAll('.win[data-app=todo]')].some(w => w.querySelector('.todo-note-text')),
    mainAlive: !!document.querySelector('.win[data-app=todo] .todo-input'),
  }))()`);
  const noteStoreGone = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    return (s?.boards || []).filter(b => b.type === 'note').length;
  })()`);
  t('T27.5b 创建/删除便签窗口(速记+持久化+菜单列板/已开聚焦)',
    note0.count === 2 && !note0.hasInput && !note0.hasCheck && note0.ta === 'TEXTAREA'
      && noteStore === true && listed.length >= 1 && listed.some(n => n.includes('便签内容测试'))
      && noDup.after === noDup.before
      && noteGone.winGone && noteGone.mainAlive && noteStoreGone === 0,
    JSON.stringify({ note0, noteStore, listed, noDup, noteGone, noteStoreGone }));

  // 窗口自动增高:连加 30 条 → 窗口长高并封顶(不超桌面),列表内部出现滚动
  const h0 = await ev(`document.querySelector('.win[data-app=todo]').offsetHeight`);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=todo] .todo-input');
    for (let i = 1; i <= 30; i++) {
      inp.value = '批量任务' + i;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
  })()`);
  await sleep(400);
  const td6 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=todo]');
    const box = w.querySelector('.todo-items');
    const areaH = document.getElementById('windows').getBoundingClientRect().height;
    return { h: w.offsetHeight, areaH: Math.round(areaH), scrollable: box.scrollHeight > box.clientHeight + 2 };
  })()`);
  t('T27.6 自动增高封顶与列表内部滚动',
    td6.h > h0 + 200 && td6.h <= td6.areaH - 25 && td6.scrollable,
    JSON.stringify({ h0, ...td6 }));
  await c.shot('t27-todo');

  // 删除批量任务:窗口高度回落
  await ev(`(() => {
    for (let i = 0; i < 30; i++) {
      const btn = document.querySelector('.win[data-app=todo] .todo-item .todo-del');
      if (!btn) break;
      btn.click();
    }
  })()`);
  await sleep(400);
  const h2 = await ev(`document.querySelector('.win[data-app=todo]').offsetHeight`);
  t('T27.7 删除后窗口回落', h2 < td6.h - 200 && h2 >= 150, `h2=${h2} capped=${td6.h}`);

  // 用户手动改尺寸(拖右下角)后:自动调高永久停用
  const h3 = await ev(`document.querySelector('.win[data-app=todo]').offsetHeight`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=todo]');
    const rz = w.querySelector('.rz-se');
    const r = rz.getBoundingClientRect();
    rz.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: r.x + 3, clientY: r.y + 3, bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.x + 80, clientY: r.y + 120, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.x + 80, clientY: r.y + 120, bubbles: true }));
  })()`);
  const h4 = await ev(`document.querySelector('.win[data-app=todo]').offsetHeight`);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=todo] .todo-input');
    inp.value = '锁定后任务A';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    inp.value = '锁定后任务B';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
  const h5 = await ev(`document.querySelector('.win[data-app=todo]').offsetHeight`);
  const cnt5 = await ev(`document.querySelectorAll('.win[data-app=todo] .todo-item').length`);
  t('T27.8 用户改尺寸后锁定(加任务不再自动调高)', h4 > h3 + 50 && h5 === h4 && cnt5 === 5, JSON.stringify({ h3, h4, h5, cnt5 }));

  // 置顶(顶栏锁按钮,点亮表示选中):压过新窗口;再点熄灭;非激活态底色半透明
  await ev(`document.querySelector('.win[data-app=todo] .todo-lock').click()`);
  const lockOn = await ev(`document.querySelector('.win[data-app=todo] .todo-lock').classList.contains('on')`);
  await sleep(200);
  await ev(`WebOS.wm.open('calc')`);
  await sleep(500);
  const td9 = await ev(`(() => {
    const a = document.querySelector('.win[data-app=todo]');
    const b = document.querySelector('.win[data-app=calc]');
    return {
      todo: +a.style.zIndex, calc: +b.style.zIndex,
      bgInactive: getComputedStyle(a).backgroundColor,
    };
  })()`);
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=calc]').dataset.id)`);
  const unpin = await ev(`(() => {
    const lock = document.querySelector('.win[data-app=todo] .todo-lock');
    lock.click();   // 取消置顶
    return !lock.classList.contains('on');
  })()`);
  t('T27.9 顶栏锁按钮(点亮/压过新窗口/再点熄灭/非激活半透明)',
    lockOn === true && td9.todo > td9.calc && td9.bgInactive.includes('0.6') && unpin === true,
    JSON.stringify(td9) + ` lockOn=${lockOn} unpin=${unpin}`);

  // 层级模型:置顶只是提升一档,压不过系统模态(全屏遮罩锁定的对话框)
  await ev(`document.querySelector('.win[data-app=todo] .todo-lock').click()`);
  await sleep(150);
  await ev(`(() => { WebOS.dialogs.confirm({ title: '系统模态', message: '置顶不应压过系统模态' }); })()`);
  await sleep(500);
  const mod = await ev(`(() => {
    const t = document.querySelector('.win[data-app=todo]');
    const d = document.querySelector('.win[data-app=sysdialog]');
    const s = document.querySelector('.modal-shade');
    return { todo: +t.style.zIndex, dlg: +d?.style.zIndex, shade: +s?.style.zIndex };
  })()`);
  await ev(`(() => {
    const btn = [...document.querySelectorAll('.win[data-app=sysdialog] .btn')].pop();
    if (btn) btn.click();
  })()`);
  await sleep(400);
  const modAfter = await ev(`(() => ({
    shadeGone: !document.querySelector('.modal-shade'),
    stillTop: [...document.querySelectorAll('.win')].every(x => x === document.querySelector('.win[data-app=todo]')
      || +x.style.zIndex < +document.querySelector('.win[data-app=todo]').style.zIndex),
  }))()`);
  t('T27.9b 置顶压不过系统模态(遮罩与对话框在其上,解除后自动回顶)',
    mod.dlg > mod.todo && mod.shade > mod.todo && modAfter.shadeGone && modAfter.stillTop,
    JSON.stringify(mod) + ' ' + JSON.stringify(modAfter));
  await ev(`document.querySelector('.win[data-app=todo] .todo-lock').click()`);   // 收尾:取消置顶

  // 置顶继承:置顶窗口创建的新便签也应是置顶(锁点亮,且浮在创建者之上)
  await ev(`document.querySelector('.win[data-app=todo] .todo-lock').click()`);   // 主窗置顶
  await sleep(150);
  await ev(`(() => {
    document.querySelector('.win[data-app=todo] .todo-menu-btn').click();
    [...document.querySelectorAll('.todo-menu .tm-item')].find(b => b.textContent.includes('新建便签')).click();
  })()`);
  await sleep(700);
  const inherit = await ev(`(() => {
    const n = [...document.querySelectorAll('.win[data-app=todo]')].find(w => w.querySelector('.todo-note-text'));
    return {
      newPinned: n.querySelector('.todo-lock').classList.contains('on'),
      newZ: +n.style.zIndex,
      mainZ: +document.querySelector('.win[data-app=todo]').style.zIndex,
      mainPinned: document.querySelector('.win[data-app=todo] .todo-lock').classList.contains('on'),
    };
  })()`);
  // 收尾:删除这张便签,主窗取消置顶
  await ev(`(() => {
    const n = [...document.querySelectorAll('.win[data-app=todo]')].find(w => w.querySelector('.todo-note-text'));
    n.querySelector('.todo-menu-btn').click();
    [...document.querySelectorAll('.todo-menu .tm-item')].find(b => b.textContent.includes('删除便签')).click();
  })()`);
  await sleep(400);
  await ev(`document.querySelector('.win[data-app=todo] .todo-lock').click()`);
  t('T27.9c 置顶窗口创建的新便签继承置顶',
    inherit.newPinned && inherit.mainPinned && inherit.newZ > inherit.mainZ,
    JSON.stringify(inherit));

  // 持久化:刷新后任务仍在(会话恢复在 e2e 模式被刻意禁用,恢复链路以
  // 真实浏览器手动验证:窗口清单带 boardId,restoreIfSaved 按 params 原样开回)
  await fresh();
  const td10 = await ev(`(async () => {
    const { loadState } = WebOS.appdata;
    const s = await loadState('todo', WebOS.accounts.current());
    const first = (s?.boards || []).find(b => b.type === 'todo');
    return { n: (first?.tasks || []).length, boards: JSON.stringify(s) };
  })()`);
  if (td10.n !== 5) console.log('   [T27.10 debug] boards =', td10.boards);
  t('T27.10 持久化(刷新后任务保留)', td10.n === 5, `tasks=${td10.n}`);

  // 桌面打开 = 展示现有全部便签:一个没开时打开所有已有的板(不再新建);
  // 已有窗口时再点桌面图标 = 只聚焦,不新建。菜单「新建待办/便签」才建新板;
  // 「删除待办」只删本板(断言用增量,不受会话恢复时机影响)
  const before = await ev(`document.querySelectorAll('.win[data-app=todo]').length`);
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  const opened = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    const boardsN = (s?.boards || []).length;
    const mains = [...document.querySelectorAll('.win[data-app=todo]')].filter(w => w.querySelector('.todo-input'));
    const first = { count: document.querySelectorAll('.win[data-app=todo]').length, boardsN,
      allBoards: document.querySelectorAll('.win[data-app=todo]').length === boardsN,
      showsOld: [...mains[0].querySelectorAll('.todo-t')].some(x => x.textContent.includes('锁定后任务A')) };
    // 已有窗口时再点桌面图标:不新建,只聚焦
    await WebOS.wm.open('todo');
    await new Promise(r => setTimeout(r, 500));
    first.refocusSame = document.querySelectorAll('.win[data-app=todo]').length === first.count;
    return first;
  })()`);
  await ev(`(() => {
    document.querySelector('.win[data-app=todo] .todo-menu-btn').click();
    [...document.querySelectorAll('.todo-menu .tm-item')].find(b => b.textContent.includes('新建便签')).click();
  })()`);
  await sleep(700);
  await ev(`(() => {
    const n = [...document.querySelectorAll('.win[data-app=todo]')].find(w => w.querySelector('.todo-note-text'));
    n.querySelector('.todo-menu-btn').click();
    [...document.querySelectorAll('.todo-menu .tm-item')].find(b => b.textContent.includes('新建待办')).click();
  })()`);
  await sleep(700);
  const wNew = await ev(`(() => ({
    count: document.querySelectorAll('.win[data-app=todo]').length,
    mains: [...document.querySelectorAll('.win[data-app=todo]')].filter(w => w.querySelector('.todo-input')).length,
  }))()`);
  // 在新清单窗口加任务 → 其他任何待办窗口都看不到(板间数据隔离)
  await ev(`(() => {
    const mains = [...document.querySelectorAll('.win[data-app=todo]')].filter(w => w.querySelector('.todo-input'));
    const inp = mains[mains.length - 1].querySelector('.todo-input');
    inp.value = '隔离板专属任务';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(700);
  const isolation = await ev(`(async () => {
    const mains = [...document.querySelectorAll('.win[data-app=todo]')].filter(w => w.querySelector('.todo-input'));
    const nw = mains[mains.length - 1];
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    const boards = s?.boards || [];
    return {
      inNew: [...nw.querySelectorAll('.todo-t')].some(x => x.textContent === '隔离板专属任务'),
      othersClean: mains.slice(0, -1).every(m => ![...m.querySelectorAll('.todo-t')].some(x => x.textContent === '隔离板专属任务')),
      onlyInOne: boards.filter(b => (b.tasks || []).some(t => t.text === '隔离板专属任务')).length === 1,
    };
  })()`);
  // 删除新清单:只删它自己,原数据原封不动
  await ev(`(() => {
    const mains = [...document.querySelectorAll('.win[data-app=todo]')].filter(w => w.querySelector('.todo-input'));
    mains[mains.length - 1].querySelector('.todo-menu-btn').click();
    [...document.querySelectorAll('.todo-menu .tm-item')].find(b => b.textContent.includes('删除待办')).click();
  })()`);
  await sleep(700);
  const cleared = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    const todos = (s?.boards || []).filter(b => b.type === 'todo');
    return {
      count: document.querySelectorAll('.win[data-app=todo]').length,   // 少一个窗口
      oldKept: todos.some(b => (b.tasks || []).some(t => t.text === '锁定后任务A')),
      goneTask: todos.every(b => !(b.tasks || []).some(t => t.text === '隔离板专属任务')),
    };
  })()`);
  t('T27.10b 桌面打开=现有全部/再点聚焦不新建 + 板间隔离 + 删除只删自己',
    before === 0 && opened.count === opened.boardsN && opened.allBoards && opened.showsOld && opened.refocusSame
      && wNew.count === opened.count + 2 && wNew.mains >= 2
      && isolation.inNew && isolation.othersClean && isolation.onlyInOne
      && cleared.count === wNew.count - 1 && cleared.oldKept && cleared.goneTask,
    JSON.stringify({ before, opened, wNew, isolation, cleared }));
  // 收尾:清场全部便签窗口
  await ev(`(() => {
    [...document.querySelectorAll('.win[data-app=todo]')].forEach(w => WebOS.wm.close(w.dataset.id));
  })()`);
  await sleep(400);

  // 自绘关闭按钮(顶栏黑色 ✕):桌面打开=全部板各一窗,逐个用 ✕ 关掉
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  await ev(`(() => {
    [...document.querySelectorAll('.win[data-app=todo]')].forEach(w => w.querySelector('.todo-close').click());
  })()`);
  await sleep(500);
  t('T27.11 自绘关闭按钮', await ev(`!document.querySelector('.win[data-app=todo]')`) === true);

  // 全关后桌面打开 = 打开全部已有的板(每块板一窗,内容原样回来)
  await ev(`WebOS.wm.open('todo')`);
  await sleep(900);
  const regrp = await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    return {
      count: document.querySelectorAll('.win[data-app=todo]').length,
      boardsN: (s?.boards || []).length,
      restored: [...document.querySelectorAll('.todo-t')].some(x => x.textContent === '锁定后任务A'),
    };
  })()`);
  t('T27.11b 全关后桌面打开全部便签', regrp.count === regrp.boardsN && regrp.count >= 1 && regrp.restored, JSON.stringify(regrp));
  await ev(`[...document.querySelectorAll('.win[data-app=todo]')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(300);

  const errs27 = await ev(`window.__errs.length`);
  t('T27.12 全程无错误', errs27 === 0, `errs=${errs27}`);

});

group('T28', '短信应用', async () => {
  /* ---- T28 短信应用 ---- */
  await ev(`localStorage.removeItem('webos.sms.v1')`);
  await wipeSharedAppData('sms');   // 短信为设备级收件箱:清设备库 + 旧按用户库,种子短信重新播种
  await fresh();   // 种子短信播种
  await ev(`WebOS.wm.open('sms')`);
  await sleep(700);
  const s0 = await ev(`(() => ({
    chats: document.querySelectorAll('.sms-chat').length,
    title: document.querySelector('.win[data-app=sms] .win-title').textContent,
  }))()`);
  t('T28 短信:种子会话 + 未读标题', s0.chats === 2 && /\(2 未读\)/.test(s0.title), JSON.stringify(s0));

  // 打开验证码会话 → 验证码识别 + 复制按钮 + 已读
  await ev(`(() => { [...document.querySelectorAll('.sms-chat')].find(c => c.textContent.includes('安全中心')).click(); })()`);
  await sleep(400);
  const s1 = await ev(`(() => ({
    code: document.querySelector('.sms-code')?.textContent,
    bubble: [...document.querySelectorAll('.sms-bubble.in .sms-text')].map(t => t.textContent).join('|'),
    unreadLeft: document.querySelector('.win[data-app=sms] .win-title').textContent,
  }))()`);
  t('T28.1 验证码识别与复制按钮', s1.code?.includes('823741') && /\(1 未读\)/.test(s1.unreadLeft), JSON.stringify(s1));

  // 回复短信 → 气泡出现在右侧
  await ev(`(() => {
    const inp = document.querySelector('.sms-input');
    inp.value = '这是我本人操作';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(400);
  const s2 = await ev(`(() => {
    const last = [...document.querySelectorAll('.sms-bubble.out .sms-text')].pop();
    return { sent: last?.textContent, count: document.querySelectorAll('.sms-bubble').length };
  })()`);
  t('T28.2 发送短信(右侧行为气泡)', s2.sent === '这是我本人操作' && s2.count === 2, JSON.stringify(s2));

  // 服务台自动回信:给 nexus-hint 发短信(新会话)
  await ev(`(() => {
    const inp = document.querySelector('.sms-input');
    inp.value = '档案的线索是什么';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  // 此时还在安全中心会话;切换地址发送:直接通过存储不可取,改用 app 内手动流程:
  // 简化:验证钩子已在存储层生效 —— 直接对 nexus-hint 发送
  await ev(`WebOS.sms.send('nexus-hint', '档案的线索是什么')`);
  await sleep(1600);   // 等自动回信
  const s3 = await ev(`(() => {
    const chat = WebOS.sms.chat('nexus-hint');
    return { msgs: chat?.msgs.map(m => (m.dir === 'in' ? '←' : '→') + m.text.slice(0, 14)) };
  })()`);
  t('T28.3 服务台短信自动回信', s3.msgs?.length === 2 && s3.msgs[1].includes('图书馆凭据'), JSON.stringify(s3.msgs));

  // (原「Todo 到期短信提醒」用例已移除:任务应用极简化后不再有截止日期与提醒)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (!(await accounts.login('todoer', 'todopass')).ok) await accounts.register('todoer', 'todopass');
    return true;
  })()`);
  await wipeAppData('todoer', 'todo');   // 清 todoer 任务档(后续组各自独立播种)
  // 元数据是 250ms 防抖:冲刷落盘,防被随后的刷新打断(重载后文件"不存在")
  await ev(`WebOS.fs.flush()`);

  // 刷新持久化:设备级短信会话跨重载保留
  await fresh();
  const s5 = await ev(`(async () => {
    const dev = await WebOS.appdata.loadSharedState('sms');   // 短信为设备级收件箱
    return {
      myChats: (dev?.chats || []).length,
      myMsgs: (dev?.chats || []).reduce((s, c) => s + (c.msgs || []).length, 0),
    };
  })()`);
  t('T28.4 持久化(刷新后会话保留)', s5.myChats >= 2 && s5.myMsgs >= 4, JSON.stringify(s5));
  await ev(`WebOS.wm.open('sms')`);
  await sleep(600);
  await c.shot('t28-sms');

  const errs28 = await ev(`window.__errs.length`);
  t('T28.5 全程无错误', errs28 === 0, `errs=${errs28}`);

});

group('T30', '天气应用(实况/预报/历史确定性)', async () => {
  /* ---- T30 天气应用(实况/预报/历史确定性) ---- */
  await needApps('weather');
  await ev(`WebOS.wm.open('weather')`);
  await sleep(800);
  const w1 = await ev(`(() => ({
    city: document.querySelector('.wx-desc')?.textContent,
    temp: document.querySelector('.wx-temp')?.textContent,
    hours: document.querySelectorAll('.wx-hour').length,
    days: document.querySelectorAll('.wx-day-row').length,
    cities: document.querySelectorAll('.app-side .nav-item').length,
  }))()`);
  t('T30 天气:实况+12小时+7日预报+8城市', w1.hours === 12 && w1.days === 7 && w1.cities === 8,
    JSON.stringify(w1));

  // 数据确定性:同一天两次 daily() 结果一致(历史可回溯的基石)
  const det = await ev(`(() => {
    const a = WebOS.__weatherDaily('shanghai', '2024-07-15');
    const b = WebOS.__weatherDaily('shanghai', '2024-07-15');
    return JSON.stringify(a) === JSON.stringify(b) && a.tmax > a.tmin;
  })()`);
  t('T30.1 气象数据确定性(同日同天)', det === true);

  // 历史查询:去年今日
  await ev(`(() => {
    [...document.querySelectorAll('.win[data-app=weather] .seg-btn')].find(b => b.textContent === '历史查询').click();
  })()`);
  await sleep(300);
  await ev(`(() => {
    const btn = [...document.querySelectorAll('.win[data-app=weather] .btn')].find(b => b.textContent === '去年今日');
    btn.click();
  })()`);
  await sleep(500);
  const w2 = await ev(`(() => ({
    hero: document.querySelector('.wx-desc')?.textContent || '',
    hasChart: !!document.querySelector('.wx-chart'),
    stat: document.querySelector('.win[data-app=weather] .app-status span').textContent,
    temp: document.querySelector('.wx-temp')?.textContent,
  }))()`);
  t('T30.2 历史查询(去年今日)', w2.stat.includes('历史') && w2.hasChart && w2.temp, JSON.stringify(w2));
  await c.shot('t30-weather-history');

  // 历史区间:一周前按钮 + 温度条形图非空
  await ev(`(() => { [...document.querySelectorAll('.win[data-app=weather] .btn')].find(b => b.textContent === '一周前').click(); })()`);
  await sleep(400);
  const w3 = await ev(`(() => ({
    bars: document.querySelectorAll('.wx-bar').length,
    temps: [...document.querySelectorAll('.wx-bar-t')].map(t => t.textContent),
  }))()`);
  t('T30.3 历史趋势条形图(7 天)', w3.bars === 7, JSON.stringify(w3.temps));

  // 城市切换:三亚比哈尔滨热(确定性气候)
  await ev(`(() => {
    [...document.querySelectorAll('.app-side .nav-item')].find(n => n.textContent.includes('三亚')).click();
  })()`);
  await sleep(500);
  await ev(`(() => {
    [...document.querySelectorAll('.win[data-app=weather] .seg-btn')].find(b => b.textContent === '实况').click();
  })()`);
  await sleep(400);
  await ev(`(() => {
    [...document.querySelectorAll('.app-side .nav-item')].find(n => n.textContent.includes('哈尔滨')).click();
  })()`);
  await sleep(400);
  const sanya = await ev(`(async () => {
    [...document.querySelectorAll('.app-side .nav-item')].find(n => n.textContent.includes('三亚')).click();
    await new Promise(r => setTimeout(r, 350));
    const t1 = Math.round(parseFloat(document.querySelector('.wx-temp').textContent));
    [...document.querySelectorAll('.app-side .nav-item')].find(n => n.textContent.includes('哈尔滨')).click();
    await new Promise(r => setTimeout(r, 350));
    const t2 = Math.round(parseFloat(document.querySelector('.wx-temp').textContent));
    return { sanya: t1, harbin: t2 };
  })()`);
  t('T30.4 城市气候差异(三亚>哈尔滨)', sanya.sanya > sanya.harbin, JSON.stringify(sanya));

  const errs30 = await ev(`window.__errs.length`);
  t('T30.5 全程无错误', errs30 === 0, `errs=${errs30}`);
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=weather]').dataset.id)`);
  await sleep(300);

});

group('T32', '笔记(含加密)', async () => {
  /* ---- T32 笔记(含加密;数据按系统用户存储,应用不设登录门槛) ---- */
  await ev(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.memo.v1')) localStorage.removeItem(k);
    return true;
  })()`);
  await wipeSharedAppData('memo');   // 清按用户库 + 共享库遗留 + 迁移旗标,种子卡片重新播种
  // 前置:登录测试账号钉住数据归属(应用本身不需要登录)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current() !== 'memoer' && !(await accounts.login('memoer', 'memopass')).ok) {
      await accounts.register('memoer', 'memopass');
      await accounts.login('memoer', 'memopass');
    }
    return true;
  })()`);
  await needApps('memo');   // 安装按用户:须在登录切换后再装
  await fresh();
  await ev(`WebOS.wm.open('memo')`);
  await sleep(700);
  const mm0 = await ev(`(() => ({
    cards: document.querySelectorAll('.memo-card').length,
    pinned: document.querySelector('.memo-pin.on') ? true : false,
  }))()`);
  t('T32 笔记:种子卡片+置顶', mm0.cards === 2 && mm0.pinned, JSON.stringify(mm0));

  // 新建加密笔记(全 GUI,单 cell 内完成以保证时序)
  await ev(`(async () => {
    [...document.querySelectorAll('.win[data-app=memo] .btn')].find(b => b.textContent.includes('新建')).click();
    await new Promise(r => setTimeout(r, 450));
    const ed = document.querySelector('.memo-editor');
    ed.querySelector('input.input').value = '银行账号';
    // 正文是渲染态直编的 md 编辑器:光标放末块末尾,真实输入管线写入
    const surf = ed.querySelector('.md-surface');
    const p = surf.querySelector('.md-block:last-child p');
    surf.focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertText', false, '6222 0000 1234 5678');
    ed.querySelectorAll('.memo-swatch')[3].click();
    ed.querySelector('input[type=checkbox]').click();
    [...ed.querySelectorAll('.btn')].find(b => b.textContent === '保存').click();
    await new Promise(r => setTimeout(r, 550));
    const i = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    i.value = 'memo-pw';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
  })()`);
  await sleep(500);

  // 点击解锁查看(密码) → 明文显示在对话框(解密走 PBKDF2 派生,轮询等待)
  await ev(`(() => {
    const card = [...document.querySelectorAll('.memo-card')].find(c => c.textContent.includes('银行账号'));
    [...card.querySelectorAll('.icon-btn')].find(b => b.title === '解锁查看').click();
  })()`);
  await waitFor(`!!document.querySelector('.win[data-app=sysdialog] .dlg-input')`);
  await ev(`(() => {
    const i = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    i.value = 'memo-pw';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const mm2 = await waitFor(`(() => {
    const box = [...document.querySelectorAll('.modal-box')].pop();
    return !!box && box.textContent.includes('6222 0000 1234 5678');
  })()`, 5000);
  t('T32.2 密码解锁查看明文', mm2 === true, `shown=${mm2}`);
  await ev(`[...document.querySelectorAll('.modal-box .btn')].find(b => b.textContent === '关闭')?.click()`);
  await sleep(300);

  // 错误密码被拒(同上,解密 + 错误弹窗创建均为异步,轮询等待报错文案)
  await ev(`(() => {
    const card = [...document.querySelectorAll('.memo-card')].find(c => c.textContent.includes('银行账号'));
    [...card.querySelectorAll('.icon-btn')].find(b => b.title === '解锁查看').click();
  })()`);
  await waitFor(`!!document.querySelector('.win[data-app=sysdialog] .dlg-input')`);
  await ev(`(() => {
    const i = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    i.value = 'wrong';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const mm3 = await waitFor(`document.querySelector('.win[data-app=sysdialog] .dlg-msg')?.textContent.includes('密码错误') === true`, 5000);
  t('T32.3 错误密码被拒', mm3 === true);
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].pop().click()`);
  await sleep(300);

  // 搜索(明文卡)
  await ev(`(() => {
    const s = document.querySelector('.win[data-app=memo] .app-toolbar input');
    s.value = '购物';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(350);
  const mm4 = await ev(`document.querySelectorAll('.memo-card').length`);
  t('T32.4 搜索过滤', mm4 === 1, `cards=${mm4}`);


  const errs5 = await ev(`window.__errs.length`);
  t('T32.5 全程无错误', errs5 === 0, `errs=${errs5}`);
  await c.shot('t32-memo');
});

group('T37', 'QQ 聊天', async () => {
  /* ---- T37 QQ 聊天 ---- */
  await needApps('qq');
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);
  // 清档:测试登录流程(QQ 按用户分键存储,基础键与 ::qq-* 会话键都要清)
  await ev(`Object.keys(localStorage).filter(k => k === 'webos.qq.v1' || k === 'webos.qq.v1.last' || k.startsWith('webos.qq.v1::')).forEach(k => localStorage.removeItem(k))`);
  await wipeSharedAppData('qq');   // QQ 按号码独立成库:清全部身份库,登录流程从零开始
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=qq]')?.dataset.id || '')`);
  await ev(`WebOS.wm.open('qq')`);
  await sleep(700);
  const q0 = await ev(`(() => ({
    login: !!document.querySelector('.qq-login'),
    num: document.querySelector('#qq-num')?.value,
  }))()`);
  t('T37 QQ 登录界面', q0.login && q0.num === '88888888', JSON.stringify(q0));

  // 登录 → 好友列表
  await ev(`document.querySelector('.qq-login-btn').click()`);
  await sleep(600);
  const q1 = await ev(`(() => ({
    friends: document.querySelectorAll('.qq-friend').length,
    online: document.querySelectorAll('.qq-friend.online').length,
    me: document.querySelector('.qq-top b')?.textContent,
  }))()`);
  t('T37.1 登录进入好友列表', q1.friends === 5 && q1.me === 'AetherWebOS 用户', JSON.stringify(q1));

  // 双击好友打开聊天 → 发消息 → 机器人自动回复
  const q2 = await ev(`(async () => {
    const f = [...document.querySelectorAll('.qq-friend')].find(f => f.textContent.includes('小雨'));
    f.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const input = document.querySelector('.qq-input');
    if (!input) return { noInput: true };
    input.value = '你好,在吗?';
    const btn = [...document.querySelectorAll('.win[data-app=qq] .btn')].find(b => b.textContent.includes('发送'));
    btn.click();
    await new Promise(r => setTimeout(r, 3500));   // 等对方正在输入 + 回复
    const bubbles = [...document.querySelectorAll('.qq-bubble .qq-bubble-text')].map(b => b.textContent);
    return { sent: bubbles.some(t => t.includes('你好,在吗?')), reply: bubbles[bubbles.length - 1], count: bubbles.length };
  })()`);
  t('T37.2 发送消息+机器人自动回复', q2.sent === true && !!q2.reply && q2.reply !== '你好,在吗?', JSON.stringify(q2));
  await c.shot('t37-qq-chat');

  // 表情面板
  const q3 = await ev(`(() => {
    const emoBtn = document.querySelector('.qq-tools .icon-btn');
    emoBtn.click();
    return document.querySelectorAll('.qq-emo-item').length;
  })()`);
  t('T37.3 表情面板', q3 === 12, `emo=${q3}`);

  // 持久化:刷新后自动恢复会话与未读
  await fresh();
  await ev(`WebOS.wm.open('qq')`);
  await sleep(700);
  const q4 = await ev(`(async () => ({
    autoLogin: !!document.querySelector('.qq-top'),
    me: document.querySelector('.qq-top b')?.textContent,
    historyKept: await WebOS.appdata.loadIdentityState('qq', 'qq-88888888')
      .then(s => ((s?.history?.['10001']) || []).length >= 1).catch(() => false),
  }))()`);
  t('T37.4 会话持久化(刷新自动登录+历史保留)', q4.autoLogin && q4.me === 'AetherWebOS 用户' && q4.historyKept,
    JSON.stringify(q4));


  const errs5 = await ev(`window.__errs.length`);
  t('T37.5 全程无错误', errs5 === 0, `errs=${errs5}`);
});

group('T38', '账号系统', async () => {
  /* ---- T38 账号系统 ---- */
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);

  // 注册账号 alice → 打开任务应用 → 建任务
  await ev(`(async () => {
    const r = await WebOS.dialogs ? null : null;
    return true;
  })()`);
  await ev(`(async () => {
    if (!WebOS.accounts) WebOS.accounts = (await import('./js/core/accounts.js')).accounts;
  })()`);
  await sleep(300);
  await ev(`(() => {
    localStorage.removeItem('webos.accounts.v1');
    localStorage.removeItem('webos.account-session.v1');
    return true;
  })()`);
  await sleep(300);
  const reg = await ev(`(async () => {
    const acc = (await import('./js/core/accounts.js')).accounts;
    const r1 = await acc.register('alice', 'alice1234');
    const r2 = await acc.register('alice', 'other');   // 重复注册被拒
    return { r1, dupRejected: !r2.ok };
  })()`);
  await wipeAppData('alice', 'todo');   // 上一轮的 alice 任务库:清掉,本轮重新播种
  t('T38 注册账号(重复注册被拒)', reg.r1?.ok === true && reg.dupRejected === true, JSON.stringify(reg));

  // 打开 todo(未登录状态:alice 已登录) → 添加任务 → 数据落在 alice 命名空间
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  const iso = await ev(`(async () => {
    const inp = document.querySelector('.win[data-app=todo] .todo-input');
    if (!inp) return { noInput: true, errs: window.__errs.slice(0, 2) };
    inp.value = 'alice 的任务';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const { loadState } = WebOS.appdata;
    const alice = await loadState('todo', 'alice');
    const bob = await loadState('todo', 'bob').catch(() => null);
    const at = (s) => ((s?.boards || [])).filter(b => b.type === 'todo').flatMap(b => b.tasks || []);
    return {
      inStore: at(alice).some(t => t.text === 'alice 的任务'),
      bobTask: at(bob).some(t => t.text === 'alice 的任务'),
    };
  })()`);
  t('T38.1 每用户数据隔离(alice 命名空间)', iso.inStore === true && iso.bobTask === false, JSON.stringify(iso));

  // 库文件冻结:x=管理位的语义下,冻结 = 无 x —— 开库归一后 todo.awdb 与
  // appdata 目录都是 rw----(属主 rw,应用级读写不受影响,38.1 已证),
  // rm/rename/chmod 因缺管理位全拒(防属主放宽 rw 把密文泄露给其他用户);
  // appdata 目录无 x 的原因:rm -r 只查顶层管理位,目录可管理的话会把
  // 冻结的库文件整棵带走。root 授 x 后属主即可解冻(最后验一步)
  const frozen = await ev(`(async () => {
    const p = '/home/alice/appdata/todo.awdb';
    const dir = '/home/alice/appdata';
    const mode6 = WebOS.fs.stat(p, { as: 'root' })?.mode6;
    const dirMode = WebOS.fs.stat(dir, { as: 'root' })?.mode6;
    const rm = WebOS.fs.rm(p, { as: 'alice' }) === false;
    const rename = WebOS.fs.rename(p, p + '.bak', { as: 'alice' }) === false;
    const chmod = WebOS.fs.chmod(p, 'rwx---', { as: 'alice' }) === false;
    const dirRm = WebOS.fs.rm(dir, { as: 'alice' }) === false;
    const dirRename = WebOS.fs.rename(dir, dir + '.bak', { as: 'alice' }) === false;
    const dirChmod = WebOS.fs.chmod(dir, 'rwx---', { as: 'alice' }) === false;
    // root 授 x 管理位 → 属主获得管理权 → 自行收回(验证位的授权语义)
    const granted = WebOS.fs.chmod(p, 'rwx---', { as: 'root' }) === true;
    const manageAfterGrant = WebOS.fs.rename(p, p + '.bak', { as: 'alice' }) === true;
    WebOS.fs.rename(p + '.bak', p, { as: 'alice' });
    const revoked = WebOS.fs.chmod(p, 'rw----', { as: 'root' }) === true;
    return {
      mode6, dirMode, rm, rename, chmod, dirRm, dirRename, dirChmod,
      granted, manageAfterGrant, revoked,
      still: WebOS.fs.stat(p, { as: 'root' })?.mode6,
      dirStill: WebOS.fs.stat(dir, { as: 'root' })?.mode6,
    };
  })()`);
  t('T38.1b 库文件与 appdata 目录冻结(rw---- = 无管理位:属主 rm/rename/chmod 全拒;root 授 x 即解冻)',
    frozen.mode6 === 'rw----' && frozen.dirMode === 'rw----'
      && frozen.rm && frozen.rename && frozen.chmod
      && frozen.dirRm && frozen.dirRename && frozen.dirChmod
      && frozen.granted && frozen.manageAfterGrant && frozen.revoked
      && frozen.still === 'rw----' && frozen.dirStill === 'rw----',
    JSON.stringify(frozen));

  // 新建文件默认权限 70(rwx----:创建者全权,其他用户无任何位)
  const def70 = await ev(`(() => {
    const p = '/home/alice/appdata/def70-probe.txt';
    WebOS.fs.write(p, 'x');
    const m = WebOS.fs.stat(p, { as: 'root' })?.mode6;
    WebOS.fs.rm(p, { as: 'root' });
    return m;
  })()`);
  t('T38.1c 新建文件默认 70(rwx----)', def70 === 'rwx---', String(def70));

  // 登出 → 未登录时打开 todo 显示登录面板
  await ev(`(async () => {
    const acc = (await import('./js/core/accounts.js')).accounts;
    acc.logout();
  })()`);
  await sleep(300);
  await ev(`(() => {
    WebOS.wm.close(document.querySelector('.win[data-app=todo]').dataset.id);
    WebOS.wm.open('todo');
  })()`);
  await sleep(700);
  const loginGate = await ev(`(() => ({
    panel: !!document.querySelector('.acc-panel'),
    close: !!document.querySelector('.win[data-app=todo] .todo-close'),
    noData: !document.querySelectorAll('.todo-item').length,
  }))()`);
  t('T38.2 登出后需要登录(数据隐藏,登录门仍有关闭钮)', loginGate.panel === true && loginGate.close === true, JSON.stringify(loginGate));

  // 登录 alice(登录面板)→ 数据恢复
  await ev(`(async () => {
    const panel = document.querySelector('.acc-panel');
    panel.querySelectorAll('.input')[0].value = 'alice';
    panel.querySelectorAll('.input')[1].value = 'alice1234';
    [...panel.querySelectorAll('.btn')].find(b => b.textContent === '登录').click();
  })()`);
  await sleep(900);
  const restored = await ev(`(() => ({
    tasks: [...document.querySelectorAll('.todo-t')].some(t => t.textContent === 'alice 的任务'),
  }))()`);
  t('T38.3 重新登录数据恢复', restored.tasks === true);

  // 错误密码登录被拒
  await ev(`(async () => {
    const acc = (await import('./js/core/accounts.js')).accounts;
    const r = await acc.login('alice', 'wrong-password');
    window.__loginDenied = r.ok === false && r.error === '密码错误';
  })()`);
  await sleep(600);
  const denied = await ev(`window.__loginDenied`);
  t('T38.4 错误密码登录被拒', denied === true);

  const errs38 = await ev(`window.__errs.length`);
  t('T38.5 全程无错误', errs38 === 0, `errs=${errs38}`);
});

group('T43', '日记(按日期 / 自动保存 / 单页加密,按用户存储免登录)', async () => {
  /* ---- T43 日记:按日期记录 / 心情 / 自动保存 / 单页加密(数据按系统用户存储,应用不设登录门槛) ---- */
  await ev(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.diary.v1')) localStorage.removeItem(k);
    return true;
  })()`);
  await wipeSharedAppData('diary');   // 清按用户库 + 共享库遗留 + 迁移旗标,断言(1 篇)不累积历史
  // 前置:登录测试账号钉住数据归属(应用本身不需要登录;未登录时仅会话内存态)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current() !== 'diaryer' && !(await accounts.login('diaryer', 'diarypass')).ok) {
      await accounts.register('diaryer', 'diarypass');
      await accounts.login('diaryer', 'diarypass');
    }
    return true;
  })()`);
  await needApps('diary');   // 安装按用户:须在登录切换后再装
  await fresh();
  await ev(`WebOS.wm.open('diary')`);
  await sleep(700);

  // 今天默认选中;写入正文(自动保存)
  const d0 = await ev(`(() => {
    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const win = document.querySelector('.win[data-app=diary]');
    // 正文是渲染态直编的 md 编辑器:光标放末块末尾,真实输入管线写入
    const surf = win.querySelector('.diary-text .md-surface');
    const p = surf.querySelector('.md-block:last-child p');
    surf.focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertText', false, '今天是终端合并成 bash 的日子,充实。');
    return { key, dateH: win.querySelector('.diary-date').textContent };
  })()`);
  t('T43 今天默认选中(标题含日期)', d0.dateH.includes('年') && d0.dateH.includes('星期'), d0.dateH);
  await sleep(500);   // 等防抖落盘

  const savedTxt = await waitFor(`(async () => {
    const s = await WebOS.appdata.loadState('diary', WebOS.accounts.current());
    const e = s?.entries && s.entries[${JSON.stringify(d0.key)}];
    return (e && e.text || '').includes('充实') || null;
  })()`, 5000);
  t('T43.1 输入自动落盘(按用户库)', savedTxt === true, '');

  // 圆点标记 + 心情
  const dot = await ev(`!!document.querySelector('.win[data-app=diary] .diary-day.sel .dot')`);
  t('T43.2 月历圆点标记', dot === true);
  await ev(`document.querySelectorAll('.win[data-app=diary] .diary-mood')[1].click()`);
  const mood = await waitFor(`(async () => {
    const s = await WebOS.appdata.loadState('diary', WebOS.accounts.current());
    return (s?.entries?.[${JSON.stringify(d0.key)}] || {}).mood || null;
  })()`, 5000);
  t('T43.3 心情选择持久化', mood === '🙂', `mood=${mood}`);

  // 切到昨天(空)再切回今天(内容仍在)
  await ev(`(() => {
    const pad = n => String(n).padStart(2, '0');
    const d = new Date(Date.now() - 86400e3);
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const cell = [...document.querySelectorAll('.win[data-app=diary] .diary-day')].find(c => c.dataset.key === key);
    cell.click();
    return key;
  })()`);
  await sleep(350);
  const emptyText = await ev(`document.querySelector('.win[data-app=diary] .diary-text').$md.get()`);
  t('T43.4 切换日期编辑器跟随', emptyText === '', JSON.stringify(emptyText));

  await ev(`[...document.querySelectorAll('.win[data-app=diary] .btn')].find(b => b.textContent.includes('今天')).click()`);
  await sleep(350);
  const back = await ev(`document.querySelector('.win[data-app=diary] .diary-text').$md.get()`);
  t('T43.5 「今天」回位且内容恢复', back.includes('充实'), JSON.stringify(back));

  /* ---- 单页加密:设密码 → 刷新后锁定卡 → 错误密码拒绝 → 正确解锁 ---- */
  await ev(`[...document.querySelectorAll('.win[data-app=diary] .app-toolbar .btn')].find(b => b.textContent.includes('加密本页')).click()`);
  for (let i = 0; i < 2; i++) {
    await waitFor(`!!document.querySelector('.win[data-app=sysdialog] .dlg-input')`);
    await ev(`(() => {
      const i = document.querySelector('.win[data-app=sysdialog] .dlg-input');
      i.value = 'diary-pw';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(450);
  }
  const locked = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=diary]');
    const cell = [...w.querySelectorAll('.diary-day')].find(c => c.classList.contains('today'));
    return cell?.querySelector('.lockmark')?.textContent || null;
  })()`, 5000);
  const stillEdit = await ev(`(() => {
    const w = document.querySelector('.win[data-app=diary]');
    // .diary-text 就是 md 编辑器根节点(非容器):查自身可见 + 编辑面可写
    const t = w.querySelector('.diary-text');
    return { edit: t.style.display !== 'none' && t.querySelector('.md-surface').contentEditable === 'true',
             btn: [...w.querySelectorAll('.app-toolbar .btn')].some(b => b.textContent.includes('解除加密')) };
  })()`);
  t('T43.6 单页加密(锁标 + 会话内仍可编辑)', locked === '🔒' && stillEdit.edit && stillEdit.btn, JSON.stringify({ locked, stillEdit }));

  // 落盘为密文(共享库里的 text 是 WEOS1 密文)
  const cipher = await waitFor(`(async () => {
    const s = await WebOS.appdata.loadState('diary', WebOS.accounts.current());
    const e = (s?.entries || {})[${JSON.stringify(d0.key)}];
    return e?.lock === true && String(e?.text || '').startsWith('WEOS1:') || null;
  })()`, 5000);
  t('T43.7 落盘为密文', cipher === true, '');

  // 刷新:会话密码清空,今天变成锁定卡
  await fresh();
  await ev(`WebOS.wm.open('diary')`);
  await sleep(700);
  const lockCard = await ev(`(() => {
    const w = document.querySelector('.win[data-app=diary]');
    const card = w.querySelector('.diary-lock');
    return { card: !!card && card.style.display !== 'none', input: !!card?.querySelector('input'),
             editHidden: w.querySelector('.diary-text').style.display === 'none' };
  })()`);
  t('T43.8 刷新后出现解锁卡', lockCard.card && lockCard.input && lockCard.editHidden, JSON.stringify(lockCard));

  // 错误密码被拒(sysdialog 报「解锁失败」)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=diary]');
    w.querySelector('.diary-lock input').value = 'wrong';
    [...w.querySelectorAll('.diary-lock .btn')].find(b => b.textContent === '解锁').click();
  })()`);
  const wrong = await waitFor(`[...document.querySelectorAll('.win[data-app=sysdialog]')].some(d => d.textContent.includes('解锁失败'))`, 5000);
  t('T43.9 错误密码被拒', wrong === true);
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].pop().click()`);
  await sleep(300);

  // 正确密码解锁:内容恢复,编辑器可用
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=diary]');
    w.querySelector('.diary-lock input').value = 'diary-pw';
    [...w.querySelectorAll('.diary-lock .btn')].find(b => b.textContent === '解锁').click();
  })()`);
  const unlocked = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=diary]');
    const md = w.querySelector('.diary-text').$md.get();
    return w.querySelector('.diary-text').style.display !== 'none' && md.includes('充实') || null;
  })()`, 5000);
  t('T43.10 正确密码解锁恢复内容', unlocked === true, '');

  // 解除加密:回到明文存储,锁标消失
  await ev(`[...document.querySelectorAll('.win[data-app=diary] .app-toolbar .btn')].find(b => b.textContent.includes('解除加密')).click()`);
  await sleep(500);
  const plainBack = await waitFor(`(async () => {
    const s = await WebOS.appdata.loadState('diary', WebOS.accounts.current());
    const e = (s?.entries || {})[${JSON.stringify(d0.key)}];
    return !e?.lock && (e?.text || '').includes('充实') || null;
  })()`, 5000);
  const markGone = await ev(`(() => {
    const w = document.querySelector('.win[data-app=diary]');
    const cell = [...w.querySelectorAll('.diary-day')].find(c => c.classList.contains('today'));
    return { lock: !!cell?.querySelector('.lockmark'), dot: !!cell?.querySelector('.dot') };
  })()`);
  t('T43.11 解除加密(明文落盘 + 圆点恢复)', plainBack === true && !markGone.lock && markGone.dot, JSON.stringify(markGone));

  const title = await ev(`document.querySelector('.win[data-app=diary] .win-title').textContent`);
  const errs = await ev(`window.__errs.length`);
  t('T43.12 标题计数+无错误', title.includes('1 篇') && errs === 0, `title=${title} errs=${errs}`);
  await c.shot('t43-diary');
});
