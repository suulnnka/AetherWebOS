/* ============================================================
 * AetherWebOS e2e 用例组 · 虚拟网络 · 终端 · 浏览器(T9 T18 T20 T47 T51 T55 T56 T58 T59)
 * 自原 e2e.mjs 单文件按域拆出;公共助手见 tools/e2e-harness.mjs。
 * 本文件只做 group() 注册(被入口 tools/e2e.mjs import),不要直接运行。
 * ============================================================ */
import { group, t, ev, c, fresh, sleep, waitFor, needApps, termType, nav, bashType, bashOut, ctxClick, typeReal, pressEnter, clickReal, wipeAppData, wipeSharedAppData } from '../e2e-harness.mjs';

group('T9', '终端 + IPC 演示', async () => {
  /* ---- T9 终端 + IPC 演示 ---- */
  await needApps('monitor');
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  await termType('notify 你好 AetherWebOS');
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

});

group('T18', '虚拟网络:DNS / curl / SSH / 浏览器谜题全链路', async () => {
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
  const got = await ev(`WebOS.fs.exists(WebOS.fs.homePath()+'/downloads/notes.txt')`);
  t('T18.7 远程下载到本机(IPC 联动)', got === true);
  await termType('status');
  const statusRun = await ev(`document.querySelector('.term-out').textContent.includes('维护锁已释放')`);
  t('T18.8 服务器自定义命令', statusRun === true);
  await termType('exit');
  await sleep(300);
  const exited = await ev(`document.querySelector('.t-prompt').textContent.includes('@aetherwebos:')`);
  t('T18.9 SSH 退出', exited === true);
  await c.shot('t18-terminal-ssh');

  // 浏览器:门户 → 关于 → 图书馆登录 → 隐藏站 → 真实 PDF 代理
  await ev(`WebOS.wm.open('browser')`);
  await sleep(600);
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
  // 键盘式登录(AetherJS 模板白名单无表单元素,数字键即链接,口令累积在查询串)
  await ev(`[...document.querySelectorAll('.vw-page .vp-key')].find(a => a.textContent.trim() === '5').click()`);
  await sleep(1500);
  const kp = await ev(`(() => {
    const p = document.querySelector('.vw-page');
    const zero = [...p.querySelectorAll('.vp-key')].find(a => (a.getAttribute('href') || '').includes('pass=50'));
    return { masked: p.textContent.includes('●'), zeroOk: !!zero };
  })()`);
  t('T18.12 图书馆键盘式口令输入(● 掩码 + 链接累积)', kp.masked === true && kp.zeroOk === true,
    JSON.stringify(kp));
  await c.shot('t18-browser-keypad');
  // 错误口令(等价于按键后点「登录」,走查询串提交)
  await nav('library.nexus/?user=reader&pass=00000&go=1');
  const wrong = await ev(`document.querySelector('.vw-page').textContent.includes('口令错误')`);
  t('T18.13 图书馆错误口令被拒', wrong === true);
  // 正确口令(谜题答案 52831;口令数字即键盘按键序列)→ 置位 + 重定向回干净地址
  await nav('library.nexus/?user=reader&pass=52831');
  await sleep(1200);   // 重定向链:登录请求 → / 干净地址(多一轮完整加载)
  const loginOk = await ev(`(() => {
    const p = document.querySelector('.vw-page');
    const addr = document.querySelector('.vw-addr').value;
    return { in: p.textContent.includes('researcher') && p.textContent.includes('h3ll0w'),
             clean: !addr.includes('pass=') };
  })()`);
  const flagLib = await ev(`WebOS && document.documentElement && JSON.parse(localStorage.getItem('webos.vnet.v1')||'{}').flags.library_ok === true`);
  t('T18.14 图书馆口令谜题(SSH 凭据泄露 + 标志位 + 干净地址)', loginOk.in === true && flagLib === true && loginOk.clean === true,
    `page=${loginOk.in} flag=${flagLib} clean=${loginOk.clean}`);
  await c.shot('t18-browser-login');
  // 登录态写在玩家进度:重新访问干净地址,condition 路由直接给会员视图(无键盘)
  await nav('library.nexus');
  const revisited = await ev(`(() => {
    const p = document.querySelector('.vw-page');
    return { loggedIn: p.textContent.includes('researcher'), noKeypad: !p.querySelector('.vp-keypad') };
  })()`);
  t('T18.15 登录态由玩家进度判定(重访即会员视图)', revisited.loggedIn === true && revisited.noKeypad === true,
    JSON.stringify(revisited));

  // 未授权直接访问 blackout → 403 应已被 library_ok 解锁(已登录)→ 首页可见
  await nav('blackout.nexus');
  const blackout = await ev(`document.querySelector('.vw-page').textContent.includes('BLACKOUT 档案馆')`);
  t('T18.16 隐藏站(凭据门禁)', blackout === true);
  // 打开路径转换的 PDF
  await ev(`[...document.querySelectorAll('.vw-page a')].find(a => a.getAttribute('href') === '/archive.pdf').click()`);
  await sleep(1600);
  const proxied = await ev(`(() => {
    const f = document.querySelector('.vw-iframe');
    return !f.hidden && (f.src || '').includes('w3.org');
  })()`);
  const questDone = await ev(`JSON.parse(localStorage.getItem('webos.vnet.v1')||'{}').flags.quest_done === true`);
  const toastWin = await ev(`document.querySelector('#toasts .toast')?.textContent.includes('谜题完成')`);
  t('T18.17 路径转换(虚拟 URL → 真实 PDF iframe)', proxied === true);
  t('T18.18 通关标志位与通知', questDone === true, `toast=${toastWin}`);
  await c.shot('t18-browser-proxy-pdf');

  // 自动分流:真实域名(虚拟 DNS 无记录)直达外网 iframe
  await nav('www.google.com');
  const routed = await ev(`(() => {
    const f = document.querySelector('.vw-iframe');
    const tab = document.querySelector('.vw-tab.active');
    return { out: !!tab && tab.classList.contains('net-out'),
             src: f && !f.hidden ? (f.src || '') : '' };
  })()`);
  t('T18.19 真实域名自动分流到外网(DNS 判定)',
    routed.out === true && routed.src.startsWith('https://www.google.com'), JSON.stringify(routed));

  // 搜索引擎:地址栏输入非 URL 关键词 → 改道内网搜索(Firefox 式)
  await nav('图书馆 口令');
  const searched = await ev(`(() => {
    const p = document.querySelector('.vw-page');
    const addr = document.querySelector('.vw-addr').value;
    return { onSearch: addr.includes('search.nexus/search/'), hit: p.textContent.includes('找到约'),
             goto: !!p.querySelector('.vp-hit-title a') };
  })()`);
  t('T18.20 地址栏搜索改道(打分排序 + 摘要)', searched.onSearch === true && searched.hit === true, JSON.stringify(searched));
  await c.shot('t18-browser-search');
  // 搜索结果跨主机跳转(模板只能相对链接 → /goto/ 中转)
  await ev(`document.querySelector('.vw-page .vp-hit-title a').click()`);
  await sleep(2600);   // goto 重定向 + 目标页加载(目标站可能首访挂载)
  const jumped = await ev(`(() => {
    const p = document.querySelector('.vw-page');
    const addr = document.querySelector('.vw-addr').value;
    const t = p.textContent;
    // 图书馆此刻已登录(进度判定)→ 会员视图;未登录流程则落登录页
    return { addr, portal: t.includes('馆际互借备忘') || t.includes('数字图书馆') || t.includes('NEXUS 集团内网门户') };
  })()`);
  t('T18.21 搜索结果跨站跳转(/goto/ 中转)', jumped.portal === true && !jumped.addr.includes('goto'), JSON.stringify(jumped));

  const errs18 = await ev(`window.__errs.length`);
  t('T18.22 全程无运行错误', errs18 === 0, `errs=${errs18}`);

});

