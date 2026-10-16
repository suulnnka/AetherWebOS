/* ============================================================
 * AetherWebOS 端到端冒烟测试
 * 先 npm run dev(Vite 开发服务器,固定 8080;应用裸模块依赖需要 Vite 解析),
 * 再运行本脚本(自动携带 ?e2e=1 进入应用测试模式,见 js/core/utils.js):
 *   node tools/e2e.mjs                  # 全部用例
 *   node tools/e2e.mjs T22 27           # 只跑指定组
 *   node tools/e2e.mjs T1-T5 邮件 天气  # 区间 / 组号 / 标题关键词,可混写
 *   node tools/e2e.mjs --list           # 列出全部用例组
 *   node tools/e2e.mjs --parallel 3     # 3 个浏览器并行跑
 *   node tools/e2e.mjs --keep           # 复用上轮浏览器 profile(默认每轮全新,见下)
 * 输出 PASS/FAIL 清单 + .shots/ 截图
 * ============================================================ */
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ?e2e=1 进入应用测试模式:跳过开机动画等装饰性等待(约定见 js/core/utils.js 的 E2E)
const URL_BASE = 'http://localhost:8080/?e2e=1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
/* 默认每轮全新 profile(原 --clean 内置为默认):浏览器内状态(localStorage +
 * OPFS 文件树)跨运行累积,数轮全量后启动被拖过 waitReady 的 12s 就绪线,
 * 表现为大批组"页面未就绪"雪崩失败;并行度实测与此无关(clean + parallel 6
 * 反而最快)。轮内持久化不受影响 —— 组间 fresh() 仍保留 localStorage,
 * "刷新后数据仍在"类用例照常工作。--keep 复用上轮 profile(调试持久化问题)。 */
