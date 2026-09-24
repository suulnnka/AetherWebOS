/* ============================================================
 * AetherWebOS 端到端冒烟测试
 * 先 npm run dev(Vite 开发服务器,固定 8080;应用裸模块依赖需要 Vite 解析),
 * 再运行本脚本(自动携带 ?e2e=1 进入应用测试模式,见 js/core/utils.js):
 *   node tools/e2e.mjs                  # 全部用例
 *   node tools/e2e.mjs T22 27           # 只跑指定组
 *   node tools/e2e.mjs T1-T5 邮件 天气  # 区间 / 组号 / 标题关键词,可混写
 *   node tools/e2e.mjs --list           # 列出全部用例组
 *   node tools/e2e.mjs --parallel 3     # 3 个浏览器并行跑
 *   node tools/e2e.mjs --clean          # 运行前清空浏览器 profile(全新状态)
 * 输出 PASS/FAIL 清单 + .shots/ 截图
 * ============================================================ */
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ?e2e=1 进入应用测试模式:跳过开机动画等装饰性等待(约定见 js/core/utils.js 的 E2E)
const URL_BASE = 'http://localhost:8080/?e2e=1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
let parallel = 6, wantList = false, workerMode = false, clean = false;   // 默认 6 个浏览器并行
const selectors = [];
let workerIds = null, workerOut = null, workerProfile = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list' || a === '-l') wantList = true;
  else if (a === '--worker') workerMode = true;          // 内部:并行工作进程
  else if (a === '--ids') workerIds = argv[++i].split(',');
  else if (a === '--out') workerOut = argv[++i];
  else if (a === '--profile') workerProfile = argv[++i];
  else if (a === '--clean') clean = true;
  else if (a === '--parallel' || a.startsWith('--parallel=')) {
    parallel = a.includes('=') ? Number(a.split('=')[1]) : Number(argv[++i]);
    if (!(parallel >= 1 && parallel <= 16)) { console.error('--parallel 需要 1-16 的数字'); process.exit(2); }
  }
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else selectors.push(a);
}

function printHelp() {
  console.log(`用法: node tools/e2e.mjs [选择器...] [选项]
  选择器: 组号(T22 或 22)、区间(T1-T5)、标题关键词(邮件);逗号分隔可混写
  --list        列出全部用例组
  --parallel N  用 N 个浏览器实例并行跑(默认 6;调试可 --parallel 1 串行)
  --clean       运行前清空测试用浏览器 profile(全新 localStorage 状态)`);
}

/* ---------- 结果收集 ---------- */
const results = [];
const TAG = workerProfile ? `[${workerProfile}] ` : '';
const t = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${TAG}${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 用例组注册 ---------- */
let c = null;   // 当前浏览器连接(进入用例组前由 runGroups 赋值)
const GROUPS = [];
const group = (id, title, fn) => GROUPS.push({ id, title, fn });
const ev = (expr) => c.evaluate(expr);

/* 就绪等待:轮询直到开机画面移除、桌面图标渲染(替代固定 sleep)。
   文件系统 v2 绑定用户:首启无账号时自动注册 e2euser,保证有 ~/desktop 与图标。 */
async function ensureE2ESession() {
  const st = await ev(`(() => ({
    os: !!window.WebOS,
    user: window.WebOS?.accounts?.current?.() || null,
    users: (window.WebOS?.accounts?.list?.() || []).map(u => u.name),
  }))()`);
  if (!st.os) return false;
  if (st.user) return true;
  // 无会话:优先用套件常用账号登录;否则注册 e2euser;账号库为空则清掉重建
  const r = await ev(`(async () => {
    const acc = WebOS.accounts;
    const tries = [
      ['e2euser', 'e2epass1'],
      ['admin', 'admin1234'],
      ['alice', 'alice1234'],
      ['todoer', 'todopass'],
      ['mailuser', 'mailpass123'],
    ];
    for (const [u, p] of tries) {
      if (!acc.list().some(x => x.name === u)) continue;
      const r = await acc.login(u, p);
      if (r.ok) return { ok: true, user: u };
    }
    if (!acc.list().length) {
      const reg = await acc.register('e2euser', 'e2epass1');
      if (reg.ok) return { ok: true, user: reg.user };
    }
    return { ok: false, users: acc.list().map(u => u.name) };
  })()`);
  return !!r?.ok;
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const r = await ev(`(() => ({ boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.dicon').length, os: !!window.WebOS }))()`);
    if (r.os && !r.boot) {
      await ensureE2ESession();
      const r2 = await ev(`(() => ({ boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.dicon').length, lock: !!document.getElementById('session') }))()`);
      if (!r2.boot && (r2.icons > 0 || r2.lock)) { await sleep(100); return; }
    }
    await sleep(100);
  }
  throw new Error('页面 12s 内未就绪');
}
/* 组间重置:回到初始桌面(localStorage 保留,由用例自行清理) */
async function fresh() { await c.goto(URL_BASE); await waitReady(); }

/* 轮询等待表达式为真值(默认 5s 超时,返回最终值)。
   用于异步 UI 就绪等待:如加密解密(PBKDF2 派生)、弹窗窗口创建等无固定耗时的环节 */
async function waitFor(expr, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) return v;
    await sleep(120);
  }
}