group('T20', '终端(Bash):Linux 指令 / 管道 / 重定向 / 虚拟网络', async () => {
  /* ---- T20 终端(Bash):Linux 指令 / 管道 / 重定向 / 虚拟网络 ---- */
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(600);

  const b0 = await bashOut();
  const b0prompt = await ev(`document.querySelector('.win[data-app=terminal] .t-prompt').textContent`);
  t('T20.0 Bash 启动(唯一 shell)', b0.includes('GNU Bash 5.2') && b0prompt.includes('@aetherwebos:'), `prompt=${b0prompt}`);

  await bashType('ls ~');
  const b1 = await bashOut();
  t('T20 Bash ls', b1.includes('documents/') && b1.includes('downloads/') && b1.includes('desktop/'), 'ls ~ ✓');

  await bashType('echo hello-bash > ~/bash_t.txt');
  await bashType('cat ~/bash_t.txt');
  const b2 = await bashOut();
  const b2fs = await ev(`WebOS.fs.read(WebOS.fs.homePath()+'/bash_t.txt')`);
  t('T20.1 重定向落地文件系统', b2.includes('hello-bash') && b2fs === 'hello-bash\n', `fs=${JSON.stringify(b2fs)}`);

  await bashType('ls ~ | grep doc');
  const b3 = await bashOut();
  await bashType('ls ~ | wc -l');
  const b4 = await bashOut();
  const wcNum = Number((/wc -l\D*(\d+)/.exec(b4) || [])[1] || 0);
  t('T20.2 管道 grep/wc', b3.includes('documents/') && wcNum >= 3, `wc -l = ${wcNum}`);

  await bashType('uname -a');
  const b5 = await bashOut();
  t('T20.3 uname -a', b5.includes('6.1.0-aetherwebos'), '');

  await bashType('sudo rm -rf /');
  const b6 = await bashOut();
  t('T20.4 未知命令拒绝(sudo)', b6.includes('bash: sudo: command not found'), '');

  await bashType('ifconfig');
  const b7 = await bashOut();
  t('T20.5 虚拟网络命令(ifconfig)', b7.includes('eth0: 10.0.0.2'), '');

  await bashType('rm ~/bash_t.txt');
  await bashType('cat ~/bash_t.txt');
  const b8 = await bashOut();
  t('T20.6 rm 与错误提示', b8.includes('没有那个文件或目录'), '');

  await bashType('find ~ -name "*.txt"');
  const b9 = await bashOut();
  const homeDocs = await ev(`WebOS.fs.homePath()+'/documents/'`);
  t('T20.7 find 通配符', b9.includes(homeDocs), b9.slice(-80));

  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=terminal] .term-in input');
    inp.value = 'ec';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  })()`);
  const bTab = await ev(`document.querySelector('.win[data-app=terminal] .term-in input').value`);
  t('T20.8 Tab 补全命令名', bTab === 'echo ', `value=${JSON.stringify(bTab)}`);
  await c.shot('t20-bash');

  await bashType('exit');
  await sleep(400);
  const bExit = await ev(`document.querySelectorAll('.win[data-app=terminal]').length`);
  t('T20.9 exit 关闭终端窗口', bExit === 0, `wins=${bExit}`);

});

group('T47', '浏览器多标签与内外网自动分流', async () => {
  /* ---- T47 浏览器:多标签页;地址按虚拟 DNS 自动分流——
   * 能解析 → 内网(虚拟网络游戏世界),不能 → 直达真实互联网;
   * 标签页随当前页面所在网络变色(内网青 / 外网琥珀 / 起始页中性) ---- */
  await fresh();

  await ev(`WebOS.wm.open('browser')`);
  await sleep(700);
  t('T47.1 初始单标签(起始页)',
    await ev(`document.querySelectorAll('.vw-tab').length === 1 &&
      document.querySelector('.vw-page').textContent.includes('NEXUS 导航')`));

  // 新建标签页
  await ev(`document.querySelector('.vw-tab-plus').click()`);
  await sleep(400);
  t('T47.2 新建标签页(唯一激活)',
    await ev(`document.querySelectorAll('.vw-tab').length === 2 &&
      [...document.querySelectorAll('.vw-tab')].filter(x => x.classList.contains('active')).length === 1`));

  // 内网域名(DNS 可解析)→ 虚拟网络页面
  await nav('portal.nexus');
  const inState = await ev(`(() => ({
    tab: document.querySelector('.vw-tab.active').classList.contains('net-in'),
    page: document.querySelector('.vw-page').textContent.includes('NEXUS 集团内网门户'),
    frameHidden: document.querySelector('.vw-iframe').hidden,
  }))()`);
  t('T47.3 内网域名走虚拟网络', inState.tab && inState.page && inState.frameHidden,
    JSON.stringify(inState));

  // 真实域名(DNS 无记录)→ 自动转外网 iframe,同一标签换琥珀色
  await nav('example.com');
  const outState = await ev(`(() => ({
    tab: document.querySelector('.vw-tab.active').classList.contains('net-out'),
    title: document.querySelector('.vw-tab.active .vw-tab-title').textContent,
    src: (() => { const f = document.querySelector('.vw-iframe'); return !f.hidden ? (f.src || '') : ''; })(),
    sandbox: (() => { const s = document.querySelector('.vw-iframe')?.getAttribute('sandbox') || ''; return s.includes('allow-scripts') && !s.includes('allow-top-navigation'); })(),
  }))()`);
  t('T47.4 同一标签按地址自动切外网(变琥珀色,sandbox 防顶层劫持)',
    outState.tab === true && outState.src.startsWith('https://example.com') && outState.sandbox === true,
    JSON.stringify(outState));

  // 后退:回到内网门户,标签恢复内网色
  await ev(`document.querySelector('.win[data-app=browser] .app-toolbar .btn[title="后退"]').click()`);
  await sleep(1300);
  t('T47.5 后退回内网页(标签恢复内网色)',
    await ev(`document.querySelector('.vw-tab.active').classList.contains('net-in') &&
      document.querySelector('.vw-page').textContent.includes('NEXUS 集团内网门户')`));

  // 再开一个标签页访问外网:两类标签颜色不同(圆点 computed style)
  await ev(`document.querySelector('.vw-tab-plus').click()`);
  await sleep(300);
  await nav('example.com');
  const colors = await ev(`(() => {
    const a = document.querySelector('.vw-tab.net-in .vw-tab-dot');
    const b = document.querySelector('.vw-tab.net-out .vw-tab-dot');
    return a && b ? [getComputedStyle(a).backgroundColor, getComputedStyle(b).backgroundColor] : null;
  })()`);
  t('T47.6 内外网标签颜色不同', Array.isArray(colors) && colors[0] !== colors[1],
    JSON.stringify(colors));

  // Firefox:滚轮在标签栏上切换标签(未溢出时向上滚 → 上一个)
  const wheelIdx = await ev(`(() => {
    const s = document.querySelector('.vw-tabs-scroll');
    s.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    return [...document.querySelectorAll('.vw-tab')].findIndex(t => t.classList.contains('active'));
  })()`);
  t('T47.7 滚轮切换标签(Firefox)', wheelIdx === 1, `idx=${wheelIdx}`);

  // Firefox:拖拽标签排序(CDP 真实鼠标:把中间的门户标签拖到最右)
  const rects = await ev(`(() =>
    [...document.querySelectorAll('.win[data-app=browser] .vw-tab')]
      .map(t => { const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
  )()`);
  const dr1 = rects[1], dr2 = rects[2];
  const sx = Math.round(dr1.x + dr1.w / 2), sy = Math.round(dr1.y + dr1.h / 2);
  const ex = Math.round(dr2.x + dr2.w - 8);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 6; k++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(sx + (ex - sx) * k / 6), y: sy, button: 'left', buttons: 1 });
    await sleep(40);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: sy, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(300);
  const order = await ev(`[...document.querySelectorAll('.vw-tab .vw-tab-title')].map(t => t.textContent)`);
  const actIdx = await ev(`[...document.querySelectorAll('.vw-tab')].findIndex(t => t.classList.contains('active'))`);
  t('T47.8 拖拽标签排序(Firefox)', order[order.length - 1] === 'NEXUS 内网门户' && actIdx === order.length - 1,
    `${order.join('|')} act=${actIdx}`);

  // 标签右键菜单
  await ev(`(() => {
    const tab = document.querySelector('.vw-tab.active');
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 150 }));
  })()`);
  const tabMenu = await ev(`[...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim())`);
  t('T47.9 标签右键菜单(含复制标签页)',
    (tabMenu || []).includes('关闭标签页') && (tabMenu || []).includes('关闭其他标签页') && (tabMenu || []).includes('复制标签页'),
    JSON.stringify(tabMenu));
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('关闭其他')).click()`);
  await sleep(300);
  t('T47.10 关闭其他标签页', await ev(`document.querySelectorAll('.vw-tab').length === 1 &&
    document.querySelector('.vw-tab').classList.contains('net-in')`));

  // Firefox:标签静音(内网页面的 audio/video 可控;跨源外网页面无法编程静音)
  const muted = await ev(`(async () => {
    const tab = document.querySelector('.vw-tab.active');
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 150 }));
    const items = [...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim());
    const has = items.includes('静音标签页');
    [...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('静音标签页'))?.click();
    await new Promise(r => setTimeout(r, 150));
    return { has, badge: !!document.querySelector('.vw-tab .vw-tab-mute') };
  })()`);
  t('T47.11 标签静音(Firefox)', muted.has && muted.badge, JSON.stringify(muted));

  // Firefox:点击地址栏即全选(用户路径;focus 事件在无头环境不派发,不作为断言路径)
  const sel = await ev(`(() => {
    const a = document.querySelector('.vw-addr');
    a.click();
    return { s: a.selectionStart, e: a.selectionEnd, len: a.value.length };
  })()`);
  t('T47.12 地址栏聚焦全选(Firefox)', sel.s === 0 && sel.e === sel.len && sel.len > 0, JSON.stringify(sel));

  // Firefox:Esc 还原地址栏为当前地址(当前停留在内网门户)
  const esc = await ev(`(() => {
    const a = document.querySelector('.vw-addr');
    a.value = 'modified-input';
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return a.value;
  })()`);
  t('T47.13 Esc 还原地址栏(Firefox)', esc === 'portal.nexus', esc);
  await c.shot('t47-browser-tabs');

  // Firefox:关闭最后一个标签页即关闭窗口
  await ev(`document.querySelector('.vw-tab .vw-tab-x').click()`);
  await sleep(500);
  t('T47.14 关闭最后一个标签页关闭窗口',
    await ev(`!document.querySelector('.win[data-app=browser]')`));

  const errs47 = await ev(`window.__errs.length`);
  t('T47.15 全程无运行错误', errs47 === 0, `errs=${errs47}`);
});