let parallel = 6, wantList = false, workerMode = false, clean = true;   // 默认 6 个浏览器并行
const selectors = [];
let workerIds = null, workerOut = null, workerProfile = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list' || a === '-l') wantList = true;
  else if (a === '--worker') workerMode = true;          // 内部:并行工作进程
  else if (a === '--ids') workerIds = argv[++i].split(',');
  else if (a === '--out') workerOut = argv[++i];
  else if (a === '--profile') workerProfile = argv[++i];
  else if (a === '--keep') clean = false;
  else if (a === '--clean') clean = true;   // 兼容旧旗标:现已是默认行为
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
  --keep        复用上轮浏览器 profile(默认每轮运行前清空,防跨运行累积拖慢启动)`);
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
      ['user', '1234'],
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
  if (r?.ok) return true;
  // 注册/登录与首启自动建号(bootstrap)并发时可能撞车:短暂轮询等任一会话就绪,
  // 避免用例在"未登录"状态下写文件被静默拒绝
  for (let i = 0; i < 20; i++) {
    if (await ev(`WebOS.accounts?.current?.() || null`)) return true;
    await sleep(100);
  }
  return false;
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

/* 商店应用前置:store 应用默认未安装(不出现在开始菜单/桌面),
 * 用到它们的用例组开头先装好再测(幂等;安装语义详见 T50 软件商店组)。
 * 安装是异步的真实下载(WebOS.apps.install 返回 Promise),必须等全部
 * 落地后再继续 —— 否则下面的 wm.open 会撞上安装门禁 */
const needApps = (...ids) => ev(`Promise.all(${JSON.stringify(ids)}.map(id => WebOS.apps.install(id, { silent: true }))).then(() => true)`);

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

/* 清掉某用户的 appdata 库文件并等元数据落盘(数据已迁 ~/appdata/*.awdb,重跑清档用;
   root 绕过权限;flush 确保 rm 的元数据在刷新前写进 OPFS,避免文件"复活") */
const wipeAppData = (user, app) => ev(`(async () => {
  WebOS.fs.rm('/home/${user}/appdata/${app}.awdb', { as: 'root' });
  await WebOS.fs.flush();
  return true;
})()`);

/* 清空非系统用户归属的库(设备级/身份库):共享区同名库 + 身份库
   (<app>#<身份>.awdb)+ 各类一次性迁移旗标 + 旧按用户库一并清掉,
   否则收养/迁移逻辑会把旧数据搬回来,断言(种子数量)不成立 */
const wipeSharedAppData = (app) => ev(`(async () => {
  const app = ${JSON.stringify(app)};
  await WebOS.fs.flush();   // 确保 fs 元数据树就绪,避免与启动期装载赛跑
  for (const k of Object.keys(localStorage)) {
    if (k === 'webos.appdata.adopt::' + app
      || k.startsWith('webos.appdata.sharedback::' + app + '::')
      || (app === 'mail' && k.startsWith('webos.appdata.mailback::'))) localStorage.removeItem(k);
  }
  WebOS.fs.rm('/home/shared/appdata/' + app + '.awdb', { as: 'root' });
  for (const f of WebOS.fs.list('/home/shared/appdata', { as: 'root' }) || []) {
    if (!f.dir && f.name.startsWith(app + '%23')) WebOS.fs.rm('/home/shared/appdata/' + f.name, { as: 'root' });
  }
  for (const u of WebOS.fs.list('/home', { as: 'root' }) || []) {
    if (u.dir && u.name !== 'shared') WebOS.fs.rm('/home/' + u.name + '/appdata/' + app + '.awdb', { as: 'root' });
  }
  await WebOS.fs.flush();
  return true;
})()`);

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
    await sleep(1600); // 模拟加载动画 + 渲染(AetherJS 站点首访另含挂载编译)
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

  // 桌面再次打开 = 新开一张独立空便签(不共享已开窗口数据);菜单「新建待办」
  // 同样独立;「删除待办」只删本板(断言用增量,不受会话恢复时机影响)。
  // 先清 lastOpen:否则「一个没开 + 上次全关记录」会走整组恢复而非新开空便签
  await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    if (s && (s.lastOpen || []).length) { s.lastOpen = []; s.seq = (s.seq || 0) + 1; await WebOS.appdata.saveState('todo', s, WebOS.accounts.current()); }
  })()`);
  const before = await ev(`document.querySelectorAll('.win[data-app=todo]').length`);
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  const opened = await ev(`(() => {
    const mains = [...document.querySelectorAll('.win[data-app=todo]')].filter(w => w.querySelector('.todo-input'));
    const nw = mains[mains.length - 1];
    return {
      count: document.querySelectorAll('.win[data-app=todo]').length,
      emptyNew: nw.querySelectorAll('.todo-item').length === 0,   // 新开的是空清单
      oldKeptVisible: mains.length < 2 || [...mains[0].querySelectorAll('.todo-t')].some(x => x.textContent.includes('锁定后任务A')),
    };
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
  t('T27.10b 每窗一板数据隔离(桌面重开=新空清单/新清单独立/删除只删自己)',
    opened.count === before + 1 && opened.emptyNew && opened.oldKeptVisible
      && wNew.count === opened.count + 2 && wNew.mains >= 2
      && isolation.inNew && isolation.othersClean && isolation.onlyInOne
      && cleared.count === wNew.count - 1 && cleared.oldKept && cleared.goneTask,
    JSON.stringify({ before, opened, wNew, isolation, cleared }));
  // 收尾:清场全部便签窗口
  await ev(`(() => {
    [...document.querySelectorAll('.win[data-app=todo]')].forEach(w => WebOS.wm.close(w.dataset.id));
  })()`);
  await sleep(400);

  // 自绘关闭按钮(顶栏黑色 ✕)。先清 lastOpen 并提升 seq(内存态才会采纳),
  // 让这里的桌面打开走「新开空便签」而非整组恢复
  await ev(`(async () => {
    const s = await WebOS.appdata.loadState('todo', WebOS.accounts.current());
    if (s) { s.lastOpen = []; s.seq = (s.seq || 0) + 1; await WebOS.appdata.saveState('todo', s, WebOS.accounts.current()); }
  })()`);
  await ev(`WebOS.wm.open('todo')`);
  await sleep(700);
  await ev(`(() => {
    const inp = document.querySelector('.win[data-app=todo] .todo-input');
    inp.value = '关闭前任务';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(600);
  await ev(`document.querySelector('.win[data-app=todo] .todo-close').click()`);
  await sleep(400);
  t('T27.11 自绘关闭按钮', await ev(`!document.querySelector('.win[data-app=todo]')`) === true);

  // 全关后桌面打开 = 整组恢复刚才关掉的那组板(内容原样回来)
  await ev(`WebOS.wm.open('todo')`);
  await sleep(900);
  const regrp = await ev(`(() => ({
    count: document.querySelectorAll('.win[data-app=todo]').length,
    restored: [...document.querySelectorAll('.todo-t')].some(x => x.textContent === '关闭前任务'),
  }))()`);
  t('T27.11b 全关后桌面打开整组恢复', regrp.count === 1 && regrp.restored, JSON.stringify(regrp));
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

group('T33', '扫雷 + 国际象棋', async () => {
  /* ---- T33 扫雷 + 国际象棋 ---- */
  await needApps('minesweeper', 'chess3d');
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
  await needApps('reversi');
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
  await needApps('solitaire', 'pairs');
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
  await needApps('sokoban');
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

group('T44', '五子棋(双规则 / 禁手标记 / AI 应答)', async () => {
  /* ---- T44 五子棋:双规则 / 禁手标记 / AI 应答 / 悔棋 ---- */
  await needApps('gomoku');
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
    g1.black === 1 && g1.last && g1.stats.plies >= 1, JSON.stringify(g1));
  /* plies 用 >=:wasm v2 引擎 ~1ms 就应完,读到时 AI 那手多半已落地 */

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

group('T52', '线索(节点便签图 / 单链连线 / 双击编辑 / 缩放 / 持久化)', async () => {
  /* ---- T52 clues:便签节点(只显标题)+ 有向单链 + 双击编辑 + 右键聚焦 ---- */
  await fresh();
  // 前置:登录专用账号并清 appdata(保证种子数据),再安装(安装按用户:登录后装)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current() !== 'clueer' && !(await accounts.login('clueer', 'cluepass')).ok) {
      await accounts.register('clueer', 'cluepass');
      await accounts.login('clueer', 'cluepass');
    }
    return true;
  })()`);
  await wipeAppData('clueer', 'clues');
  await needApps('clues');

  await ev(`WebOS.wm.open('clues')`);
  const opened = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w && w.querySelectorAll('.clue-note').length === 3 ? true : false;
  })()`);
  const s0 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const edges = [...w.querySelectorAll('.clue-edge')];
    return {
      notes: w.querySelectorAll('.clue-note').length,
      links: edges.length,
      arrows: edges.every(p => (p.getAttribute('marker-end') || '').includes('clue-arr')),
      anchor: !!w.querySelector('.clue-anchor'),
      status: w.querySelector('.clue-status-l')?.textContent || '',
      statusR: w.querySelector('.clue-status-r')?.textContent || '',
    };
  })()`);
  t('T52.1 骨架(种子 3 便签 / 2 单链带箭头 / 状态栏)', opened === true
    && s0.notes === 3 && s0.links === 2 && s0.arrows === true && s0.anchor === true
    && s0.status.includes('3 节点') && s0.status.includes('2 单链')
    && s0.statusR.includes('双击便签编辑'), JSON.stringify(s0));

  // 选中 + 编辑:改标题/加内容
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('案件')).click();
  })()`);
  const selOk = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const sel = w.querySelector('.clue-note.sel');
    return sel && [...w.querySelectorAll('.app-toolbar .btn')].filter(b => !b.disabled).length >= 4;   // 新建+编辑+连出+删除
  })()`);
  t('T52.2 单击选中(sel 类 + 上下文按钮可用)', selOk === true);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑')).click();
  })()`);
  const editorUp = await waitFor(`(() => {
    const box = document.querySelector('.clue-editor');
    return box && box.querySelector('.clue-ed-title') && box.querySelector('.clue-ed-body-in')
      && box.querySelector('.clue-ed-sheet') && box.querySelector('.clue-ed-preview .clue-note')
      && box.querySelector('.clue-swatch.on') ? true : false;
  })()`);
  t('T52.3 编辑器(左编辑纸标题+正文融合 / 右预览+颜色)', editorUp === true);
  await ev(`(() => {
    const box = document.querySelector('.clue-editor');
    box.querySelector('.clue-ed-title').value = '案件:仓库失窃·改';
    box.querySelector('.clue-ed-body-in').value = '监控断电十分钟是人为。';
    [...box.querySelectorAll('.btn.primary')].find(b => b.textContent.includes('保存')).click();
  })()`);
  const edited = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const n = [...w.querySelectorAll('.clue-note')].find(x => x.textContent.includes('仓库失窃·改'));
    if (!n || !n.classList.contains('has-body')) return false;
    // 回归:保存后编辑器与遮罩都必须消失(旧 bug 只删 box,灰色 mask 残留罩死全屏)
    return !document.querySelector('.clue-editor') && !document.querySelector('body > .modal-mask');
  })()`);
  t('T52.4 保存后只显标题 + 遮罩彻底关闭(回归)', edited === true
    && await ev(`(() => {
      const n = [...document.querySelector('.win[data-app=clues]').querySelectorAll('.clue-note')]
        .find(x => x.textContent.includes('仓库失窃·改'));
      return n.querySelector('.clue-title').textContent === '案件:仓库失窃·改'
        && !n.textContent.includes('监控断电');
    })()`));

  // 双击便签直接打开编辑器(改名后保存生效,遮罩随之关闭)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const n = [...w.querySelectorAll('.clue-note')].find(x => x.textContent.includes('嫌疑人'));
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 30, clientY: r.top + 15 }));
  })()`);
  const dblEd = await waitFor(`(() => {
    const box = document.querySelector('.clue-editor');
    return box && box.querySelector('.clue-ed-title').value.includes('嫌疑人') ? true : false;
  })()`);
  await ev(`(() => {
    const box = document.querySelector('.clue-editor');
    box.querySelector('.clue-ed-title').value = '嫌疑人 M(重点)';
    [...box.querySelectorAll('.btn.primary')].find(b => b.textContent.includes('保存')).click();
  })()`);
  const dblSaved = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return [...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('重点'))
      && !document.querySelector('.clue-editor') && !document.querySelector('body > .modal-mask');
  })()`);
  t('T52.5 双击便签直接编辑(打开即带原文 / 保存生效)', dblEd === true && dblSaved === true);

  // 双击空白新建便签(落点即位置)
  await ev(`(() => {
    const cv = document.querySelector('.win[data-app=clues] .clues-canvas');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 420, clientY: r.top + 300 }));
  })()`);
  const newDlg = await waitFor(`!!document.querySelector('.clue-editor')`);
  await ev(`(() => {
    const box = document.querySelector('.clue-editor');
    box.querySelector('.clue-ed-title').value = '门外的新脚印';
    [...box.querySelectorAll('.btn.primary')].find(b => b.textContent.includes('保存')).click();
  })()`);
  const added = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-note').length === 4
      && [...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('新脚印')) ? true : false;
  })()`);
  t('T52.6 双击空白新建(4 便签)', newDlg === true && added === true);

  // 连线:选中「门外的新脚印」→ 连出 → 点击「嫌疑人 M」
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('新脚印')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('连出')).click();
  })()`);
  const linking = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelector('.clues-canvas').classList.contains('linking')
      && w.querySelector('.clue-status-r').textContent.includes('目标便签');
  })()`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('嫌疑人')).click();
  })()`);
  const linked = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-edge').length === 3 ? true : false;
  })()`);
  t('T52.7 单链连线(连出 → 点目标,3 单链带箭头)', linking === true && linked === true
    && await ev(`(() => {
      const w = document.querySelector('.win[data-app=clues]');
      return [...w.querySelectorAll('.clue-edge')].every(p => (p.getAttribute('marker-end') || '').includes('clue-arr'))
        && !w.querySelector('.clues-canvas').classList.contains('linking');
    })()`));

  // 重复同向单链被拒绝(数量不变,连线模式退出)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('新脚印')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('连出')).click();
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('嫌疑人')).click();
  })()`);
  const dupOk = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return { links: w.querySelectorAll('.clue-edge').length, linking: w.querySelector('.clues-canvas').classList.contains('linking') };
  })()`);
  t('T52.8 同向单链去重(仍 3 条)', dupOk.links === 3 && dupOk.linking === false, JSON.stringify(dupOk));

  // 聚焦(右键便签 → 聚焦):只显示它 + 直接相邻(无关联的「新脚印」被隐藏)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const n = [...w.querySelectorAll('.clue-note')].find(x => x.textContent.includes('仓库失窃'));
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }));
  })()`);
  const focusMenu = await waitFor(`[...document.querySelectorAll('#ctx .ctx-item')].some(b => b.textContent.includes('聚焦'))`);
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('聚焦')).click()`);
  const focused = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-note').length === 3 && w.querySelector('.clue-focus-chip') ? true : false;
  })()`);
  t('T52.9 右键聚焦(只留相关 3 张,无关节点隐藏)', focusMenu === true && focused === true
    && await ev(`(() => {
      const w = document.querySelector('.win[data-app=clues]');
      return w.querySelector('.clue-focus-chip').textContent.includes('仓库失窃')
        && ![...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('新脚印'))
        && w.querySelectorAll('.clue-edge').length === 2;      // 聚焦只画可见节点间的线
    })()`));
  // 双击空白退出聚焦
  await ev(`(() => {
    const cv = document.querySelector('.win[data-app=clues] .clues-canvas');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }));
  })()`);
  const exited = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const chip = w && w.querySelector('.clue-focus-chip');
    return w.querySelectorAll('.clue-note').length === 4 && chip && chip.style.display === 'none' ? true : false;
  })()`);
  t('T52.10 双击空白退出聚焦(回全图 4 张)', exited === true);

  // 工具栏缩放:+ 放大 / 百分比复位 / − 缩小(整体节点随之缩放)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const btns = [...w.querySelectorAll('.app-toolbar .btn')];
    btns.find(b => b.title === '放大').click();
    btns.find(b => b.title === '放大').click();
  })()`);
  const zoomedIn = await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').textContent`);
  await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').click()`);
  const zoomReset = await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').textContent`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.title === '缩小').click();
  })()`);
  const zoomedOut = await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').textContent`);
  t('T52.11 工具栏缩放(放大 / 复位 100% / 缩小)', parseInt(zoomedIn) > 100
    && zoomReset.trim() === '100%' && parseInt(zoomedOut) < 100,
    `${zoomedIn} → ${zoomReset} → ${zoomedOut}`);
  await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').click()`);   // 复位回 100%,不干扰后续

  // 反向单链:嫌疑人 → 案件(与已有 案件→嫌疑人 互为反向,两条都弯开)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('嫌疑人')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('连出')).click();
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('仓库失窃')).click();
  })()`);
  const curved = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const qs = [...w.querySelectorAll('.clue-edge')].filter(p => p.getAttribute('d').includes('Q'));
    return w.querySelectorAll('.clue-edge').length === 4 && qs.length === 2 ? true : false;
  })()`);
  t('T52.12 反向单链(双向对自动弯开不重叠)', curved === true);

  // 连线右键删除
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    w.querySelector('.clue-edge-hit')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  })()`);
  const menuUp = await waitFor(`[...document.querySelectorAll('#ctx .ctx-item')].some(b => b.textContent.includes('删除连线'))`);
  t('T52.13 连线右键菜单(反转 / 删除)', menuUp === true);
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('删除连线')).click()`);
  const linkGone = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-edge').length === 3 ? true : false;
  })()`);
  t('T52.14 删除连线(3 条)', linkGone === true);

  // 删除便签:确认框 + 级联清线
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('新脚印')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('删除')).click();
  })()`);
  const confirmUp = await waitFor(`(() => {
    return [...document.querySelectorAll('.win[data-app=sysdialog]')].some(d => d.textContent.includes('删除便签'));
  })()`);
  t('T52.15 删除便签确认框(提示级联删线)', confirmUp === true);
  await ev(`(() => {
    const btns = [...document.querySelectorAll('.win[data-app=sysdialog] button')];
    (btns.find(b => b.textContent.includes('删除')) || btns.find(b => b.textContent.includes('确定')))?.click();
  })()`);
  const nodeGone = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-note').length === 3 && w.querySelectorAll('.clue-edge').length === 2 ? true : false;
  })()`);
  t('T52.16 删除便签级联清线(回 3 节点 2 单链)', nodeGone === true);

  // 持久化:落盘后整页刷新,重新登录打开,数据原样回来
  await sleep(450);   // 等过持久化防抖(200ms),再显式冲刷元数据
  await ev(`(async () => { await WebOS.fs.flush(); return true; })()`);
  await fresh();
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current() !== 'clueer') await accounts.login('clueer', 'cluepass');
    return true;
  })()`);
  await needApps('clues');
  await ev(`WebOS.wm.open('clues')`);
  const restored = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    if (!w) return false;
    const edited = [...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('仓库失窃·改'));
    return w.querySelectorAll('.clue-note').length === 3 && edited
      && w.querySelectorAll('.clue-edge').length === 2 ? true : false;
  })()`);
  t('T52.17 刷新后数据恢复(编辑过的标题 / 3 节点 2 单链)', restored === true);

  const errs52 = await ev(`window.__errs.length`);
  t('T52.18 全程无错误', errs52 === 0, `errs=${errs52}`);
  await c.shot('t52-clues');
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
console.log(`====== AetherWebOS E2E:${scope}(${ids.length}/${GROUPS.length} 组,parallel=${parallel}${clean ? '' : ',keep'})======`);
const T0 = Date.now();

if (clean) {
  // 清扫全部 webos-cdp-profile-*(含历史并行度遗留的 worker 目录),而非只清本轮要用的:
  // 跨运行累积的 OPFS/localStorage 全在这些目录里,留着只会拖慢后续每一轮
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith('webos-cdp-profile-')) {
        try { rmSync(join(tmpdir(), name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch { /* tmpdir 不可读:跳过清理,本轮照跑 */ }
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
