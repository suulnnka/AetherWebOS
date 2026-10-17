/* ============================================================
 * AetherWebOS e2e 用例组 · 外壳与桌面(T1 T2 T3 T6 T7 T10 T13 T14 T22 T23 T24 T25 T40 T41 T42 T45 T46 T62 T64)
 * 自原 e2e.mjs 单文件按域拆出;公共助手见 tools/e2e-harness.mjs。
 * 本文件只做 group() 注册(被入口 tools/e2e.mjs import),不要直接运行。
 * ============================================================ */
import { group, t, ev, c, fresh, sleep, waitFor, needApps, termType, nav, bashType, bashOut, ctxClick, typeReal, pressEnter, clickReal, wipeAppData, wipeSharedAppData } from '../e2e-harness.mjs';

group('T1', '启动与桌面', async () => {
  /* ---- T1 启动与桌面 ---- */
  // 轮询等待启动完成(开机画面移除且桌面图标就绪),固定 sleep 在模块增多后不可靠
  for (let i = 0; i < 40; i++) {
    const ready = await ev(`(() => ({ boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.dicon').length }))()`);
    if (!ready.boot && ready.icons > 0) break;
    await sleep(300);
  }
  await sleep(300);
  const boot1 = await ev(`({
    errs: window.__errs,
    boot: !!document.getElementById('boot'),
    icons: document.querySelectorAll('.dicon').length,
    pinned: document.querySelectorAll('#tb-pinned .tbtn').length,
    smItems: document.querySelectorAll('.sm-item').length,
    clock: document.getElementById('clock-time').textContent,
    theme: document.documentElement.dataset.theme,
  })`);
  t('T1 桌面启动', !boot1.boot && boot1.icons >= 12 && boot1.pinned >= 3 && boot1.smItems >= 12,
    `icons=${boot1.icons} pinned=${boot1.pinned} sm=${boot1.smItems} clock=${boot1.clock} errs=${boot1.errs.length}`);
  if (boot1.errs.length) console.log('   errors:', boot1.errs.join('\n   '));
  await c.shot('t1-desktop');

});

group('T2', '开始菜单与搜索', async () => {
  /* ---- T2 开始菜单与搜索 ---- */
  await ev(`document.getElementById('start-btn').click()`);
  await sleep(300);
  const sm = await ev(`({
    open: document.getElementById('start-menu').classList.contains('open'),
    items: document.querySelectorAll('.sm-item:not(.hide)').length,
  })`);
  t('T2 开始菜单打开', sm.open && sm.items >= 7, `items=${sm.items}`);
  await ev(`const i=document.getElementById('sm-input'); i.value='终端'; i.dispatchEvent(new Event('input'))`);
  await sleep(150);
  const filtered = await ev(`document.querySelectorAll('.sm-item:not(.hide)').length`);
  t('T2.1 搜索过滤', filtered === 1, `visible=${filtered}(终端)`);
  await ev(`const i=document.getElementById('sm-input'); i.value=''; i.dispatchEvent(new Event('input'))`);
  await c.shot('t2-startmenu');
  await ev(`document.getElementById('start-btn').click()`); // 关闭

});

group('T3', '启动设置应用', async () => {
  /* ---- T3 启动设置应用 ---- */
  await ev(`document.querySelector('.sm-item[data-search*="settings"]').click()`);
  await sleep(500);
  const win1 = await ev(`({
    wins: document.querySelectorAll('.win').length,
    title: document.querySelector('.win-title')?.textContent,
    btns: document.querySelectorAll('.win .wbtn').length,
    taskBtn: document.querySelectorAll('#tb-tasks .tbtn').length,
    focused: document.querySelector('.win')?.classList.contains('focused'),
  })`);
  t('T3 窗口创建', win1.wins === 1 && win1.btns === 3 && win1.taskBtn === 1 && win1.focused,
    `title=${win1.title} btns=${win1.btns}`);
  await c.shot('t3-settings-window');

});

group('T6', '音量面板(托盘)', async () => {
  /* ---- T6 音量面板(托盘) ---- */
  await ev(`document.getElementById('tray-vol').click()`);
  await sleep(300);
  const volPop = await ev(`({
    pop: !!document.querySelector('[data-pop="volume"]'),
    range: !!document.querySelector('[data-pop="volume"] input[type=range]'),
  })`);
  t('T6 音量面板', volPop.pop && volPop.range, JSON.stringify(volPop));
  await c.shot('t6-volume-popover');
  // 通过终端稍后再验证 IPC 音量,先关闭面板
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);

});

group('T7', '时钟日历面板', async () => {
  /* ---- T7 时钟日历面板 ---- */
  await ev(`document.getElementById('tray-clock').click()`);
  await sleep(300);
  const cal = await ev(`({
    pop: !!document.querySelector('[data-pop="cal"]'),
    days: document.querySelectorAll('[data-pop="cal"] .day').length,
    today: !!document.querySelector('[data-pop="cal"] .day.today'),
  })`);
  t('T7 日历面板', cal.pop && cal.days >= 28 && cal.days <= 42 && cal.today, JSON.stringify(cal));
  await c.shot('t7-calendar');
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);

});

group('T10', '窗口操作', async () => {
  /* ---- T10 窗口操作 ---- */
  // 独立运行前置:窗口操作需要文件管家窗口
  await ev(`WebOS.wm.open('files')`);
  await sleep(500);
  const filesWin = await ev(`document.querySelector('.win[data-app=files]').dataset.id`);
  await ev(`WebOS.wm.minimize('${filesWin}')`);
  await sleep(500);
  const minState = await ev(`({
    display: document.querySelector('.win[data-app=files]').style.display,
    taskActive: document.querySelector('#tb-tasks .tbtn') ? document.querySelectorAll('#tb-tasks .tbtn.active').length : 0,
  })`);
  t('T10 最小化', minState.display === 'none', JSON.stringify(minState));
  await ev(`WebOS.wm.restoreWin('${filesWin}')`);
  await sleep(400);
  await ev(`WebOS.wm.toggleMax('${filesWin}')`);
  await sleep(400);
  const maxState = await ev(`({
    cls: document.querySelector('.win[data-app=files]').classList.contains('max'),
    w: document.querySelector('.win[data-app=files]').offsetWidth,
    area: document.getElementById('windows').clientWidth,
  })`);
  t('T10.1 最大化', maxState.cls && Math.abs(maxState.w - maxState.area) < 8, JSON.stringify(maxState));
  await c.shot('t10_1-maximized');
  await ev(`WebOS.wm.toggleMax('${filesWin}')`);
  await sleep(300);
  await ev(`WebOS.wm.close('${filesWin}')`);
  await sleep(400);
  const afterClose = await ev(`document.querySelectorAll('.win[data-app=files]').length`);
  t('T10.2 关闭窗口', afterClose === 0);

});

group('T13', '通知中心', async () => {
  /* ---- T13 通知中心 ---- */
  // 独立运行前置:先发一条系统通知(原流程依赖 T9 终端 notify 的残留)
  await ev(`WebOS.bus.publish('sys:notify', { from: 'e2e', type: 'notify', payload: { title: 'E2E 测试通知', body: 'independent-run' } })`);
  await sleep(300);
  await ev(`document.getElementById('tray-bell').click()`);
  await sleep(300);
  const noti = await ev(`({
    pop: !!document.querySelector('[data-pop="noti"]'),
    items: document.querySelectorAll('.noti-item').length,
  })`);
  t('T13 通知中心', noti.pop && noti.items >= 1, JSON.stringify(noti));
  await c.shot('t13-notifications');

});

group('T14', '持久化:刷新后数据仍在', async () => {
  /* ---- T14 持久化:刷新后数据仍在 ---- */
  // 独立运行:先落一份待持久化的状态(主题 + 文件改动),刷新后应原样保留
  const w14 = await ev(`(() => {
    const p = WebOS.fs.homePath()+'/documents/欢迎使用.txt';
    const ok = WebOS.fs.write(p, (WebOS.fs.read(p) || '') + '\\n[E2E 测试行]');
    WebOS.settings.set({ theme: 'dark' });
    return { ok, user: WebOS.accounts.current(), path: p, mem: (WebOS.fs.read(p) || '').slice(-16) };
  })()`);
  if (!w14.ok) console.log('   [T14 debug] write =', JSON.stringify(w14));
  await sleep(500);   // fs 落盘是 250ms 防抖;并行负载下链式写可能更久,
  await ev(`WebOS.fs.flush()`);   // 刷新前显式冲刷,别让导航拦腰打断落盘
  await fresh();
  const persisted = await ev(`({
    theme: JSON.parse(localStorage.getItem('webos.settings.v1')).theme,
    file: WebOS.fs.read(WebOS.fs.homePath()+'/documents/欢迎使用.txt').includes('[E2E 测试行]'),
    user: WebOS.accounts.current(),
    errs: window.__errs.length,
  })`);
  t('T14 刷新后持久化', persisted.theme === 'dark' && persisted.file && persisted.errs === 0, JSON.stringify(persisted));
  await c.shot('t14-after-reload');
});

