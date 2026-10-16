/* ============================================================
 * AetherWebOS e2e 公共设施(自原 e2e.mjs 单文件上提)
 * 断言收集 t() / 用例组注册 group() / 浏览器连接与 ev() /
 * 组间重置 fresh() / 各类跨组共享助手(终端输入、真实键鼠、清档等)。
 * 连接 c 由入口 e2e.mjs 的 runGroups 经 setConn() 注入;导出为活绑定,
 * 用例组内的 c.send / c.shot 直接可用(只读,不可赋值)。
 * ============================================================ */

// ?e2e=1 进入应用测试模式:跳过开机动画等装饰性等待(约定见 js/core/utils.js 的 E2E)
export const URL_BASE = 'http://localhost:8080/?e2e=1';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 结果收集 ---------- */
export const results = [];
export let TAG = '';   // 工作进程输出前缀([w0] 等),入口解析 --profile 后经 setTag 注入
export const setTag = (profile) => { TAG = profile ? `[${profile}] ` : ''; };
export const t = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${TAG}${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 用例组注册 ---------- */
export let c = null;   // 当前浏览器连接(进入用例组前由入口 runGroups 经 setConn 赋值)
export const setConn = (conn) => { c = conn; };
export const GROUPS = [];
export const group = (id, title, fn) => GROUPS.push({ id, title, fn });
export const ev = (expr) => c.evaluate(expr);

/* 就绪等待:轮询直到开机画面移除、桌面图标渲染(替代固定 sleep)。
   文件系统 v2 绑定用户:首启无账号时自动注册 e2euser,保证有 ~/desktop 与图标。 */
async function ensureE2ESession() {
  const st = await ev(`(() => ({
    os: !!window.WebOS,
    user: window.WebOS.accounts?.current?.() || null,
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
export async function fresh() { await c.goto(URL_BASE); await waitReady(); }

/* 商店应用前置:store 应用默认未安装(不出现在开始菜单/桌面),
 * 用到它们的用例组开头先装好再测(幂等;安装语义详见 T50 软件商店组)。
 * 安装是异步的真实下载(WebOS.apps.install 返回 Promise),必须等全部
 * 落地后再继续 —— 否则下面的 wm.open 会撞上安装门禁 */
export const needApps = (...ids) => ev(`Promise.all(${JSON.stringify(ids)}.map(id => WebOS.apps.install(id, { silent: true }))).then(() => true)`);

/* 轮询等待表达式为真值(默认 5s 超时,返回最终值)。
   用于异步 UI 就绪等待:如加密解密(PBKDF2 派生)、弹窗窗口创建等无固定耗时的环节 */
export async function waitFor(expr, timeout = 5000) {
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
export const wipeAppData = (user, app) => ev(`(async () => {
  WebOS.fs.rm('/home/${user}/appdata/${app}.awdb', { as: 'root' });
  await WebOS.fs.flush();
  return true;
})()`);

/* 清空非系统用户归属的库(设备级/身份库):共享区同名库 + 身份库
   (<app>#<身份>.awdb)+ 各类一次性迁移旗标 + 旧按用户库一并清掉,
   否则收养/迁移逻辑会把旧数据搬回来,断言(种子数量)不成立 */
export const wipeSharedAppData = (app) => ev(`(async () => {
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

export const termType = async (cmd) => {
  await ev(`(async () => {
    const inp = document.querySelector('.term-in input');
    inp.value = ${JSON.stringify(cmd)};
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(350);
};

export const nav = async (addrInput) => {
  await ev(`(async () => {
    const a = document.querySelector('.vw-addr');
    a.value = ${JSON.stringify(addrInput)};
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(1600); // 模拟加载动画 + 渲染(AetherJS 站点首访另含挂载编译)
};

/* bash 子 shell 命令:与 termType 同一终端窗口(先输入 bash 进入子 shell) */
export const bashType = async (cmd) => {
  await ev(`(async () => {
    const w = document.querySelector('.win[data-app=terminal]');
    const inp = w.querySelector('.term-in input');
    inp.value = ${JSON.stringify(cmd)};
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(320);
};

export const bashOut = () => ev(`document.querySelector('.win[data-app=terminal] .term-out').textContent`);

export const ctxClick = async (label) => {
  await ev(`(() => {
    const item = [...document.querySelectorAll('#ctx .ctx-item')].find(i => i.textContent.includes(${JSON.stringify(label)}));
    if (item) item.click();
  })()`);
  await sleep(400);
};

/** CDP 真实键盘输入(经浏览器输入管线,isTrusted;三段式保证非字母/中文字符插入) */

export const typeReal = async (text) => {
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

export const pressEnter = async () => {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(120);
};

export const clickReal = async (x, y, count = 1) => {
  for (let i = 0; i < count; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i + 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i + 1 });
    await sleep(70);
  }
};