/* ---- 共享助手(从各用例组上提,跨组复用) ---- */

  const termType = async (cmd) => {
    await ev(`(async () => {
      const inp = document.querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(350);
  };

  const nav = async (addrInput) => {
    await ev(`(async () => {
      const a = document.querySelector('.vw-addr');
      a.value = ${JSON.stringify(addrInput)};
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(1400); // 模拟加载动画 + 渲染
  };

  /* bash 子 shell 命令:与 termType 同一终端窗口(先输入 bash 进入子 shell) */
  const bashType = async (cmd) => {
    await ev(`(async () => {
      const w = document.querySelector('.win[data-app=terminal]');
      const inp = w.querySelector('.term-in input');
      inp.value = ${JSON.stringify(cmd)};
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(320);
  };

  const bashOut = () => ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent`);

  const ctxClick = async (label) => {
    await ev(`(() => {
      const item = [...document.querySelectorAll('#ctx .ctx-item')].find(i => i.textContent.includes(${JSON.stringify(label)}));
      if (item) item.click();
    })()`);
    await sleep(400);
  };

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
  t('T1 桌面启动', !boot1.boot && boot1.icons >= 15 && boot1.pinned >= 3 && boot1.smItems >= 15,
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
  const saved = await ev(`WebOS.fs.read(WebOS.fs.homePath()+'/documents/欢迎使用.txt').includes('[E2E 测试行]')`);
  t('T8.2 记事本保存到虚拟文件系统', saved === true);
  await ev(`WebOS.wm.close(document.querySelector('.win[data-app=notes]').dataset.id)`);
  await sleep(400);

});

group('T9', '终端 + IPC 演示', async () => {
  /* ---- T9 终端 + IPC 演示 ---- */
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

group('T12', '音乐播放器', async () => {
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
  await ev(`WebOS.settings.set({ theme: 'dark' });
  WebOS.fs.write(WebOS.fs.homePath()+'/documents/欢迎使用.txt', (WebOS.fs.read(WebOS.fs.homePath()+'/documents/欢迎使用.txt') || '') + '\\n[E2E 测试行]')`);
  await sleep(500);   // fs 落盘是 250ms 防抖,等它写进 localStorage 再刷新
  await fresh();
  const persisted = await ev(`({
    theme: JSON.parse(localStorage.getItem('webos.settings.v1')).theme,
    file: WebOS.fs.read(WebOS.fs.homePath()+'/documents/欢迎使用.txt').includes('[E2E 测试行]'),
    errs: window.__errs.length,
  })`);
  t('T14 刷新后持久化', persisted.theme === 'dark' && persisted.file && persisted.errs === 0, JSON.stringify(persisted));
  await c.shot('t14-after-reload');
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
  const got = await ev(`WebOS.fs.exists('/home/downloads/notes.txt')`);
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

});

group('T19', '霓虹 2.0:每应用灯条 / 流光 / 呼吸 / 悬浮切角任务栏 / 动态桌面', async () => {
  /* ---- T19 霓虹 2.0:每应用灯条 / 流光 / 呼吸 / 悬浮切角任务栏 / 动态桌面 ---- */
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

});

group('T22', '多窗口模式:平铺/层叠/贴边/焦点', async () => {
  /* ---- T22 多窗口模式:平铺/层叠/贴边/焦点 ---- */
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
  const targetApp = 'monitor';
  const oneClick = await ev(`(() => {
    const w = document.querySelector('.win[data-app=monitor]');
    const btn = w.querySelector('.wbtn.close');
    btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return {
      activated: w.classList.contains('focused'),
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
  t('T24 桌面 = 快捷方式文件 + 文件夹(无自动图标)', dsk1.apps === 0 && dsk1.links >= 11 && dsk1.folders >= 1 && await ev(`WebOS.fs.isDir(WebOS.fs.desktopPath())`), JSON.stringify(dsk1));

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

  // d. F2 重命名(选中 → 键盘 → 对话框);先让输入框失焦,模拟用户点击桌面后的状态
  await ev(`(() => {
    document.activeElement && document.activeElement.blur();
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/测试便签.txt');
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
  const renamed = await ev(`WebOS.fs.exists(WebOS.fs.desktopPath()+'/改名后.txt')`);
  t('T24.3 F2 重命名', renamed === true);

  // e. Delete 删除(确认对话框)
  await ev(`(() => {
    document.activeElement && document.activeElement.blur();
    const n = [...document.querySelectorAll('.dicon')].find(x => x.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/改名后.txt');
    n.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
  })()`);
  await sleep(200);
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  await sleep(450);
  await ev(`[...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].find(b => b.textContent === '删除').click()`);
  await sleep(600);
  const deleted = await ev(`!WebOS.fs.exists(WebOS.fs.desktopPath()+'/改名后.txt') && ![...document.querySelectorAll('.dicon')].some(n => n.dataset.key === 'fs:'+WebOS.fs.desktopPath()+'/改名后.txt')`);
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

group('T26', '邮件应用', async () => {
  /* ---- T26 邮件应用 ---- */
  await ev(`WebOS.vnet.resetState();
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.mail.v1')) localStorage.removeItem(k);
    localStorage.removeItem('webos.account-session.v1')`);
  await fresh();   // 重载后清会话 → 需重新登录(测试随后注册 mailuser)
  // 账号门:注册并登录邮件用户(种子邮件将播种到该用户空间)
  await ev(`(async () => {
    const acc = (await import('./js/core/accounts.js')).accounts;
    if (!(await acc.login('mailuser', 'mailpass123')).ok) await acc.register('mailuser', 'mailpass123');
  })()`);
  await sleep(500);
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

group('T27', '任务(Todo)应用', async () => {
  /* ---- T27 任务(Todo)应用 ---- */
  await ev(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.todo.v1') || k === 'webos.account-session.v1') localStorage.removeItem(k);
  })()`);
  await fresh();   // 清档重载(含账号会话),种子数据从零开始
  // 登录测试用户(todo 现在需要账号)
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
    store: Object.keys(localStorage).filter(k => k.startsWith('webos.todo.v1'))
      .some(k => JSON.parse(localStorage.getItem(k) || '{}').tasks?.some(t => t.text === '写周报' && t.project === '工作')),
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
    projects: (Object.keys(localStorage).filter(k => k.startsWith('webos.todo.v1'))
      .map(k => JSON.parse(localStorage.getItem(k) || '{}')).find(s => s.projects) || {}).projects || [],
    active: document.querySelector('.app-side .nav-item.active')?.textContent.replace(/\s+/g, '') || '',
  }))()`);
  t('T27.3 新建项目并切换', td3.projects.includes('解谜') && td3.active?.startsWith('解谜'), JSON.stringify(td3));

  // 逾期任务:直接在存储中注入一条,重新渲染验证
  await ev(`(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('webos.todo.v1') && JSON.parse(localStorage.getItem(k) || '{}').tasks);
    const s = JSON.parse(localStorage.getItem(key));
    s.seq = (s.seq || 0) + 1;   // 提升版本号,让运行中的 todo 实例同步采纳
    s.tasks.push({ id: 't99', project: '解谜', text: '过期任务', done: false, prio: 2, due: '2020-01-01', starred: false, created: Date.now() });
    localStorage.setItem(key, JSON.stringify(s));
    WebOS.wm.close(document.querySelector('.win[data-app=sokoban]')?.dataset.id || 'x');
    WebOS.wm.close(document.querySelector('.win[data-app=todo]').dataset.id);
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
  const td5 = await ev(`WebOS.fs.read(WebOS.fs.desktopPath()+'/todo.txt')`);
  const ok5 = typeof td5 === 'string' && td5.includes('过期任务') && td5.includes('写周报');
  if (!ok5) console.log('   todo.txt 内容:', JSON.stringify((td5 || '').slice(0, 200)));
  t('T27.5 导出清单到桌面文件', ok5, (td5 || '').slice(0, 80));

  // 持久化:刷新后任务仍在
  await fresh();
  const td6 = await ev(`(() => {
    let maxn = 0;
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('webos.todo.v1')) continue;
      const n = ((JSON.parse(localStorage.getItem(k) || '{}').tasks) || []).length;
      if (n > maxn) maxn = n;
    }
    return maxn;
  })()`);
  t('T27.6 持久化(刷新后任务保留)', td6 >= 5, `tasks=${td6}`);
  await ev(`WebOS.wm.open('todo')`);
  await sleep(600);

  const errs27 = await ev(`window.__errs.length`);
  t('T27.7 全程无错误', errs27 === 0, `errs=${errs27}`);

});

group('T28', '短信应用', async () => {
  /* ---- T28 短信应用 ---- */
  await ev(`localStorage.removeItem('webos.sms.v1')`);
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

  // Todo 到期联动:逾期任务产生提醒短信;打开 todo 触发 checkDue 立即检查
  // 独立运行前置:登录测试账号并注入一条逾期任务(原流程依赖 T27 的遗留数据)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (!(await accounts.login('todoer', 'todopass')).ok) await accounts.register('todoer', 'todopass');
    const key = accounts.userKey('webos.todo.v1');
    const s = JSON.parse(localStorage.getItem(key) || '{}');
    s.tasks = s.tasks || [];
    if (!s.tasks.some(t => t.text === '过期任务')) {
      s.seq = (s.seq || 0) + 1;
      s.tasks.push({ id: 't' + s.seq, project: '工作', text: '过期任务', done: false, prio: 2, due: '2020-01-01', starred: false, created: Date.now() });
      localStorage.setItem(key, JSON.stringify(s));
    }
  })()`);
  await sleep(300);
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
  await fresh();
  const s5 = await ev(`WebOS.sms.stats()`);
  t('T28.5 持久化(刷新后会话保留)', s5.chats >= 3 && s5.msgs >= 4, JSON.stringify(s5));
  await ev(`WebOS.wm.open('sms')`);
  await sleep(600);
  await c.shot('t28-sms');

  const errs28 = await ev(`window.__errs.length`);
  t('T28.6 全程无错误', errs28 === 0, `errs=${errs28}`);

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

group('T30', '天气应用(实况/预报/历史确定性)', async () => {
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

group('T32', '笔记(含加密)', async () => {
  /* ---- T32 笔记(含加密) ---- */
  await ev(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.memo.v1')) localStorage.removeItem(k);
    return true;
  })()`);
  // 独立运行前置:登录测试账号(笔记数据按账号隔离,不能依赖遗留会话)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current()) return true;
    if (!(await accounts.login('memoer', 'memopass')).ok) await accounts.register('memoer', 'memopass');
    return true;
  })()`);
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

group('T33', '扫雷 + 国际象棋', async () => {
  /* ---- T33 扫雷 + 国际象棋 ---- */
  await fresh();

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

  // 3D 象棋:等 chess3d 应用注册完成(含 Three.js chunk)再打开
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


  const errs3 = await ev(`window.__errs.length`);
  t('T33.3 全程无错误', errs3 === 0, `errs=${errs3}`);
});

group('T34', '黑白棋', async () => {
  /* ---- T34 黑白棋 ---- */
  await fresh();
  await ev(`WebOS.wm.open('reversi')`);
  await sleep(700);
  const rv0 = await ev(`(() => ({
    cells: document.querySelectorAll('.rv-cell').length,
    black: document.querySelectorAll('.rv-piece.b').length,
    white: document.querySelectorAll('.rv-piece.w').length,
    hints: document.querySelectorAll('.rv-hint-dot').length,
  }))()`);
  t('T34 黑白棋:初始局面(4子+4合法步提示)', rv0.cells === 64 && rv0.black === 2 && rv0.white === 2 && rv0.hints === 4,
    JSON.stringify(rv0));

  // 引擎规则验证:开局黑方合法位 = d3(2,3) / c4(3,2) / f5(4,5) / e6(5,4)
  const rv1 = await ev(`(() => {
    const hints = [...document.querySelectorAll('.rv-cell.hint')].map(c => c.dataset.r + ',' + c.dataset.c).sort();
    return { hints, ok: JSON.stringify(hints) === JSON.stringify(['2,3', '3,2', '4,5', '5,4']) };
  })()`);
  t('T34.1 合法走法位置正确(标准开局4位)', rv1.ok, JSON.stringify(rv1.hints));

  // 玩家落子(第一个提示位)→ 翻子 → AI 应答 → 子数变化
  const rv2 = await ev(`(async () => {
    const before = document.querySelectorAll('.rv-piece').length;
    const cell = document.querySelector('.rv-cell.hint');
    const rc = cell.dataset.r + ',' + cell.dataset.c;
    cell.click();
    await new Promise(r => setTimeout(r, 900));   // 翻子 + AI
    const n = document.querySelectorAll('.rv-piece').length;
    const status = document.querySelector('.win[data-app=reversi] .app-status span').textContent;
    return { rc, before, after: n, status };
  })()`);
  t('T34.2 落子翻子+AI 应答', rv2.after >= 4, JSON.stringify(rv2));

  // 传回终端规则验证:用引擎API核对黑白棋终局计数(应用窗口直接读)
  const rv3 = await ev(`(() => ({
    black: document.querySelector('.win[data-app=reversi] .rv-count.black')?.textContent,
    white: document.querySelector('.win[data-app=reversi] .rv-count.white')?.textContent,
    sum: +(document.querySelector('.win[data-app=reversi] .rv-count.black')?.textContent || 0) +
         +(document.querySelector('.win[data-app=reversi] .rv-count.white')?.textContent || 0),
  }))()`);
  t('T34.3 子数统计一致', rv3.sum >= 4 && rv3.sum <= 64, JSON.stringify(rv3));
  await c.shot('t34-reversi');

  // 工具栏按钮按文字查找(新对局/换边/悔棋)
  const rvBtn = (label) => ev(`[...document.querySelectorAll('.win[data-app=reversi] .app-toolbar .btn')]
    .find(b => b.textContent.includes('${label}'))?.click()`);

  // 悔棋:人机模式连 AI 应手一起撤 → 回到初始 4 子,轮到玩家
  await rvBtn('悔棋');
  await sleep(300);
  const rv4 = await ev(`(() => ({
    pieces: document.querySelectorAll('.rv-piece').length,
    status: document.querySelector('.win[data-app=reversi] .app-status span').textContent,
  }))()`);
  t('T34.5 悔棋撤两手回初始局面', rv4.pieces === 4 && rv4.status.includes('黑方行棋'), JSON.stringify(rv4));

  // 换边:玩家改执白,AI 执黑先行落子;搜索信息改写在状态栏右侧(infoL)
  await rvBtn('换边');
  await sleep(2500);
  const rv5 = await ev(`(() => {
    const spans = document.querySelectorAll('.win[data-app=reversi] .app-status span');
    return {
      pieces: document.querySelectorAll('.rv-piece').length,
      status: spans[0].textContent,
      info: spans[spans.length - 1].textContent,
    };
  })()`);
  t('T34.6 换边后 AI 执黑先行', rv5.pieces >= 5 && rv5.status.includes('白方行棋') && rv5.info.length > 0,
    JSON.stringify(rv5));

  // 新对局保持执白偏好:仍是 AI(黑)先行;悔棋可复活终局就不在此展开了
  const rv6 = await ev(`[...document.querySelectorAll('.win[data-app=reversi] .app-toolbar .btn')]
    .find(b => b.textContent.includes('新对局'))?.click()`);
  await sleep(2000);
  const rv7 = await ev(`(() => ({
    pieces: document.querySelectorAll('.rv-piece').length,
    status: document.querySelector('.win[data-app=reversi] .app-status span').textContent,
  }))()`);
  t('T34.7 新对局执白时 AI 先行', rv6 === undefined || rv6 === true ? rv7.pieces >= 5 && rv7.status.includes('白方行棋') : false,
    JSON.stringify(rv7));

  const errs4 = await ev(`window.__errs.length`);
  t('T34.4 全程无错误', errs4 === 0, `errs=${errs4}`);
});

group('T35', '纸牌游戏(接龙 + 记忆翻牌)', async () => {
  /* ---- T35 纸牌游戏(接龙 + 记忆翻牌) ---- */
  await fresh();

  // 接龙:发牌正确性(52 张全在场上:28 在列 + 24 在牌堆)、7 列、点击翻牌
  await ev(`WebOS.wm.open('solitaire')`);
  await sleep(700);
  const so1 = await ev(`(() => ({
    cols: document.querySelectorAll('.sol-col').length,
    slots: document.querySelectorAll('.sol-top .card').length,
    stockCards: (JSON.stringify(0), document.querySelectorAll('.sol-top .card').length),
    title: document.querySelector('.win[data-app=solitaire] .win-title').textContent,
  }))()`);
  t('T35 接龙:界面(7列+6顶槽)', so1.cols === 7 && so1.slots === 6, JSON.stringify(so1));

  // 牌堆点击翻牌:点一次后弃牌堆有牌
  const so2 = await ev(`(async () => {
    const stock = document.querySelector('.sol-top .card');
    stock.click();
    await new Promise(r => setTimeout(r, 300));
    const wasteHas = document.querySelectorAll('.sol-top .card.has').length >= 2;  // stock+waste
    return { wasteHas };
  })()`);
  t('T35.1 牌堆翻牌到弃牌堆', so2.wasteHas === true);

  // 列内翻牌:每列最后一张应翻开
  const so3 = await ev(`(() => {
    const cols = [...document.querySelectorAll('.sol-col')];
    const ups = cols.map(col => {
      const cards = [...col.querySelectorAll('.card')];
      const last = cards.at(-1);
      return last ? !!last.querySelector('.card-face') : false;
    });
    return { allTailsUp: ups.every(Boolean), ups };
  })()`);
  t('T35.2 列尾牌全部翻开', so3.allTailsUp === true, JSON.stringify(so3.ups));
  await c.shot('t35-solitaire');

  // 记忆翻牌:4x4 = 16 张、翻两张配对流程
  await ev(`WebOS.wm.open('pairs')`);
  await sleep(700);
  const p1 = await ev(`(() => ({
    cards: document.querySelectorAll('.pairs-card').length,
    status: document.querySelector('.win[data-app=pairs] .app-status span').textContent,
  }))()`);
  t('T35.3 记忆翻牌:4x4=16 张', p1.cards === 16, JSON.stringify(p1));

  // 自动配对:枚举找到一对相同花色点数的牌翻它们(通过 DOM 文本)
  const p2 = await ev(`(async () => {
    // 关键:flip 触发 render() 会重建 DOM,所有旧引用失效 ——
    // 因此每次点击后必须重新按位置查询节点再读取内容
    const known = new Map();   // 内容 -> 位置索引
    const readFace = (i) => {
      const c = document.querySelectorAll('.pairs-card')[i];
      return c ? (c.querySelector('.pairs-face')?.textContent ?? null) : null;
    };
    const clickAt = async (i, waitMs) => {
      const c = document.querySelectorAll('.pairs-card')[i];
      if (!c) return null;
      c.click();
      await new Promise((r) => setTimeout(r, waitMs));
      const node = document.querySelectorAll('.pairs-card')[i];
      return node ? (node.querySelector('.pairs-face')?.textContent ?? null) : null;
    };
    for (let round = 0; round < 20; round++) {   // 翻牌遍历即可,不做全量穷举
      if (document.querySelectorAll('.pairs-card.matched').length >= 2) return { found: true };
      // 找当前未翻开、未配对的第一张
      const cards = [...document.querySelectorAll('.pairs-card')];
      const idx = cards.findIndex((c) => !c.classList.contains('matched') && !c.classList.contains('up'));
      if (idx < 0) break;
      const keyA = await clickAt(idx, 120);
      if (keyA == null) continue;
      if (known.has(keyA) && known.get(keyA) !== idx) {
        const keyB = await clickAt(known.get(keyA), 400);   // 配对即时生效,等 render 即可
        if (document.querySelectorAll('.pairs-card.matched').length >= 2) return { found: true };
        known.delete(keyA);
        continue;
      }
      // 未知内容:翻开另一张未知的牌,记录两张
      const cards2 = [...document.querySelectorAll('.pairs-card')];
      const idx2 = cards2.findIndex((c) => !c.classList.contains('matched') && !c.classList.contains('up'));
      if (idx2 < 0) break;
      const keyB = await clickAt(idx2, 450);   // 翻错锁 150ms(e2e 模式)+ render 余量
      if (keyB != null && !known.has(keyB)) known.set(keyB, idx2);
      if (!known.has(keyA)) known.set(keyA, idx);
    }
    return { found: document.querySelectorAll('.pairs-card.matched').length >= 2 };
  })()`);
  await c.shot('t35-pairs');


  const errs5 = await ev(`window.__errs.length`);
  t('T35.5 全程无错误', errs5 === 0, `errs=${errs5}`);
});

group('T36', '推箱子', async () => {
  /* ---- T36 推箱子 ---- */
  await fresh();
  for (let i = 0; i < 10 && !(await ev(`WebOS.apps.list().some(a => a.id === 'sokoban')`)); i++) await sleep(400);
  await ev(`WebOS.wm.open('sokoban')`);
  await sleep(700);
  const sk1 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=sokoban]');
    return {
      cells: w.querySelectorAll('.soko-cell').length,
      boxes: w.querySelectorAll('.soko-cell.box').length,
      status: w.querySelector('.app-status span').textContent,
      err: w.querySelector('.win-error')?.textContent || '',
    };
  })()`);
  t('T36 推箱子:第一关加载(30格+1箱)', sk1.cells === 30 && sk1.boxes === 1 && !sk1.err, JSON.stringify(sk1));

  // 键盘解第一关(A W D)→ 箱子入目标 → 胜利对话框
  const sk2 = await ev(`(async () => {
    for (const k of ['a', 'w', 'd']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      await new Promise(r => setTimeout(r, 220));
    }
    await new Promise(r => setTimeout(r, 500));
    const w = document.querySelector('.win[data-app=sokoban]');
    return {
      onGoal: w.querySelectorAll('.soko-cell.on-goal').length,
      statusR: w.querySelector('.app-status .mono').textContent,
      winDlg: [...document.querySelectorAll('.win[data-app=sysdialog] .dlg-title')].some(t => t.textContent.includes('过关')),
    };
  })()`);
  t('T36.1 键盘推箱通关(箱子入目标)', sk2.onGoal === 1 && sk2.winDlg, JSON.stringify(sk2));

  // 撤销:胜利后 1.4s 自动进入下一关(撤销栈清空),在新关卡验证移动+撤销
  await ev(`(() => {
    const dlgBtn = [...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].pop();
    if (dlgBtn) dlgBtn.click();
    return true;
  })()`);
  await sleep(1700);   // 等自动切换到第二关
  const sk3 = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=sokoban]');
    // 模拟用户点击窗口恢复焦点(对话框关闭后焦点需要重新激活)
    w.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const before = w.querySelector('.app-status .mono').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const after = w.querySelector('.app-status .mono').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const undone = w.querySelector('.app-status .mono').textContent;
    return { before, after, undone, undoWorks: undone === before && after !== before };
  })()`);
  t('T36.2 移动与撤销(U)', sk3.undoWorks === true, JSON.stringify(sk3));
  await c.shot('t36-sokoban');


  const errs3 = await ev(`window.__errs.length`);
  t('T36.3 全程无错误', errs3 === 0, `errs=${errs3}`);
});

group('T37', 'QQ 聊天', async () => {
  /* ---- T37 QQ 聊天 ---- */
  await fresh();
  for (let i = 0; i < 10 && (await ev(`!window.WebOS`)); i++) await sleep(500);
  // 清档:测试登录流程(QQ 按用户分键存储,基础键与 ::qq-* 会话键都要清)
  await ev(`Object.keys(localStorage).filter(k => k === 'webos.qq.v1' || k.startsWith('webos.qq.v1::')).forEach(k => localStorage.removeItem(k))`);
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
  const q4 = await ev(`(() => ({
    autoLogin: !!document.querySelector('.qq-top'),
    me: document.querySelector('.qq-top b')?.textContent,
    historyKept: Object.keys(localStorage).filter(k => k.startsWith('webos.qq.v1'))
      .some(k => { const s = JSON.parse(localStorage.getItem(k) || '{}'); return (s.history?.['10001'] || []).length >= 1; }),
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
  t('T38 注册账号(重复注册被拒)', reg.r1?.ok === true && reg.dupRejected === true, JSON.stringify(reg));

  // 打开 todo(未登录状态:alice 已登录) → 添加任务 → 数据落在 alice 命名空间
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  const iso = await ev(`(async () => {
    const inp = document.querySelector('.win[data-app=todo] .todo-add input');
    if (!inp) return { noInput: true, errs: window.__errs.slice(0, 2) };
    inp.value = 'alice 的任务';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const aliceKey = Object.keys(localStorage).find(k => k.includes('webos.todo.v1::alice'));
    const bobTask = Object.keys(localStorage).some(k => k.includes('::bob'));
    return { aliceKey, bobTask, inStore: aliceKey ? JSON.parse(localStorage.getItem(aliceKey)).tasks.some(t => t.text === 'alice 的任务') : false };
  })()`);
  t('T38.1 每用户数据隔离(alice 命名空间)', iso.inStore === true && iso.bobTask === false, JSON.stringify(iso));

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
    noData: !document.querySelectorAll('.todo-item').length,
  }))()`);
  t('T38.2 登出后需要登录(数据隐藏)', loginGate.panel === true, JSON.stringify(loginGate));

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

  // 41.4 任务应用:任务行自定义右键(标记完成 / 删除任务)
  // 任务数据按用户持久化:历史轮次的「删除任务」会耗尽种子任务,
  // 先清该用户的任务存储再打开(应用检测不到存储即重新播种),并用轮询等行渲染
  await ev(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.todo.v1')) localStorage.removeItem(k);
    return true;
  })()`);
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (!(await accounts.login('todoer', 'todopass')).ok) await accounts.register('todoer', 'todopass');
    return true;
  })()`);
  await sleep(300);
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
  t('T41.4 任务行自定义右键', (ctx3.items || []).includes('标记完成') && (ctx3.items || []).includes('删除任务'),
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
  t('T41.6 笔记卡片右键', (ctx4 || []).some(i => i === '置顶' || i === '取消置顶') && (ctx4 || []).includes('删除笔记'),
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

group('T43', '日记(按日期记录 / 心情 / 自动保存)', async () => {
  /* ---- T43 日记:按日期记录 / 心情 / 自动保存 ---- */
  await ev(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('webos.diary.v1')) localStorage.removeItem(k);
    return true;
  })()`);
  // 独立运行前置:登录测试账号(日记数据按账号隔离,不能依赖遗留会话)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current()) return true;
    if (!(await accounts.login('diaryer', 'diarypass')).ok) await accounts.register('diaryer', 'diarypass');
    return true;
  })()`);
  await fresh();
  await ev(`WebOS.wm.open('diary')`);
  await sleep(700);

  // 今天默认选中;写入正文(自动保存)
  const d0 = await ev(`(() => {
    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const win = document.querySelector('.win[data-app=diary]');
    const ta = win.querySelector('.diary-text');
    ta.value = '今天是终端合并成 bash 的日子,充实。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { key, dateH: win.querySelector('.diary-date').textContent };
  })()`);
  t('T43 今天默认选中(标题含日期)', d0.dateH.includes('年') && d0.dateH.includes('星期'), d0.dateH);
  await sleep(500);   // 等防抖落盘

  const saved = await ev(`(() => {
    const k = Object.keys(localStorage).find(k => k.startsWith('webos.diary.v1'));
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    const e = s.entries && s.entries[${JSON.stringify(d0.key)}];
    return { has: !!e, text: (e && e.text) || '' };
  })()`);
  t('T43.1 输入自动落盘', saved.has && saved.text.includes('充实'), JSON.stringify(saved));

  // 圆点标记 + 心情
  const dot = await ev(`!!document.querySelector('.win[data-app=diary] .diary-day.sel .dot')`);
  t('T43.2 月历圆点标记', dot === true);
  await ev(`document.querySelectorAll('.win[data-app=diary] .diary-mood')[1].click()`);
  await sleep(450);
  const mood = await ev(`(() => {
    const k = Object.keys(localStorage).find(k => k.startsWith('webos.diary.v1'));
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    return (s.entries[${JSON.stringify(d0.key)}] || {}).mood;
  })()`);
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
  const emptyText = await ev(`document.querySelector('.win[data-app=diary] .diary-text').value`);
  t('T43.4 切换日期编辑器跟随', emptyText === '', JSON.stringify(emptyText));

  await ev(`[...document.querySelectorAll('.win[data-app=diary] .btn')].find(b => b.textContent.includes('今天')).click()`);
  await sleep(350);
  const back = await ev(`document.querySelector('.win[data-app=diary] .diary-text').value`);
  t('T43.5 「今天」回位且内容恢复', back.includes('充实'), JSON.stringify(back));

  const title = await ev(`document.querySelector('.win[data-app=diary] .win-title').textContent`);
  const errs = await ev(`window.__errs.length`);
  t('T43.6 标题计数+无错误', title.includes('1 篇') && errs === 0, `title=${title} errs=${errs}`);
  await c.shot('t43-diary');
});

group('T44', '五子棋(双规则 / 禁手标记 / AI 应答)', async () => {
  /* ---- T44 五子棋:双规则 / 禁手标记 / AI 应答 / 悔棋 ---- */
  await fresh();
  await ev(`WebOS.wm.open('gomoku')`);
  await sleep(700);
  const g0 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return {
      pts: w.querySelectorAll('.gk-pt').length,
      stats: window.__gomoku?.stats(),
      bars: w.querySelectorAll('.app-status').length,
      buttons: [...w.querySelectorAll('.app-toolbar .btn')].map((b) => b.textContent.trim()),
      selects: [...w.querySelectorAll('.app-toolbar select')].map((s) => s.selectedOptions[0].textContent),
      status: w.querySelector('.app-status span')?.textContent,
    };
  })()`);
  t('T44 窗口与棋盘(225 交叉点,有禁手默认档)',
    g0.pts === 225 && g0.stats?.mode === 'renju' && g0.bars === 1, JSON.stringify(g0.stats));
  t('T44.1 顶栏按钮组:新对局/人机/换边/悔棋 + 规则/难度下拉',
    g0.buttons.join('|') === '新对局|人机|换边|悔棋' && g0.selects.join('/') === '有禁手/高级',
    g0.buttons.join(' ') + ' | ' + g0.selects.join('/'));
  t('T44.2 底栏左边是行棋状态(黑先)', g0.status === '黑方行棋 · 第 1 手', g0.status);

  // 落一子(H8 天元)→ AI 应答 → plies=2
  await ev(`document.querySelector('.win[data-app=gomoku] .gk-pt[data-i="112"]').click()`);
  await sleep(400);
  const g1 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return {
      black: w.querySelectorAll('.gk-stone.black').length,
      last: !!w.querySelector('.gk-stone.last'),
      stats: window.__gomoku.stats(),
    };
  })()`);
  t('T44.3 点天元真的落子(黑子 1 颗,带上一手标记)',
    g1.black === 1 && g1.last && g1.stats.plies === 1, JSON.stringify(g1));

  let g2 = null;
  for (let i = 0; i < 60; i++) {
    g2 = await ev(`({ stats: window.__gomoku.stats(),
      info: document.querySelector('.win[data-app=gomoku] .app-status .mono')?.textContent,
      status: document.querySelector('.win[data-app=gomoku] .app-status span')?.textContent })`);
    if (g2.stats.plies === 2 && !g2.stats.searching) break;
    await sleep(250);
  }
  t('T44.4 AI(白方)应答,回到黑方回合', g2.stats.plies === 2 && g2.stats.turn === 0, JSON.stringify(g2.stats));
  t('T44.5 底栏右侧有引擎信息(档位·深度·节点·耗时·评分)',
    /^.+ · 深度 \d+ · \d+k 节点 · \d+ms · [+-]/.test(g2.info), g2.info);

  // 有禁手:双人模式按谱落子构造「横竖双活三」局面 → (7,7) 出现 × 标记且点不下去
  await ev(`(() => {
    const btns = [...document.querySelectorAll('.win[data-app=gomoku] .app-toolbar .btn')];
    btns.find(b => b.textContent === '人机').click();          // 切双人
    btns.find(b => b.textContent.includes('新对局')).click();  // 清掉 AI 对局残子,拿一张空盘
    return true;
  })()`);
  await sleep(350);
  for (const i of [111, 0, 113, 30, 97, 60, 127, 90]) {   // 黑 (7,6)(7,8)(6,7)(8,7),白 (0,0)(2,0)(4,0)(6,0) 摊开 —— 8 手后轮黑
    await ev(`document.querySelector('.win[data-app=gomoku] .gk-pt[data-i="${i}"]').click()`);
    await sleep(120);
  }
  const g3 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    const pt = w.querySelector('.gk-pt[data-i="112"]');
    const stonesBefore = w.querySelectorAll('.gk-stone').length;
    pt.click();                                     // 点禁手点:应被拒绝
    return {
      stonesBefore,
      stonesAfter: w.querySelectorAll('.gk-stone').length,
      banCls: pt.classList.contains('ban'),
      banMark: !!pt.querySelector('.gk-ban'),
      banCount: w.querySelectorAll('.gk-ban').length,
      stats: window.__gomoku.stats(),
    };
  })()`);
  t('T44.6 双活三点标 × 且拒落(点后子数不变)',
    g3.banCls && g3.banMark && g3.banCount === 1 &&
    g3.stonesBefore === 8 && g3.stonesAfter === 8, JSON.stringify(g3));

  // 切无禁手:重开新对局,禁手标记逻辑整体关闭
  await ev(`window.__gomoku.setMode(0)`);
  await sleep(400);
  const g5 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return {
      stats: window.__gomoku.stats(),
      stones: w.querySelectorAll('.gk-stone').length,
      bans: w.querySelectorAll('.gk-ban').length,
      status: w.querySelector('.app-status span')?.textContent,
    };
  })()`);
  t('T44.7 切无禁手后重开(空盘,无禁手标记)',
    g5.stats.mode === 'free' && g5.stats.plies === 0 && g5.stones === 0 && g5.bans === 0, JSON.stringify(g5));

  // 悔棋:先走一手再悔(无禁双人下悔一手)
  await ev(`document.querySelector('.win[data-app=gomoku] .gk-pt[data-i="112"]').click()`);
  await sleep(250);
  await ev(`[...document.querySelectorAll('.win[data-app=gomoku] .app-toolbar .btn')].find(b => b.textContent.includes('悔棋')).click()`);
  await sleep(250);
  const g6 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return { stones: w.querySelectorAll('.gk-stone').length, stats: window.__gomoku.stats() };
  })()`);
  t('T44.8 悔棋撤一手回到空盘', g6.stones === 0 && g6.stats.plies === 0, JSON.stringify(g6));

  const errs = await ev(`window.__errs.length`);
  t('T44.9 全程无错误', errs === 0, `errs=${errs}`);
  await c.shot('t44-gomoku');
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


/* ---------- 用例筛选 ---------- */
function resolveSelection() {
  if (!selectors.length) return GROUPS.map(g => g.id);
  const picked = new Set();
  const unknown = [];
  for (const raw of selectors) {
    for (const tok of raw.split(',')) {
      const s = tok.trim();
      if (!s) continue;
      const range = /^t?(\d+)\s*(?:-|~)\s*t?(\d+)$/i.exec(s);
      if (range) {
        const lo = Math.min(+range[1], +range[2]), hi = Math.max(+range[1], +range[2]);
        for (const g of GROUPS) { const n = +g.id.slice(1); if (n >= lo && n <= hi) picked.add(g.id); }
        continue;
      }
      const num = /^t?(\d+)$/i.exec(s);
      if (num) {
        const hit = GROUPS.find(g => g.id === 'T' + num[1]);
        if (hit) { picked.add(hit.id); continue; }
      }
      const kw = s.toLowerCase();
      const hits = GROUPS.filter(g => g.id.toLowerCase().includes(kw) || g.title.toLowerCase().includes(kw));
      if (hits.length) hits.forEach(g => picked.add(g.id));
      else unknown.push(s);
    }
  }
  if (unknown.length) {
    console.error(`未识别的用例选择器: ${unknown.join(', ')}(用 --list 查看全部组)`);
    process.exit(2);
  }
  return GROUPS.filter(g => picked.has(g.id)).map(g => g.id);
}

/* ---------- 运行一批用例组(每组先重置到初始桌面,互不依赖) ---------- */
async function runGroups(ids) {
  c = await launch(URL_BASE, { profile: workerProfile || 'main' });
  const summaries = [];
  try {
    for (const id of ids) {
      const g = GROUPS.find(x => x.id === id);
      const mark = results.length;
      const t0 = Date.now();
      let crashed = false;
      try { await fresh(); await g.fn(); }
      catch (e) { crashed = true; t(`${id} 用例组中断`, false, String(e?.message || e).split('\n')[0].slice(0, 220)); }
      const sub = results.slice(mark);
      summaries.push({
        id, title: g.title, ms: Date.now() - t0, n: sub.length,
        pass: !crashed && sub.length > 0 && sub.every(r => r.ok),
      });
    }
  } finally { await c.close(); }
  return summaries;
}

/* ---------- 入口 ---------- */
if (workerMode) {
  console.log(`${TAG}---- 工作进程跑: ${workerIds.join(', ')}`);
  const summaries = await runGroups(workerIds);
  writeFileSync(workerOut, JSON.stringify(summaries));
  process.exit(summaries.every(s => s.pass) ? 0 : 1);
}

if (wantList) {
  console.log('可用用例组(每组可独立运行,自动重置到初始桌面):');
  for (const g of GROUPS) console.log(`  ${g.id.padEnd(4)}  ${g.title}`);
  console.log(`\n选择示例: node tools/e2e.mjs T22 27   /   node tools/e2e.mjs T1-T5 邮件`);
  process.exit(0);
}

const ids = resolveSelection();
if (!ids.length) { console.error('选择器没有匹配到任何用例组(用 --list 查看全部组)'); process.exit(2); }

/* 服务器预检:必须由 Vite 开发服务(解析应用裸模块依赖)提供页面 */
try {
  const pong = await fetch(URL_BASE, { signal: AbortSignal.timeout(3000) });
  if (!pong.ok) throw new Error('HTTP ' + pong.status);
} catch {
  console.error('开发服务器未就绪:先运行 npm run dev(端口 8080),再跑 e2e');
  process.exit(2);
}

const scope = ids.length === GROUPS.length ? '全部' : ids.join(', ');
console.log(`====== AetherWebOS E2E:${scope}(${ids.length}/${GROUPS.length} 组,parallel=${parallel}${clean ? ',clean' : ''})======`);
const T0 = Date.now();

if (clean) {
  const marks = parallel > 1 ? Array.from({ length: parallel }, (_, i) => 'w' + i) : ['main'];
  for (const m of marks) {
    try { rmSync(join(tmpdir(), 'webos-cdp-profile-' + m), { recursive: true, force: true }); } catch {}
  }
}

let all = [];
if (parallel === 1) {
  all = await runGroups(ids);
} else {
  // 轮询分组,每个工作进程一个独立 Chrome(独立调试端口 + 独立 profile)
  const chunks = Array.from({ length: parallel }, () => []);
  ids.forEach((id, i) => chunks[i % parallel].push(id));
  const outs = [], kids = [];
  for (let i = 0; i < parallel; i++) {
    if (!chunks[i].length) continue;
    const out = join(tmpdir(), `webos-e2e-w${i}-${process.pid}.json`);
    outs.push(out);
    kids.push(new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker',
        '--ids', chunks[i].join(','), '--out', out, '--profile', 'w' + i], { stdio: 'inherit' });
      p.on('close', resolve);
    }));
  }
  await Promise.all(kids);
  for (const out of outs) {
    try { all.push(...JSON.parse(readFileSync(out, 'utf8'))); rmSync(out, { force: true }); }
    catch (e) { console.error(`工作进程结果丢失: ${out}(${e.message})`); }
  }
  all.sort((a, b) => GROUPS.findIndex(g => g.id === a.id) - GROUPS.findIndex(g => g.id === b.id));
}

/* ---------- 汇总 ---------- */
console.log('\n====== 分组结果 ======');
for (const s of all) {
  console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.id.padEnd(4)} ${s.title}  (${(s.ms / 1000).toFixed(1)}s, ${s.n} 项)`);
}
const failGroups = all.filter(s => !s.pass);
const wall = ((Date.now() - T0) / 1000).toFixed(1);
console.log(`\n====== 结果: ${all.length - failGroups.length}/${all.length} 组通过,耗时 ${wall}s ======`);
process.exit(failGroups.length ? 1 : 0);