group('T22', '多窗口模式:平铺/层叠/贴边/焦点', async () => {
  /* ---- T22 多窗口模式:平铺/层叠/贴边/焦点 ---- */
  await needApps('monitor');
  // 准备三个窗口(wm.open 是 async —— 顺序 await,保证 monitor 最后打开并持有焦点)
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  await ev(`(async () => { await WebOS.wm.open('files'); return true; })()`);
  await ev(`(async () => { await WebOS.wm.open('terminal'); return true; })()`);
  await ev(`(async () => { await WebOS.wm.open('monitor'); return true; })()`);
  await sleep(800);
  const pre = await ev(`({
    wins: document.querySelectorAll('.win').length,
    focused: document.querySelectorAll('.win.focused').length,
    layoutBtn: !!document.getElementById('tb-layout'),
  })`);
  t('T22 三窗口 + 唯一活动窗口', pre.wins === 3 && pre.focused === 1 && pre.layoutBtn,
    JSON.stringify(pre));

  // 网格平铺:覆盖桌面、互不重叠
  await ev(`WebOS.wm.tile()`);
  await sleep(500);
  const tiled = await ev(`(() => {
    const area = document.getElementById('windows').getBoundingClientRect();
    const rects = [...document.querySelectorAll('.win')].map(w => {
      const r = w.getBoundingClientRect();
      return { l: r.left - area.left, t: r.top - area.top, w: r.width, h: r.height };
    });
    const overlap = rects.some((a, i) => rects.some((b, j) => i < j &&
      a.l < b.l + b.w - 2 && b.l < a.l + a.w - 2 && a.t < b.t + b.h - 2 && b.t < a.t + a.h - 2));
    const covered = rects.reduce((s, r) => s + r.w * r.h, 0) / (area.width * area.height);
    return { n: rects.length, overlap, covered: +covered.toFixed(2), focused: document.querySelectorAll('.win.focused').length };
  })()`);
  t('T22.1 网格平铺(无重叠+高覆盖)', tiled.n === 3 && !tiled.overlap && tiled.covered > 0.9 && tiled.focused === 1,
    JSON.stringify(tiled));
  await c.shot('t22-tiled');

  // Alt+Q 切换活动窗口
  const beforeFocus = await ev(`document.querySelector('.win.focused').dataset.app`);
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', altKey: true, bubbles: true }))`);
  await sleep(250);
  const afterFocus = await ev(`document.querySelector('.win.focused').dataset.app`);
  t('T22.2 Alt+Q 切换活动窗口', beforeFocus !== afterFocus, `${beforeFocus} → ${afterFocus}`);

  // 焦点:非活动窗口任意一次点击既激活又穿透到内容(关闭按钮一下就关)
  // 激活态在 pointerdown 后立即读:click 会同步关窗,关窗即摘 .focused
  const targetApp = 'monitor';
  const oneClick = await ev(`(() => {
    const w = document.querySelector('.win[data-app=monitor]');
    const btn = w.querySelector('.wbtn.close');
    btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    const activated = w.classList.contains('focused');
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return {
      activated,
      bodies: [...document.querySelectorAll('.win .win-body')]
        .map(b => +getComputedStyle(b).opacity),
    };
  })()`);
  t('T22.3 一次点击既激活又穿透', oneClick.activated, JSON.stringify(oneClick));
  await sleep(400);
  const closedNow = await ev(`!document.querySelector('.win[data-app=monitor]')`);
  t('T22.4 一次点击即关闭窗口', closedNow === true, `target=${targetApp}`);
  const noDim = await ev(`(() => {
    const other = document.querySelector('.win[data-app=files]');
    return { opacity: getComputedStyle(other.querySelector('.win-body')).opacity };
  })()`);
  t('T22.5 非活动窗口不变暗', parseFloat(noDim.opacity) > 0.95, noDim.opacity);

  // 拖拽贴边分屏:把 files 窗口拖到左边缘 → 左半屏
  await ev(`(async () => {
    const w = document.querySelector('.win[data-app=files]');
    const head = w.querySelector('.win-head');
    const a = document.getElementById('windows').getBoundingClientRect();
    const hx = a.left + 200, hy = a.top + 20;
    head.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: hx, clientY: hy, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 30));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: hx - 120, clientY: hy + 60, bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: a.left + 2, clientY: a.top + 300, bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: a.left + 2, clientY: a.top + 300, bubbles: true }));
  })()`);
  await sleep(500);
  const snapped = await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    const a = document.getElementById('windows').getBoundingClientRect();
    const r = w.getBoundingClientRect();
    return { left: Math.round(r.left - a.left), width: Math.round(r.width), half: Math.round(a.width / 2) };
  })()`);
  t('T22.6 拖拽贴边分屏(左半屏)', snapped.left === 0 && Math.abs(snapped.width - snapped.half) < 10,
    JSON.stringify(snapped));

  // 层叠排列:窗口错位
  await ev(`WebOS.wm.cascade()`);
  await sleep(500);
  const casc = await ev(`[...document.querySelectorAll('.win')].map(w => w.offsetLeft)`);
  t('T22.7 层叠排列', new Set(casc).size === casc.length, JSON.stringify(casc));
  await c.shot('t22-cascade');

  const errs22 = await ev(`window.__errs.length`);
  t('T22.8 全程无错误', errs22 === 0, `errs=${errs22}`);

});

group('T65', '窗口焦点语义:桌面失焦/最小化失焦/关窗接棒/键盘焦点随激活', async () => {
  /* ---- T65 焦点语义:操作落在窗口外 → 失焦;键盘焦点不留在非激活窗口 ---- */
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  await ev(`(async () => { await WebOS.wm.open('files'); return true; })()`);
  await ev(`(async () => { await WebOS.wm.open('terminal'); return true; })()`);
  await sleep(900);   // 终端挂载后 80ms 自动 focus 输入框

  // 初始:terminal 后开即活动窗口,原生输入焦点在其输入框内
  const st0 = await ev(`(() => {
    const f = document.querySelector('.win.focused');
    const ae = document.activeElement;
    return {
      focusedApp: f?.dataset.app,
      activeId: WebOS.wm.activeId(),
      caretInFocused: !!(f && ae && f.contains(ae) && ae !== document.body),
    };
  })()`);
  t('T65.0 活动窗口持有原生输入焦点', st0.focusedApp === 'terminal' && !!st0.activeId && st0.caretInFocused, JSON.stringify(st0));

  // 点击桌面壁纸 → 无活动窗口:类清零 / activeId null / 任务栏无高亮 / 键盘焦点收回
  const afterDesk = await ev(`(() => {
    document.getElementById('wallpaper').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    const ae = document.activeElement;
    return {
      focused: document.querySelectorAll('.win.focused').length,
      activeId: WebOS.wm.activeId(),
      caretOutsideWins: !(ae && ae.closest('.win')),
      taskActive: document.querySelectorAll('#tb-tasks .tbtn.active').length,
    };
  })()`);
  t('T65.1 点击桌面 → 无活动窗口(任务栏高亮清除/键盘焦点收回)',
    afterDesk.focused === 0 && afterDesk.activeId === null && afterDesk.caretOutsideWins && afterDesk.taskActive === 0,
    JSON.stringify(afterDesk));

  // 点击桌面图标同样失焦
  const iconClick = await ev(`(() => {
    const icon = document.querySelector('.dicon');
    if (!icon) return { skipped: true, focused: 0 };
    icon.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    return { skipped: false, focused: document.querySelectorAll('.win.focused').length };
  })()`);
  t('T65.1b 点击桌面图标 → 失焦', iconClick.focused === 0, JSON.stringify(iconClick));

  // 点击窗口(捕获相 pointerdown)恢复激活
  const back = await ev(`(() => {
    const w = document.querySelector('.win[data-app=files]');
    w.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    return { app: document.querySelector('.win.focused')?.dataset.app, mine: WebOS.wm.activeId() === w.dataset.id };
  })()`);
  t('T65.2 点击窗口恢复激活', back.app === 'files' && back.mine, JSON.stringify(back));

  // 原生焦点 ↔ 激活耦合:程序式聚焦非激活窗口的输入框,该窗口随之激活
  // (e2e 的 Chrome 对 .focus() 不派发 focusin,须合成 —— 同 T27.3b 对 blur 的处理)
  const coup = await ev(`(() => {
    const inp = document.querySelector('.win[data-app=terminal] input');
    inp.focus();
    inp.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    return { focusedApp: document.querySelector('.win.focused')?.dataset.app, caret: document.activeElement === inp };
  })()`);
  t('T65.3 程序式聚焦非激活窗口输入框 → 窗口随之激活', coup.focusedApp === 'terminal' && coup.caret, JSON.stringify(coup));

  // Alt+Q 切走后,原窗口的输入框不再是 activeElement(键盘不漏给失焦窗口)
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', altKey: true, bubbles: true }))`);
  await sleep(250);
  const sw = await ev(`(() => {
    const term = document.querySelector('.win[data-app=terminal]');
    const ae = document.activeElement;
    return { now: document.querySelector('.win.focused')?.dataset.app, caretLeft: !(ae && term.contains(ae) && ae !== document.body) };
  })()`);
  t('T65.4 Alt+Q 切走后键盘焦点不留在原窗口', sw.now === 'files' && sw.caretLeft, JSON.stringify(sw));

  // 最小化活动窗口 → 失焦(不转移)
  const min = await ev(`(() => {
    const f = document.querySelector('.win.focused');
    WebOS.wm.minimize(f.dataset.id);
    return { focused: document.querySelectorAll('.win.focused').length, activeId: WebOS.wm.activeId() };
  })()`);
  t('T65.5 最小化活动窗口 → 失焦', min.focused === 0 && min.activeId === null, JSON.stringify(min));

  // 任务栏按钮:还原并激活(focus 对最小化窗口先还原再激活)
  await sleep(300);
  const rst = await ev(`(() => {
    const list = WebOS.wm.taskList();
    const i = list.findIndex(w => w.appId === 'files');
    document.querySelectorAll('#tb-tasks .tbtn')[i].click();
    const w = document.querySelector('.win[data-app=files]');
    return { focusedApp: document.querySelector('.win.focused')?.dataset.app, shown: w.style.display !== 'none', mine: WebOS.wm.activeId() === w.dataset.id };
  })()`);
  t('T65.6 任务栏按钮还原 → 还原并激活', rst.focusedApp === 'files' && rst.shown && rst.mine, JSON.stringify(rst));

  // 关闭活动窗口 → 焦点接棒给最近激活的剩余窗口
  const succ = await ev(`(() => {
    const files = document.querySelector('.win[data-app=files]');
    WebOS.wm.close(files.dataset.id);
    return { focusedApp: document.querySelector('.win.focused')?.dataset.app };
  })()`);
  t('T65.7 关闭活动窗口 → 焦点接棒给剩余窗口', succ.focusedApp === 'terminal', JSON.stringify(succ));

  // 关最后一个窗口 → 无活动窗口 + 广播 sys:win-blur
  const lastBlur = await ev(`(async () => {
    let blurEvt = null;
    const off = WebOS.bus.subscribe('sys:win-blur', (p) => { blurEvt = p; });
    const term = document.querySelector('.win[data-app=terminal]');
    WebOS.wm.close(term.dataset.id);
    await new Promise(r => setTimeout(r, 150));
    off();
    return { focused: document.querySelectorAll('.win.focused').length, activeId: WebOS.wm.activeId(), blurApp: blurEvt?.appId };
  })()`);
  t('T65.8 关最后一窗 → 无活动窗口并广播 sys:win-blur',
    lastBlur.focused === 0 && lastBlur.activeId === null && lastBlur.blurApp === 'terminal', JSON.stringify(lastBlur));

  // 显示桌面 → 无活动;再切 → 回到此前活动窗口
  await ev(`(async () => { await WebOS.wm.open('files'); await WebOS.wm.open('terminal'); return true; })()`);
  await sleep(900);
  const sd = await ev(`(async () => {
    WebOS.wm.toggleShowDesktop();
    await new Promise(r => setTimeout(r, 350));
    const afterHide = document.querySelectorAll('.win.focused').length;
    WebOS.wm.toggleShowDesktop();
    await new Promise(r => setTimeout(r, 350));
    return { afterHide, afterShow: document.querySelector('.win.focused')?.dataset.app };
  })()`);
  t('T65.9 显示桌面 → 无活动;还原 → 回到此前活动窗口', sd.afterHide === 0 && sd.afterShow === 'terminal', JSON.stringify(sd));

  const errs65 = await ev(`window.__errs.length`);
  t('T65.10 全程无错误', errs65 === 0, `errs=${errs65}`);

});

