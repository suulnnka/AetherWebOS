/* ============================================================
 * AetherWebOS e2e 用例组 · 主题与壁纸(T4 T5 T15 T16 T17 T19 T39)
 * 自原 e2e.mjs 单文件按域拆出;公共助手见 tools/e2e-harness.mjs。
 * 本文件只做 group() 注册(被入口 tools/e2e.mjs import),不要直接运行。
 * ============================================================ */
import { group, t, ev, c, fresh, sleep, waitFor, needApps, termType, nav, bashType, bashOut, ctxClick, typeReal, pressEnter, clickReal, wipeAppData, wipeSharedAppData } from '../e2e-harness.mjs';

group('T4', '主题切换(设置→外观→浅色)', async () => {
  /* ---- T4 主题切换(设置→外观→浅色) ---- */
  // 独立运行前置:主题切换需要设置窗口
  await ev(`WebOS.wm.open('settings')`);
  await sleep(500);
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

});

group('T5', '壁纸切换', async () => {
  /* ---- T5 壁纸切换(静态组) ---- */
  // 独立运行前置:壁纸切换需要设置窗口
  await ev(`WebOS.wm.open('settings')`);
  await sleep(500);
  await ev(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('壁纸')).click()`);
  await sleep(200);
  const before = await ev(`getComputedStyle(document.getElementById('wallpaper')).backgroundImage.slice(0,40)`);
  // 静态组里选一个与当前不同的壁纸(避免上次运行持久化导致的"点了同一个")
  const curWall = await ev(`WebOS.settings.get('wallpaperStatic')`);
  const target = curWall === 'ocean' ? 'forest' : 'ocean';
  const NAMES = { ocean: '深海', forest: '青森' };
  await ev(`document.querySelector('.wp-thumb[title="静态壁纸 · ${NAMES[target]}"]').click()`);
  await sleep(400);
  const after = await ev(`(() => ({
    bg: getComputedStyle(document.getElementById('wallpaper')).backgroundImage.slice(0,40),
    stat: WebOS.settings.get('wallpaperStatic'),
    type: WebOS.settings.get('wallpaperType'),
  }))()`);
  t('T5 壁纸切换', before !== after.bg && after.stat === target && after.type === 'static', `${before} → ${after.bg}`);
  await c.shot('t5-wallpaper');

});

group('T15', '风格主题(mac / win98 / winxp / win7)', async () => {
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

});

group('T16', 'Win3.1 / Ubuntu', async () => {
  /* ---- T16 Win3.1 / Ubuntu ---- */
  // 独立运行前置:标题栏检查需要至少一个已打开窗口
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
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

});

group('T17', '霓虹未来', async () => {
  /* ---- T17 霓虹未来 ---- */
  // 独立运行前置:标题栏检查需要至少一个已打开窗口
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
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
  t('T17.2 桌面暗化(无扫描线)', ne.wpOverlay && !ne.scanlines && ne.tbBorderTop !== 'rgba(0, 0, 0, 0)',
    `overlay=${ne.wpOverlay} scan=${ne.scanlines} tbBorder=${ne.tbBorderTop}`);
  await c.shot('t17-neon');
  // 关闭按钮品红霓虹
  await ev(`WebOS.settings.set({ style: 'modern' })`);
  await sleep(350);
  const backMod3 = await ev(`({ attr: document.documentElement.dataset.style, errs: window.__errs.length })`);
  t('T17.3 恢复现代风格', backMod3.attr === 'modern' && backMod3.errs === 0, JSON.stringify(backMod3));

});

group('T19', '霓虹 2.0:每应用灯条 / 流光 / 呼吸 / 悬浮切角任务栏 / 动态桌面', async () => {
  /* ---- T19 霓虹 2.0:每应用灯条 / 流光 / 呼吸 / 悬浮切角任务栏 / 动态桌面 ---- */
  await needApps('monitor', 'music');
  await ev(`WebOS.settings.set({ style: 'neon' })`);
  await ev(`WebOS.wm.open('files'); WebOS.wm.open('monitor')`);
  await sleep(1050);   // 霓虹出场编排 ~0.8s,读完稳态需等它结束
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
      orbsAnim: cs(document.getElementById('desktop'), '::after').animationName,
      sweepAnim: cs(document.getElementById('icons'), '::before').animationName,
      taskNeon: document.querySelector('#tb-tasks .tbtn.active')?.style.getPropertyValue('--neon-a').trim(),
    };
  })()`);
  t('T19 每应用专属灯条色', ne2.filesA === '#ffb400' && ne2.monitorA === '#ff3860' && ne2.filesA !== ne2.monitorA,
    `files=${ne2.filesA} monitor=${ne2.monitorA}`);
  t('T19.1 灯条流光动画', ne2.stripAnim.includes('neonFlow') && ne2.stripSize.includes('200%'), JSON.stringify({ anim: ne2.stripAnim, size: ne2.stripSize }));
  t('T19.2 未聚焦灯条停摆', ne2.unfocusedPaused === 'paused', `playState=${ne2.unfocusedPaused}`);
  t('T19.3 活动窗口呼吸辉光', ne2.breath.includes('neonBreath'), `anim=${ne2.breath}`);
  t('T19.4 任务栏现代深色(全宽+无切角+静态顶线)', !ne2.tbClip && !ne2.tbFloat && ne2.tbStrip === 'none',
    `clip=${ne2.tbClip} float=${ne2.tbFloat} strip=${ne2.tbStrip}`);
  t('T19.5 动态桌面(漂浮光球,无网格/扫描带)', ne2.orbsAnim && ne2.sweepAnim === 'none',
    `orbs=${ne2.orbsAnim} sweep=${ne2.sweepAnim}`);
  t('T19.6 任务栏芯片携带应用霓虹色', ne2.taskNeon === '#ff3860' || ne2.taskNeon === '#ffb400', ne2.taskNeon);
  await c.shot('t19-neon2');
  await ev(`WebOS.settings.set({ style: 'modern' })`);
  await sleep(400);
  const backMod4 = await ev(`({ attr: document.documentElement.dataset.style, errs: window.__errs.length })`);
  t('T19.7 恢复现代风格', backMod4.attr === 'modern' && backMod4.errs === 0, JSON.stringify(backMod4));

});

