/* ============================================================
 * 零依赖 CDP(Chrome DevTools Protocol)驱动
 * 用系统 Chrome 无头实例驱动 WebOS,做交互与截图验证。
 * 用法见 tools/e2e.mjs
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function launch(url = 'http://localhost:8080/') {
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + process.env.TEMP + '/webos-cdp-profile',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });
  await sleep(1200);

  // 找到页面 target
  let target;
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const client = {
    send, proc, ws,
    async evaluate(expr) {
      // 包一层函数作用域,避免多次 evaluate 之间的顶层 const/let 重复声明
      const wrapped = `(() => { return eval(${JSON.stringify(expr)}); })()`;
      const r = await send('Runtime.evaluate', {
        expression: wrapped, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error('页面执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result?.value;
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(1800);
    },
    async shot(name) {
      mkdirSync('.shots', { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`.shots/${name}.png`, Buffer.from(r.data, 'base64'));
      return `.shots/${name}.png`;
    },
    async close() {
      try { ws.close(); } catch {}
      try { proc.kill(); } catch {}
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
