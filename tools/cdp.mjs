/* ============================================================
 * CDP(Chrome DevTools Protocol)驱动
 * 用系统 Chrome 无头实例驱动 AetherWebOS,做交互与截图验证。
 * 用法见 tools/e2e.mjs
 * ============================================================ */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function launch(url = 'http://localhost:8080/', { profile = '' } = {}) {
  // profile 用于并行时隔离实例:独立调试端口 + 独立 localStorage
  const dataDir = process.env.TEMP + '/webos-cdp-profile' + (profile ? '-' + profile : '');
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',   // 系统分配空闲端口,并行互不冲突
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + dataDir,
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });

  // 清掉上次运行遗留的端口文件(否则会读到已死实例的端口),再轮询新文件
  try { rmSync(dataDir + '/DevToolsActivePort', { force: true }); } catch {}
  let port = 0;
  for (let i = 0; i < 60; i++) {
    try {
      const first = readFileSync(dataDir + '/DevToolsActivePort', 'utf8').split('\n')[0].trim();
      if (first) { port = Number(first); break; }
    } catch { /* Chrome 尚未就绪 */ }
    await sleep(200);
  }
  if (!port) throw new Error('Chrome DevTools 端口未就绪');

  // 找到页面 target
  let target;
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!target) throw new Error('无法连接 Chrome DevTools');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  // 连接断开时拒绝所有在途调用,避免工作进程永久卡死
  ws.onclose = () => {
    for (const [, p] of pending) p.reject(new Error('CDP 连接已关闭'));
    pending.clear();
  };
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} 超时(${timeoutMs / 1000}s)`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
  // 等待一次 CDP 事件(如 Page.loadEventFired),超时返回 null
  const waitEvent = (method, timeoutMs = 15000) => new Promise((resolve) => {
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === method) { ws.removeEventListener('message', h); clearTimeout(timer); resolve(m.params); }
    };
    const timer = setTimeout(() => { ws.removeEventListener('message', h); resolve(null); }, timeoutMs);
    ws.addEventListener('message', h);
  });

  const client = {
    send, proc, ws,
    async evaluate(expr) {
      // 包一层函数作用域,避免多次 evaluate 之间的顶层 const/let 重复声明
      const wrapped = `(() => { return eval(${JSON.stringify(expr)}); })()`;
      const r = await send('Runtime.evaluate', {
        expression: wrapped, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        const line = r.exceptionDetails.lineNumber != null ? r.exceptionDetails.lineNumber + 1 : '?';
        const col = r.exceptionDetails.columnNumber != null ? r.exceptionDetails.columnNumber + 1 : '?';
        const snippet = String(expr).split('\n').slice(Math.max(0, line - 3), line + 1).join('\n');
        throw new Error('页面执行异常(line ' + line + ':' + col + '): ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n--- 附近代码 ---\n' + snippet);
      }
      return r.result?.value;
    },
    async goto(url) {
      // 等新文档 load 完成(而非旧文档),再留首帧渲染余量
      const loaded = waitEvent('Page.loadEventFired', 20000);
      await send('Page.navigate', { url });
      await loaded;
      await sleep(200);
    },
    async shot(name) {
      mkdirSync('.shots', { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`.shots/${name}.png`, Buffer.from(r.data, 'base64'));
      return `.shots/${name}.png`;
    },
    async close() {
      try { ws.close(); } catch {}
      // Windows 上 proc.kill() 只杀主进程,渲染进程会残留并锁住 profile,
      // 导致下次同 profile 启动失败 —— 必须杀整棵进程树
      try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); }
      catch { try { proc.kill(); } catch {} }
      await sleep(300);
    },
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // 禁用 HTTP 缓存:保留 profile 的 localStorage(持久化测试依赖),
  // 但避免 CSS/JS 同秒修改时 304 命中旧缓存
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.goto(url);
  return client;
}