group('T39', '动态壁纸', async () => {
  /* ---- T39 壁纸:静态静止 / 动态流动 / 分组分开选择与记忆 / 动效开关 ---- */
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);

  // 静态壁纸:完全静止(动态与静态分离后,只有动态壁纸才动)
  const base = await ev(`(() => {
    const wp = document.getElementById('wallpaper');
    const cs = getComputedStyle(wp);
    return { name: cs.animationName, motion: wp.dataset.motion, type: WebOS.settings.get('wallpaperType'), stat: WebOS.settings.get('wallpaperStatic') };
  })()`);
  t('T39.1 静态壁纸默认静止', base.name === 'none' && base.motion === 'none' && base.type === 'static', JSON.stringify(base));

  // 切到流动型动态壁纸(星云):data-motion=flow + 双动画 + 220% 画布
  await ev(`WebOS.settings.set({ wallpaperType: 'dynamic', wallpaperDynamic: 'nebula' })`);
  await sleep(600);
  const flow = await ev(`(() => {
    const wp = document.getElementById('wallpaper');
    const cs = getComputedStyle(wp);
    return {
      motion: wp.dataset.motion,
      names: cs.animationName,
      size: cs.backgroundSize,
      radial: wp.style.background.includes('radial-gradient'),
    };
  })()`);
  t('T39.2 流动型壁纸(星云)生效', flow.motion === 'flow' && /wpPan/.test(flow.names) && /wpFlow/.test(flow.names) && flow.radial === true, JSON.stringify(flow));
  t('T39.3 光斑画布放大 220%', flow.size.includes('220%'), flow.size);
  await c.shot('t39-wallpaper-flow');

  // 分组各自记住选择:切回静态组 → 恢复组内记住的壁纸(静止)
  await ev(`WebOS.settings.set({ wallpaperType: 'static' })`);
  await sleep(500);
  const back = await ev(`(() => {
    const wp = document.getElementById('wallpaper');
    return { motion: wp.dataset.motion, stat: WebOS.settings.get('wallpaperStatic'), size: wp.style.backgroundSize };
  })()`);
  t('T39.4 切回静态组恢复记住的壁纸', back.motion === 'none' && back.stat === base.stat && !back.size, JSON.stringify(back));

  // 再切动态组 → 记住的星云恢复流动
  await ev(`WebOS.settings.set({ wallpaperType: 'dynamic' })`);
  await sleep(500);
  const memo = await ev(`(() => {
    const wp = document.getElementById('wallpaper');
    return { motion: wp.dataset.motion, dyn: WebOS.settings.get('wallpaperDynamic'), names: getComputedStyle(wp).animationName };
  })()`);
  t('T39.5 切回动态组恢复记住的壁纸', memo.motion === 'flow' && memo.dyn === 'nebula' && /wpFlow/.test(memo.names), JSON.stringify(memo));

  // 关闭界面动效 → 壁纸动画一并停用;再恢复
  await ev(`WebOS.settings.set({ effects: false })`);
  await sleep(400);
  const off = await ev(`getComputedStyle(document.getElementById('wallpaper')).animationName`);
  await ev(`WebOS.settings.set({ effects: true })`);
  await sleep(300);
  const on = await ev(`getComputedStyle(document.getElementById('wallpaper')).animationName`);
  t('T39.6 动效开关停用/恢复壁纸动画', off === 'none' && /wpPan/.test(on), `off=${off}, on=${on}`);
  await ev(`WebOS.settings.set({ wallpaperType: 'static', wallpaperStatic: ${JSON.stringify(base.stat === 'aurora' ? 'sunset' : 'aurora')} })`);
  await sleep(300);

  const errs39 = await ev(`window.__errs.length`);
  t('T39.6 全程无错误', errs39 === 0, `errs=${errs39}`);
});