group('T23', '系统对话框(模态/遮罩/Promise API/进度)', async () => {
  /* ---- T23 系统对话框(模态/遮罩/Promise API/进度) ---- */
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  await ev(`WebOS.wm.open('files')`);
  await sleep(500);

  // 确认对话框:模态遮罩 + 仅关闭按钮 + 焦点独占
  const dlg1 = await ev(`(async () => {
    window.__dlg = null;
    WebOS.dialogs.confirm({ title: '删除确认', message: '确定删除这个文件吗?', danger: true, okText: '删除' })
      .then(r => { window.__dlg = r; });
    await new Promise(r => setTimeout(r, 600));
    return {
      wins: document.querySelectorAll('.win[data-app=sysdialog]').length,
      shade: !!document.querySelector('.modal-shade'),
      btns: document.querySelectorAll('.win[data-app=sysdialog] .wbtn').length,
      focused: document.querySelector('.win.focused')?.dataset.app,
      taskbar: document.querySelectorAll('#tb-tasks .tbtn').length,
    };
  })()`);
  t('T23 确认对话框(模态+遮罩)', dlg1.wins === 1 && dlg1.shade && dlg1.btns === 1 && dlg1.focused === 'sysdialog',
    JSON.stringify(dlg1));

  // 模态阻塞:点击底层 files 窗口按钮被遮罩拦截
  const shadeBlocked = await ev(`(() => {
    const btn = document.querySelector('.win[data-app=files] .btn.icon');
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!el?.classList?.contains('modal-shade');
  })()`);
  t('T23.1 模态遮罩阻塞底层窗口', shadeBlocked === true);

  // Alt+Q 模态期不切到普通窗口
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', altKey: true, bubbles: true }))`);
  await sleep(200);
  const altq = await ev(`document.querySelector('.win.focused')?.dataset.app`);
  t('T23.2 模态期 Alt+Q 不离开对话框', altq === 'sysdialog', altq);

  // 点「删除」→ Promise true,窗口关闭,遮罩消失
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].find(b => b.textContent === '删除').click()`);
  await sleep(450);
  const dlg1res = await ev(`({ r: window.__dlg, shade: !!document.querySelector('.modal-shade'), wins: document.querySelectorAll('.win[data-app=sysdialog]').length })`);
  t('T23.3 确认→true + 清理', dlg1res.r === true && !dlg1res.shade && dlg1res.wins === 0, JSON.stringify(dlg1res));

  // prompt:输入值 + Enter 提交
  await ev(`(async () => {
    window.__dlg = undefined;
    WebOS.dialogs.prompt({ title: '重命名', message: '输入新名称:', value: '旧名.txt' })
      .then(r => { window.__dlg = r; });
    await new Promise(r => setTimeout(r, 550));
    const inp = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    inp.value = '新名.txt';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(400);
  t('T23.4 输入框(Enter 提交值)', await ev(`window.__dlg`) === '新名.txt');

  // prompt 取消 → null;错误弹窗图标;进度对话框
  await ev(`(async () => {
    window.__dlg = undefined;
    WebOS.dialogs.prompt({ title: '测试取消' }).then(r => { window.__dlg = r; });
    await new Promise(r => setTimeout(r, 550));
    document.querySelector('.win[data-app=sysdialog] .wbtn.close').click();
  })()`);
  await sleep(400);
  t('T23.5 关闭按钮→null', await ev(`window.__dlg`) === null);

  const errDlg = await ev(`(async () => {
    WebOS.dialogs.error({ title: '致命错误', message: '系统组件异常', detail: 'E_DEMO (0xDEAD)' });
    await new Promise(r => setTimeout(r, 550));
    return {
      iconBg: getComputedStyle(document.querySelector('.win[data-app=sysdialog] .dlg-icon')).backgroundColor,
      detail: document.querySelector('.win[data-app=sysdialog] .dlg-detail')?.textContent,
    };
  })()`);
  t('T23.6 错误弹窗(红色图标+技术细节)', errDlg.iconBg === 'rgb(239, 68, 68)' && errDlg.detail.includes('E_DEMO'),
    JSON.stringify(errDlg));
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].pop().click()`);
  await sleep(400);

  // 进度对话框:set(50) → 50%;done → promise true
  const prog = await ev(`(async () => {
    window.__prog = null;
    const h = WebOS.dialogs.progress({ title: '系统自检', message: '开始…' });
    h.promise.then(r => { window.__prog = r; });
    await new Promise(r => setTimeout(r, 500));
    h.set(50, '检查模块 50%');
    await new Promise(r => setTimeout(r, 350));
    const w50 = document.querySelector('.win[data-app=sysdialog] .dlg-bar i').style.width;
    const pct = document.querySelector('.win[data-app=sysdialog] .dlg-pct').textContent;
    h.done('自检完成');
    return { w50, pct };
  })()`);
  await sleep(600);
  const progDone = await ev(`({ r: window.__prog, wins: document.querySelectorAll('.win[data-app=sysdialog]').length })`);
  t('T23.7 进度对话框(50%→完成)', prog.w50 === '50%' && prog.pct === '50%' && progDone.r === true && progDone.wins === 0,
    JSON.stringify({ ...prog, ...progDone }));

  // 终端 alert 命令联动(重开终端)
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  await termType('alert 引擎过热');
  await sleep(500);
  const termDlg = await ev(`document.querySelector('.win[data-app=sysdialog] .dlg-msg')?.textContent`);
  t('T23.8 终端 alert 命令', termDlg === '引擎过热', String(termDlg));
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].pop().click()`);
  await c.shot('t23-dialogs');

  const errs23 = await ev(`window.__errs.length`);
  t('T23.9 全程无错误', errs23 === 0, `errs=${errs23}`);

});

