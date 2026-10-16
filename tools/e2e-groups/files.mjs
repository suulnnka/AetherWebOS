/* ============================================================
 * AetherWebOS e2e 用例组 · 文件与存储(T8 T21 T29 T31 T53 T60 T63)
 * 自原 e2e.mjs 单文件按域拆出;公共助手见 tools/e2e-harness.mjs。
 * 本文件只做 group() 注册(被入口 tools/e2e.mjs import),不要直接运行。
 * ============================================================ */
import { group, t, ev, c, fresh, sleep, waitFor, needApps, termType, nav, bashType, bashOut, ctxClick, typeReal, pressEnter, clickReal, wipeAppData, wipeSharedAppData } from '../e2e-harness.mjs';

group('T8', '文件管家 + 记事本(IPC 参数传递)', async () => {
  /* ---- T8 文件管家 + 记事本(IPC 参数传递) ---- */
  await ev(`WebOS.wm.open('files')`);
  await sleep(500);
  const files = await ev(`({
    items: document.querySelectorAll('.fitem').length,
    crumbs: [...document.querySelectorAll('.crumb')].map(c=>c.textContent.trim()).join('>'),
  })`);
  t('T8 文件管家打开', files.items >= 4, `items=${files.items} path=${files.crumbs}`);
  await c.shot('t8-files');

  // 双击进入文件夹后不保持选中态(打开文件同理,走同一 openItem)
  const selAfterNav = await ev(`(async () => {
    const doc = [...document.querySelectorAll('.fitem')].find(f => f.textContent.trim().startsWith('documents'));
    doc.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const wasSel = doc.classList.contains('selected');
    doc.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return { wasSel, selLeft: !!document.querySelector('.fitem.selected'), entered: !doc.isConnected };
  })()`);
  t('T8.0 打开(文件夹/文件)后不保持选中', selAfterNav.wasSel && !selAfterNav.selLeft && selAfterNav.entered,
    JSON.stringify(selAfterNav));

  // 双击 欢迎使用.txt
  await ev(`[...document.querySelectorAll('.fitem')].find(f => f.textContent.includes('欢迎使用')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await sleep(600);
  const notes = await ev(`({
    wins: document.querySelectorAll('.win').length,
    val: [...document.querySelectorAll('.notes-area')].map(a=>a.value.slice(0,12)),
    title: [...document.querySelectorAll('.win-title')].map(t=>t.textContent),
  })`);
  t('T8.1 双击文件→记事本(IPC)', notes.val[0]?.includes('欢迎使用') && notes.title.some(x => x.includes('欢迎使用.txt')), JSON.stringify(notes));
  await c.shot('t8_1-notes-opens');

  // 记事本编辑 + 保存 → 文件管家收到 sys:fs-changed 自动刷新标题
  await ev(`const a=document.querySelector('.notes-area'); a.value += '\\n[E2E 测试行]'; a.dispatchEvent(new Event('input'));
    document.querySelector('.win[data-app=notes] .btn').click()`);
  await sleep(500);
  const saved = await ev(`WebOS.fs.read(WebOS.fs.homePath()+'/documents/欢迎使用.txt').includes('[E2E 测试行]')`);
  t('T8.2 记事本保存到虚拟文件系统', saved === true);
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=notes]').dataset.id)`);
  await sleep(400);

});

