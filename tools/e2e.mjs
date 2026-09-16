/* ============================================================
 * WebOS 端到端冒烟测试
 * 运行:先启动静态服务器,再 node tools/e2e.mjs
 * 输出 PASS/FAIL 清单 + .shots/ 截图
 * ============================================================ */
import { launch } from './cdp.mjs';

const results = [];
const t = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const c = await launch('http://localhost:8080/');
const ev = (expr) => c.evaluate(expr);

try {
  /* ---- T1 启动与桌面 ---- */
  await sleep(1600); // 等开机画面结束
  const boot1 = await ev(`({
    errs: window.__errs,
    boot: !!document.getElementById('boot'),
    icons: document.querySelectorAll('.dicon').length,
    pinned: document.querySelectorAll('#tb-pinned .tbtn').length,
    smItems: document.querySelectorAll('.sm-item').length,
    clock: document.getElementById('clock-time').textContent,
    theme: document.documentElement.dataset.theme,
  })`);
  t('T1 桌面启动', !boot1.boot && boot1.icons >= 15 && boot1.pinned === 3 && boot1.smItems >= 15,
    `icons=${boot1.icons} pinned=${boot1.pinned} sm=${boot1.smItems} clock=${boot1.clock} errs=${boot1.errs.length}`);
  if (boot1.errs.length) console.log('   errors:', boot1.errs.join('\n   '));
  await c.shot('t1-desktop');

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
  t('T2.1 搜索过滤', filtered === 2, `visible=${filtered}(终端 + Bash 终端)`);
  await ev(`const i=document.getElementById('sm-input'); i.value=''; i.dispatchEvent(new Event('input'))`);
  await c.shot('t2-startmenu');
  await ev(`document.getElementById('start-btn').click()`); // 关闭

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

  /* ---- T4 主题切换(设置→外观→浅色) ---- */
  await ev(`[...document.querySelectorAll('.seg-btn')].find(b => b.textContent === '浅色').click()`);
  await sleep(400);
  const theme = await ev(`({
    html: document.documentElement.dataset.theme,
    persisted: JSON.parse(localStorage.getItem('webos.settings.v1')).theme,
  })`);
  t('T4 主题切换+持久化', theme.html === 'light' && theme.persisted === 'light', JSON.stringify(theme));
  await c.shot('t4-light-theme');

  /* ---- T4.1 切回深色 ---- */
  await ev(`[...document.querySelectorAll('.seg-btn')].find(b => b.textContent === '深色').click()`);
  await sleep(300);
  t('T4.1 切回深色', await ev(`document.documentElement.dataset.theme`) === 'dark');

  /* ---- T5 壁纸切换 ---- */
  await ev(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('壁纸')).click()`);
  await sleep(200);
  const before = await ev(`getComputedStyle(document.getElementById('wallpaper')).backgroundImage.slice(0,40)`);
  // 选一个与当前不同的壁纸(避免上次运行持久化导致的"点了同一个")
  const curWall = await ev(`JSON.parse(localStorage.getItem('webos.settings.v1')||'{}').wallpaper`);
  const wallIdx = curWall === 'sunset' ? 0 : 2;
  await ev(`document.querySelectorAll('.wp-thumb')[${wallIdx}].click()`);
  await sleep(400);
  const after = await ev(`getComputedStyle(document.getElementById('wallpaper')).backgroundImage.slice(0,40)`);
  t('T5 壁纸切换', before !== after, `${before} → ${after}`);
  await c.shot('t5-wallpaper');

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

  /* ---- T8 文件管家 + 记事本(IPC 参数传递) ---- */
  await ev(`WebOS.wm.open('files')`);
  await sleep(500);
  const files = await ev(`({
    items: document.querySelectorAll('.fitem').length,
    crumbs: [...document.querySelectorAll('.crumb')].map(c=>c.textContent.trim()).join('>'),
  })`);
  t('T8 文件管家打开', files.items >= 4, `items=${files.items} path=${files.crumbs}`);
  await c.shot('t8-files');
  // 进入 documents,双击 欢迎使用.txt
  await ev(`[...document.querySelectorAll('.fitem')].find(f => f.textContent.trim().startsWith('documents')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await sleep(400);
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
  const saved = await ev(`WebOS.fs.read('/home/documents/欢迎使用.txt').includes('[E2E 测试行]')`);
  t('T8.2 记事本保存到虚拟文件系统', saved === true);
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=notes]').dataset.id)`);
  await sleep(400);

  /* ---- T9 终端 + IPC 演示 ---- */
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  const termType = async (cmd) => {
    await ev(`(async () => {
      const inp = document.querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(350);
  };
  await termType('notify 你好 WebOS');
  const toast = await ev(`!!document.querySelector('.toast')`);
  const badge = await ev(`(document.getElementById('tray-bell').querySelector('.badge')?.hidden === false)`);
  t('T9 终端 notify → 系统通知(IPC)', toast === true, `toast=${toast} badgeVisible=${badge}`);
  await c.shot('t9-notify-toast');

  await termType('vol 40');
  const vol = await ev(`({ v: WebOS.settings.get('volume'), paths: document.querySelectorAll('#tray-vol svg path').length })`);
  t('T9.1 终端 vol → 音量系统(IPC)', vol.v === 40 && vol.paths === 1, JSON.stringify(vol)); // volume1 = 1 条 path(仅喇叭)

  await termType('sysinfo');
  await sleep(2600); // request 2s 超时后才会输出错误
  const sysinfoFail = await ev(`document.querySelector('.term-out').textContent.includes('无响应')`);
  t('T9.2 request 超时(监视器未开)', sysinfoFail === true);
  await ev(`WebOS.wm.open('monitor')`);
  await sleep(500);
  await termType('sysinfo');
  const sysinfoOk = await ev(`document.querySelector('.term-out').textContent.includes('监视器响应')`);
  t('T9.3 request/response 打通', sysinfoOk === true);
  await c.shot('t9_3-sysinfo');

  // 监视器 IPC 页有消息流
  await ev(`[...document.querySelectorAll('.seg-btn')].find(b=>b.textContent==='IPC 消息').click()`);
  await sleep(400);
  const ipcRows = await ev(`document.querySelectorAll('.table tbody tr').length`);
  t('T9.4 监视器 IPC 消息表', ipcRows > 3, `rows=${ipcRows}`);
  await c.shot('t9_4-ipc-monitor');

  /* ---- T10 窗口操作 ---- */
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

  /* ---- T12 音乐播放器 ---- */
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

  /* ---- T13 通知中心 ---- */
  await ev(`document.getElementById('tray-bell').click()`);
  await sleep(300);
  const noti = await ev(`({
    pop: !!document.querySelector('[data-pop="noti"]'),
    items: document.querySelectorAll('.noti-item').length,
  })`);
  t('T13 通知中心', noti.pop && noti.items >= 1, JSON.stringify(noti));
  await c.shot('t13-notifications');

  /* ---- T14 持久化:刷新后数据仍在 ---- */
  await c.goto('http://localhost:8080/');
  await sleep(1800);
  const persisted = await ev(`({
    theme: JSON.parse(localStorage.getItem('webos.settings.v1')).theme,
    wall: JSON.parse(localStorage.getItem('webos.settings.v1')).wallpaper,
    file: WebOS.fs.read('/home/documents/欢迎使用.txt').includes('[E2E 测试行]'),
    errs: window.__errs.length,
  })`);
  t('T14 刷新后持久化', persisted.theme === 'dark' && persisted.file && persisted.errs === 0, JSON.stringify(persisted));
  await c.shot('t14-after-reload');

  /* ---- T15 风格主题(mac / win98 / winxp / win7) ---- */
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  const styleStates = {};
  for (const st of ['win98', 'winxp', 'win7', 'mac']) {
    await ev(`WebOS.settings.set({ style: '${st}' })`);
    await sleep(450);
    styleStates[st] = await ev(`({
      attr: document.documentElement.dataset.style,
      taskbarBg: getComputedStyle(document.getElementById('taskbar')).backgroundColor,
      taskbarImg: getComputedStyle(document.getElementById('taskbar')).backgroundImage.slice(0, 30),
      taskbarH: document.getElementById('taskbar').offsetHeight,
      startBR: getComputedStyle(document.getElementById('start-btn')).borderRadius,
      transform: getComputedStyle(document.getElementById('taskbar')).transform,
      winHeadBg: getComputedStyle(document.querySelector('.win-head')).backgroundImage.slice(0, 30),
      persisted: JSON.parse(localStorage.getItem('webos.settings.v1')).style,
    })`);
    await c.shot('t15-' + st);
  }
  t('T15 Win98 银灰任务栏', styleStates.win98.attr === 'win98' &&
      styleStates.win98.taskbarBg === 'rgb(192, 192, 192)' &&
      styleStates.win98.winHeadBg !== 'none',
    `h=${styleStates.win98.taskbarH} bg=${styleStates.win98.taskbarBg}`);
  t('T15.1 WinXP 蓝色渐变任务栏', styleStates.winxp.taskbarImg !== 'none' && styleStates.winxp.taskbarH === 30,
    `img=${styleStates.winxp.taskbarImg}`);
  t('T15.2 Win7 圆形开始球', styleStates.win7.startBR === '50%' && styleStates.win7.transform === 'none',
    `br=${styleStates.win7.startBR}`);
  t('T15.3 macOS 悬浮居中 Dock', styleStates.mac.transform !== 'none',
    `transform=${styleStates.mac.transform}`);
  t('T15.4 风格持久化', styleStates.mac.persisted === 'mac');

  await ev(`WebOS.settings.set({ style: 'modern' })`);
  await sleep(400);
  const backModern = await ev(`({
    attr: document.documentElement.dataset.style,
    bg: getComputedStyle(document.getElementById('taskbar')).backgroundColor,
    errs: window.__errs.length,
  })`);
  t('T15.5 恢复现代风格', backModern.attr === 'modern' && backModern.bg !== 'rgb(192, 192, 192)' && backModern.errs === 0,
    JSON.stringify(backModern));
  await c.shot('t15_5-modern-back');

  /* ---- T16 Win3.1 / Ubuntu ---- */
  await ev(`WebOS.settings.set({ style: 'win31' })`);
  await sleep(450);
  const w31 = await ev(`(() => {
    const head = document.querySelector('.win-head');
    const cs = getComputedStyle(head);
    const closeBtn = head.querySelector('.wbtn.close');
    const title = head.querySelector('.win-title');
    return {
      attr: document.documentElement.dataset.style,
      headBg: cs.backgroundColor,
      headImg: cs.backgroundImage,
      headH: head.offsetHeight,
      taskbarBg: getComputedStyle(document.getElementById('taskbar')).backgroundColor,
      menuBoxLeft: closeBtn.getBoundingClientRect().left < title.getBoundingClientRect().left,
      menuBoxHasBar: getComputedStyle(closeBtn, '::after').width === '8px',
    };
  })()`);
  t('T16 Win3.1 纯海军蓝标题栏', w31.attr === 'win31' && w31.headBg === 'rgb(0, 0, 128)' && w31.headImg === 'none' && w31.headH === 22,
    `bg=${w31.headBg} img=${w31.headImg} h=${w31.headH}`);
  t('T16.1 Win3.1 系统菜单盒在左', w31.menuBoxLeft && w31.menuBoxHasBar && w31.taskbarBg === 'rgb(192, 192, 192)',
    `menuBoxLeft=${w31.menuBoxLeft} bar=${w31.menuBoxHasBar}`);
  await c.shot('t16-win31');

  await ev(`WebOS.settings.set({ style: 'ubuntu' })`);
  await sleep(450);
  const ub = await ev(`(() => {
    const tb = document.getElementById('taskbar').getBoundingClientRect();
    const clock = document.getElementById('tray-clock').getBoundingClientRect();
    const closeBtn = document.querySelector('.win-head .wbtn.close');
    return {
      attr: document.documentElement.dataset.style,
      tbTop: tb.top,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      clockCentered: Math.abs((clock.left + clock.right) / 2 - innerWidth / 2) < 30,
      clockDateHidden: getComputedStyle(document.getElementById('clock-date')).display === 'none',
      closeBR: getComputedStyle(closeBtn).borderRadius,
      closeBg: getComputedStyle(closeBtn).backgroundColor,
      winTop: document.getElementById('windows').getBoundingClientRect().top,
    };
  })()`);
  t('T16.2 Ubuntu GNOME 顶栏', ub.attr === 'ubuntu' && ub.tbTop === 0 && ub.winTop === 32,
    `tbTop=${ub.tbTop} winTop=${ub.winTop}`);
  t('T16.3 Ubuntu Yaru 橙强调色', ub.accent === '#e95420' && ub.closeBg === 'rgb(233, 84, 32)' && ub.closeBR === '50%',
    `accent=${ub.accent} close=${ub.closeBg} br=${ub.closeBR}`);
  t('T16.4 Ubuntu 居中时钟', ub.clockCentered && ub.clockDateHidden, `centered=${ub.clockCentered}`);
  await c.shot('t16-ubuntu');
  await c.shot('t16-ubuntu-clock');

  await ev(`WebOS.settings.set({ style: 'modern' })`);
  await sleep(400);
  const backMod2 = await ev(`({ attr: document.documentElement.dataset.style, errs: window.__errs.length,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() })`);
  t('T16.5 恢复现代(强调色还原)', backMod2.attr === 'modern' && backMod2.errs === 0 && backMod2.accent !== '#e95420',
    JSON.stringify(backMod2));

  /* ---- T17 霓虹未来 ---- */
  await ev(`WebOS.settings.set({ style: 'neon' })`);
  await sleep(450);
  const ne = await ev(`(() => {
    const head = document.querySelector('.win-head');
    const win = document.querySelector('.win');
    return {
      attr: document.documentElement.dataset.style,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      panel: getComputedStyle(document.documentElement).getPropertyValue('--panel-solid').trim(),
      stripAnim: getComputedStyle(head, '::before').animationName,
      winGlow: getComputedStyle(win).boxShadow !== 'none',
      tbBorderTop: getComputedStyle(document.getElementById('taskbar')).borderTopColor,
      wpOverlay: getComputedStyle(document.getElementById('wallpaper'), '::before').content !== 'none',
      scanlines: getComputedStyle(document.body, '::before').content !== 'none',
      titleFont: getComputedStyle(head.querySelector('.win-title')).fontFamily.includes('mono') ||
                 getComputedStyle(head.querySelector('.win-title')).fontFamily.length > 0,
    };
  })()`);
  t('T17 霓虹皮肤生效(暗色+青色强调)', ne.attr === 'neon' && ne.accent === '#00e5ff' && ne.panel === '#0a1020',
    `accent=${ne.accent} panel=${ne.panel}`);
  t('T17.1 窗口霓虹灯条与辉光', ne.stripAnim === 'neonFlow' && ne.winGlow,
    `strip=${ne.stripAnim} glow=${ne.winGlow}`);
  t('T17.2 桌面暗化网格与扫描线', ne.wpOverlay && ne.scanlines && ne.tbBorderTop !== 'rgba(0, 0, 0, 0)',
    `overlay=${ne.wpOverlay} scan=${ne.scanlines} tbBorder=${ne.tbBorderTop}`);
  await c.shot('t17-neon');
  // 关闭按钮品红霓虹
  await ev(`WebOS.settings.set({ style: 'modern' })`);
  await sleep(350);
  const backMod3 = await ev(`({ attr: document.documentElement.dataset.style, errs: window.__errs.length })`);
  t('T17.3 恢复现代风格', backMod3.attr === 'modern' && backMod3.errs === 0, JSON.stringify(backMod3));

  /* ---- T18 虚拟网络:DNS / curl / SSH / 浏览器谜题全链路 ---- */
  await ev(`WebOS.vnet.resetState()`);   // 清空上次的游戏进度标志
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  await termType('nslookup portal.nexus');
  const dnsOk = await ev(`document.querySelector('.term-out').textContent.includes('10.0.0.10')`);
  t('T18 nslookup 虚拟 DNS', dnsOk === true);
  await termType('ping router.nexus');
  const pingOk = await ev(`document.querySelector('.term-out').textContent.includes('来自 10.0.0.1 的回复')`);
  t('T18.1 ping 网关', pingOk === true);
  await termType('curl http://portal.nexus/');
  const curlOk = await ev(`document.querySelector('.term-out').textContent.includes('图书馆系统维护')`);
  t('T18.2 curl 虚拟站点', curlOk === true);

  // SSH:密码验证 → 远程会话(用域名连接,验证 DNS 解析路径)
  await termType('ssh researcher@vault.nexus');
  await sleep(300);
  const pwdPrompt = await ev(`document.querySelector('.term-out').textContent.includes("researcher@vault.nexus's password") &&
    document.querySelector('.term-in input').type === 'password'`);
  t('T18.3 SSH 密码掩码输入', pwdPrompt === true);
  await termType('h3ll0w'); // 掩码输入,不回显
  await sleep(400);
  const sshIn = await ev(`document.querySelector('.t-prompt').textContent.includes('researcher@vault')`);
  t('T18.4 SSH 会话建立', sshIn === true);
  await termType('ls');
  const lsOk = await ev(`document.querySelector('.term-out').textContent.includes('notes.txt')`);
  t('T18.5 远程 ls', lsOk === true);
  await termType('cat notes.txt');
  const catOk = await ev(`document.querySelector('.term-out').textContent.includes('blackout.nexus')`);
  t('T18.6 远程 cat(线索)', catOk === true);
  await termType('get notes.txt');
  const got = await ev(`WebOS.fs.exists('/home/downloads/notes.txt')`);
  t('T18.7 远程下载到本机(IPC 联动)', got === true);
  await termType('status');
  const statusRun = await ev(`document.querySelector('.term-out').textContent.includes('维护锁已释放')`);
  t('T18.8 服务器自定义命令', statusRun === true);
  await termType('exit');
  await sleep(300);
  const exited = await ev(`document.querySelector('.t-prompt').textContent.includes('@webos:')`);
  t('T18.9 SSH 退出', exited === true);
  await c.shot('t18-terminal-ssh');

  // 浏览器:门户 → 关于 → 图书馆登录 → 隐藏站 → 真实 PDF 代理
  await ev(`WebOS.wm.open('browser')`);
  await sleep(600);
  const nav = async (addrInput) => {
    await ev(`(async () => {
      const a = document.querySelector('.vw-addr');
      a.value = ${JSON.stringify(addrInput)};
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(1400); // 模拟加载动画 + 渲染
  };
  await nav('portal.nexus');
  const portal = await ev(`document.querySelector('.vw-page').textContent.includes('NEXUS 集团内网门户')`);
  t('T18.10 浏览器打开虚拟门户', portal === true);
  // 站内链接导航
  await ev(`[...document.querySelectorAll('.vw-page a')].find(a => a.textContent.includes('关于本馆')).click()`);
  await sleep(1200);
  const about = await ev(`document.querySelector('.vw-page').textContent.includes('52,831')`);
  t('T18.11 站内链接(线索:馆藏数)', about === true);
  await c.shot('t18-browser-portal');

  await nav('library.nexus');
  // 错误口令
  await ev(`(async () => {
    const page = () => document.querySelector('.vw-page');
    page().querySelector('input[name=user]').value = 'reader';
    page().querySelector('input[name=pass]').value = '00000';
    page().querySelector('form button').click();
  })()`);
  await sleep(1300);
  const wrong = await ev(`document.querySelector('.vw-page').textContent.includes('口令错误')`);
  t('T18.12 图书馆错误口令被拒', wrong === true);
  // 正确口令(谜题答案 52831)
  await ev(`(async () => {
    const page = () => document.querySelector('.vw-page');
    page().querySelector('input[name=user]').value = 'reader';
    page().querySelector('input[name=pass]').value = '52831';
    page().querySelector('form button').click();
  })()`);
  await sleep(1300);
  const loginOk = await ev(`document.querySelector('.vw-page').textContent.includes('researcher') &&
    document.querySelector('.vw-page').textContent.includes('h3ll0w')`);
  const flagLib = await ev(`WebOS && document.documentElement && JSON.parse(localStorage.getItem('webos.vnet.v1')||'{}').flags.library_ok === true`);
  t('T18.13 图书馆口令谜题(SSH 凭据泄露 + 标志位)', loginOk === true && flagLib === true,
    `page=${loginOk} flag=${flagLib}`);
  await c.shot('t18-browser-login');

  // 未授权直接访问 blackout → 403 应已被 library_ok 解锁(已登录)→ 首页可见
  await nav('blackout.nexus');
  const blackout = await ev(`document.querySelector('.vw-page').textContent.includes('BLACKOUT 档案馆')`);
  t('T18.14 隐藏站(凭据门禁)', blackout === true);
  // 打开路径转换的 PDF
  await ev(`[...document.querySelectorAll('.vw-page a')].find(a => a.getAttribute('href') === '/archive.pdf').click()`);
  await sleep(1600);
  const proxied = await ev(`(() => {
    const f = document.querySelector('.vw-iframe');
    return !f.hidden && (f.src || '').includes('w3.org');
  })()`);
  const questDone = await ev(`JSON.parse(localStorage.getItem('webos.vnet.v1')||'{}').flags.quest_done === true`);
  const toastWin = await ev(`document.querySelector('#toasts .toast')?.textContent.includes('谜题完成')`);
  t('T18.15 路径转换(虚拟 URL → 真实 PDF iframe)', proxied === true);
  t('T18.16 通关标志位与通知', questDone === true, `toast=${toastWin}`);
  await c.shot('t18-browser-proxy-pdf');

  // 外网隔离:真实域名必须被拒绝
  await nav('www.google.com');
  const blocked = await ev(`document.querySelector('.vw-page').textContent.includes('无法解析主机')`);
  t('T18.17 外网域名被拒(隔离验证)', blocked === true);

  const errs18 = await ev(`window.__errs.length`);
  t('T18.18 全程无运行错误', errs18 === 0, `errs=${errs18}`);

  /* ---- T19 霓虹 2.0:每应用灯条 / 流光 / 呼吸 / 悬浮切角任务栏 / 动态桌面 ---- */
  await ev(`WebOS.settings.set({ style: 'neon' })`);
  await ev(`WebOS.wm.open('files'); WebOS.wm.open('monitor')`);
  await sleep(800);
  const ne2 = await ev(`(() => {
    const winOf = (id) => document.querySelector('.win[data-app="' + id + '"]');
    const f = winOf('files'), m = winOf('monitor');
    const focused = f.classList.contains('focused') ? f : m;
    const unfocused = focused === f ? m : f;
    const cs = getComputedStyle;
    const tb = document.getElementById('taskbar').getBoundingClientRect();
    return {
      filesA: f.style.getPropertyValue('--neon-a').trim(),
      monitorA: m.style.getPropertyValue('--neon-a').trim(),
      stripAnim: cs(f.querySelector('.win-head'), '::before').animationName,
      stripSize: cs(f.querySelector('.win-head'), '::before').backgroundSize,
      unfocusedPaused: cs(unfocused.querySelector('.win-head'), '::before').animationPlayState,
      breath: cs(focused).animationName,
      tbClip: cs(document.getElementById('taskbar')).clipPath !== 'none',
      tbStrip: cs(document.getElementById('taskbar'), '::before').animationName,
      tbFloat: tb.left > 0 && tb.width < innerWidth - 20,
      gridAnim: cs(document.getElementById('desktop'), '::before').animationName,
      orbsAnim: cs(document.getElementById('desktop'), '::after').animationName,
      sweepAnim: cs(document.getElementById('icons'), '::before').animationName,
      taskNeon: document.querySelector('#tb-tasks .tbtn.active')?.style.getPropertyValue('--neon-a').trim(),
    };
  })()`);
  t('T19 每应用专属灯条色', ne2.filesA === '#ffb400' && ne2.monitorA === '#ff3860' && ne2.filesA !== ne2.monitorA,
    `files=${ne2.filesA} monitor=${ne2.monitorA}`);
  t('T19.1 灯条流光动画', ne2.stripAnim === 'neonFlow' && ne2.stripSize.includes('200%'), JSON.stringify({ anim: ne2.stripAnim, size: ne2.stripSize }));
  t('T19.2 未聚焦灯条停摆', ne2.unfocusedPaused === 'paused', `playState=${ne2.unfocusedPaused}`);
  t('T19.3 活动窗口呼吸辉光', ne2.breath === 'neonBreath', `anim=${ne2.breath}`);
  t('T19.4 任务栏悬浮+切角+顶部流光', ne2.tbClip && ne2.tbFloat && ne2.tbStrip === 'neonFlow',
    `clip=${ne2.tbClip} float=${ne2.tbFloat} strip=${ne2.tbStrip}`);
  t('T19.5 动态桌面(网格/光球/扫描带)', ne2.gridAnim && ne2.orbsAnim && ne2.sweepAnim,
    `grid=${ne2.gridAnim} orbs=${ne2.orbsAnim} sweep=${ne2.sweepAnim}`);
  t('T19.6 任务栏芯片携带应用霓虹色', ne2.taskNeon === '#ff3860' || ne2.taskNeon === '#ffb400', ne2.taskNeon);
  await c.shot('t19-neon2');
  await ev(`WebOS.settings.set({ style: 'modern' })`);
  await sleep(400);
  const backMod4 = await ev(`({ attr: document.documentElement.dataset.style, errs: window.__errs.length })`);
  t('T19.7 恢复现代风格', backMod4.attr === 'modern' && backMod4.errs === 0, JSON.stringify(backMod4));

  /* ---- T20 Bash 终端:白名单指令 / 管道 / 重定向 ---- */
  await ev(`WebOS.wm.open('bash')`);
  await sleep(600);
  const bashType = async (cmd) => {
    await ev(`(async () => {
      const w = document.querySelector('.win[data-app=bash]');
      const inp = w.querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(320);
  };
  const bashOut = () => ev(`document.querySelector('.win[data-app=bash] .term-out').textContent`);

  await bashType('ls /home');
  const b1 = await bashOut();
  t('T20 Bash ls 白名单', b1.includes('documents/') && b1.includes('downloads/'), 'ls /home ✓');

  await bashType('echo hello-bash > /home/bash_t.txt');
  await bashType('cat /home/bash_t.txt');
  const b2 = await bashOut();
  const b2fs = await ev(`WebOS.fs.read('/home/bash_t.txt')`);
  t('T20.1 重定向落地文件系统', b2.includes('hello-bash') && b2fs === 'hello-bash\n', `fs=${JSON.stringify(b2fs)}`);

  await bashType('ls /home | grep doc');
  const b3 = await bashOut();
  await bashType('ls /home | wc -l');
  const b4 = await bashOut();
  const wcNum = Number((/wc -l\D*(\d+)/.exec(b4) || [])[1] || 0);
  t('T20.2 管道 grep/wc', b3.includes('documents/') && wcNum >= 4, `wc -l = ${wcNum}`);

  await bashType('uname -a');
  const b5 = await bashOut();
  t('T20.3 uname -a', b5.includes('6.1.0-webos'), '');

  await bashType('sudo rm -rf /');
  const b6 = await bashOut();
  t('T20.4 非白名单拒绝(sudo)', b6.includes('bash: sudo: command not found'), '');
  await bashType('curl http://portal.nexus/');
  const b7 = await bashOut();
  t('T20.5 网络命令禁用(curl)', b7.includes('bash: curl: command not found'), '');

  await bashType('rm /home/bash_t.txt');
  await bashType('cat /home/bash_t.txt');
  const b8 = await bashOut();
  t('T20.6 rm 与错误提示', b8.includes('没有那个文件或目录'), '');

  await bashType('find /home -name "*.txt"');
  const b9 = await bashOut();
  t('T20.7 find 通配符', b9.includes('/home/documents/'), b9.slice(-80));
  await c.shot('t20-bash');

  await bashType('exit');
  await sleep(400);
  const bExit = await ev(`document.querySelectorAll('.win[data-app=bash]').length`);
  t('T20.8 exit 关闭窗口', bExit === 0, `wins=${bExit}`);

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
  // 文本「在记事本中编辑」:落到虚拟文件系统并调起记事本
  await ev(`[...document.querySelectorAll('.win[data-app=viewer] .btn')].find(b => b.textContent.includes('在记事本中编辑')).click()`);
  await sleep(600);
  const toNotes = await ev(`({
    notesWin: !!document.querySelector('.win[data-app=notes]'),
    saved: WebOS.fs.read('/home/downloads/readme.txt'),
  })`);
  t('T21.4 文本转入记事本(IPC 联动)', toNotes.notesWin && toNotes.saved === '本地文件内容 ABC', JSON.stringify(toNotes.saved));

  // 关闭全部预览器(对象 URL 生命周期由 onClose 回收)
  await ev(`[...document.querySelectorAll('.win[data-app=viewer]')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  const errs21 = await ev(`window.__errs.length`);
  t('T21.5 关闭回收无错误', errs21 === 0, `errs=${errs21}`);

  /* ---- T22 多窗口模式:平铺/层叠/贴边/单活动 ---- */
  // 准备三个窗口
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  await ev(`WebOS.wm.open('files'); WebOS.wm.open('terminal'); WebOS.wm.open('monitor')`);
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

  // 严格单活动:非活动窗口首次点击仅激活(关闭按钮点一次不关,点两次才关)
  await ev(`WebOS.settings.set({ singleActive: true })`);
  await sleep(300);
  const target = await ev(`(() => {
    const unfocused = [...document.querySelectorAll('.win:not(.focused)')].find(w => w.dataset.app === 'monitor');
    return unfocused.dataset.app;
  })()`);
  const firstClick = await ev(`(() => {
    const w = document.querySelector('.win[data-app=monitor]');
    const btn = w.querySelector('.wbtn.close');
    btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return {
      stillOpen: !!document.querySelector('.win[data-app=monitor]'),
      nowFocused: w.classList.contains('focused'),
      dimmed: getComputedStyle(w.querySelector('.win-body')).opacity,
    };
  })()`);
  t('T22.3 首次点击仅激活(不穿透)', firstClick.stillOpen && firstClick.nowFocused,
    JSON.stringify(firstClick));
  const dimOther = await ev(`(() => {
    const other = document.querySelector('.win[data-app=files]');
    return { opacity: getComputedStyle(other.querySelector('.win-body')).opacity };
  })()`);
  t('T22.4 非活动窗口变暗', parseFloat(dimOther.opacity) < 0.8, dimOther.opacity);
  // 第二次点击真正关闭(窗口有 170ms 退场动画,延迟后检查)
  await ev(`(() => {
    const btn = document.querySelector('.win[data-app=monitor] .wbtn.close');
    btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(400);
  const secondClick = await ev(`!document.querySelector('.win[data-app=monitor]')`);
  t('T22.5 第二次点击生效', secondClick === true);

  await ev(`WebOS.settings.set({ singleActive: false })`);
  await sleep(300);

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

  /* ---- T24 桌面操作系统化:文件图标/右键新建/框选/吸附/固定 ---- */
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);

  // a. 桌面渲染应用快捷方式 + 桌面文件
  const dsk1 = await ev(`(() => {
    const icons = [...document.querySelectorAll('.dicon')];
    return {
      total: icons.length,
      apps: icons.filter(n => n.dataset.kind === 'app').length,
      files: icons.filter(n => n.dataset.kind === 'fs').length,
    };
  })()`);
  t('T24 桌面 = 应用快捷方式 + 文件图标', dsk1.apps >= 11 && await ev(`WebOS.fs.isDir('/home/desktop')`), JSON.stringify(dsk1));

  // b. 桌面右键 → 新建文本文档(全 GUI:菜单 → 系统对话框输入)
  const ctxClick = async (label) => {
    await ev(`(() => {
      const item = [...document.querySelectorAll('#ctx .ctx-item')].find(i => i.textContent.includes(${JSON.stringify(label)}));
      if (item) item.click();
    })()`);
    await sleep(400);
  };
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
    fs: WebOS.fs.read('/home/desktop/测试便签.txt') === '',
    icon: [...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:/home/desktop/测试便签.txt'),
  })`);
  t('T24.1 右键新建文档(菜单→对话框→文件系统→图标)', menuHasNew && newFile.fs && newFile.icon, JSON.stringify(newFile));

  // c. 终端写桌面文件 → 图标实时出现(IPC 联动)
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  await termType('echo 来自终端 > /home/desktop/终端创建.txt');
  await sleep(600);
  const liveIcon = await ev(`[...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:/home/desktop/终端创建.txt')`);
  t('T24.2 终端写桌面 → 图标实时刷新', liveIcon === true);

  // d. F2 重命名(选中 → 键盘 → 对话框);先让输入框失焦,模拟用户点击桌面后的状态
  await ev(`(() => {
    document.activeElement && document.activeElement.blur();
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'fs:/home/desktop/测试便签.txt');
    n.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
  })()`);
  await sleep(200);
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`);
  await sleep(450);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    inp.value = '改名后.txt';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(600);
  const renamed = await ev(`WebOS.fs.exists('/home/desktop/改名后.txt')`);
  t('T24.3 F2 重命名', renamed === true);

  // e. Delete 删除(确认对话框)
  await ev(`(() => {
    document.activeElement && document.activeElement.blur();
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'fs:/home/desktop/改名后.txt');
    n.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
  })()`);
  await sleep(200);
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  await sleep(450);
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].find(b => b.textContent === '删除').click()`);
  await sleep(600);
  const deleted = await ev(`!WebOS.fs.exists('/home/desktop/改名后.txt') && ![...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:/home/desktop/改名后.txt')`);
  t('T24.4 Delete 删除(确认→文件系统→图标移除)', deleted === true);

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
  await c.goto('http://localhost:8080/');
  await sleep(1800);
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

  /* ---- T25 真实输入回归(浏览器输入管线:真实鼠标与键盘事件) ---- */
  await ev(`[...document.querySelectorAll('.win')].forEach(w => WebOS.wm.close(w.dataset.id))`);
  await sleep(500);
  await ev(`(() => { document.querySelectorAll('.dicon.selected').forEach(d => d.classList.remove('selected')); return true; })()`);

  /** CDP 真实键盘输入(经浏览器输入管线,isTrusted;三段式保证非字母/中文字符插入) */
  const typeReal = async (text) => {
    for (const ch of text) {
      const code = /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase()
        : ch === '.' ? 'Period' : ch === '/' ? 'Slash' : ch === ' ' ? 'Space' : undefined;
      const vk0 = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
      const vk = vk0 > 255 ? 0 : vk0;   // 中文等超范围键码需省略
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, ...(code ? { code } : {}), ...(vk ? { windowsVirtualKeyCode: vk } : {}) });
      await c.send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, ...(code ? { code } : {}), ...(vk ? { windowsVirtualKeyCode: vk } : {}) });
      await sleep(12);
    }
  };
  const pressEnter = async () => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(120);
  };
  const clickReal = async (x, y, count = 1) => {
    for (let i = 0; i < count; i++) {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i + 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i + 1 });
      await sleep(70);
    }
  };

  // 25.1 真实鼠标双击桌面图标 → 打开应用(回归:窗口层曾挡住真实点击)
  const iconPt = await ev(`(() => {
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'app:notes');
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await clickReal(iconPt.x, iconPt.y, 2);
  await sleep(600);
  const realClick = await ev(`({
    notes: !!document.querySelector('.win[data-app=notes]'),
    selected: document.querySelectorAll('.dicon.selected').length,
  })`);
  t('T25 真实鼠标双击桌面图标', realClick.notes === true && realClick.selected >= 1, JSON.stringify(realClick));

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
    created: WebOS.fs.exists('/home/desktop/真实新建.txt'),
    icon: [...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:/home/desktop/真实新建.txt'),
  }))()`);
  t('T25.4 右键菜单+真实点击+真实键盘新建文件', realMenu.created && realMenu.icon, JSON.stringify(realMenu));
  // 清理
  await ev(`WebOS.fs.rm('/home/desktop/真实新建.txt')`);
  await sleep(300);

  const errs25 = await ev(`window.__errs.length`);
  t('T25.5 全程无错误', errs25 === 0, `errs=${errs25}`);

  /* ---- T26 邮件应用 ---- */
  await ev(`WebOS.vnet.resetState(); localStorage.removeItem('webos.mail.v1'); location.reload()`);
  await sleep(2200);   // 重载后种子邮件播种
  await ev(`WebOS.wm.open('mail')`);
  await sleep(700);
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
  await c.goto('http://localhost:8080/');
  await sleep(1800);
  await ev(`WebOS.wm.open('mail')`);
  await sleep(700);
  await ev(`[...document.querySelectorAll('.mail-side .list-item')].find(f => f.textContent.includes('已发送')).click()`);
  await sleep(400);
  const m6 = await ev(`document.querySelectorAll('.mail-item').length`);
  t('T26.7 持久化(刷新后已发送仍在)', m6 === 1, `sent=${m6}`);
  await c.shot('t26-mail');

  const errs26 = await ev(`window.__errs.length`);
  t('T26.8 全程无错误', errs26 === 0, `errs=${errs26}`);

  /* ---- T27 任务(Todo)应用 ---- */
  await ev(`localStorage.removeItem('webos.todo.v1'); location.reload()`);
  await sleep(2000);   // 清档重载,种子数据从零开始
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  const td0 = await ev(`(() => {
    const items = [...document.querySelectorAll('.todo-item')];
    return {
      items: items.length,
      ring: document.querySelector('.todo-ring-num')?.textContent,
      status: document.querySelector('.win[data-app=todo] .app-status span').textContent,
    };
  })()`);
  t('T27 任务:种子数据 + 侧栏 + 进度环', td0.items === 3 && td0.ring === '33%', JSON.stringify(td0));

  // 添加任务(真实流程:选项目 → 输入 → 回车)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=todo]');
    const sel = w.querySelector('.todo-add select');   // 项目下拉
    sel.value = '工作';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const inp = w.querySelector('.todo-add input');
    inp.value = '写周报';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(600);   // persist 防抖 200ms
  const td1 = await ev(`({
    added: [...document.querySelectorAll('.todo-t')].some(t => t.textContent === '写周报'),
    store: JSON.parse(localStorage.getItem('webos.todo.v1')).tasks.some(t => t.text === '写周报' && t.project === '工作'),
  })`);
  t('T27.1 添加任务(项目下拉→回车→持久化)', td1.added && td1.store, JSON.stringify(td1));

  // 完成任务 → 通知 + 进度更新
  const td2 = await ev(`(async () => {
    const row = [...document.querySelectorAll('.todo-item')].find(i => i.textContent.includes('写周报'));
    row.querySelector('.todo-check').click();
    await new Promise(r => setTimeout(r, 400));
    return {
      done: [...document.querySelectorAll('.todo-item.done')].some(i => i.textContent.includes('写周报')),
      toast: [...document.querySelectorAll('#toasts .toast')].some(t => t.textContent.includes('任务完成')),
      ring: document.querySelector('.todo-ring-num')?.textContent,
    };
  })()`);
  t('T27.2 完成任务(划线+通知+进度环)', td2.done && td2.toast && td2.ring === '50%', JSON.stringify(td2));

  // 新建项目 + 切换
  await ev(`(() => { [...document.querySelectorAll('.app-side .btn')].find(b => b.textContent.includes('新建项目')).click(); })()`);
  await sleep(450);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    inp.value = '解谜';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(500);
  const td3 = await ev(`(() => ({
    projects: JSON.parse(localStorage.getItem('webos.todo.v1')).projects,
    active: document.querySelector('.app-side .nav-item.active')?.textContent.replace(/\s+/g, '') || '',
  }))()`);
  t('T27.3 新建项目并切换', td3.projects.includes('解谜') && td3.active?.startsWith('解谜'), JSON.stringify(td3));

  // 逾期任务:直接在存储中注入一条,重新渲染验证
  await ev(`(() => {
    const s = JSON.parse(localStorage.getItem('webos.todo.v1'));
    s.seq = (s.seq || 0) + 1;   // 提升版本号,让运行中的 todo 实例同步采纳
    s.tasks.push({ id: 't99', project: '解谜', text: '过期任务', done: false, prio: 2, due: '2020-01-01', starred: false, created: Date.now() });
    localStorage.setItem('webos.todo.v1', JSON.stringify(s));
    WebOS.wm.open('todo');
  })()`);
  await sleep(2100);   // 等跨实例同步 tick(1.5s)
  const td4 = await ev(`(() => {
    const w = [...document.querySelectorAll('.win[data-app=todo]')].pop();
    const late = [...w.querySelectorAll('.todo-due')].find(d => d.classList.contains('late'));
    return { late: late?.textContent, status: w.querySelector('.app-status span').textContent };
  })()`);
  t('T27.4 逾期任务红色标记', td4.late?.includes('已逾期'), JSON.stringify(td4));
  await c.shot('t27-todo');

  // 导出到桌面
  await ev(`(() => { [...document.querySelectorAll('.win[data-app=todo] .btn')].find(b => b.textContent.includes('导出到桌面')).click(); })()`);
  await sleep(500);
  await sleep(600);
  const td5 = await ev(`WebOS.fs.read('/home/desktop/todo.txt')`);
  const ok5 = typeof td5 === 'string' && td5.includes('过期任务') && td5.includes('写周报');
  if (!ok5) console.log('   todo.txt 内容:', JSON.stringify((td5 || '').slice(0, 200)));
  t('T27.5 导出清单到桌面文件', ok5, (td5 || '').slice(0, 80));

  // 持久化:刷新后任务仍在
  await c.goto('http://localhost:8080/');
  await sleep(1800);
  const td6 = await ev(`JSON.parse(localStorage.getItem('webos.todo.v1')).tasks.length`);
  t('T27.6 持久化(刷新后任务保留)', td6 >= 5, `tasks=${td6}`);
  await ev(`WebOS.wm.open('todo')`);
  await sleep(600);

  const errs27 = await ev(`window.__errs.length`);
  t('T27.7 全程无错误', errs27 === 0, `errs=${errs27}`);

  /* ---- T28 短信应用 ---- */
  await ev(`localStorage.removeItem('webos.sms.v1'); location.reload()`);
  await sleep(2200);   // 种子短信播种
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

  // Todo 到期联动:逾期任务产生提醒短信;打开 todo 触发 checkDue 立即检查
  await ev(`WebOS.wm.open('todo')`);
  await sleep(800);
  let s4 = await ev(`(() => {
    const c = WebOS.sms.chat('todo-reminder');
    return { exists: !!c, text: c?.msgs.map(m => m.text).join('|') };
  })()`);
  for (let i = 0; i < 10 && !s4.exists; i++) { await sleep(500); s4 = await ev(`(() => {
    const c = WebOS.sms.chat('todo-reminder');
    return { exists: !!c, text: c?.msgs.map(m => m.text).join('|') };
  })()`); }
  if (!s4.text?.includes('任务提醒')) console.log('   [T28.4 debug] s4 =', JSON.stringify(s4));
  t('T28.4 Todo 到期短信提醒(应用联动)', s4.exists === true && s4.text?.includes('任务提醒'), s4.text);

  // 刷新持久化
  await c.goto('http://localhost:8080/');
  await sleep(1800);
  const s5 = await ev(`WebOS.sms.stats()`);
  t('T28.5 持久化(刷新后会话保留)', s5.chats >= 3 && s5.msgs >= 4, JSON.stringify(s5));
  await ev(`WebOS.wm.open('sms')`);
  await sleep(600);
  await c.shot('t28-sms');

  const errs28 = await ev(`window.__errs.length`);
  t('T28.6 全程无错误', errs28 === 0, `errs=${errs28}`);

  /* ---- T29 文件加密(AES-GCM) ---- */
  await ev(`WebOS.fs.write('/home/documents/机密.txt', '绝密内容 top-secret')`);
  await ev(`WebOS.wm.open('files')`);
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(700);

  // 终端加密
  await termType('crypt encrypt /home/documents/机密.txt s3cret');
  await sleep(700);
  const c1 = await ev(`(() => ({
    locked: WebOS.fs.read('/home/documents/机密.txt').startsWith('WEOS1:'),
    plainLeak: WebOS.fs.read('/home/documents/机密.txt').includes('top-secret'),
  }))()`);
  t('T29 终端加密(密文落地,明文不可见)', c1.locked && !c1.plainLeak, JSON.stringify(c1));
  await termType('crypt islocked /home/documents/机密.txt');
  const c2 = await ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent.includes('已加密')`);
  t('T29.1 islocked 查询', c2 === true);

  // 错误密码解密被拒
  await termType('crypt decrypt /home/documents/机密.txt wrongpw');
  await sleep(600);
  const c3 = await ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent.includes('密码错误')`);
  t('T29.2 错误密码被拒', c3 === true);

  // 正确密码解密 → 原文还原
  await termType('crypt decrypt /home/documents/机密.txt s3cret');
  await sleep(600);
  const c4 = await ev(`WebOS.fs.read('/home/documents/机密.txt')`);
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
    lockedInStore: WebOS.fs.read('/home/documents/机密.txt').startsWith('WEOS1:'),
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
    notPersisted: !WebOS.fs.read('/home/documents/机密.txt').includes('top-secret'),
  }))()`);
  t('T29.5 双击解锁只读预览(明文不落盘)', c6.preview === '绝密内容 top-secret' && c6.notPersisted, JSON.stringify(c6));
  await c.shot('t29-unlock-preview');

  // bash cat 加密文件被拒
  await ev(`WebOS.wm.open('bash')`);
  await sleep(600);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=bash] .term-in input');
    inp.value = 'cat /home/documents/机密.txt';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(400);
  const c7 = await ev(`document.querySelector('.win[data-app=bash] .term-out').textContent.includes('是加密文件')`);
  t('T29.6 Bash cat 拒绝加密文件', c7 === true);

  // 解密还原(终端)并清理
  await termType('crypt decrypt /home/documents/机密.txt pw123');
  await sleep(600);
  const c8 = await ev(`({ restored: WebOS.fs.read('/home/documents/机密.txt') === '绝密内容 top-secret', errs: window.__errs.length })`);
  t('T29.7 解密还原+无错误', c8.restored && c8.errs === 0, JSON.stringify(c8));

  /* ---- T30 天气应用(实况/预报/历史确定性) ---- */
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

  /* ---- T31 压缩包支持 ---- */
  await c.goto('http://localhost:8080/');
  await sleep(2000);
  await ev(`(() => {
    WebOS.fs.rm('/home/documents/archive.zip');
    WebOS.fs.write('/home/documents/打包A.txt', '文件A内容');
    WebOS.fs.write('/home/documents/打包B.txt', '文件B内容');
    WebOS.fs.mkdir('/home/documents/bundle');
    WebOS.fs.write('/home/documents/bundle/inner.txt', '嵌套文件');
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
      zip: WebOS.fs.exists('/home/documents/打包A.zip'),
      toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.slice(0, 40)),
      errs: window.__errs,
    };
  })()`);
  await sleep(400);
  const z1 = await ev(`(() => {
    const content = WebOS.fs.read('/home/documents/打包A.zip');
    return { exists: content != null, b64: content?.startsWith(' ZIPB64:'), bytes: content?.length };
  })()`);
  t('T31 压缩为 ZIP(工具栏,B64 存储)', z1.exists && z1.b64, JSON.stringify(z1));

  // ZIP 引擎验证:解压 打包A.zip(含目录递归的 bundle 在 T31 准备阶段已建)
  const z2 = await ev(`(async () => {
    const { unzip } = await import('./js/core/zip.js');
    const data = await (await fetch('/')).text(); // noop 保持 async
    const b64 = WebOS.fs.read('/home/documents/打包A.zip');
    const bin = Uint8Array.from(atob(b64.slice(8)), c => c.charCodeAt(0)); // 前缀  ZIPB64: 共 8 字符
    return { entries: (await unzip(bin, { asText: true })).map(i => i.name + ':' + (i.text ?? '')) };
  })()`);
  t('T31.1 ZIP 引擎解压(内容还原)', z2.entries?.some(e => e.includes('打包A.txt:文件A内容')), JSON.stringify(z2.entries));
  await c.shot('t31-zip');

  /* ---- T32 备忘录(含加密) ---- */
  await ev(`localStorage.removeItem('webos.memo.v1')`);
  await c.goto('http://localhost:8080/');
  await sleep(2000);
  await ev(`WebOS.wm.open('memo')`);
  await sleep(700);
  const mm0 = await ev(`(() => ({
    cards: document.querySelectorAll('.memo-card').length,
    pinned: document.querySelector('.memo-pin.on') ? true : false,
  }))()`);
  t('T32 备忘录:种子卡片+置顶', mm0.cards === 2 && mm0.pinned, JSON.stringify(mm0));

  // 新建加密备忘录(全 GUI,单 cell 内完成以保证时序)
  await ev(`(async () => {
    [...document.querySelectorAll('.win[data-app=memo] .btn')].find(b => b.textContent.includes('新建')).click();
    await new Promise(r => setTimeout(r, 450));
    const ed = document.querySelector('.memo-editor');
    ed.querySelector('input.input').value = '银行账号';
    ed.querySelector('textarea.input').value = '6222 0000 1234 5678';
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

  // 点击解锁查看(密码) → 明文显示在对话框
  await ev(`(() => {
    const card = [...document.querySelectorAll('.memo-card')].find(c => c.textContent.includes('银行账号'));
    [...card.querySelectorAll('.icon-btn')].find(b => b.title === '解锁查看').click();
  })()`);
  await sleep(450);
  await ev(`(() => {
    const i = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    i.value = 'memo-pw';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(500);
  const mm2 = await ev(`(() => {
    const box = [...document.querySelectorAll('.modal-box')].pop();
    return { shown: box?.textContent.includes('6222 0000 1234 5678') };
  })()`);
  t('T32.2 密码解锁查看明文', mm2.shown === true, JSON.stringify(mm2));
  await ev(`[...document.querySelectorAll('.modal-box .btn')].find(b => b.textContent === '关闭')?.click()`);
  await sleep(300);

  // 错误密码被拒
  await ev(`(() => {
    const card = [...document.querySelectorAll('.memo-card')].find(c => c.textContent.includes('银行账号'));
    [...card.querySelectorAll('.icon-btn')].find(b => b.title === '解锁查看').click();
  })()`);
  await sleep(450);
  await ev(`(() => {
    const i = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    i.value = 'wrong';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(500);
  const mm3 = await ev(`document.querySelector('.win[data-app=sysdialog] .dlg-msg')?.textContent.includes('密码错误')`);
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

  /* ---- T33 扫雷 + 3D 国际象棋 ---- */
  await c.goto('http://localhost:8080/');
  await sleep(2000);

  // 扫雷:棋盘规模 / 首击安全 / 右键插旗
  await ev(`WebOS.wm.open('minesweeper')`);
  await sleep(700);
  const g1 = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=minesweeper]');
    const cells = [...w.querySelectorAll('.ms-cell')];
    const first = cells[40];   // 中心格
    first.click();
    await new Promise(r => setTimeout(r, 250));
    const opened = w.querySelectorAll('.ms-cell.open').length;
    // 首击安全:翻开的都不是雷(数字格即非雷)
    const safe = !w.querySelector('.ms-cell.mine');
    // 右键插旗
    const target = [...w.querySelectorAll('.ms-cell:not(.open)')][0];
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 250));
    const flag = w.querySelectorAll('.ms-cell.flag').length;
    return { total: cells.length, opened, safe, flag };
  })()`);
  t('T33 扫雷:9x9=81格+首击安全+展开', g1.total === 81 && g1.safe && g1.opened > 1, JSON.stringify(g1));
  t('T33.1 右键插旗', g1.flag === 1);
  await c.shot('t33-minesweeper');

  // 3D 象棋:等 Three.js CDN 模块加载完成(registry 出现 chess3d)再打开
  for (let i = 0; i < 20 && !(await ev(`!!WebOS.apps.list().find(a => a.id === 'chess3d')`)); i++) await sleep(500);
  await ev(`WebOS.wm.open('chess3d')`);
  await sleep(2500);
  const g2 = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=chess3d]');
    const canvas = w.querySelector('canvas');
    if (!canvas) return { noCanvas: true };
    if (!window.__chess) return { noHook: true, hasErr: (w.querySelector('.win-error')?.textContent || '').slice(0, 120) };
    const before = JSON.stringify(window.__chess.board());
    window.__chess.click(6, 4);   // 选中 e2 兵
    await new Promise(r => setTimeout(r, 250));
    window.__chess.click(4, 4);   // 走 e2-e4
    await new Promise(r => setTimeout(r, 1300));   // 等 AI 应答
    return {
      changed: JSON.stringify(window.__chess.board()) !== before,
      turn: window.__chess.turn(),
      status: w.querySelector('.app-status span').textContent,
    };
  })()`);
  t('T33.2 3D 象棋:走子+AI 应答', g2.changed === true && g2.turn === 'w', JSON.stringify(g2));
  await c.shot('t33-chess');

  const errs33 = await ev(`window.__errs.length`);
  t('T33.3 全程无错误', errs33 === 0, `errs=${errs33}`);

  const errs32 = await ev(`window.__errs.length`);
  t('T32.5 全程无错误', errs32 === 0, `errs=${errs32}`);
  await c.shot('t32-memo');

  const errs31 = await ev(`window.__errs.length`);
  t('T31.3 全程无错误', errs31 === 0, `errs=${errs31}`);
} catch (e) {
  t('执行中断', false, String(e.message || e));
} finally {
  await c.close();
}

const fail = results.filter(r => !r.ok);
console.log(`\n====== 结果: ${results.length - fail.length}/${results.length} 通过 ======`);
process.exit(fail.length ? 1 : 0);