group('T24', '桌面操作系统化:文件图标/右键新建/框选/吸附/固定', async () => {
  /* ---- T24 桌面操作系统化:文件图标/右键新建/框选/吸附/固定 ---- */
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);

  // a. 桌面 = /home/desktop 内容:全部是快捷方式文件与文件夹,无自动生成的应用图标
  const dsk1 = await ev(`(() => {
    const icons = [...document.querySelectorAll('.dicon')];
    return {
      total: icons.length,
      apps: icons.filter(n => n.dataset.kind === 'app').length,
      files: icons.filter(n => n.dataset.kind === 'fs').length,
      links: icons.filter(n => n.dataset.key.endsWith('.app')).length,
      folders: icons.filter(n => n.dataset.dir === '1').length,
    };
  })()`);
  t('T24 桌面 = 快捷方式文件 + 文件夹(无自动图标)', dsk1.apps === 0 && dsk1.links >= 12 && await ev(`WebOS.fs.isDir(WebOS.fs.desktopPath())`), JSON.stringify(dsk1));

  // 双击打开应用后,图标不再保持选中态
  const iconSel = await ev(`(async () => {
    const icon = [...document.querySelectorAll('.dicon')].find(n => n.dataset.key.endsWith('/便签.app'));
    if (!icon) return { noIcon: true };
    icon.classList.add('selected');
    icon.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    return {
      opened: !!document.querySelector('.win[data-app=todo]'),
      selLeft: !!document.querySelector('.dicon.selected'),
    };
  })()`);
  await ev(`[...document.querySelectorAll('.win[data-app=todo]')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(300);
  t('T24.0 双击打开后图标不保持选中', iconSel.opened === true && !iconSel.selLeft, JSON.stringify(iconSel));

  // b. 桌面右键 → 新建文本文档(全 GUI:菜单 → 系统对话框输入)
  await ev(`document.getElementById('icons').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 300 }))`);
  await sleep(250);
  const menuHasNew = await ev(`[...document.querySelectorAll('#ctx .ctx-item')].some(i => i.textContent.includes('新建文本文档'))`);
  await ctxClick('新建文本文档');
  await sleep(400);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    inp.value = '测试便签.txt';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(600);
  const newFile = await ev(`({
    fs: WebOS.fs.read(WebOS.fs.desktopPath()+'/测试便签.txt') === '',
    icon: [...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/测试便签.txt'),
  })`);
  t('T24.1 右键新建文档(菜单→对话框→文件系统→图标)', menuHasNew && newFile.fs && newFile.icon, JSON.stringify(newFile));

  // c. 终端写桌面文件 → 图标实时出现(IPC 联动)
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  await termType('echo 来自终端 > ~/desktop/终端创建.txt');
  await sleep(600);
  const liveIcon = await ev(`[...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/终端创建.txt')`);
  t('T24.2 终端写桌面 → 图标实时刷新', liveIcon === true);

  // d. F2 重命名(选中 → 键盘 → 就地输入框);先让输入框失焦,模拟用户点击桌面后的状态
  await ev(`(() => {
    document.activeElement && document.activeElement.blur();
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/测试便签.txt');
    n.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
  })()`);
  await sleep(200);
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`);
  await sleep(350);
  await ev(`(() => {
    const inp = document.querySelector('body > .rename-input');
    inp.value = '改名后.txt';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(600);
  const renamed = await ev(`WebOS.fs.exists(WebOS.fs.desktopPath()+'/改名后.txt')`);
  t('T24.3 F2 重命名(就地输入框)', renamed === true);

  // e. Delete 删除(直接入回收站,免确认;可还原)
  await ev(`(() => {
    document.activeElement && document.activeElement.blur();
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/改名后.txt');
    n.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
  })()`);
  await sleep(200);
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  await sleep(600);
  const deleted = await ev(`(() => {
    const p = WebOS.fs.desktopPath()+'/改名后.txt';
    const inTrash = WebOS.trash.listTrash().some(i => i.orig === p);
    return !WebOS.fs.exists(p) && inTrash
      && ![...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:'+p);
  })()`);
  t('T24.4 Delete 删除(入回收站→文件系统→图标移除,原路径记录在案)', deleted === true);
  await ev(`WebOS.trash.emptyTrash()`);   // 还原现场:清掉本轮入筒条目

  // f. 橡皮筋框选
  await ev(`(async () => {
    const d = document.getElementById('desktop').getBoundingClientRect();
    const x1 = d.left + 8, y1 = d.top + 8, x2 = d.left + 260, y2 = d.top + 420;
    d  // target
    document.getElementById('wallpaper').dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: x1, clientY: y1, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x2, clientY: y2, bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x2, clientY: y2, bubbles: true }));
  })()`);
  await sleep(300);
  const band = await ev(`document.querySelectorAll('.dicon.selected').length`);
  t('T24.5 橡皮筋框选多图标', band >= 2, `selected=${band}`);

  // g. 拖动吸附网格
  await ev(`(async () => {
    const n = document.querySelector('.dicon');
    const r = n.getBoundingClientRect();
    const sx = r.left + 30, sy = r.top + 20;
    n.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: sx, clientY: sy, bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 30));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: sx + 137, clientY: sy + 91, bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 30));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: sx + 137, clientY: sy + 91, bubbles: true }));
  })()`);
  await sleep(300);
  const snappedIcon = await ev(`(() => {
    const n = document.querySelector('.dicon');
    return { l: n.offsetLeft, t: n.offsetTop,
      alignedX: (n.offsetLeft - 12) % 92 === 0, alignedY: (n.offsetTop - 10) % 104 === 0 };
  })()`);
  t('T24.6 图标拖动网格吸附', snappedIcon.alignedX && snappedIcon.alignedY, JSON.stringify(snappedIcon));

  // h. 开始菜单右键 → 固定计算器(持久化)
  await ev(`document.getElementById('start-btn').click()`);
  await sleep(350);
  await ev(`(() => {
    const item = [...document.querySelectorAll('.sm-item')].find(i => i.dataset.search.includes('calc'));
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
  })()`);
  await sleep(300);
  await ctxClick('固定到任务栏');
  await sleep(400);
  const pinned1 = await ev(`({
    pinned: WebOS.settings.get('pinnedApps').includes('calc'),
    btn: [...document.querySelectorAll('#tb-pinned .tbtn')].length,
  })`);
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  t('T24.7 开始菜单右键固定到任务栏', pinned1.pinned && pinned1.btn === 4, JSON.stringify(pinned1));

  // 持久化:刷新后仍固定,然后取消固定还原
  await fresh();
  const pinned2 = await ev(`({
    persisted: WebOS.settings.get('pinnedApps').includes('calc'),
    btns: [...document.querySelectorAll('#tb-pinned .tbtn')].length,
  })`);
  t('T24.8 固定持久化(刷新后仍在)', pinned2.persisted && pinned2.btns === 4, JSON.stringify(pinned2));
  // 还原:取消固定
  await ev(`(() => {
    WebOS.settings.set({ pinnedApps: ['files', 'notes', 'terminal'] });
    [...document.querySelectorAll('.dicon')].forEach(d => d.classList.remove('selected'));
    return true;
  })()`);
  await sleep(400);
  await c.shot('t24-desktop');
  const errs24 = await ev(`window.__errs.length`);
  t('T24.9 全程无错误', errs24 === 0, `errs=${errs24}`);

});

group('T25', '真实输入回归(浏览器输入管线:真实鼠标与键盘事件)', async () => {
  /* ---- T25 真实输入回归(浏览器输入管线:真实鼠标与键盘事件) ---- */
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  await ev(`(() => { document.querySelectorAll('.dicon.selected').forEach(d => d.classList.remove('selected')); return true; })()`);


  // 25.1 真实鼠标双击桌面快捷方式 → 打开应用(回归:窗口层曾挡住真实点击)
  const iconPt = await ev(`(() => {
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/记事本.app');
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await clickReal(iconPt.x, iconPt.y, 2);
  await sleep(600);
  const realClick = await ev(`({
    notes: !!document.querySelector('.win[data-app=notes]'),
    selected: document.querySelectorAll('.dicon.selected').length,
  })`);
  // 打开后不保持选中(新语义)
  t('T25 真实鼠标双击桌面图标(打开且不残留选中)', realClick.notes === true && realClick.selected === 0, JSON.stringify(realClick));

  // 25.2 真实键盘:记事本打字
  await ev(`(() => { document.querySelector('.win[data-app=notes] .notes-area').focus(); return true; })()`);
  await typeReal('hello webos');
  await sleep(300);
  const noteTyped = await ev(`document.querySelector('.win[data-app=notes] .notes-area').value`);
  t('T25.1 真实键盘→记事本', noteTyped === 'hello webos', JSON.stringify(noteTyped));
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=notes]').dataset.id)`);
  await sleep(400);

  // 25.3 真实键盘:终端执行命令
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(600);
  await ev(`(() => { document.querySelector('.win[data-app=terminal] .term-in input').focus(); return true; })()`);
  await typeReal('echo real-kb');
  await pressEnter();
  await sleep(400);
  const termReal = await ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent.includes('real-kb')`);
  t('T25.2 真实键盘→终端', termReal === true);
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=terminal]').dataset.id)`);
  await sleep(400);

  // 25.4 真实键盘:浏览器地址栏(含 '.' 字符)
  await ev(`WebOS.wm.open('browser')`);
  await sleep(700);
  await ev(`(() => { document.querySelector('.win[data-app=browser] .vw-addr').focus(); return true; })()`);
  await typeReal('portal.nexus');
  await pressEnter();
  await sleep(1600);
  const browserReal = await ev(`(() => ({
    addr: document.querySelector('.win[data-app=browser] .vw-addr').value,
    page: document.querySelector('.win[data-app=browser] .vw-page')?.textContent.includes('NEXUS 集团内网门户'),
  }))()`);
  t('T25.3 真实键盘→浏览器(域名含 .)', browserReal.addr === 'portal.nexus' && browserReal.page,
    JSON.stringify(browserReal));
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=browser]').dataset.id)`);
  await sleep(400);

  // 25.5 右键菜单 → 真实点击菜单项 → 真实键盘输入文件名(headless CDP 不派发
  // contextmenu,故菜单用事件打开;后续全部走真实输入管线)
  await ev(`document.getElementById('icons').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 300 }))`);
  await sleep(300);
  const menuItem = await ev(`(() => {
    const item = [...document.querySelectorAll('#ctx .ctx-item')].find(i => i.textContent.includes('新建文本文档'));
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (menuItem) {
    await clickReal(menuItem.x, menuItem.y);      // 真实点击菜单项
    await sleep(500);
    await ev(`(() => { document.querySelector('.win[data-app=sysdialog] .dlg-input').focus(); return true; })()`);
    // 全选后真实键盘输入新名(修饰键组合不产生字符,不能带 char text)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await typeReal('真实新建.txt');
    await pressEnter();
    await sleep(600);
  }
  const realMenu = await ev(`(() => ({
    created: WebOS.fs.exists(WebOS.fs.desktopPath()+'/真实新建.txt'),
    icon: [...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/真实新建.txt'),
  }))()`);
  t('T25.4 右键菜单+真实点击+真实键盘新建文件', realMenu.created && realMenu.icon, JSON.stringify(realMenu));
  // 清理
  await ev(`WebOS.fs.rm(WebOS.fs.desktopPath()+'/真实新建.txt')`);
  await sleep(300);

  const errs25 = await ev(`window.__errs.length`);
  t('T25.5 全程无错误', errs25 === 0, `errs=${errs25}`);

});

group('T40', '系统用户与注销', async () => {
  /* ---- T40 系统用户:创建/列表/注销锁屏/锁屏登录/删除 ---- */
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);
  // 干净的账号状态(含锁屏标志)
  await ev(`(() => { localStorage.removeItem('webos.accounts.v1'); localStorage.removeItem('webos.account-session.v1'); localStorage.removeItem('webos.session-locked.v1'); return true; })()`);
  await fresh();   // 重载后以全新账号状态启动

  // 创建用户(admin 为管理员,创建 carol 不切换会话)
  const created = await ev(`(async () => {
    const r1 = await WebOS.accounts.createUser('admin', 'admin1234', { displayName: '管理员' });
    const r2 = await WebOS.accounts.createUser('carol', 'carol1234');
    const dup = await WebOS.accounts.createUser('carol', 'x2345');
    return { r1: r1.ok, r2: r2.ok, dupRejected: dup.ok === false, names: WebOS.accounts.list().map(u => u.name) };
  })()`);
  t('T40 创建用户(重名被拒)', created.r1 && created.r2 && created.dupRejected &&
    created.names.includes('admin') && created.names.includes('carol'), JSON.stringify(created));

  // 登录 admin → 开始菜单显示显示名
  await ev(`(async () => { await WebOS.accounts.login('admin', 'admin1234'); return true; })()`);
  await sleep(400);
  const chip = await ev(`({ text: document.getElementById('sm-username').textContent, title: document.getElementById('sm-user').title })`);
  t('T40.1 开始菜单显示登录用户', chip.text === '管理员' && chip.title.includes('admin'), JSON.stringify(chip));

  // 电源菜单 → 注销:全部窗口关闭 + 锁屏出现
  await ev(`WebOS.wm.open('todo')`);
  await sleep(800);
  await ev(`document.getElementById('start-btn').click()`);
  await sleep(400);
  await ev(`document.getElementById('sm-power').click()`);
  await sleep(400);
  await ev(`(() => { const it = [...document.querySelectorAll('#ctx .ctx-item')].find(i => i.textContent.includes('注销')); it && it.click(); return !!it; })()`);
  await sleep(800);
  const locked = await ev(`(() => ({
    overlay: !!document.getElementById('session'),
    wins: document.querySelectorAll('.win').length,
    users: [...document.querySelectorAll('.ss-user .ss-uname')].map(n => n.textContent),
    chipTitle: document.getElementById('sm-user').title,
  }))()`);
  t('T40.2 注销后锁屏(窗口清空,列出用户)', locked.overlay && locked.wins === 0 &&
    locked.users.includes('管理员') && locked.users.includes('carol') && locked.chipTitle.includes('未登录'), JSON.stringify(locked));
  await c.shot('t40-locked');

  // 锁屏登录:选 carol → 密码 → 进入桌面
  await ev(`(() => {
    const tile = [...document.querySelectorAll('.ss-user')].find(n => n.textContent.includes('carol'));
    tile && tile.click();
    const inp = document.querySelector('#session .ss-form input[type=password]');
    inp.value = 'carol1234';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  const loginC = await ev(`(() => ({
    overlay: !!document.getElementById('session'),
    user: WebOS.accounts.current(),
    chip: document.getElementById('sm-username').textContent,
  }))()`);
  t('T40.3 锁屏登录进入桌面', !loginC.overlay && loginC.user === 'carol' && loginC.chip === 'carol', JSON.stringify(loginC));

  // 错误密码在锁屏被拒
  await ev(`document.getElementById('start-btn').click()`);
  await sleep(300);
  await ev(`document.getElementById('sm-power').click()`);
  await sleep(300);
  await ev(`(() => { const it = [...document.querySelectorAll('#ctx .ctx-item')].find(i => i.textContent.includes('注销')); it && it.click(); })()`);
  await sleep(600);
  await ev(`(() => {
    const inp = document.querySelector('#session .ss-form input[type=password]');
    inp.value = 'wrong-pass';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  const wrongPw = await ev(`(() => ({
    stillLocked: !!document.getElementById('session'),
    err: (document.querySelector('#session .ss-error') || {}).textContent || '',
    user: WebOS.accounts.current(),
  }))()`);
  t('T40.4 错误密码被拒(保持锁屏)', wrongPw.stillLocked && wrongPw.err.includes('密码错误') && wrongPw.user === null, JSON.stringify(wrongPw));

  // 锁屏注册新用户(直接创建并登录)
  await ev(`(() => {
    const sw = [...document.querySelectorAll('#session .ss-switch')].find(b => b.textContent.includes('注册新用户'));
    sw && sw.click();
    return true;
  })()`);
  await sleep(300);
  await ev(`(() => {
    const box = document.querySelector('#session .ss-box');
    const [u, p] = box.querySelectorAll('.ss-form .input');
    u.value = 'dave'; p.value = 'dave1234';
    const btn = box.querySelector('.ss-main');
    btn.click();
    return true;
  })()`);
  await sleep(900);
  const regC = await ev(`(() => ({
    overlay: !!document.getElementById('session'),
    user: WebOS.accounts.current(),
    count: WebOS.accounts.list().length,
    names: WebOS.accounts.list().map(u => u.name),
  }))()`);
  // count 含 e2e 引导账号等,核心断言:dave 已注册并登录
  t('T40.5 锁屏注册新用户并登录', !regC.overlay && regC.user === 'dave' && regC.count >= 3 && regC.names.includes('dave'), JSON.stringify(regC));

  // 删除用户:密码错误被拒;正确密码删除;删除当前用户触发注销锁屏
  const del = await ev(`(async () => {
    const bad = await WebOS.accounts.remove('admin', 'nope');
    const ok = await WebOS.accounts.remove('admin', 'admin1234');
    return { badRejected: bad.ok === false && bad.error === '密码错误', ok: ok.ok, names: WebOS.accounts.list().map(u => u.name) };
  })()`);
  t('T40.6 删除用户(密码校验)', del.badRejected && del.ok && !del.names.includes('admin'), JSON.stringify(del));
  await ev(`(async () => { await WebOS.accounts.remove('dave', 'dave1234'); return true; })()`);
  await sleep(600);
  const lockAfterDel = await ev(`(() => ({ overlay: !!document.getElementById('session'), user: WebOS.accounts.current() }))()`);
  t('T40.7 删除当前用户自动注销锁屏', lockAfterDel.overlay && lockAfterDel.user === null, JSON.stringify(lockAfterDel));

  const errs40 = await ev(`window.__errs.length`);
  t('T40.8 全程无错误', errs40 === 0, `errs=${errs40}`);
});

group('T41', '应用内右键', async () => {
  /* ---- T41 应用内右键:拦截浏览器菜单 / 选中复制 / 全选 / 应用自定义菜单 ---- */
  await needApps('memo');
  // CDP 授权剪贴板,让「复制」可用真实系统剪贴板验证;headless 页面须置于前台才有文档焦点
  await c.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await c.send('Page.bringToFront');
  await ev(`(async () => { try { await navigator.clipboard.writeText(''); } catch {} return true; })()`);
  await sleep(150);

  // 41.1 记事本:选中文字 → 右键被拦截(不弹浏览器菜单)且出现「复制」
  await ev(`WebOS.wm.open('notes')`);
  await sleep(600);
  const ctx1 = await ev(`(() => {
    const ta = document.querySelector('.win[data-app=notes] .notes-area');
    ta.value = '右键复制这段文字';
    ta.focus();
    ta.setSelectionRange(2, 4);   // 选中「复制」二字
    const notPrevented = ta.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    return {
      notPrevented,
      items: [...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim()),
    };
  })()`);
  t('T41 应用内右键拦截+复制项', ctx1.notPrevented === false && ctx1.items.includes('复制'),
    JSON.stringify(ctx1));
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('复制')).click()`);
  await sleep(300);
  const clip1 = await ev(`navigator.clipboard.readText()`);
  t('T41.1 复制写入系统剪贴板', clip1 === '复制', JSON.stringify(clip1));

  // 41.2 无选中 → 表单控件出现「全选」并生效
  const ctx2 = await ev(`(() => {
    const ta = document.querySelector('.win[data-app=notes] .notes-area');
    ta.setSelectionRange(0, 0);
    ta.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    return [...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim());
  })()`);
  t('T41.2 无选中表单控件 → 全选项', ctx2.includes('全选'), JSON.stringify(ctx2));
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('全选')).click()`);
  await sleep(200);
  const selAll = await ev(`(() => {
    const ta = document.querySelector('.win[data-app=notes] .notes-area');
    return ta.selectionStart === 0 && ta.selectionEnd === ta.value.length;
  })()`);
  t('T41.3 全选生效', selAll === true);

  // 41.4 任务应用:任务行自定义右键(按完成态显示「标记完成/标记为待办」/ 删除任务)
  // 任务数据按用户持久化:历史轮次的「删除任务」会耗尽种子任务,
  // 先清该用户的任务存储再打开(应用检测不到存储即重新播种),并用轮询等行渲染
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (!(await accounts.login('todoer', 'todopass')).ok) await accounts.register('todoer', 'todopass');
    return true;
  })()`);
  await needApps('memo');   // 安装按用户:登录切换到 todoer 后补装,41.6 才打得开
  await wipeAppData('todoer', 'todo');
  await ev(`WebOS.wm.open('todo')`);
  await waitFor(`!!document.querySelector('.todo-item')`);
  const ctx3 = await ev(`(() => {
    const row = [...document.querySelectorAll('.todo-item')][0];
    if (!row) return { noRow: true };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 400 }));
    return {
      items: [...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim()),
      count: document.querySelectorAll('.todo-item').length,
    };
  })()`);
  t('T41.4 任务行自定义右键',
    (ctx3.items || []).some(i => i === '标记完成' || i === '标记为待办') && (ctx3.items || []).includes('删除任务'),
    JSON.stringify(ctx3));
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('删除任务')).click()`);
  await sleep(400);
  const afterDel = await ev(`document.querySelectorAll('.todo-item').length`);
  t('T41.5 右键删除任务', afterDel === ctx3.count - 1, `${ctx3.count} → ${afterDel}`);

  // 41.6 笔记卡片自定义右键
  await ev(`WebOS.wm.open('memo')`);
  await sleep(700);
  const ctx4 = await ev(`(() => {
    const card = document.querySelector('.memo-card');
    if (!card) return { noCard: true };
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    return [...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim());
  })()`);
  t('T41.6 笔记卡片右键', (Array.isArray(ctx4) ? ctx4 : []).some(i => i === '置顶' || i === '取消置顶') && (Array.isArray(ctx4) ? ctx4 : []).includes('删除笔记'),
    JSON.stringify(ctx4));

  // 41.7 浏览器:地址栏右键 → 刷新 + 复制页面地址(先写入地址,初始值为空)
  await ev(`WebOS.wm.open('browser')`);
  await sleep(800);
  const ctx5 = await ev(`(() => {
    const a = document.querySelector('.win[data-app=browser] .vw-addr');
    a.value = 'portal.nexus';
    a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 200 }));
    return [...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim());
  })()`);
  t('T41.7 浏览器地址栏右键', (ctx5 || []).includes('刷新') && (ctx5 || []).includes('复制页面地址'),
    JSON.stringify(ctx5));
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('复制页面地址')).click()`);
  await sleep(300);
  const clip2 = await ev(`navigator.clipboard.readText()`);
  const addrVal = await ev(`document.querySelector('.win[data-app=browser] .vw-addr').value`);
  t('T41.8 复制页面地址', clip2 === addrVal && !!clip2, JSON.stringify({ clip: clip2, addr: addrVal }));

  // 41.9 文件管家自有的文件右键不受系统默认菜单影响(回归)
  await ev(`WebOS.wm.open('files')`);
  await sleep(600);
  const ctx6 = await ev(`(() => {
    const item = [...document.querySelectorAll('.fitem')][0];
    if (!item) return { noItem: true };
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    return [...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim());
  })()`);
  t('T41.9 文件管家自有右键不受影响', (ctx6 || []).includes('打开'), JSON.stringify(ctx6));

  const errs41 = await ev(`window.__errs.length`);
  t('T41.10 全程无错误', errs41 === 0, `errs=${errs41}`);
});