group('T21', '本地资源 + 文件预览', async () => {
  /* ---- T21 本地资源 + 文件预览 ---- */
  // 在页面内构造 File + DataTransfer,模拟拖放(无头环境无法弹 OS 对话框)
  await ev(`WebOS.wm.open('localfiles')`);
  await sleep(600);
  await ev(`(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(['本地文件内容 ABC'], 'readme.txt', { type: 'text/plain' }));
    dt.items.add(new File(['{"a":1}'], 'data.json', { type: 'application/json' }));
    const w = document.querySelector('.win[data-app=localfiles]');
    w.querySelector('.app').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  })()`);
  await sleep(500);
  const lf = await ev(`({
    items: document.querySelectorAll('.win[data-app=localfiles] .fitem').length,
    status: document.querySelector('.win[data-app=localfiles] .app-status span').textContent,
  })`);
  t('T21 本地资源:拖入文件列表', lf.items === 2, JSON.stringify(lf));

  // 双击 txt → 预览器打开并显示文本
  await ev(`[...document.querySelectorAll('.win[data-app=localfiles] .fitem')].find(f => f.textContent.includes('readme')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(700);
  const vw1 = await ev(`({
    wins: document.querySelectorAll('.win[data-app=viewer]').length,
    text: document.querySelector('.win[data-app=viewer] .viewer-pre')?.textContent,
    title: document.querySelector('.win[data-app=viewer] .win-title')?.textContent,
  })`);
  t('T21.1 双击→预览器(文本)', vw1.wins === 1 && (vw1.text || '').includes('本地文件内容 ABC'), vw1.title);

  // 直接以 params 打开:图片(canvas 生成)/视频路由/PDF 路由/未知类型
  await ev(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 60; canvas.height = 40;
    canvas.getContext('2d').fillStyle = '#e95420';
    canvas.getContext('2d').fillRect(0, 0, 60, 40);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    WebOS.wm.open('viewer', { params: { file: new File([blob], 'pic.png', { type: 'image/png' }) } });
    await new Promise(r => setTimeout(r, 500));
    WebOS.wm.open('viewer', { params: { file: new File([new Uint8Array(8)], 'clip.mp4', { type: 'video/mp4' }) } });
    await new Promise(r => setTimeout(r, 400));
    WebOS.wm.open('viewer', { params: { file: new File([new Uint8Array(8)], 'doc.pdf', { type: 'application/pdf' }) } });
    await new Promise(r => setTimeout(r, 400));
    WebOS.wm.open('viewer', { params: { file: new File([new Uint8Array(8)], 'x.bin', { type: 'application/octet-stream' }) } });
    await new Promise(r => setTimeout(r, 400));
  })()`);
  const vw = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=viewer]')];
    const byName = (n) => wins.find(w => w.querySelector('.win-title')?.textContent.includes(n));
    return {
      imgLoaded: byName('pic.png')?.querySelector('img')?.naturalWidth,
      videoEl: !!byName('clip.mp4')?.querySelector('video'),
      pdfFrame: !!byName('doc.pdf')?.querySelector('iframe'),
      unknown: byName('x.bin')?.querySelector('.viewer-empty')?.textContent.includes('暂不支持'),
      count: wins.length,
    };
  })()`);
  t('T21.2 图片预览(canvas 位图解码)', vw.imgLoaded === 60, `naturalWidth=${vw.imgLoaded}`);
  t('T21.3 视频/PDF/未知 路由', vw.videoEl && vw.pdfFrame && vw.unknown && vw.count === 5,
    JSON.stringify(vw));   // T21.1 文本窗 + 图片/视频/PDF/未知 4 窗 = 5
  await c.shot('t21-viewer');

  // Markdown 预览:渲染成富文本,编辑入口指向 Markdown 编辑器
  await ev(`WebOS.wm.open('viewer', { params: { file: new File(['# MD 标题\\n\\n**重要** 内容与 \`行内码\`\\n\\n- [x] 任务'], 'note.md', { type: 'text/markdown' }) } })`);
  await sleep(500);
  const mdv = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=viewer]')];
    const w = wins.find(x => x.querySelector('.win-title')?.textContent.includes('note.md'));
    return { h1: w?.querySelector('.viewer-md h1')?.textContent,
             strong: w?.querySelector('.viewer-md strong')?.textContent,
             code: w?.querySelector('.viewer-md p code')?.textContent,
             check: !!w?.querySelector('.viewer-md .md-check.on'),
             editBtn: [...(w?.querySelectorAll('.btn') || [])].some(b => b.textContent.includes('Markdown 编辑器')) };
  })()`);
  t('T21.4 Markdown 渲染预览(本地 File)', mdv.h1 === 'MD 标题' && mdv.strong === '重要' && mdv.code === '行内码' && mdv.check && mdv.editBtn, JSON.stringify(mdv));

  // VFS 来源(params.path):md 与 png 写入虚拟文件系统后预览
  await ev(`(async () => {
    const home = WebOS.fs.homePath();
    WebOS.fs.write(home + '/documents/手册.md', '# 虚拟文件系统里的 MD\\n\\n- [x] 支持任务列表');
    const canvas = document.createElement('canvas');
    canvas.width = 24; canvas.height = 16;
    canvas.getContext('2d').fillStyle = '#22c55e';
    canvas.getContext('2d').fillRect(0, 0, 24, 16);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    WebOS.fs.write(home + '/documents/图标.png', new Uint8Array(await blob.arrayBuffer()));
    await WebOS.fs.flush();
    return true;
  })()`);
  await ev(`WebOS.wm.open('viewer', { params: { path: WebOS.fs.homePath() + '/documents/手册.md' } })`);
  await sleep(600);
  const vmd = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=viewer]')];
    const w = wins.find(x => x.querySelector('.win-title')?.textContent.includes('手册.md'));
    return { h1: w?.querySelector('.viewer-md h1')?.textContent, check: !!w?.querySelector('.viewer-md .md-check.on') };
  })()`);
  t('T21.5 VFS Markdown 预览(params.path)', vmd.h1 === '虚拟文件系统里的 MD' && vmd.check, JSON.stringify(vmd));

  // 文件管家双击 png → 文件预览(位图解码)
  await ev(`WebOS.wm.open('files')`);
  await sleep(500);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    [...w.querySelectorAll('.fitem')].find(f => f.textContent.trim().startsWith('documents')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(400);
  await ev(`(() => {
    [...document.querySelectorAll('.win[data-app=files] .fitem')].find(f => f.textContent.includes('图标.png')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(700);
  const vpic = await ev(`(() => {
    const wins = [...document.querySelectorAll('.win[data-app=viewer]')];
    const w = wins.find(x => x.querySelector('.win-title')?.textContent.includes('图标.png'));
    return { img: w?.querySelector('img')?.naturalWidth ?? null };
  })()`);
  t('T21.6 文件管家图片双击 → 预览', vpic.img === 24, JSON.stringify(vpic));

  // 文本「在记事本中编辑」:落到虚拟文件系统并调起记事本
  await ev(`[...document.querySelectorAll('.win[data-app=viewer] .btn')].find(b => b.textContent.includes('在记事本中编辑')).click()`);
  await sleep(600);
  const toNotes = await ev(`({
    notesWin: !!document.querySelector('.win[data-app=notes]'),
    saved: WebOS.fs.read(WebOS.fs.homePath()+'/downloads/readme.txt'),
  })`);
  t('T21.7 文本转入记事本(IPC 联动)', toNotes.notesWin && toNotes.saved === '本地文件内容 ABC', JSON.stringify(toNotes.saved));

  // 关闭全部预览器(对象 URL 生命周期由 onClose 回收)
  await ev(`[...document.querySelectorAll('.win[data-app=viewer]')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  const errs21 = await ev(`window.__errs.length`);
  t('T21.8 关闭回收无错误', errs21 === 0, `errs=${errs21}`);

});

group('T29', '文件加密(AES-GCM)', async () => {
  /* ---- T29 文件加密(AES-GCM) ---- */
  await ev(`WebOS.fs.write(WebOS.fs.homePath()+'/documents/机密.txt', '绝密内容 top-secret')`);
  await ev(`WebOS.wm.open('files')`);
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(700);

  // 终端加密
  await termType('crypt encrypt ~/documents/机密.txt s3cret');
  await sleep(700);
  const c1 = await ev(`(() => ({
    locked: WebOS.fs.read(WebOS.fs.homePath()+'/documents/机密.txt').startsWith('WEOS1:'),
    plainLeak: WebOS.fs.read(WebOS.fs.homePath()+'/documents/机密.txt').includes('top-secret'),
  }))()`);
  t('T29 终端加密(密文落地,明文不可见)', c1.locked && !c1.plainLeak, JSON.stringify(c1));
  await termType('crypt islocked ~/documents/机密.txt');
  const c2 = await ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent.includes('已加密')`);
  t('T29.1 islocked 查询', c2 === true);

  // 错误密码解密被拒
  await termType('crypt decrypt ~/documents/机密.txt wrongpw');
  await sleep(600);
  const c3 = await ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent.includes('密码错误')`);
  t('T29.2 错误密码被拒', c3 === true);

  // 正确密码解密 → 原文还原
  await termType('crypt decrypt ~/documents/机密.txt s3cret');
  await sleep(600);
  const c4 = await ev(`WebOS.fs.read(WebOS.fs.homePath()+'/documents/机密.txt')`);
  t('T29.3 正确密码解密还原', c4 === '绝密内容 top-secret', JSON.stringify(c4));

  // 文件管家 GUI:重新加密(对话框双密码)→ 锁图标 → 双击解锁预览
  await sleep(500);   // 等待 fs-changed 刷新文件列表
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    const item = [...w.querySelectorAll('.fitem')].find(f => f.textContent.includes('机密.txt'));
    if (item) return;   // 已在 documents 视图
    // 否则进入 documents 目录
    const doc = [...w.querySelectorAll('.fitem')].find(f => f.textContent.includes('documents'));
    doc.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(600);   // 等目录渲染
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    const item = [...w.querySelectorAll('.fitem')].find(f => f.textContent.includes('机密.txt'));
    if (!item) throw new Error('列表中无 机密.txt: ' + [...w.querySelectorAll('.fitem')].map(f => f.textContent).join(','));
  })()`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    const item = [...w.querySelectorAll('.fitem')].find(f => f.textContent.includes('机密.txt'));
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
  })()`);
  await sleep(300);
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(i => i.textContent.includes('加密…')).click()`);
  await sleep(500);
  await ev(`(() => { document.querySelector('.win[data-app=sysdialog] .dlg-input').value = 'pw123'; document.querySelector('.win[data-app=sysdialog] .dlg-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(500);
  await ev(`(() => { const i = document.querySelector('.win[data-app=sysdialog] .dlg-input'); i.value = 'pw123'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(700);
  const c5 = await ev(`(() => ({
    lockedInStore: WebOS.fs.read(WebOS.fs.homePath()+'/documents/机密.txt').startsWith('WEOS1:'),
    lockIcon: [...document.querySelectorAll('.win[data-app=files] .fitem')].find(f => f.textContent.includes('🔒')) !== undefined,
  }))()`);
  t('T29.4 GUI 加密(双密码对话框+锁图标)', c5.lockedInStore && c5.lockIcon, JSON.stringify(c5));
  await c.shot('t29-encrypt');

  // 双击加密文件 → 密码解锁 → 预览器显示明文
  await ev(`(() => {
    const item = [...document.querySelectorAll('.win[data-app=files] .fitem')].find(f => f.textContent.includes('机密.txt'));
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(500);
  await ev(`(() => { const i = document.querySelector('.win[data-app=sysdialog] .dlg-input'); i.value = 'pw123'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(700);
  const c6 = await ev(`(() => ({
    preview: [...document.querySelectorAll('.win[data-app=viewer] .viewer-pre')].pop()?.textContent,
    notPersisted: !WebOS.fs.read(WebOS.fs.homePath()+'/documents/机密.txt').includes('top-secret'),
  }))()`);
  t('T29.5 双击解锁只读预览(明文不落盘)', c6.preview === '绝密内容 top-secret' && c6.notPersisted, JSON.stringify(c6));
  await c.shot('t29-unlock-preview');

  // Bash 终端 cat 加密文件被拒(终端本身就是 bash,直接输入)
  await bashType('cat ~/documents/机密.txt');
  const c7 = await ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent.includes('是加密文件')`);
  t('T29.6 Bash cat 拒绝加密文件', c7 === true);

  // 解密还原(终端)并清理
  await termType('crypt decrypt ~/documents/机密.txt pw123');
  await sleep(600);
  const c8 = await ev(`({ restored: WebOS.fs.read(WebOS.fs.homePath()+'/documents/机密.txt') === '绝密内容 top-secret', errs: window.__errs.length })`);
  t('T29.7 解密还原+无错误', c8.restored && c8.errs === 0, JSON.stringify(c8));

});

group('T31', '压缩包支持', async () => {
  /* ---- T31 压缩包支持 ---- */
  await fresh();
  await ev(`(() => {
    WebOS.fs.rm(WebOS.fs.homePath()+'/documents/archive.zip');
    WebOS.fs.write(WebOS.fs.homePath()+'/documents/打包A.txt', '文件A内容');
    WebOS.fs.write(WebOS.fs.homePath()+'/documents/打包B.txt', '文件B内容');
    WebOS.fs.mkdir(WebOS.fs.homePath()+'/documents/bundle');
    WebOS.fs.write(WebOS.fs.homePath()+'/documents/bundle/inner.txt', '嵌套文件');
    return true;
  })()`);
  await ev(`WebOS.wm.open('files')`);
  await sleep(700);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    const doc = [...w.querySelectorAll('.fitem')].find(f => f.textContent.includes('documents'));
    if (doc) doc.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(500);

  // 通过 GUI 工具栏:选中 打包A.txt → 压缩
  const z0 = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=files]');
    if (!w) return { noWin: true, wins: [...document.querySelectorAll('.win')].map(x => x.dataset.app) };
    const item = [...w.querySelectorAll('.fitem')].find(f => f.textContent.includes('打包A.txt'));
    if (!item) return { noItem: true, fitems: [...w.querySelectorAll('.fitem')].map(f => f.textContent.trim()) };
    item.click();   // onClick 设置 selected
    w.querySelector('button[title="把选中项压缩为 ZIP"]').click();
    await new Promise(r => setTimeout(r, 1200));
    await new Promise(r => setTimeout(r, 400));
    return {
      ok: true,
      selected: w.querySelectorAll('.fitem.selected').length,
      zip: WebOS.fs.exists(WebOS.fs.homePath()+'/documents/打包A.zip'),
      toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.slice(0, 40)),
      errs: window.__errs,
    };
  })()`);
  await sleep(400);
  const z1 = await ev(`(() => {
    const content = WebOS.fs.read(WebOS.fs.homePath()+'/documents/打包A.zip');
    return { exists: content != null, b64: content?.charCodeAt(0) === 0 && content?.slice(1, 8) === 'ZIPB64:', bytes: content?.length };
  })()`);
  t('T31 压缩为 ZIP(工具栏,B64 存储)', z1.exists && z1.b64, JSON.stringify(z1));

  // ZIP 引擎验证:解压 打包A.zip(含目录递归的 bundle 在 T31 准备阶段已建)
  const z2 = await ev(`(async () => {
    const { unzip } = await import('./js/core/zip.js');
    const data = await (await fetch('/')).text(); // noop 保持 async
    const b64 = WebOS.fs.read(WebOS.fs.homePath()+'/documents/打包A.zip');
    const bin = Uint8Array.from(atob(b64.slice(8)), c => c.charCodeAt(0));
    return { entries: (await unzip(bin, { asText: true })).map(i => i.name + ':' + (i.text ?? '')) };
  })()`);
  t('T31.1 ZIP 引擎解压(内容还原)', z2.entries?.some(e => e.includes('打包A.txt:文件A内容')), JSON.stringify(z2.entries));
  await c.shot('t31-zip');


  const errs3 = await ev(`window.__errs.length`);
  t('T31.3 全程无错误', errs3 === 0, `errs=${errs3}`);
});

group('T53', '快照与 COW(创建零拷贝 / 写时分叉 / 跨重载持久化 / 恢复 / 权限)', async () => {
  /* ---- T53 snapshots:遮蔽式 COW,快照内容在源文件修改/覆写/删除后不变 ---- */
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);

  // 专用账号(家目录由注册自动播种);全程显式 as,不依赖会话登录态
  // 先清空上一轮遗留的快照(保证 id 从 1 开始,可重跑)
  await ev(`(async () => {
    const fs = WebOS.fs;
    await WebOS.fs.ready();
    for (const it of fs.snapshots.list({ as: 'root' })) await fs.snapshots.remove(it.id, { as: 'root' });
    await fs.flush();
    const { accounts } = await import('./js/core/accounts.js');
    if (!accounts.list().some(u => u.name === 'snapuser')) await accounts.register('snapuser', 'snappass1');
    return true;
  })()`);
  await sleep(300);

  // 1) 建快照 → 改文本 / 覆写随机写文件 / 删源文件 → 快照均读快照时内容
  const cow = await ev(`(async () => {
    const fs = WebOS.fs;
    const dir = '/home/snapuser/documents';
    fs.write(dir + '/cow.txt', 'v1', { as: 'snapuser' });
    await fs.writeAt(dir + '/bin.dat', 0, new Uint8Array([1,2,3,4,5,6,7,8]), { as: 'snapuser' });
    const snap = await fs.snapshots.create(dir, { as: 'snapuser', name: 'base' });
    if (!snap) return { fail: 'create' };
    const id = snap.id;
    fs.write(dir + '/cow.txt', 'v2', { as: 'snapuser' });                          // 文本分叉
    await fs.writeAt(dir + '/bin.dat', 0, new Uint8Array([9,9,9,9]), { as: 'snapuser' });   // backing 覆写分叉
    const snapTxt = await fs.snapshots.readFile(id, 'cow.txt', { as: 'snapuser' });
    const liveTxt = fs.read(dir + '/cow.txt', { as: 'snapuser' });
    const snapBin = await fs.snapshots.readFile(id, 'bin.dat', { as: 'snapuser' });
    const liveBin = await fs.readAt(dir + '/bin.dat', 0, 8, { as: 'snapuser' });
    fs.rm(dir + '/cow.txt', { as: 'snapuser' });                                    // 删除源文件
    await fs.flush();                                                               // 遮蔽域 + 注册表落盘
    const afterRm = await fs.snapshots.readFile(id, 'cow.txt', { as: 'snapuser' });
    const names = (fs.snapshots.readDir(id, '', { as: 'snapuser' }) || []).map(e => e.name);
    return {
      id, files: snap.files, dirs: snap.dirs,
      snapTxt, liveTxt,
      snapBin: snapBin ? Array.from(snapBin) : null,
      liveBin: liveBin ? Array.from(liveBin) : null,
      afterRm,
      hasCow: names.includes('cow.txt'), hasBin: names.includes('bin.dat'),
      listed: fs.snapshots.list({ as: 'snapuser' }).length,
    };
  })()`);
  t('T53.1 COW 分叉(文本改/随机写覆写/删除源文件,快照仍读旧内容)',
    cow.fail === undefined
    && cow.snapTxt === 'v1' && cow.liveTxt === 'v2'
    && JSON.stringify(cow.snapBin) === JSON.stringify([1,2,3,4,5,6,7,8])
    && JSON.stringify(cow.liveBin) === JSON.stringify([9,9,9,9,5,6,7,8])
    && cow.afterRm === 'v1'
    && cow.hasCow && cow.hasBin && cow.listed === 1,
    JSON.stringify(cow));

  // 2) reload:注册表 + 遮蔽域从 OPFS 重建,快照内容不变
  await fresh();
  const reloaded = await ev(`(async () => {
    await WebOS.fs.ready();
    const fs = WebOS.fs;
    const list = fs.snapshots.list({ as: 'snapuser' });
    if (!list.length) return { fail: 'no-snaps' };
    const txt = await fs.snapshots.readFile(list[0].id, 'cow.txt', { as: 'snapuser' });
    const bin = await fs.snapshots.readFile(list[0].id, 'bin.dat', { as: 'snapuser' });
    return { txt, bin: bin ? Array.from(bin) : null, name: list[0].name };
  })()`);
  t('T53.2 快照跨重载持久化(遮蔽域生效)',
    reloaded.fail === undefined && reloaded.txt === 'v1'
    && JSON.stringify(reloaded.bin) === JSON.stringify([1,2,3,4,5,6,7,8])
    && reloaded.name === 'base',
    JSON.stringify(reloaded));

  // 3) 恢复:改乱子树后整棵回滚,快照本体不被消费(可再次恢复)
  const restored = await ev(`(async () => {
    const fs = WebOS.fs;
    const id = fs.snapshots.list({ as: 'snapuser' })[0].id;
    const dir = '/home/snapuser/documents';
    fs.write(dir + '/cow.txt', 'v3', { as: 'snapuser' });               // 重建并再改
    fs.write(dir + '/junk.txt', '垃圾', { as: 'snapuser' });             // 快照外的多余文件
    await fs.writeAt(dir + '/bin.dat', 4, new Uint8Array([7,7,7,7,7,7,7,7]), { as: 'snapuser' });
    const ok = await fs.snapshots.restore(id, { as: 'snapuser' });
    await fs.flush();
    return {
      ok,
      cow: fs.read(dir + '/cow.txt', { as: 'snapuser' }),
      junkGone: fs.exists(dir + '/junk.txt') === false,
      bin: Array.from(await fs.readAt(dir + '/bin.dat', 0, 8, { as: 'snapuser' })),
      stillThere: fs.snapshots.list({ as: 'snapuser' }).length === 1,
      again: await fs.snapshots.readFile(id, 'cow.txt', { as: 'snapuser' }),
    };
  })()`);
  t('T53.3 恢复快照(子树整棵回滚,快照保留可复用)',
    restored.ok === true && restored.cow === 'v1' && restored.junkGone
    && JSON.stringify(restored.bin) === JSON.stringify([1,2,3,4,5,6,7,8])
    && restored.stillThere && restored.again === 'v1',
    JSON.stringify(restored));

  // 4) 权限:创建/可见/读取限属主与 root;root 可全量管理
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (!accounts.list().some(u => u.name === 'snoop')) await accounts.register('snoop', 'snooppass1');
    return true;
  })()`);
  const guards = await ev(`(async () => {
    const fs = WebOS.fs;
    const dir = '/home/snapuser/documents';
    const sid = fs.snapshots.list({ as: 'snapuser' })[0]?.id ?? -1;
    const listVisible = fs.snapshots.list({ as: 'snoop' }).length;
    const cantCreate = (await fs.snapshots.create(dir, { as: 'snoop' })) === null;
    const rootCan = !!(await fs.snapshots.create('/home/snapuser', { as: 'root', name: 'rootview' }));
    const rootId = fs.snapshots.list({ as: 'root' }).find((x) => x.name === 'rootview')?.id;
    const cantRead = sid >= 0 && (await fs.snapshots.readFile(sid, 'cow.txt', { as: 'snoop' })) === null;
    const rootRead = await fs.snapshots.readFile(sid, 'cow.txt', { as: 'root' });
    const rootRemove = await fs.snapshots.remove(rootId, { as: 'root' });
    const countAfter = fs.snapshots.list({ as: 'root' }).length;
    return { sid, listVisible, cantCreate, rootCan, rootId, cantRead, rootRead, rootRemove, countAfter };
  })()`);
  t('T53.4 快照权限(属主或 root:他人不可建/不可见/不可读)',
    guards.sid >= 1 && guards.listVisible === 0 && guards.cantCreate && guards.rootCan
    && guards.cantRead && guards.rootRead === 'v1'
    && guards.rootRemove === true && guards.countAfter === 1,
    JSON.stringify(guards));

  // 5) 删除快照(遮蔽域随之回收)
  const cleanup = await ev(`(async () => {
    const fs = WebOS.fs;
    const sid = fs.snapshots.list({ as: 'snapuser' })[0]?.id;
    const ok = await fs.snapshots.remove(sid, { as: 'snapuser' });
    const empty = fs.snapshots.list({ as: 'snapuser' }).length === 0;
    await fs.flush();
    return { ok, empty };
  })()`);
  t('T53.5 删除快照', cleanup.ok === true && cleanup.empty === true, JSON.stringify(cleanup));

  // 6) 终端 snap 命令冒烟(会话用户身份):create / list / cat + COW
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(700);
  const termType = async (cmd) => {
    await ev(`(() => {
      const inp = document.querySelector('.win[data-app=terminal] .term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(380);
  };
  const termOut = () => ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent`);
  await termType('echo hi > ~/documents/termtest.txt');
  await termType('snap create ~/documents demo');
  await termType('snap');
  const out1 = await termOut();
  const idm = /#(\d+)/.exec(out1);
  await termType('echo changed > ~/documents/termtest.txt');   // 分叉:快照应仍读 hi
  await termType(`snap cat ${idm ? idm[1] : 0} termtest.txt`);
  const out2 = await termOut();
  await termType('cat ~/documents/termtest.txt');
  const out3 = await termOut();
  const term = {
    listed: /demo/.test(out1) && idm != null,
    snapCat: out2.trimEnd().endsWith('hi'),
    liveChanged: out3.trimEnd().endsWith('changed'),
  };
  t('T53.6 终端 snap 命令(create / list / cat,COW 生效)',
    term.listed && term.snapCat && term.liveChanged, JSON.stringify(term));
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=terminal]');
    if (w) WebOS.wm.close(w.dataset.id);
    const u = WebOS.accounts.current() || 'user';
    WebOS.fs.rm('/home/' + u + '/documents/termtest.txt', { as: 'root' });
    return true;
  })()`);

  // 7) 粒度:单文件快照恢复 + 整树快照('/')换根恢复
  const gran = await ev(`(async () => {
    const fs = WebOS.fs;
    const p = '/home/snapuser/documents/cow.txt';
    // 单文件快照:改后恢复,只影响这一个文件
    fs.write(p, 'v9', { as: 'snapuser' });
    const fsnap = await fs.snapshots.create(p, { as: 'snapuser', name: 'onefile' });
    fs.write(p, 'v10', { as: 'snapuser' });
    const old = await fs.snapshots.readFile(fsnap.id, '', { as: 'snapuser' });
    const r1 = await fs.snapshots.restore(fsnap.id, { as: 'snapuser' });
    const after = fs.read(p, { as: 'snapuser' });
    await fs.snapshots.remove(fsnap.id, { as: 'snapuser' });
    // 整树快照:root 建 '/' → 加脏标记 → 换根恢复 → 标记消失、树完整、根引导字段保留
    const wsnap = await fs.snapshots.create('/', { as: 'root', name: 'wholefs' });
    const marker = '/home/snapuser/documents/wholemark.txt';
    fs.write(marker, 'dirty', { as: 'root' });
    const r2 = await fs.snapshots.restore(wsnap.id, { as: 'root' });
    await fs.flush();
    const gone = fs.exists(marker) === false;
    const homeIntact = fs.exists('/home/snapuser') === true && fs.read(p, { as: 'root' }) === 'v9';
    const noBogus = !fs.list('/', { as: 'root' }).some(x => x.name === '/');
    const rootFields = fs.exportAll().v === 2 && fs.exportAll().xs === 1;
    await fs.snapshots.remove(wsnap.id, { as: 'root' });
    await fs.flush();
    return { fsnapOk: !!fsnap, old, r1, after, wsnapOk: !!wsnap, r2, gone, homeIntact, noBogus, rootFields };
  })()`);
  t('T53.7 快照粒度(单文件恢复 + 整树换根恢复)',
    gran.fsnapOk === true && gran.old === 'v9' && gran.r1 === true && gran.after === 'v9'
    && gran.wsnapOk === true && gran.r2 === true && gran.gone === true
    && gran.homeIntact === true && gran.noBogus === true && gran.rootFields === true,
    JSON.stringify(gran));

  // 8) 换根恢复后重载,树应完整可装载(引导字段缺失会触发整盘清空,这里必须读到旧值)
  await fresh();
  const afterReload = await ev(`(async () => {
    await WebOS.fs.ready();
    return {
      v: WebOS.fs.exportAll().v,
      cow: WebOS.fs.read('/home/snapuser/documents/cow.txt', { as: 'root' }),
      home: WebOS.fs.exists('/home/snapuser'),
    };
  })()`);
  t('T53.8 整树恢复后重载正常', afterReload.v === 2 && afterReload.cow === 'v9' && afterReload.home === true,
    JSON.stringify(afterReload));

  const errs53 = await ev(`window.__errs.length`);
  t('T53.9 全程无错误', errs53 === 0, `errs=${errs53}`);
});

group('T60', '回收站 / 文件剪贴板 / 打开方式 / 会话记录', async () => {
  /* ---- T60:桌面 OS 四件套(全部驱动真实 UI,WebOS.* 仅造数据与断言) ---- */
  await fresh();
  const HOME = await ev(`WebOS.fs.homePath()`);
  const USER = await ev(`WebOS.accounts.current()`);
  await ev(`WebOS.trash.emptyTrash()`);   // 清掉前轮遗留,保证计数确定

  /* ---- 1) 桌面 Delete 入筒 + 角标 ---- */
  await ev(`WebOS.fs.write(${JSON.stringify(HOME + '/desktop/e2e-trash.txt')}, 'trash-me')`);
  const iconSel = JSON.stringify(`.dicon[data-key="fs:${HOME}/desktop/e2e-trash.txt"]`);
  await waitFor(`!!document.querySelector(${iconSel})`, 5000);
  // 选中该图标(真实选择态),按 Delete(desktop 捕获相监听)
  await ev(`(() => {
    document.querySelectorAll('.dicon').forEach(d => d.classList.remove('selected'));
    document.querySelector(${iconSel}).classList.add('selected');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  })()`);
  await waitFor(`(() => {
    const l = WebOS.trash.listTrash();
    return !WebOS.fs.exists(${JSON.stringify(HOME + '/desktop/e2e-trash.txt')})
      && l.length === 1 && l[0].orig === ${JSON.stringify(HOME + '/desktop/e2e-trash.txt')}
      && !document.querySelector(${iconSel})
      && (document.querySelector('.dicon[data-trash="1"] .trash-badge')?.textContent || '') === '1';
  })()`, 5000);
  const t1 = await ev(`(() => ({
    gone: !WebOS.fs.exists(${JSON.stringify(HOME + '/desktop/e2e-trash.txt')}),
    list: WebOS.trash.listTrash().map(i => i.orig),
    icon: !document.querySelector(${iconSel}),
    badge: document.querySelector('.dicon[data-trash="1"] .trash-badge')?.textContent || '',
  }))()`);
  t('T60 桌面 Delete 入筒(文件进回收站 + 图标消失 + 角标 1)',
    t1.gone && t1.list.length === 1 && t1.list[0] === HOME + '/desktop/e2e-trash.txt' && t1.icon && t1.badge === '1',
    JSON.stringify(t1));

  /* ---- 2) 回收站窗口:列表 / 原位置 / 双击还原(真实 UI) ---- */
  await ev(`WebOS.wm.open('trash')`);
  await waitFor(`document.querySelectorAll('.win[data-app=trash] .tr-item').length === 1`, 5000);
  const row = await ev(`(() => {
    const r = document.querySelector('.win[data-app=trash] .tr-item');
    return { name: r.querySelector('.tr-name').textContent, meta: r.querySelector('.tr-meta').textContent,
             status: document.querySelector('.win[data-app=trash] .app-status').textContent };
  })()`);
  await ev(`document.querySelector('.win[data-app=trash] .tr-item').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(`WebOS.fs.exists(${JSON.stringify(HOME + '/desktop/e2e-trash.txt')}) && !!document.querySelector('.win[data-app=trash] .tr-empty')`, 5000);
  const t2 = await ev(`(() => ({
    restored: WebOS.fs.exists(${JSON.stringify(HOME + '/desktop/e2e-trash.txt')}) && WebOS.fs.read(${JSON.stringify(HOME + '/desktop/e2e-trash.txt')}),
    empty: !!document.querySelector('.win[data-app=trash] .tr-empty'),
  }))()`);
  t('T60.1 回收站窗口(原位置展示 + 双击还原 + 内容完好)',
    row.name === 'e2e-trash.txt' && row.meta.includes('desktop/e2e-trash.txt') && row.status.includes('1 个项目')
    && t2.restored === 'trash-me' && t2.empty,
    JSON.stringify({ row, t2 }));

  /* ---- 3) 彻底删除走危险确认(sysdialog 真实弹窗) ---- */
  await ev(`WebOS.fs.write(${JSON.stringify(HOME + '/desktop/e2e-trash2.txt')}, 'x')`);
  await ev(`WebOS.trash.moveToTrash([${JSON.stringify(HOME + '/desktop/e2e-trash2.txt')}])`);
  await waitFor(`document.querySelectorAll('.win[data-app=trash] .tr-item').length === 1`, 5000);
  await ev(`(() => {   // 工具栏第三个按钮 = 清空回收站
    const btns = document.querySelectorAll('.win[data-app=trash] .app-toolbar .btn');
    btns[btns.length - 1].click();
  })()`);
  await waitFor(`!!document.querySelector('.win[data-app=sysdialog]')`, 5000);
  await ev(`document.querySelector('.win[data-app=sysdialog] .dlg-btns .btn.danger').click()`);
  await waitFor(`WebOS.trash.listTrash().length === 0 && !!document.querySelector('.win[data-app=trash] .tr-empty') && !document.querySelector('.dicon[data-trash="1"] .trash-badge')`, 5000);
  const t3 = await ev(`(() => ({ n: WebOS.trash.listTrash().length, empty: !!document.querySelector('.win[data-app=trash] .tr-empty'), badge: !document.querySelector('.dicon[data-trash="1"] .trash-badge') }))()`);
  t('T60.2 清空回收站(危险确认弹窗 + 空态 + 桌面角标消失)',
    t3.n === 0 && t3.empty && t3.badge, JSON.stringify(t3));
  await ev(`(() => { WebOS.wm.close(WebOS.wm.taskList().find(w => w.appId === 'trash').id); return true; })()`);

  /* ---- 4) 文件剪贴板:文件管家 Ctrl+C / Ctrl+X / Ctrl+V(真实键序) ---- */
  await ev(`WebOS.fs.write(${JSON.stringify(HOME + '/documents/e2e-clip.txt')}, 'clip-me')`);
  await ev(`WebOS.wm.open('files')`);
  await waitFor(`!!document.querySelector('.win[data-app=files] .fgrid')`, 6000);
  const clickSide = async (label) => {
    await ev(`(() => {
      const b = [...document.querySelectorAll('.win[data-app=files] .list-item')].find(n => n.textContent.trim() === ${JSON.stringify(label)});
      b.click();
    })()`);
    await sleep(250);
  };
  const keyOn = (sel, key, opts = {}) => ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true, ...${JSON.stringify(opts)} }))`);
  await clickSide('文档');
  await waitFor(`!!document.querySelector('.win[data-app=files] .fitem[data-path="${HOME}/documents/e2e-clip.txt"]')`, 5000);
  const clipSel = JSON.stringify(`.win[data-app=files] .fitem[data-path="${HOME}/documents/e2e-clip.txt"]`);
  // Ctrl+C 复制 → 主目录 Ctrl+V → 落一份副本
  await ev(`document.querySelector(${clipSel}).click()`);
  await keyOn(`.win[data-app=files] .fitem[data-path="${HOME}/documents/e2e-clip.txt"]`, 'c');
  await clickSide('主目录');
  await keyOn('.win[data-app=files] .fgrid', 'v');
  await waitFor(`WebOS.fs.exists(${JSON.stringify(HOME + '/e2e-clip.txt')}) && WebOS.fs.exists(${JSON.stringify(HOME + '/documents/e2e-clip.txt')})`, 5000);
  const t4a = await ev(`(() => ({ copied: WebOS.fs.read(${JSON.stringify(HOME + '/e2e-clip.txt')}), src: WebOS.fs.exists(${JSON.stringify(HOME + '/documents/e2e-clip.txt')}) }))()`);
  // 剪切态淡显:剪切 documents 里那份 → 下载 Ctrl+V → 源消失
  await clickSide('文档');
  await waitFor(`!!document.querySelector(${clipSel})`, 5000);
  await ev(`document.querySelector(${clipSel}).click()`);
  await keyOn(`.win[data-app=files] .fitem[data-path="${HOME}/documents/e2e-clip.txt"]`, 'x');
  const cutCls = await ev(`document.querySelector(${clipSel})?.classList.contains('cut') === true`);
  await clickSide('下载');
  await keyOn('.win[data-app=files] .fgrid', 'v');
  await waitFor(`WebOS.fs.exists(${JSON.stringify(HOME + '/downloads/e2e-clip.txt')}) && !WebOS.fs.exists(${JSON.stringify(HOME + '/documents/e2e-clip.txt')}) && !WebOS.clipboard.hasFiles()`, 5000);
  const t4b = await ev(`(() => ({ moved: WebOS.fs.read(${JSON.stringify(HOME + '/downloads/e2e-clip.txt')}), srcGone: !WebOS.fs.exists(${JSON.stringify(HOME + '/documents/e2e-clip.txt')}), clipCleared: !WebOS.clipboard.hasFiles() }))()`);
  t('T60.3 文件剪贴板(Ctrl+C 复制 / Ctrl+X 剪切淡显 / Ctrl+V 粘贴 / 剪切一次性)',
    t4a.copied === 'clip-me' && t4a.src === true && cutCls === true
    && t4b.moved === 'clip-me' && t4b.srcGone && t4b.clipCleared,
    JSON.stringify({ t4a, cutCls, t4b }));

  /* ---- 5) 打开方式:右键菜单 → 选择器 → 记住默认(真实 UI) ---- */
  await clickSide('文档');
  await waitFor(`!!document.querySelector('.win[data-app=files] .fitem[data-path="${HOME}/documents/应用开发指南.md"]')`, 5000);
  const mdSel = `.win[data-app=files] .fitem[data-path="${HOME}/documents/应用开发指南.md"]`;
  await ev(`document.querySelector(${JSON.stringify(mdSel)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 }))`);
  await waitFor(`!!document.querySelector('#ctx .ctx-item')`, 4000);
  await ev(`(() => { [...document.querySelectorAll('#ctx .ctx-item')].find(n => n.textContent.includes('打开方式')).click(); })()`);
  await waitFor(`document.querySelectorAll('.ow-item').length >= 2`, 5000);
  const owDefault = await ev(`WebOS.openwith.defaultFor('应用开发指南.md')`);
  await ev(`(() => { document.querySelector('.ow-always input').click(); })()`);   // 勾选「始终」
  await ev(`(() => { [...document.querySelectorAll('.ow-item')].find(n => n.querySelector('b').textContent.includes('记事本')).click(); })()`);
  await waitFor(`!!document.querySelector('.win[data-app=notes]') && !document.querySelector('.ow-item')
    && (JSON.parse(localStorage.getItem('webos.openwith.v1') || '{}').md || null) === 'notes'`, 6000);
  const t5 = await ev(`(() => ({
    notes: !!document.querySelector('.win[data-app=notes]'),
    assoc: (JSON.parse(localStorage.getItem('webos.openwith.v1') || '{}').md) || null,
    dlgClosed: !document.querySelector('.ow-item'),
  }))()`);
  t('T60.4 打开方式(右键入口 + 选择器 + 记住默认 .md=记事本 + 直开)',
    owDefault === 'mdedit' && t5.notes && t5.assoc === 'notes' && t5.dlgClosed,
    JSON.stringify({ owDefault, t5 }));
  // 还原关联并收尾
  await ev(`(() => {
    WebOS.openwith.setDefault('md', null);
    const w = WebOS.wm.taskList().find(x => x.appId === 'notes'); if (w) WebOS.wm.close(w.id);
    const f = WebOS.wm.taskList().find(x => x.appId === 'files'); if (f) WebOS.wm.close(f.id);
    WebOS.fs.rm(${JSON.stringify(HOME + '/e2e-clip.txt')});
    WebOS.fs.rm(${JSON.stringify(HOME + '/downloads/e2e-clip.txt')});
    WebOS.fs.rm(${JSON.stringify(HOME + '/desktop/e2e-trash.txt')});
    return true;
  })()`);

  /* ---- 6) 会话记录:开窗即记 / e2e 刷新不恢复 / 注销丢弃 ---- */
  await ev(`WebOS.wm.open('calc')`);
  await sleep(900);   // 快照防抖 400ms
  const s6a = await ev(`JSON.parse(localStorage.getItem('webos.session.windows.v1') || '{}')[${JSON.stringify(USER)}] || null`);
  await fresh();      // 刷新:?e2e=1 模式明确不恢复(测试要干净桌面)
  await sleep(1200);
  const s6b = await ev(`(() => ({ wins: document.querySelectorAll('.win').length, saved: JSON.parse(localStorage.getItem('webos.session.windows.v1') || '{}')[${JSON.stringify(USER)}] || null }))()`);
  await ev(`WebOS.accounts.logout()`);
  await sleep(500);
  const s6c = await ev(`JSON.parse(localStorage.getItem('webos.session.windows.v1') || '{}')[${JSON.stringify(USER)}] || null`);
  t('T60.5 会话记录(开窗即记 / e2e 不恢复 / 注销丢弃)',
    Array.isArray(s6a) && s6a.some(w => w.app === 'calc')
    && s6b.wins === 0 && Array.isArray(s6b.saved) && s6b.saved.some(w => w.app === 'calc')
    && s6c === null,
    JSON.stringify({ s6a, s6b, s6c }));
  await c.shot('t60-desktop-suite');
  await fresh();   // 注销后回到锁屏,登录回会话供后续组使用
});

/* ---- T63 落盘分层(fs-writeback 方案,docs/fs-writeback.md §5)----
 * 结构档 30ms 微防抖 / writeAt 分类 / 懒档写放大 / fs.batch 合并广播 /
 * savedAt+clockDelta 启动校准 / cowGuard 遮蔽注册表及时落盘。
 * 「强杀近似」的判别力都落在 reload 前的盘上状态断言(pagehide 会兜底
 * 冲刷,只看 reload 后结果会误归 meta 也通过)。 ---- */
group('T63', '落盘分层(结构档微防抖 / 懒档写放大 / batch 合并 / 启动校准 / 遮蔽及时落盘)', async () => {
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);

  /* 页内直读/直写 webos/fs.v2.json:校准用例手工构造「懒写未刷」的盘上状态 */
  const treeIO = `
    async function readTree() {
      const root = await navigator.storage.getDirectory();
      const dh = await root.getDirectoryHandle('webos');
      const fh = await dh.getFileHandle('fs.v2.json');
      return JSON.parse(await (await fh.getFile()).text());
    }
    async function writeTreeJSON(t) {
      const root = await navigator.storage.getDirectory();
      const dh = await root.getDirectoryHandle('webos', { create: true });
      const fh = await dh.getFileHandle('fs.v2.json', { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(t));
      await w.close();
    }
    function nodeAt(t, p) {
      let n = t;
      for (const s of p.slice(1).split('/')) { n = n.c?.[s]; if (!n) return null; }
      return n;
    }`;

  // T-新1 播种批量:注册(登录播种:家目录 + 桌面快捷方式)放进 fs.batch
  //   → 一条 batch 合并广播、≤2 趟写树
  const seeded = await ev(`(async () => {
    const fs = WebOS.fs;
    await fs.ready();
    const name = 'fswb' + (Date.now() % 100000);
    let broadcasts = 0, last = null;
    const off = WebOS.bus.subscribe('sys:fs-changed', (p) => { broadcasts++; last = p; });
    fs.__probe.reset();
    const reg = await fs.batch(() => WebOS.accounts.register(name, 'fswbpass1'));
    await new Promise(r => setTimeout(r, 80));   // 等尾随窗彻底落定
    const calls = fs.__probe.writeTreeCalls;
    off();
    return { ok: !!reg?.ok, broadcasts, calls, action: last?.action,
      paths: last?.paths?.length || 0,
      homeSeeded: fs.isDir('/home/' + name),
      shortcuts: (fs.list('/home/' + name + '/desktop', { as: 'root' }) || []).length };
  })()`);
  t('T63.1 播种批量(batch 内登录播种:合并为 1 条广播、≤2 趟写树、家目录与快捷方式齐备)',
    seeded.ok && seeded.broadcasts === 1 && seeded.calls <= 2
    && seeded.action === 'batch' && seeded.paths >= 2
    && seeded.homeSeeded && seeded.shortcuts >= 2,
    JSON.stringify(seeded));

  // T-新2 size/mtime 启动校准:flush 落齐后手工把树 JSON 改回旧 s/旧 m/旧
  //   savedAt(模拟「懒写窗口内强杀」的盘上状态)→ reload → 校准修复
  const calibPrep = await ev(`(async () => {
    const fs = WebOS.fs;
    const p = '/home/' + WebOS.accounts.current() + '/appdata/calib.dat';
    await fs.writeAt(p, 0, new Uint8Array(16), { as: 'root' });    // 首写(结构档)
    await new Promise(r => setTimeout(r, 80));                     // 过结构窗:盘上树已带初始 s=16
    await fs.writeAt(p, 16, new Uint8Array(16), { as: 'root' });  // 追加 16B(懒档,盘上树不追)
    const tWrite = Date.now();
    await fs.flush();                                              // 落齐(拿到含新 s 的树)
    ${treeIO}
    const tree = await readTree();
    const n = nodeAt(tree, p);
    n.s = 16; n.m = tWrite - 3600000;      // 旧 s / 旧 m(一小时前)
    tree.savedAt = tWrite - 60000;         // 旧哨兵(字节写入前一分钟)
    await writeTreeJSON(tree);
    return { tWrite, p };
  })()`);
  await fresh();   // reload → 启动校准
  const calib = await ev(`(async () => {
    await WebOS.fs.ready();
    const fs = WebOS.fs;
    const p = ${JSON.stringify(calibPrep.p)};
    const size = await fs.fileSize(p, { as: 'root' });
    const mtime = fs.stat(p, { as: 'root' })?.mtime;
    const head = Array.from((await fs.readAt(p, 0, 4, { as: 'root' })) || []);
    return { size, mtime, head };
  })()`);
  t('T63.2 启动校准(size 修到实际 32B / mtime 修到实际写入时刻 / readAt 全程可读)',
    calib.size === 32
    && calib.mtime >= calibPrep.tWrite - 2000 && calib.mtime <= Date.now()
    && calib.head.length === 4,
    JSON.stringify({ tWrite: calibPrep.tWrite, calib }));

  // T-新2 反向哨兵:快照 → 改动 → 恢复 → reload → mtime 仍为快照时刻
  //   (校准不得打爆恢复保留的旧 mtime,防 naive max / 哨兵误修)
  const snapPrep = await ev(`(async () => {
    const fs = WebOS.fs;
    const p = '/home/' + WebOS.accounts.current() + '/documents/mtime-guard.txt';
    fs.write(p, 'v1', { as: 'root' });
    await fs.flush();
    const m0 = fs.stat(p, { as: 'root' }).mtime;
    const snap = await fs.snapshots.create(fs.parentPath(p), { as: 'root', name: 'mtime-guard' });
    fs.write(p, 'v2-改动', { as: 'root' });
    await fs.snapshots.restore(snap.id, { as: 'root' });
    await fs.flush();
    return { m0, p };
  })()`);
  await fresh();
  const snapAfter = await ev(`(async () => {
    await WebOS.fs.ready();
    const fs = WebOS.fs;
    const p = ${JSON.stringify(snapPrep.p)};
    return { mtime: fs.stat(p, { as: 'root' })?.mtime, content: fs.read(p, { as: 'root' }) };
  })()`);
  t('T63.3 反向哨兵(恢复保留原 mtime:reload 后仍为快照时刻,校准不误修)',
    snapAfter.content === 'v1' && snapAfter.mtime === snapPrep.m0,
    JSON.stringify({ m0: snapPrep.m0, after: snapAfter.mtime }));

  // T-新3 结构档判别(强杀近似):新建文件(首写 writeAt 高危分支 / fs.write)
  //   不 flush、sleep 120ms → 判别点在「盘上树已含新节点」(reload 前断言,
  //   pagehide 兜底不背书);reload 后存在且可读
  const mkFiles = await ev(`(async () => {
    const fs = WebOS.fs;
    const u = WebOS.accounts.current();
    await fs.writeAt('/home/' + u + '/tnew3a.dat', 0, new Uint8Array([1, 2, 3, 4]), { as: 'root' });
    fs.write('/home/' + u + '/tnew3b.txt', 'text3', { as: 'root' });
    return { a: '/home/' + u + '/tnew3a.dat', b: '/home/' + u + '/tnew3b.txt' };
  })()`);
  await sleep(120);
  const diskTree = await ev(`(async () => {
    ${treeIO}
    const t = await readTree();
    return { a: !!nodeAt(t, ${JSON.stringify(mkFiles.a)}), b: !!nodeAt(t, ${JSON.stringify(mkFiles.b)}) };
  })()`);
  await fresh();
  const survived = await ev(`(async () => {
    await WebOS.fs.ready();
    const fs = WebOS.fs;
    const a = ${JSON.stringify(mkFiles.a)}, b = ${JSON.stringify(mkFiles.b)};
    const bin = Array.from((await fs.readAt(a, 0, 4, { as: 'root' })) || []);
    return { hasA: fs.exists(a), hasB: fs.exists(b), bin, txt: fs.read(b, { as: 'root' }) };
  })()`);
  t('T63.4 结构档判别(新建即结构趟:120ms 内盘上树已含节点;reload 后存在且可读)',
    diskTree.a && diskTree.b && survived.hasA && survived.hasB
    && JSON.stringify(survived.bin) === JSON.stringify([1, 2, 3, 4]) && survived.txt === 'text3',
    JSON.stringify({ diskTree, survived }));

  // T-新4 懒档行为:已存在文件连续 10 次就地覆盖 writeAt → sleep 120ms
  //   (不等待直接计数则合并窗未响,断言恒真)→ 0 趟写树、广播合并;
  //   flush 后盘上树 m/s 为最新
  const lazy = await ev(`(async () => {
    const fs = WebOS.fs;
    const p = '/home/' + WebOS.accounts.current() + '/tnew4.dat';
    await fs.writeAt(p, 0, new Uint8Array(8), { as: 'root' });   // 新建(结构档)
    await fs.flush();                                            // 干净起点(结构趟已落定)
    const t0 = Date.now();
    fs.__probe.reset();
    let broadcasts = 0;
    const off = WebOS.bus.subscribe('sys:fs-changed', () => broadcasts++);
    for (let i = 0; i < 10; i++) {
      await fs.writeAt(p, 0, new Uint8Array([i & 255, 1, 2, 3]), { as: 'root' });   // 纯就地覆盖
    }
    await new Promise(r => setTimeout(r, 120));   // > 30ms 合并窗落定;< 30s,metaTimer 不串场
    const calls = fs.__probe.writeTreeCalls;
    off();
    await fs.flush();                             // 懒档搭 flush 便车落盘
    ${treeIO}
    const n = nodeAt(await readTree(), p);
    return { broadcasts, calls, t0, s: n.s, m: n.m };
  })()`);
  t('T63.5 懒档行为(纯就地覆盖 0 趟写树 / 广播合并 ≤2 条 / flush 后盘上 s=8、m≥首次覆盖)',
    lazy.calls === 0 && lazy.broadcasts >= 1 && lazy.broadcasts <= 2
    && lazy.s === 8 && lazy.m >= lazy.t0 - 1000,
    JSON.stringify(lazy));

  // T-新5 快照遮蔽注册表及时落盘:建快照 → flush(注册表落盘,gen=null)
  //   → writeAt 覆盖(触发 cowGuard 遮蔽)→ 不 flush,sleep 120ms → reload
  //   → 快照读覆盖前旧内容(注册表必须已随遮蔽字节落盘)
  const shadowPrep = await ev(`(async () => {
    const fs = WebOS.fs;
    const dir = '/home/' + WebOS.accounts.current() + '/documents';
    const enc = (s) => new TextEncoder().encode(s);
    await fs.writeAt(dir + '/shadow.bin', 0, enc('OLD'), { as: 'root' });
    const snap = await fs.snapshots.create(dir, { as: 'root', name: 'shadow-guard' });
    await fs.flush();
    await fs.writeAt(dir + '/shadow.bin', 0, enc('NEW'), { as: 'root' });   // 遮蔽 + 覆盖
    return { dir };
  })()`);
  await sleep(120);   // 不 flush
  // 判别点在 reload 前:盘上注册表须已带 gen(pagehide 兜底不背书)
  const regDisk = await ev(`(async () => {
    const root = await navigator.storage.getDirectory();
    const dh = await root.getDirectoryHandle('webos');
    const raw = await (await dh.getFileHandle('fs.snaps.v1.json')).getFile().then(f => f.text());
    const reg = JSON.parse(raw);
    const it = (reg.items || []).find(x => x.name === 'shadow-guard');
    const n = it && it.tree && it.tree.c && it.tree.c['shadow.bin'];
    return { gen: n ? n.gen : undefined };
  })()`);
  await fresh();
  const shadowAfter = await ev(`(async () => {
    await WebOS.fs.ready();
    const fs = WebOS.fs;
    const dir = ${JSON.stringify(shadowPrep.dir)};
    const it = fs.snapshots.list({ as: 'root' }).find(x => x.name === 'shadow-guard');
    if (!it) return { fail: 'no-snap' };
    const bin = await fs.snapshots.readFile(it.id, 'shadow.bin', { as: 'root' });
    const live = new TextDecoder().decode((await fs.readAt(dir + '/shadow.bin', 0, 3, { as: 'root' })) || new Uint8Array());
    return { snap: bin ? new TextDecoder().decode(bin) : null, live };
  })()`);
  t('T63.6 遮蔽注册表及时落盘(120ms 内盘上已带 gen;reload 后快照读覆盖前旧内容,活跃文件为新内容)',
    regDisk.gen != null && shadowAfter.fail === undefined
    && shadowAfter.snap === 'OLD' && shadowAfter.live === 'NEW',
    JSON.stringify({ regDisk, shadowAfter }));

  // 收尾清理:本组造的快照与测试文件(root 身份,幂等)
  await ev(`(async () => {
    const fs = WebOS.fs;
    await fs.ready();
    for (const it of fs.snapshots.list({ as: 'root' })) {
      if (it.name === 'mtime-guard' || it.name === 'shadow-guard') await fs.snapshots.remove(it.id, { as: 'root' });
    }
    const u = WebOS.accounts.current();
    for (const p of [
      '/home/' + u + '/appdata/calib.dat',
      '/home/' + u + '/tnew3a.dat', '/home/' + u + '/tnew3b.txt',
      '/home/' + u + '/tnew4.dat',
      '/home/' + u + '/documents/mtime-guard.txt',
      '/home/' + u + '/documents/shadow.bin',
    ]) fs.rm(p, { as: 'root' });
    await fs.flush();
    return true;
  })()`);
});