group('T51', '浏览器收藏(星标 / 收藏夹面板 / 起始页卡片 / Ctrl+D / 持久化)', async () => {
  /* ---- T51 浏览器收藏:Firefox 式书签 —— 地址栏旁星标一键收藏,已收藏时
   * 星标菜单改名/删除;收藏夹面板逐条管理(跳转/改名/移除);起始页出现
   * 收藏卡片;Ctrl+D 收藏;数据按用户落 ~/appdata/browser.awdb,重载仍在 ---- */

  // 前置:钉住登录用户(收藏按用户存储;未登录仅会话内存态)+ 清所有用户收藏库
  await ev(`(async () => {
    const a = WebOS.accounts;
    if (!a.current()) {
      if (!(await a.login('user', '1234')).ok) {
        await a.register('surfer', 'surferpass');
        await a.login('surfer', 'surferpass');
      }
    }
    return true;
  })()`);
  await wipeSharedAppData('browser');   // 清各用户 browser.awdb,断言不累积历史
  await fresh();
  await ev(`WebOS.wm.open('browser')`);
  await sleep(700);

  // 起始页星标置灰,进入可收藏页面后可用
  const starStart = await ev(`document.querySelector('.vw-star').disabled`);
  await nav('portal.nexus');
  const starNow = await ev(`!document.querySelector('.vw-star').disabled && !document.querySelector('.vw-star').classList.contains('on')`);
  t('T51 星标:起始页置灰,门户页可用且未点亮', starStart === true && starNow === true);

  // 星标一键收藏(Firefox:点击即收藏,星标点亮,状态栏反馈)
  await ev(`document.querySelector('.vw-star').click()`);
  await sleep(200);
  const s1 = await ev(`(() => ({
    on: document.querySelector('.vw-star').classList.contains('on'),
    title: document.querySelector('.vw-star').title,
    status: document.querySelector('.app-status span').textContent,
  }))()`);
  t('T51.1 星标一键收藏(点亮+状态反馈)', s1.on === true && s1.status.includes('已收藏'),
    JSON.stringify(s1));

  // 已收藏:再点星标 → 编辑菜单(改名 / 删除)
  await ev(`document.querySelector('.vw-star').click()`);
  await sleep(200);
  const starMenu = await ev(`[...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim())`);
  t('T51.2 已收藏星标菜单(编辑/删除)', starMenu.includes('编辑名称…') && starMenu.includes('删除收藏'),
    JSON.stringify(starMenu));
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('编辑名称')).click()`);
  await sleep(400);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=sysdialog] .dlg-input');
    inp.value = '内网门户';
    return [...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')]
      .find(b => b.textContent.trim() === '确定').click();
  })()`);
  await sleep(400);

  // 收藏夹面板:列表 + 改名生效 + 计数
  await ev(`document.querySelector('.vw-bm-btn').click()`);
  await sleep(200);
  const pop1 = await ev(`(() => ({
    open: !!document.querySelector('.vw-bm-pop'),
    names: [...document.querySelectorAll('.vw-bm-pop .vw-bm-name')].map(n => n.textContent),
    head: document.querySelector('.vw-bm-pop .vw-bm-head')?.textContent.trim(),
    dot: document.querySelector('.vw-bm-pop .vw-bm-row .vw-tab-dot')?.className || '',
  }))()`);
  t('T51.3 收藏夹面板列出收藏(改名生效/内网圆点)',
    pop1.open && pop1.names.length === 1 && pop1.names[0] === '内网门户'
    && pop1.head === '收藏 1' && pop1.dot.includes('net-in'),
    JSON.stringify(pop1));

  // 面板行点击 → 当前标签跳转并关面板
  await nav('example.com');
  await ev(`document.querySelector('.vw-bm-btn').click()`);
  await sleep(200);
  await ev(`document.querySelector('.vw-bm-pop .vw-bm-row').click()`);
  await sleep(1400);
  const jump = await ev(`(() => ({
    page: document.querySelector('.vw-page').textContent.includes('NEXUS 集团内网门户'),
    pop: !!document.querySelector('.vw-bm-pop'),
  }))()`);
  t('T51.4 面板行点击跳转(面板关闭)', jump.page === true && jump.pop === false, JSON.stringify(jump));

  // 起始页收藏卡片 + 卡片链接跳转
  await ev(`[...document.querySelectorAll('.win[data-app=browser] .app-toolbar .btn')].find(b => b.title === '起始页').click()`);
  await sleep(600);
  const card = await ev(`(() => {
    const c = [...document.querySelectorAll('.vw-page .vp-card')]
      .find(r => r.querySelector('.vp-card-title')?.textContent.includes('收藏'));
    return { has: !!c, link: c?.querySelector('.vw-link')?.textContent, href: c?.querySelector('.vw-link')?.getAttribute('href') };
  })()`);
  t('T51.5 起始页收藏卡片', card.has === true && card.link === '内网门户' && card.href === 'http://portal.nexus',
    JSON.stringify(card));
  await ev(`[...document.querySelectorAll('.vw-page a')].find(a => a.textContent === '内网门户').click()`);
  await sleep(1400);
  t('T51.6 卡片链接跳转', await ev(`document.querySelector('.vw-page').textContent.includes('NEXUS 集团内网门户')`));

  // 页面右键:已收藏 → 移除收藏入口(不再重复收藏)
  await ev(`document.querySelector('.vw-page').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }))`);
  const pgMenu = await ev(`[...document.querySelectorAll('#ctx .ctx-item')].map(b => b.textContent.trim())`);
  t('T51.7 页面右键出现「移除收藏」', pgMenu.includes('移除收藏') && !pgMenu.includes('收藏此页'),
    JSON.stringify(pgMenu));
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);   // 点外部关菜单
  await sleep(150);

  // Ctrl+D 收藏当前页(Firefox),收藏数变 2
  await nav('example.com');
  // 对话框关闭后 .focused 不自动归还:先在窗口上按一下(pointerdown 捕获监听 → focus)
  await ev(`document.querySelector('.win[data-app=browser]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(100);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await sleep(250);
  const ctrlD = await ev(`(() => ({
    on: document.querySelector('.vw-star').classList.contains('on'),
    n: document.querySelectorAll('.vw-tab').length,
  }))()`);
  t('T51.8 Ctrl+D 收藏当前页', ctrlD.on === true, JSON.stringify(ctrlD));

  // 面板逐条移除 → 清空后空态提示;星标随移除熄灭
  await ev(`document.querySelector('.vw-bm-btn').click()`);
  await sleep(200);
  const cnt1 = await ev(`document.querySelectorAll('.vw-bm-pop .vw-bm-row').length`);
  await ev(`[...document.querySelectorAll('.vw-bm-pop .vw-bm-act')].find(b => b.title === '移除收藏').click()`);
  await sleep(200);
  const after = await ev(`(() => ({
    rows: document.querySelectorAll('.vw-bm-pop .vw-bm-row').length,
    empty: !!document.querySelector('.vw-bm-pop .vw-bm-empty'),
  }))()`);
  t('T51.9 面板移除一条', cnt1 === 2 && after.rows === 1 && after.empty === false, `${cnt1}→${after.rows}`);
  await ev(`[...document.querySelectorAll('.vw-bm-pop .vw-bm-act')].find(b => b.title === '移除收藏').click()`);
  await sleep(300);
  const empty2 = await ev(`(() => ({
    empty: !!document.querySelector('.vw-bm-pop .vw-bm-empty'),
    addBtn: !!document.querySelector('.vw-bm-pop .vw-bm-add'),
    starOn: document.querySelector('.vw-star').classList.contains('on'),
  }))()`);
  t('T51.10 清空后空态(含收藏当前页按钮),星标熄灭',
    empty2.empty === true && empty2.addBtn === true && empty2.starOn === false, JSON.stringify(empty2));
  // 空态「收藏当前页」一键收藏
  await ev(`document.querySelector('.vw-bm-pop .vw-bm-add').click()`);
  await sleep(200);
  const readd = await ev(`document.querySelectorAll('.vw-bm-pop .vw-bm-row').length`);
  t('T51.11 空态一键收藏当前页', readd === 1, `rows=${readd}`);
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);   // 点外部关面板
  await sleep(150);
  t('T51.12 点外部关闭面板', await ev(`!document.querySelector('.vw-bm-pop')`));

  // 持久化:收藏门户页 → 刷新系统 → 重开浏览器 → 收藏仍在(按用户 ~/appdata/browser.awdb)
  await nav('portal.nexus');
  await ev(`document.querySelector('.vw-star').click()`);
  await sleep(400);   // 等 200ms 防抖保存
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=browser]').dataset.id)`);
  await sleep(300);
  await ev(`(async () => { await WebOS.fs.flush(); return true; })()`);   // 落盘元数据在刷新前写进 OPFS
  await fresh();
  await ev(`WebOS.wm.open('browser')`);
  await sleep(700);
  await nav('portal.nexus');
  const persist = await ev(`(() => ({
    on: document.querySelector('.vw-star').classList.contains('on'),
    db: WebOS.fs.exists('/home/' + WebOS.accounts.current() + '/appdata/browser.awdb'),
  }))()`);
  t('T51.13 收藏持久化(重载后仍在/库已落盘)', persist.on === true && persist.db === true,
    JSON.stringify(persist));
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=browser]').dataset.id)`);

  const errs51 = await ev(`window.__errs.length`);
  t('T51.14 全程无运行错误', errs51 === 0, `errs=${errs51}`);
});