group('T42', '弹框分级', async () => {
  /* ---- T42 弹框分级:一级非模态 / 二级应用模态 / 三级系统模态 ---- */
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);

  // 准备:settings(被锁对象)与 calc(对照)两个窗口
  await ev(`WebOS.wm.open('settings')`);
  await sleep(700);
  await ev(`WebOS.wm.open('calc')`);
  await sleep(700);

  const closeAllDialogs = `(() => {
    for (const w of [...document.querySelectorAll('.win[data-app=sysdialog]')]) WebOS.wm.close(w.dataset.id);
    return true;
  })()`;

  // ---- 42.1 一级:非模态 —— 不锁定任何界面 ----
  const l1 = await ev(`(async () => {
    WebOS.dialogs.confirm({ level: 1, title: '一级测试', message: '非模态' });
    await new Promise(r => setTimeout(r, 600));
    const settingsWin = document.querySelector('.win[data-app=settings]');
    WebOS.wm.focus(settingsWin.dataset.id);
    return {
      dialogOpen: !!document.querySelector('.win[data-app=sysdialog]'),
      noSysShade: !document.querySelector('.modal-shade'),
      noAppShade: !document.querySelector('.app-shade'),
      otherFocusable: settingsWin.classList.contains('focused'),
    };
  })()`);
  t('T42.1 一级弹框不影响任何操作', l1.dialogOpen && l1.noSysShade && l1.noAppShade && l1.otherFocusable,
    JSON.stringify(l1));
  await ev(closeAllDialogs);
  await sleep(300);

  // ---- 42.2 二级:应用模态 —— 锁 settings 全部窗口,calc 照常 ----
  const l2 = await ev(`(async () => {
    WebOS.dialogs.confirm({ level: 2, owner: 'settings', title: '二级测试', message: '锁定 settings' });
    await new Promise(r => setTimeout(r, 600));
    const settingsWin = document.querySelector('.win[data-app=settings]');
    const calcWin = document.querySelector('.win[data-app=calc]');
    const dlg = [...document.querySelectorAll('.win[data-app=sysdialog]')].pop();
    WebOS.wm.focus(settingsWin.dataset.id);
    const settingsFocusRefused = !settingsWin.classList.contains('focused');
    WebOS.wm.focus(calcWin.dataset.id);
    const calcFocused = calcWin.classList.contains('focused');
    WebOS.wm.focus(dlg.dataset.id);
    return {
      shadeOnSettings: !!settingsWin.querySelector('.app-shade'),
      settingsFocusRefused,
      noShadeOnCalc: !calcWin.querySelector('.app-shade'),
      calcFocusable: calcFocused,
      dialogFocusable: dlg.classList.contains('focused'),
    };
  })()`);
  t('T42.2 二级锁定本应用窗口,其他应用照常',
    l2.shadeOnSettings && l2.settingsFocusRefused && l2.noShadeOnCalc && l2.calcFocusable && l2.dialogFocusable,
    JSON.stringify(l2));

  // 关闭二级弹框 → 遮罩消失,settings 恢复可聚焦
  const l2close = await ev(`(async () => {
    for (const w of [...document.querySelectorAll('.win[data-app=sysdialog]')]) WebOS.wm.close(w.dataset.id);
    await new Promise(r => setTimeout(r, 400));
    const settingsWin = document.querySelector('.win[data-app=settings]');
    WebOS.wm.focus(settingsWin.dataset.id);
    return {
      shadeGone: !document.querySelector('.app-shade'),
      settingsFocusable: settingsWin.classList.contains('focused'),
    };
  })()`);
  t('T42.3 关闭二级弹框后解锁', l2close.shadeGone && l2close.settingsFocusable, JSON.stringify(l2close));

  // ---- 42.4 三级:系统模态 —— 全屏遮罩,任何窗口不可聚焦 ----
  const l3 = await ev(`(async () => {
    WebOS.dialogs.confirm({ level: 3, title: '三级测试', message: '系统模态' });
    await new Promise(r => setTimeout(r, 600));
    const calcWin = document.querySelector('.win[data-app=calc]');
    const settingsWin = document.querySelector('.win[data-app=settings]');
    WebOS.wm.focus(calcWin.dataset.id);
    WebOS.wm.focus(settingsWin.dataset.id);
    return {
      sysShade: !!document.querySelector('.modal-shade'),
      noAppShade: !document.querySelector('.app-shade'),
      nothingFocused: !document.querySelector('.win.focused:not([data-app=sysdialog])'),
    };
  })()`);
  t('T42.4 三级锁定整个系统', l3.sysShade && l3.noAppShade && l3.nothingFocused, JSON.stringify(l3));

  // 关闭三级弹框 → 系统恢复
  const l3close = await ev(`(async () => {
    for (const w of [...document.querySelectorAll('.win[data-app=sysdialog]')]) WebOS.wm.close(w.dataset.id);
    await new Promise(r => setTimeout(r, 400));
    const calcWin = document.querySelector('.win[data-app=calc]');
    WebOS.wm.focus(calcWin.dataset.id);
    return {
      shadeGone: !document.querySelector('.modal-shade'),
      calcFocusable: calcWin.classList.contains('focused'),
    };
  })()`);
  t('T42.5 关闭三级弹框后系统恢复', l3close.shadeGone && l3close.calcFocusable, JSON.stringify(l3close));

  // ---- 42.6 通用弹窗:复杂配置页(二级 · 可缩放 · Promise 带回结果) ----
  const cfg = await ev(`(async () => {
    let result = 'pending';
    const h = WebOS.wm.popup({
      title: '配置弹窗测试', width: 640, height: 480, resizable: true,
      level: 2, owner: 'settings',
      mount({ root, close }) {
        const save = document.createElement('button');
        save.textContent = '保存'; save.className = 'btn cfg-save';
        save.onclick = () => close({ quality: 'ultra' });
        const box = document.createElement('div');
        box.className = 'cfg-test';
        box.append(save);
        root.append(box);
      },
    });
    h.promise.then(v => { result = v; });
    await new Promise(r => setTimeout(r, 600));
    const win = WebOS.wm.get(h.id)?.el;
    const st = {
      opened: !!win,
      width: win ? win.offsetWidth : 0,
      resizable: !!win?.querySelector('.rz'),
      shadeOnSettings: !!document.querySelector('.win[data-app=settings] .app-shade'),
    };
    win.querySelector('.cfg-save').click();
    await new Promise(r => setTimeout(r, 400));
    st.closed = !document.getElementById(h.id);
    st.result = result;
    return st;
  })()`);
  t('T42.6 配置弹窗:任意内容+缩放+结果回传',
    cfg.opened && cfg.width === 640 && cfg.resizable && cfg.shadeOnSettings && cfg.closed &&
    cfg.result && cfg.result.quality === 'ultra', JSON.stringify(cfg));

  // ---- 42.7 通用弹窗:游戏渲染(三级锁系统 + canvas + 关闭恢复) ----
  const game = await ev(`(async () => {
    const h = WebOS.wm.popup({
      title: '游戏弹窗测试', width: 460, height: 420, level: 3,
      mount({ root }) {
        const cv = document.createElement('canvas');
        cv.className = 'game-cv';
        root.append(cv);
      },
    });
    await new Promise(r => setTimeout(r, 600));
    const win = WebOS.wm.get(h.id)?.el;
    const calcWin = document.querySelector('.win[data-app=calc]');
    WebOS.wm.focus(calcWin.dataset.id);
    const st = {
      canvas: !!win?.querySelector('canvas.game-cv'),
      sysShade: !!document.querySelector('.modal-shade'),
      calcRefused: !calcWin.classList.contains('focused'),
    };
    h.close('done');
    await new Promise(r => setTimeout(r, 400));
    let v = 'unset';
    h.promise.then(x => { v = x; });
    await new Promise(r => setTimeout(r, 50));
    st.shadeGone = !document.querySelector('.modal-shade');
    st.promiseValue = v;
    return st;
  })()`);
  t('T42.7 游戏弹窗:三级锁定+canvas+关闭恢复',
    game.canvas && game.sysShade && game.calcRefused && game.shadeGone && game.promiseValue === 'done',
    JSON.stringify(game));

  const errs42 = await ev(`window.__errs.length`);
  t('T42.8 全程无错误', errs42 === 0, `errs=${errs42}`);
});

group('T45', '三级弹窗锁定任务栏', async () => {
  /* ---- T45 三级(系统模态)弹框期间,任务栏一并锁定 ----
   * 遮罩挂在窗口层盖不到任务栏,锁定由 sys:modal 事件驱动:
   * taskbar 加 sys-locked + inert,startmenu 收起。 */
  await fresh();
  await ev(`WebOS.wm.open('calc')`);   // 对照窗口:解锁后系统应恢复
  await sleep(500);

  // 预置:先打开开始菜单,弹框一出应立即收起
  await ev(`document.getElementById('start-btn').click()`);
  await sleep(300);
  const smBefore = await ev(`document.getElementById('start-menu').classList.contains('open')`);
  t('T45.0 预置:开始菜单已打开', smBefore === true, `open=${smBefore}`);

  // confirm() 返回的 Promise 在弹框关闭前不兑现,而 evaluate 是 awaitPromise:true,
  // 所以必须包在 async IIFE 里发出去,不能裸 evaluate 这个 Promise
  await ev(`(async () => { WebOS.dialogs.confirm({ level: 3, title: '锁定任务栏测试', message: '系统模态' }); })()`);
  await waitFor(`!!document.querySelector('.modal-shade')`);
  const locked = await ev(`(() => {
    const tb = document.getElementById('taskbar');
    const r = document.getElementById('start-btn').getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      cls: tb.classList.contains('sys-locked'),
      inert: tb.hasAttribute('inert') || tb.inert === true,
      smClosed: !document.getElementById('start-menu').classList.contains('open'),
      hitMissesTaskbar: !tb.contains(hit),
    };
  })()`);
  t('T45.1 三级期间任务栏锁定(类 + inert + 菜单收起 + 点击打不进任务栏)',
    locked.cls && locked.inert && locked.smClosed && locked.hitMissesTaskbar, JSON.stringify(locked));

  // 真实鼠标点击开始按钮:inert 命中测试挡下,菜单不应打开
  const sb = await ev(`(() => {
    const r = document.getElementById('start-btn').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await clickReal(sb.x, sb.y);
  await sleep(300);
  const smStill = await ev(`!document.getElementById('start-menu').classList.contains('open')`);
  t('T45.2 三级期间真实点击任务栏无响应', smStill === true);

  // 关闭弹框 → 任务栏解锁,开始菜单恢复可用,窗口恢复可聚焦
  await ev(`(() => {
    for (const w of [...document.querySelectorAll('.win[data-app=sysdialog]')]) WebOS.wm.close(w.dataset.id);
    return true;
  })()`);
  await waitFor(`!document.querySelector('.modal-shade')`);
  const unlocked = await ev(`(async () => {
    document.getElementById('start-btn').click();
    await new Promise(r => setTimeout(r, 250));
    const tb = document.getElementById('taskbar');
    const calcWin = document.querySelector('.win[data-app=calc]');
    WebOS.wm.focus(calcWin.dataset.id);
    return {
      cls: !tb.classList.contains('sys-locked'),
      inert: !tb.hasAttribute('inert') && tb.inert !== true,
      smOpens: document.getElementById('start-menu').classList.contains('open'),
      calcFocusable: calcWin.classList.contains('focused'),
    };
  })()`);
  t('T45.3 关闭三级后任务栏解锁、菜单可用、窗口可聚焦',
    unlocked.cls && unlocked.inert && unlocked.smOpens && unlocked.calcFocusable, JSON.stringify(unlocked));
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);

  const errs = await ev(`window.__errs.length`);
  t('T45.4 全程无错误', errs === 0, `errs=${errs}`);
});

group('T46', '应用内弹框为二级(五子棋终局)', async () => {
  /* ---- T46 五子棋终局弹框走 ctx.dialogs(二级 · 应用模态):
   * 不再全屏遮罩锁系统,只锁五子棋自己的窗口,任务栏与其他应用照常 ---- */
  await needApps('gomoku');
  await fresh();
  await ev(`WebOS.wm.open('calc')`);   // 对照:二级不锁其他应用
  await sleep(400);
  await ev(`WebOS.wm.open('gomoku')`);
  await sleep(700);

  // 切双人模式 + 新对局,按谱连成五连(黑 112/111/110/109/108 横五连)
  await ev(`(() => {
    const btns = [...document.querySelectorAll('.win[data-app=gomoku] .app-toolbar .btn')];
    btns.find(b => b.textContent === '人机').click();
    btns.find(b => b.textContent.includes('新对局')).click();
    return true;
  })()`);
  await sleep(350);
  for (const i of [112, 0, 111, 1, 110, 2, 109, 3, 108]) {
    await ev(`document.querySelector('.win[data-app=gomoku] .gk-pt[data-i="${i}"]').click()`);
    await sleep(120);
  }

  const st = await waitFor(`(() => {
    const dlg = [...document.querySelectorAll('.win[data-app=sysdialog]')].pop();
    if (!dlg) return null;
    const gk = document.querySelector('.win[data-app=gomoku]');
    const tb = document.getElementById('taskbar');
    return {
      title: dlg.querySelector('.dlg-title')?.textContent,
      noSysShade: !document.querySelector('.modal-shade'),
      shadeOnGomoku: !!gk.querySelector('.app-shade'),
      taskbarFree: !tb.classList.contains('sys-locked') && !tb.hasAttribute('inert'),
    };
  })()`);
  t('T46 终局弹框为二级:遮罩只盖五子棋,系统与任务栏照常',
    st && st.title === '终局' && st.noSysShade && st.shadeOnGomoku && st.taskbarFree, JSON.stringify(st));

  const focusable = await ev(`(() => {
    const calc = document.querySelector('.win[data-app=calc]');
    WebOS.wm.focus(calc.dataset.id);
    return calc.classList.contains('focused');
  })()`);
  t('T46.1 二级不锁其他应用(calc 可聚焦)', focusable === true);

  // 关闭弹框 → 五子棋解锁
  await ev(`(() => {
    for (const w of [...document.querySelectorAll('.win[data-app=sysdialog]')]) WebOS.wm.close(w.dataset.id);
    return true;
  })()`);
  const released = await waitFor(`(() => {
    const gk = document.querySelector('.win[data-app=gomoku]');
    if (!gk) return null;
    WebOS.wm.focus(gk.dataset.id);
    return !gk.querySelector('.app-shade') && gk.classList.contains('focused');
  })()`);
  t('T46.2 关闭弹框后五子棋解锁', released === true);

  const errs = await ev(`window.__errs.length`);
  t('T46.3 全程无错误', errs === 0, `errs=${errs}`);
  await c.shot('t46-gomoku-endgame');
});

group('T62', '任务栏收缩与同时任务上限(按钮收窄 / 藏头留尾 / 60 上限)', async () => {
  /* ---- T62 任务栏:任务多时按钮按任务区可用宽收窄(下限 48px),最小宽也
   * 放不下则藏前面的留后面的(溢出钮弹出被藏清单可取回);同时任务上限 60
   * (对话框豁免不拦,上限期系统提示仍可弹出)。popup 窗口与普通窗口一样
   * 进任务栏,这里用它低成本造大量任务(level:1 非模态)。 ---- */
  await fresh();
  const openJobs = (from, to) => ev(`(async () => {
    for (let i = ${from}; i < ${to}; i++) {
      WebOS.wm.popup({ title: 'job' + String(i).padStart(2, '0'), level: 1, width: 320, height: 200 });
      await new Promise(r => setTimeout(r, 30));
    }
    return true;
  })()`);
  await openJobs(0, 1);
  await sleep(250);
  const one = await ev(`(() => {
    const b = document.querySelector('#tb-tasks .tbtn');
    return { n: document.querySelectorAll('#tb-tasks .tbtn').length, w: b?.offsetWidth };
  })()`);
  t('T62 单任务:按钮保持默认宽 140px', one.n === 1 && one.w === 140, JSON.stringify(one));

  // 8 个任务:140×8 超出任务区 → 按钮均匀收窄(等宽、不小于 48、容器不溢出)
  await openJobs(1, 8);
  await sleep(250);
  const shrunk = await ev(`(() => {
    const box = document.getElementById('tb-tasks');
    const ws = [...box.querySelectorAll('.tbtn')].map(b => b.offsetWidth);
    return { n: ws.length, min: Math.min(...ws), max: Math.max(...ws),
      fits: box.scrollWidth <= box.clientWidth + 1 };
  })()`);
  t('T62.1 任务变多按钮收窄(等宽 / ≥48 / <140 / 不溢出容器)',
    shrunk.n === 8 && shrunk.max < 140 && shrunk.min >= 48 && shrunk.max - shrunk.min <= 1 && shrunk.fits,
    JSON.stringify(shrunk));
  await c.shot('t62-shrink');

  // 25 个:最小宽也放不下 → 藏头留尾(最早的 job00 收起,最新的 job24 仍在栏)
  await openJobs(8, 25);
  await sleep(250);
  const ovf = await ev(`(() => {
    const box = document.getElementById('tb-tasks');
    const ov = box.querySelector('.tb-overflow');
    const btns = [...box.querySelectorAll('.tbtn:not(.tb-overflow)')];
    const titles = btns.map(b => b.title);
    return { total: WebOS.wm.count(), visible: btns.length,
      ovN: ov ? +ov.querySelector('.ov-n').textContent : -1,
      hasFirst: titles.includes('job00'), hasLast: titles.includes('job24'),
      fits: box.scrollWidth <= box.clientWidth + 1,
      minW: btns.length ? Math.min(...btns.map(b => b.offsetWidth)) : 0 };
  })()`);
  t('T62.2 放不下藏头留尾(job00 收起 / job24 在栏 / 溢出钮计数吻合 / 可见钮仍 ≥48)',
    ovf.total === 25 && ovf.visible + ovf.ovN === 25 && !ovf.hasFirst && ovf.hasLast && ovf.fits && ovf.minW >= 48,
    JSON.stringify(ovf));
  await c.shot('t62-overflow');

  // 溢出菜单取回:点溢出钮列被藏任务,点 job00 → 其窗口被聚焦
  const menuPick = await ev(`(async () => {
    document.querySelector('#tb-tasks .tb-overflow').click();
    await new Promise(r => setTimeout(r, 120));
    const items = [...document.querySelectorAll('#ctx .ctx-item')];
    const first = items.find(b => b.textContent.includes('job00'));
    if (!first) return { opened: items.length, found: false, focused: false };
    first.click();
    await new Promise(r => setTimeout(r, 200));
    const win = [...document.querySelectorAll('.win')].find(w => w.querySelector('.win-title')?.textContent === 'job00');
    return { opened: items.length, found: true, focused: !!win?.classList.contains('focused') };
  })()`);
  t('T62.3 溢出菜单可取回被藏任务(点击聚焦对应窗口)',
    menuPick.found && menuPick.focused, JSON.stringify(menuPick));

  // 上限:补到 60 → 第 61 个(files)被拒 + toast;对话框豁免照常弹;关一个后恢复可开
  await openJobs(25, 60);
  await sleep(300);
  const cap = await ev(`(async () => {
    const n0 = WebOS.wm.count();
    const refused = await WebOS.wm.open('files');
    const toast = [...document.querySelectorAll('#toasts .toast')].map(x => x.textContent).join('|');
    WebOS.dialogs.info({ level: 1, title: '上限期对话框', message: '对话框豁免' });
    await new Promise(r => setTimeout(r, 250));
    const dlg = !!document.querySelector('.win[data-app=sysdialog]');
    const dlgBtn = [...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].pop();
    if (dlgBtn) dlgBtn.click();
    await new Promise(r => setTimeout(r, 200));
    WebOS.wm.close(WebOS.wm.taskList()[0].id);   // 关最早的任务腾名额
    await new Promise(r => setTimeout(r, 120));
    const ok = await WebOS.wm.open('files');
    await new Promise(r => setTimeout(r, 300));
    return { n0, refused: refused === null, toastHasCap: toast.includes('上限'),
      dlg, filesOk: !!ok && !!document.querySelector('.win[data-app=files]') };
  })()`);
  t('T62.4 同时任务上限 60(第 61 个被拒 + toast;对话框豁免;关一个后可开)',
    cap.n0 === 60 && cap.refused && cap.toastHasCap && cap.dlg && cap.filesOk, JSON.stringify(cap));
  await c.shot('t62-limit');
});

/* ---- T64 界面语言 i18n P0(docs/i18n.md §6/§11):设置 locale + 重启式切换,
 * zh 逐字节基线 / en 外壳全英(开始菜单 / 桌面标签 / 窗口与任务栏标题 /
 * 托盘日期 / 设置「系统」节语言行)/ 商店卡片与分类英译 / 双语搜索索引 /
 * 切回 zh 恢复。切换走 WebOS.settings.set(等价设置应用确认后的路径)。 ---- */
group('T64', '界面语言(locale 设置 / 重启切换 / en 外壳与商店 / 双语搜索 / 切回)', async () => {
  await fresh();

  /* 1) zh 基线:lang 属性 + 开始菜单中文名(保证 zh 与现状逐像素一致) */
  const zhBase = await ev(`(() => ({
    lang: document.documentElement.lang,
  }))()`);
  await ev(`document.getElementById('start-btn').click()`);
  await waitFor(`document.querySelectorAll('.sm-item').length > 0`, 5000);
  const zhMenu = await ev(`[...document.querySelectorAll('.sm-item .name')].map(n => n.textContent)`);
  await ev(`document.getElementById('start-btn').click()`);
  t('T64.1 zh 基线(lang=zh-CN + 开始菜单中文名)',
    zhBase.lang === 'zh-CN' && zhMenu.includes('文件管家') && zhMenu.includes('记事本') && zhMenu.includes('终端'),
    JSON.stringify({ lang: zhBase.lang, sample: zhMenu.slice(0, 6) }));

  /* 2) 切 en(settings.set → reload,与设置应用确认路径等价) */
  await ev(`WebOS.settings.set({ locale: 'en-US' })`);
  await sleep(400);   // 设置防抖落盘(150ms)后再重载
  await fresh();
  const enBoot = await ev(`(() => ({
    lang: document.documentElement.lang,
    startTitle: document.getElementById('start-btn').title,
    smPlaceholder: document.getElementById('sm-input').placeholder,
  }))()`);
  t('T64.2 切 en 后 lang / 静态文案(index.html 随语言同步)',
    enBoot.lang === 'en-US' && enBoot.startTitle === 'Start menu' && enBoot.smPlaceholder === 'Search apps…',
    JSON.stringify(enBoot));

  /* 3) 外壳显示名:桌面标签 / 开始菜单 / 窗口标题 / 任务栏按钮 */
  const desk = await ev(`[...document.querySelectorAll('.dicon .label')].map(n => n.textContent)`);
  await ev(`document.getElementById('start-btn').click()`);
  await waitFor(`document.querySelectorAll('.sm-item').length > 0`, 5000);
  const enMenu = await ev(`[...document.querySelectorAll('.sm-item .name')].map(n => n.textContent)`);
  /* 双语搜索索引:输入英文 terminal 命中「终端」 */
  await ev(`(() => {
    const i = document.getElementById('sm-input');
    i.value = 'terminal';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const searchHit = await ev(`(() => {
    const first = document.querySelector('.sm-item:not(.hide)');
    const hit = first ? first.querySelector('.name').textContent : '';
    document.getElementById('start-btn').click();
    return hit;
  })()`);
  await ev(`WebOS.wm.open('calc')`);
  await waitFor(`!!document.querySelector('.win[data-app=calc]')`, 5000);
  const winTitle = await ev(`(() => ({
    title: document.querySelector('.win[data-app=calc] .win-title')?.textContent || '',
    task: [...document.querySelectorAll('#tb-tasks .t-title')].map(n => n.textContent),
    pinned: [...document.querySelectorAll('#tb-pinned .tbtn')].map(b => b.title),
  }))()`);
  await ev(`WebOS.wm.close(WebOS.wm.taskList()[0].id)`);
  const deskDbg = desk.includes('Files') ? null : await ev(`(() => {
    const n = [...document.querySelectorAll('.dicon .label')].find(x => x.textContent === '文件管家' || x.textContent === '终端');
    const path = n ? n.closest('.dicon').dataset.key.slice(3) : null;
    return { path, content: path ? WebOS.fs.read(path) : null, user: WebOS.accounts.current(),
             installedFiles: WebOS.apps.isInstalled('files'), lang: document.documentElement.lang };
  })()`);
  t('T64.3 外壳显示名英译(桌面标签 / 开始菜单 / 窗口与任务栏标题 / 双语搜索)',
    desk.includes('Files') && desk.includes('Recycle Bin') && !desk.includes('回收站')
    && enMenu.includes('Files') && enMenu.includes('Terminal') && !enMenu.includes('文件管家')
    && searchHit === 'Terminal'
    && winTitle.title === 'Calculator' && winTitle.task.includes('Calculator') && winTitle.pinned.includes('Files'),
    JSON.stringify({ desk, menu: enMenu.slice(0, 6), searchHit, winTitle, deskDbg }));

  /* 4) 设置应用「系统」节:界面语言行(下拉当前值 + 文案)与工具栏日期 */
  await ev(`WebOS.wm.open('settings', { params: { section: 'system' } })`);
  await waitFor(`!!document.querySelector('.win[data-app=settings] .set-body')`, 5000);
  const setRow = await ev(`(() => {
    const sel = document.querySelector('.win[data-app=settings] select.input');
    const labels = [...document.querySelectorAll('.win[data-app=settings] .set-body .s-label')].map(n => n.textContent);
    return { value: sel ? sel.value : null, opts: sel ? [...sel.options].map(o => o.textContent) : [],
             hasLangRow: labels.includes('Interface language'), toolDate: document.querySelector('.win[data-app=settings] .app-toolbar .dim')?.textContent || '' };
  })()`);
  await ev(`WebOS.wm.close(WebOS.wm.taskList()[0].id)`);
  t('T64.4 设置「系统」节界面语言行(英文文案 + 下拉 en-US + 日期英文星期)',
    setRow.value === 'en-US' && setRow.hasLangRow && setRow.opts.includes('Follow browser')
    && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{4}\/\d{2}\/\d{2}$/.test(setRow.toolDate.trim()),
    JSON.stringify(setRow));
  await c.shot('t64-en-settings');

  /* 5) 软件商店:卡片名 / 简介 / 分类走 manifest.i18n 与 category 字典 */
  await ev(`WebOS.wm.open('appstore')`);
  await waitFor(`!!document.querySelector('.st-card[data-app=memo]')`, 8000);
  const card = await ev(`(() => {
    const c = document.querySelector('.st-card[data-app=memo]');
    return { name: c.querySelector('.st-name').childNodes[0].textContent, desc: c.querySelector('.st-desc').textContent,
             line: c.querySelector('.st-line').textContent,
             cats: [...document.querySelectorAll('.st-nav .nav-item .st-nav-label')].map(n => n.textContent) };
  })()`);
  await ev(`WebOS.wm.close(WebOS.wm.taskList()[0].id)`);
  t('T64.5 商店卡片英译(名字 / 简介 / 分类侧栏)',
    card.name === 'Notes' && card.desc === 'Card-style notes with encryption and pinning'
    && card.line.includes('Productivity') && card.cats.includes('Games') && !card.cats.includes('游戏'),
    JSON.stringify(card));
  await c.shot('t64-en-store');

  /* 6) 切回 zh:恢复中文(含 lang 与开始菜单) */
  await ev(`WebOS.settings.set({ locale: 'zh-CN' })`);
  await sleep(400);
  await fresh();
  const back = await ev(`(() => ({
    lang: document.documentElement.lang,
    smPlaceholder: document.getElementById('sm-input').placeholder,
  }))()`);
  await ev(`document.getElementById('start-btn').click()`);
  await waitFor(`document.querySelectorAll('.sm-item').length > 0`, 5000);
  const backMenu = await ev(`[...document.querySelectorAll('.sm-item .name')].map(n => n.textContent)`);
  await ev(`document.getElementById('start-btn').click()`);
  t('T64.6 切回 zh 恢复(lang / 开始菜单中文名 / 静态文案)',
    back.lang === 'zh-CN' && back.smPlaceholder === '搜索应用…'
    && backMenu.includes('文件管家') && !backMenu.includes('Files'),
    JSON.stringify({ back, sample: backMenu.slice(0, 6) }));
});