group('T55', '浏览器历史(访问记录 / 面板管理 / 起始页卡片 / Ctrl+H / 持久化)', async () => {
  /* ---- T55 历史:页面加载完成即记录(重访累计次数),面板删除/清空,跨重载持久化 ---- */
  const u55 = await ev(`WebOS.accounts.current()`);
  await wipeAppData(u55, 'browser');   // 收藏+历史同库同档:清档从零起测
  await ev(`WebOS.wm.open('browser')`);
  await sleep(700);

  const nav = async (q) => {
    await ev(`(() => {
      const a = document.querySelector('.win[data-app=browser] .vw-addr');
      a.value = ${JSON.stringify(q)};
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(1900);   // 模拟 DNS→连接→响应 ≈ 720ms + 渲染余量
  };
  const closePops = () => ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  const histRows = () => ev(`(() => [...document.querySelectorAll('.vw-bm-pop .vw-bm-row')].map(r => ({
    name: r.querySelector('.vw-bm-name').textContent,
    url: r.querySelector('.vw-bm-url').textContent,
    time: r.querySelector('.vw-bm-time')?.textContent || '',
  })))()`);

  await nav('portal.nexus');
  await ev(`document.querySelector('.win[data-app=browser] .vw-hist-btn').click()`);
  await sleep(200);
  const rows1 = await histRows();
  t('T55 访问即记录(门户一条,带今天时间)',
    rows1.length === 1 && rows1[0].name === 'NEXUS 内网门户' && /^portal\.nexus\/?$/.test(rows1[0].url)
      && /^\d{2}:\d{2}$/.test(rows1[0].time),
    JSON.stringify(rows1));

  // 重访同址:仍是一条,次数累计为 ×2
  await closePops();
  await nav('portal.nexus');
  await ev(`document.querySelector('.win[data-app=browser] .vw-hist-btn').click()`);
  await sleep(200);
  const rows2 = await histRows();
  t('T55.1 重访累计次数(一条记录 ×2)', rows2.length === 1 && /2 次$/.test(rows2[0].time), JSON.stringify(rows2));
  await closePops();
  await sleep(150);

  // Ctrl+H 开面板(Esc 关闭)
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await sleep(150);
  const byKey = await ev(`!!document.querySelector('.vw-bm-pop')`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(150);
  t('T55.2 Ctrl+H 开关历史面板(Esc 关闭)', byKey === true
    && await ev(`!document.querySelector('.vw-bm-pop')`) === true);

  // 起始页「最近访问」卡片(回起始页后可见)
  await ev(`[...document.querySelectorAll('.win[data-app=browser] .vw-toolbar .btn.icon')].find(b => b.title === '起始页').click()`);
  await sleep(400);
  const card = await ev(`(() => {
    const c = [...document.querySelectorAll('.win[data-app=browser] .vp-card')]
      .find(x => x.querySelector('.vp-card-title')?.textContent === '最近访问');
    return { has: !!c, links: c ? [...c.querySelectorAll('a')].map(a => a.textContent) : [] };
  })()`);
  t('T55.3 起始页「最近访问」卡片', card.has === true && card.links.includes('NEXUS 内网门户'),
    JSON.stringify(card));

  // 面板移除单条 → 空态
  await ev(`document.querySelector('.win[data-app=browser] .vw-hist-btn').click()`);
  await sleep(200);
  await ev(`document.querySelector('.vw-bm-pop .vw-bm-act[title="移除该记录"]').click()`);
  await sleep(200);
  const empty1 = await ev(`(() => ({
    empty: !!document.querySelector('.vw-bm-pop .vw-bm-empty'),
    rows: document.querySelectorAll('.vw-bm-pop .vw-bm-row').length,
  }))()`);
  t('T55.4 面板移除单条(空态)', empty1.empty === true && empty1.rows === 0, JSON.stringify(empty1));
  await closePops();

  // 持久化:再访图书馆 → 刷新 → 重开浏览器 → 记录仍在、库已落盘
  await nav('library.nexus');
  await sleep(300);
  await ev(`(async () => { await WebOS.fs.flush(); return true; })()`);
  await fresh();
  await ev(`WebOS.wm.open('browser')`);
  await sleep(900);   // 等历史水合(同收藏)
  await ev(`document.querySelector('.win[data-app=browser] .vw-hist-btn').click()`);
  await sleep(200);
  const rows3 = await histRows();
  t('T55.5 跨重载持久化(重开后仍在/库已落盘)',
    rows3.length === 1 && rows3[0].name === 'NEXUS 数字图书馆'
      && await ev(`WebOS.fs.exists('/home/' + WebOS.accounts.current() + '/appdata/browser.awdb')`) === true,
    JSON.stringify(rows3));

  // 清空历史
  await ev(`document.querySelector('.vw-bm-pop .vw-bm-add').click()`);
  await sleep(200);
  t('T55.6 清空历史', await ev(`!!document.querySelector('.vw-bm-pop .vw-bm-empty')`) === true);
  await closePops();
  await sleep(150);

  const errs55 = await ev(`window.__errs.length`);
  t('T55.7 全程无运行错误', errs55 === 0, `errs=${errs55}`);
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=browser]').dataset.id)`);
});

group('T56', '模拟远程终端(认证 / 远端文件系统 / 权限 / 传输 / 跳板 / 多会话 / 持久化)', async () => {
  /* ---- T56 模拟远程终端:core/vssh.js 引擎 + 实训靶机 lab.nexus ---- */
  await ev(`WebOS.vnet.resetState()`);   // 清掉上次远端改动(覆盖层/活动树)
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);

  /* 在第 idx 个终端窗口输入(多会话场景;断言只看「新增」输出,防累积误判) */
  const typeIn = async (idx, cmd) => {
    await ev(`(() => {
      const w = document.querySelectorAll('.win[data-app=terminal]')[${idx}];
      const inp = w.querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(340);
  };
  const winText = (idx) => ev(`document.querySelectorAll('.win[data-app=terminal] .term-out')[${idx}].textContent`);
  const winPrompt = (idx) => ev(`document.querySelectorAll('.win[data-app=terminal] .t-prompt')[${idx}].textContent`);
  let mark = (await winText(0)).length;
  /* 取「新增」输出;密码提示行被收回时 textContent 变短 → 整段重看(只用于 includes 断言) */
  const diffFrom = (s, m) => (s.length >= m ? s.slice(m) : s);
  const run = async (cmd) => { await typeIn(0, cmd); const s = await winText(0); const fresh = diffFrom(s, mark); mark = s.length; return fresh; };

  // 本机准备上传素材
  await run('echo marker-up-42 > ~/desktop/up.txt');

  // 1) 登录认证:掩码 → 错口令被拒(可重试)→ 正确口令进入
  await run('ssh guest@lab.nexus');
  const masked = await ev(`document.querySelector('.win[data-app=terminal] .term-in input').type === 'password'`);
  await run('wrongpass');
  const denied = (await winText(0)).includes('Permission denied, please try again.');   // 首次出现,查全文(密码提示行被收回,差分切片会错位)
  await run('guest');
  const labPrompt = await winPrompt(0);
  t('T56 SSH 登录认证(掩码 / 错口令被拒 / 家目录 ~ 提示符)',
    masked && denied && labPrompt.includes('[guest@lab ~]$'), JSON.stringify({ masked, denied, labPrompt }));

  // 2) 远端读 + 权限机关:shadow 仅 root 可读;ls -a 隐藏文件;ls -l 元数据
  const read1 = (await run('cat welcome.txt')).includes('练习模拟远程终端');
  const shadow = await run('cat /etc/shadow');
  const dot = await run('ls -a');
  const long = await run('ls -l /etc');
  t('T56.1 远端读文件与权限机关',
    read1 && shadow.includes('权限不够') && dot.includes('.bashrc')
    && long.includes('-rw-------') && /root\s+root\s+\d+\s+\S+\s+shadow/.test(long),
    JSON.stringify({ read1, shadow: shadow.slice(0, 40), dot: dot.includes('.bashrc') }));

  // 3) 写操作链:echo > 重定向 / mkdir / cp / mv / rm / grep / find
  const w1 = await run('echo hello-lab > hello.txt');   // 重定向:只回显命令行,不吐输出
  const w2 = (await run('cat hello.txt')).includes('hello-lab');
  await run('mkdir docs');
  await run('cp hello.txt docs/copy.txt');
  await run('mv hello.txt docs/moved.txt');
  const lsDocs = await run('ls docs');
  const grepHit = (await run('grep lab docs/copy.txt')).includes('hello-lab');
  const findHit = (await run('find docs -name *.txt')).includes('docs/copy.txt');
  const rmOut = await run('rm docs/moved.txt');
  const lsAfter = await run('ls docs');
  t('T56.2 远端写操作(echo > / mkdir / cp / mv / rm / grep / find)',
    w1.trim().endsWith('echo hello-lab > hello.txt') && w2 && lsDocs.includes('copy.txt') && lsDocs.includes('moved.txt')
    && grepHit && findHit && !rmOut.includes('rm:') && lsAfter.includes('copy.txt') && !lsAfter.includes('moved.txt'),
    JSON.stringify({ w1: w1.trim(), w2, grepHit, findHit }));

  // 4) 传输:put 上传本机文件 / get 下载远端文件(落本机 ~/downloads)
  const putOut = await run('put ~/desktop/up.txt upload.txt');
  const putCat = (await run('cat upload.txt')).includes('marker-up-42');
  await run('get /etc/hosts');
  const hostsLocal = await ev(`(() => {
    const c = WebOS.fs.read(WebOS.fs.homePath() + '/downloads/hosts');
    return c != null && c.includes('router.nexus');
  })()`);
  t('T56.3 传输(put 上传 / get 下载到本机 downloads)',
    putOut.includes('已上传') && putCat && hostsLocal === true, putOut.trim());

  // 5) 多会话:第二个终端窗口连入同一主机,远端文件状态双向实时共享
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(450);
  let mark1 = (await winText(1)).length;
  const run1 = async (cmd) => { await typeIn(1, cmd); const s = await winText(1); const fresh = diffFrom(s, mark1); mark1 = s.length; return fresh; };
  await run1('ssh guest@lab.nexus');
  await run1('guest');
  const prompt1 = await winPrompt(1);
  const cross = await run('echo shared-live-tree > cross.txt');   // 窗口 0 写
  const seeCross = (await run1('cat cross.txt')).includes('shared-live-tree');   // 窗口 1 读
  await run1('echo from-win-1 > back.txt');                        // 窗口 1 写
  const seeBack = (await run('cat back.txt')).includes('from-win-1');   // 窗口 0 读
  t('T56.4 多窗口会话共享远端文件系统', prompt1.includes('[guest@lab') && seeCross && seeBack,
    JSON.stringify({ prompt1, seeCross, seeBack }));

  // 6) 跳板嵌套:lab 会话里 ssh 到 vault,exit 逐层退回(vault → lab → 本地)
  await run('ssh researcher@vault.nexus');
  await run('h3ll0w');
  const vaultPrompt = await winPrompt(0);
  const notes = (await run('cat notes.txt')).includes('blackout.nexus');
  const exit1 = await run('exit');
  const backLab = await winPrompt(0);
  await run('exit');
  const localPrompt = await winPrompt(0);
  t('T56.5 跳板嵌套与逐层退出',
    vaultPrompt.includes('[researcher@vault ~]$') && notes
    && exit1.includes('Connection to vault.nexus closed.') && backLab.includes('[guest@lab')
    && localPrompt.includes('@aetherwebos:'),
    JSON.stringify({ vaultPrompt, backLab, localPrompt }));

  // 7) scp:上行(→ /tmp)与下行(→ 本机)一次性传输,口令验证即断
  await run('scp ~/desktop/up.txt guest@lab.nexus:/tmp/scp-up.txt');
  await run('guest');
  await run('scp guest@lab.nexus:/etc/hosts ~/desktop/hosts-dl.txt');
  await run('guest');
  const scpAll = await winText(0);   // 认证提示行收回使差分错位,断言用全文(目标串唯一)
  const hostsDl = await ev(`WebOS.fs.read(WebOS.fs.homePath() + '/desktop/hosts-dl.txt')`);
  const scpSeen = (await run1('cat /tmp/scp-up.txt')).includes('marker-up-42');   // 窗口 1 仍在会话:立即可见
  t('T56.6 scp 双向传输(不进交互会话,远端即刻可见)',
    scpAll.includes('lab.nexus:/tmp/scp-up.txt') && hostsDl != null && hostsDl.includes('router.nexus') && scpSeen,
    JSON.stringify({ up: scpAll.includes('lab.nexus:/tmp/scp-up.txt'), dl: hostsDl != null, scpSeen }));

  // 8) 远程 Tab 补全(窗口 1 仍在 lab 会话:命令名 / 目录条目)
  await ev(`(() => {
    const w = document.querySelectorAll('.win[data-app=terminal]')[1];
    const inp = w.querySelector('.term-in input');
    inp.value = 'cat wel';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  })()`);
  const tabVal = await ev(`document.querySelectorAll('.win[data-app=terminal] .term-in input')[1].value`);
  t('T56.7 远程会话 Tab 补全', tabVal === 'cat welcome.txt ', JSON.stringify(tabVal));

  // 9) 持久化:刷新页面重连,cross.txt 仍在(覆盖层随 vnet 进度落盘)
  await sleep(500);   // 等 vnet 防抖落盘
  await fresh();
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(500);
  mark = (await winText(0)).length;
  await run('ssh guest@lab.nexus');
  await run('guest');
  const lsReload = await run('ls');
  const overlaySaved = await ev(`(() => {
    const v = JSON.parse(localStorage.getItem('webos.vnet.v1') || '{}');
    return !!(v.sshFs && Object.keys(v.sshFs).some(k => k.includes('lab.nexus') || k.includes('10.0.0.30')));
  })()`);
  t('T56.8 跨重载持久化(远端改动保留 / 覆盖层落盘)',
    lsReload.includes('cross.txt') && lsReload.includes('upload.txt') && overlaySaved === true,
    JSON.stringify({ lsReload: lsReload.trim(), overlaySaved }));

  // 10) resetState 整机重置:覆盖层与活动树一并清空
  await ev(`WebOS.vnet.resetState()`);
  await run('exit');
  await run('ssh guest@lab.nexus');
  await run('guest');
  const lsReset = await run('ls');
  t('T56.9 vnet.resetState 靶机重置(改动清空)', !lsReset.includes('cross.txt') && !lsReset.includes('upload.txt')
    && lsReset.includes('welcome.txt'), JSON.stringify(lsReset.trim()));

  const errs56 = await ev(`window.__errs.length`);
  t('T56.10 全程无运行错误', errs56 === 0, `errs=${errs56}`);
  await c.shot('t56-remote-terminal');
});

group('T58', 'EXE 打包与直接执行(自动加密 / 终端免 node / 密文不可读)', async () => {
  /* ---- T58 AEXE:编辑器打包 → 终端 ./x.exe 直跑 → 篡改报错 ---- */
  await fresh();
  const HOME = await ev(`WebOS.fs.homePath()`);
  const SRC = 'const secret = "E2E-秘密-42";\nprint("hello from exe");\nprint(secret);\n';
  const P_AJS = HOME + '/documents/e2e工具.ajs';
  const P_EXE = HOME + '/documents/e2e工具.exe';

  // 1) 编辑器一键打包:已保存的 .ajs 自动同名 .exe,内容为密文
  await ev(`(() => {
    WebOS.fs.rm(${JSON.stringify(P_AJS)}); WebOS.fs.rm(${JSON.stringify(P_EXE)});
    WebOS.fs.write(${JSON.stringify(P_AJS)}, ${JSON.stringify(SRC)});
    return true;
  })()`);
  await ev(`WebOS.wm.open('codeedit', { params: { path: ${JSON.stringify(P_AJS)} } })`);
  await waitFor(`!!document.querySelector('.win[data-app=codeedit] .cedit-ta')?.value.includes('E2E')`);
  await ev(`document.querySelector('.win[data-app=codeedit] .ce-exe').click()`);
  const exe = await waitFor(`WebOS.fs.read(${JSON.stringify(P_EXE)}) || ''`, 5000);
  t('T58 打包(密文落盘,魔数头,源码/秘密串不可见)',
    exe.startsWith('AEXE1:') && exe.includes('WEOS1:')
    && !exe.includes('print') && !exe.includes('E2E-秘密-42') && !exe.includes('hello'),
    exe.slice(0, 48));

  // 2) 终端直接执行:./ 相对路径、裸名、绝对路径,输出与源一致(自动解密)
  await ev(`WebOS.wm.open('terminal')`);
  await sleep(600);
  const termRun = async (cmd) => {
    await ev(`(() => {
      const inp = document.querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
  };
  const termExpr = () => `document.querySelector('.term-out').textContent || ''`;
  const termText = () => ev(termExpr());
  await termRun(`cd ${HOME}/documents`);
  await sleep(300);
  await termRun('./e2e工具.exe');
  await waitFor(`(${termExpr()}).includes('E2E-秘密-42')`, 8000);
  await termRun('e2e工具.exe');
  await waitFor(`((${termExpr()}).match(/E2E-秘密-42/g) || []).length >= 2`, 8000);
  await termRun(P_EXE);
  await waitFor(`((${termExpr()}).match(/E2E-秘密-42/g) || []).length >= 3`, 8000);
  const s2 = await termText();
  t('T58.1 终端免 node 直跑(./ 相对 / 裸名 / 绝对路径)',
    (s2.match(/hello from exe/g) || []).length === 3
    && (s2.match(/E2E-秘密-42/g) || []).length === 3, `hello×${(s2.match(/hello from exe/g) || []).length}`);

  // 3) cat 看得见但看不懂:密文原样输出,秘密串不出现
  await termRun('cat e2e工具.exe');
  await sleep(400);
  const s3 = await termText();
  const catPart = s3.slice(s3.lastIndexOf('AEXE1:'));
  t('T58.2 cat 密文(可见魔数,源码不可读)', catPart.startsWith('AEXE1:') && !catPart.includes('E2E-秘密-42'),
    catPart.slice(0, 40));

  // 4) 篡改/伪造的 exe:解密失败有明确报错,不是 command not found
  await termRun('cp e2e工具.exe e2e坏.exe');
  await sleep(300);
  await ev(`WebOS.fs.write(${JSON.stringify(HOME + '/documents/e2e坏.exe')}, 'AEXE1:YmFk:WEOS1:aa:bb:cc')`);
  await termRun('./e2e坏.exe');
  await waitFor(`(${termExpr()}).includes('解密失败')`, 5000);
  const s4 = await termText();

  // 5) 不存在 / 非 exe 的路径:按文件语义报错
  await termRun('./不存在.exe');
  await sleep(300);
  await termRun('./e2e工具.ajs');
  await sleep(300);
  const s5 = await termText();
  t('T58.3 错误路径明确(篡改报解密失败 / 缺文件 / 非 exe 不可直跑)',
    s4.includes('解密失败') && s5.includes('没有那个文件或目录')
    && /e2e工具\.ajs[^]*不是可执行文件/.test(s5), '');

  // 6) 收尾:无运行错误 + 清理
  const errs58 = await ev(`JSON.stringify(window.__errs).slice(0, 300)`);
  t('T58.4 全程无运行错误', errs58 === '[]', String(errs58));
  await ev(`(() => {
    WebOS.fs.rm(${JSON.stringify(P_AJS)}); WebOS.fs.rm(${JSON.stringify(P_EXE)});
    WebOS.fs.rm(${JSON.stringify(HOME + '/documents/e2e坏.exe')});
    return true;
  })()`);
  await c.shot('t58-exe');
});

group('T59', '远端 node 与远端 exe(SSH 会话跑 AetherJS / 密文直击 / put 上传执行)', async () => {
  /* ---- T59:模拟远程终端里的脚本执行(与本地 node/exe 同一沙盒 Worker) ---- */
  await fresh();
  await ev(`WebOS.vnet.resetState()`);
  const HOME = await ev(`WebOS.fs.homePath()`);

  await ev(`WebOS.wm.open('terminal')`);
  await sleep(700);
  const termExpr = () => `document.querySelector('.term-out').textContent || ''`;
  const termRun = async (cmd) => {
    await ev(`(() => {
      const inp = document.querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
  };

  // 登录靶机
  await termRun('ssh guest@lab.nexus');
  await sleep(400);
  await termRun('guest');
  await waitFor(`(${termExpr()}).includes('已连接')`, 5000);

  // 1) 远端 node 跑靶机自带脚本(远端 FS 读取 + 沙盒执行)
  await termRun('node /opt/tools/netcheck.ajs');
  await waitFor(`(${termExpr()}).includes('台在线')`, 8000);
  const s1 = await ev(termExpr());
  t('T59 远端 node(自带脚本:主机扫描/校验和/完成)',
    s1.includes('内网主机 4 台,3 台在线(vault 不回应)') && s1.includes('会话校验和:1535') && s1.includes('自检完成'),
    s1.slice(-160));

  // 2) 远端 node -e 内联 + 权限机关(shadow root-only)+ 缺文件
  await termRun('node -e "print(40 + 2);"');
  await waitFor(`(${termExpr()}).includes('42')`, 5000);
  await termRun('node /etc/shadow');
  await sleep(400);
  await termRun('node /opt/tools/不存在.ajs');
  await sleep(400);
  const s2 = await ev(termExpr());
  t('T59.1 远端 node(-e 内联 / shadow 权限拒绝 / 缺文件报错)',
    s2.includes('42') && s2.includes('node: /etc/shadow: 权限不够')
    && s2.includes('node: 无法加载 /opt/tools/不存在.ajs'), '');

  // 3) 远端 exe 直击:cd /opt/tools → ./hardware.exe → 裸名再来一次
  await termRun('cd /opt/tools');
  await sleep(300);
  await termRun('./hardware.exe');
  await waitFor(`((${termExpr()}).match(/Nexus R7/g) || []).length >= 1`, 8000);
  await termRun('hardware.exe');
  await waitFor(`((${termExpr()}).match(/Nexus R7/g) || []).length >= 2`, 8000);
  const s3 = await ev(termExpr());
  t('T59.2 远端 exe 直击(./ 相对与裸名,自动解密)',
    (s3.match(/Nexus R7/g) || []).length === 2 && s3.includes('UPTIME : 6 天'), '');

  // 4) cat 密文可见不可读(只看最后一段 cat 输出,之前脚本的运行输出不算)
  await termRun('cat hardware.exe');
  await sleep(400);
  const s4raw = await ev(termExpr());
  const s4 = s4raw.slice(s4raw.lastIndexOf('AEXE1:'));
  t('T59.3 远端 cat 密文(魔数可见,源码不可读)',
    s4.startsWith('AEXE1:') && !s4.includes('Nexus R7'), s4.slice(0, 40));

  // 5) put 上传本机脚本 → 远端 node 执行(本机→远端的工作流)
  await termRun('cd ~');
  await sleep(250);
  await ev(`WebOS.fs.write(${JSON.stringify(HOME + '/documents/e2e-remote.ajs')}, 'print("远端执行:上传脚本 OK");')`);
  await termRun('put ~/documents/e2e-remote.ajs');
  await waitFor(`(${termExpr()}).includes('已上传')`, 5000);
  await termRun('node e2e-remote.ajs');
  await waitFor(`(${termExpr()}).includes('远端执行:上传脚本 OK')`, 8000);

  // 6) cp 改名后照跑(内容魔数识别,与文件名无关)+ 非 exe 报错
  await termRun('cp /opt/tools/hardware.exe /tmp/hw2.exe');
  await sleep(300);
  await termRun('cd /tmp');
  await sleep(250);
  await termRun('./hw2.exe');
  await waitFor(`((${termExpr()}).match(/Nexus R7/g) || []).length >= 3`, 8000);
  await termRun('/opt/tools/netcheck.ajs');   // 存在但不是 exe → 明确拒跑
  await sleep(400);
  const s6 = await ev(termExpr());
  t('T59.4 上传执行 + 改名直击 + 非 exe 拒跑',
    s6.includes('远端执行:上传脚本 OK') && (s6.match(/Nexus R7/g) || []).length >= 3
    && s6.includes('不是可执行文件'), `R7×${(s6.match(/Nexus R7/g) || []).length}`);

  // 7) exit 断开 + 无运行错误 + 清理(远端覆盖层与本地文件)
  await termRun('exit');
  await sleep(400);
  const s7 = await ev(termExpr());
  const errs59 = await ev(`JSON.stringify(window.__errs).slice(0, 300)`);
  t('T59.5 exit 断开 + 全程无运行错误',
    s7.includes('Connection closed') && errs59 === '[]', String(errs59));
  await ev(`(() => { WebOS.fs.rm(${JSON.stringify(HOME + '/documents/e2e-remote.ajs')}); WebOS.vnet.resetState(); return true; })()`);
  await c.shot('t59-remote-node');
});
