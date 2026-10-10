/* ============================================================
 * AetherJS 脚本运行器 —— 代码编辑器(运行按钮)与终端(node 命令)共用
 * ------------------------------------------------------------
 * 执行在独立 module Worker 里(引导见 ascript-worker.js):
 *  - AetherJS 语言层面不防死循环(规格第 11 节资源防护出域,处置
 *    归宿主),Worker + 超时 terminate 保证页面永不被脚本卡死,
 *    超时后 Worker 惰性重生;
 *  - 脚本唯一宿主能力是 print(经 log 消息单向转发,按请求 id 路由,
 *    并发运行互不串台);
 *  - 程序值(顶层 return 或末表达式)结构化克隆回传,函数值在
 *    Worker 侧以 '<function>' 占位。
 *
 * 编译错误(syntax)带 line/col 透传,编辑器据此跳转光标。
 * ============================================================ */

const DEFAULT_TIMEOUT = 5000;   // 单次执行上限;超时 terminate

let worker = null;
let alive = false;
let seq = 0;
const pending = new Map();      // id → { resolve, timer, print }

function kill(reason) {
  if (!alive) return;
  alive = false;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, ms: 0, error: { kind: 'limit', message: reason } });
  }
  pending.clear();
  const w = worker;
  worker = null;
  try { w.terminate(); } catch { /* 已退出 */ }
}

function spawn() {
  // new URL 必须内联在 new Worker 调用里:Vite worker 插件按此静态识别,
  // 拆成变量会被当成普通资源内联成 data: URL(相对 import 解析不了)
  const w = new Worker(new URL('./ascript-worker.js', import.meta.url), { type: 'module' });
  worker = w;
  alive = true;
  w.onmessage = (e) => {
    if (worker !== w) return;   // 过时实例的迟到消息(terminate 后)忽略
    const m = e.data;
    if (!m) return;
    if (m.type === 'log') {
      pending.get(m.id)?.print?.(m.text);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve({ ok: true, value: m.value, ms: m.ms });
    else p.resolve({ ok: false, ms: m.ms ?? 0, error: { kind: m.kind, message: m.message, line: m.line ?? null, col: m.col ?? null } });
  };
  w.onerror = () => { if (worker === w) kill('脚本 Worker 异常退出'); };
}

/**
 * 发起一次 Worker 请求。永不 reject:一切失败(含超时/Worker 死亡)
 * 都以 { ok:false, error } 形状 resolve,调用方无需 try/catch。
 * @param killOnTimeout 超时是否 terminate Worker:run 必须(死循环只有
 *        杀掉才能停);check 不杀 —— 它常在 run 忙碌时排队,杀了会误伤
 *        正在执行的脚本,放弃本次检查即可(迟到回包按 id 丢弃)。
 */
function request(msg, timeoutMs, killOnTimeout) {
  const { print, ...payload } = msg;   // print 是宿主回调,不能 postMessage 过界
  return new Promise((resolve) => {
    if (!alive) spawn();
    const id = ++seq;
    const rec = { resolve, print: print ?? null, timer: null };
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      rec.timer = setTimeout(() => {
        pending.delete(id);
        const reason = `执行超时(${timeoutMs / 1000}s),已强制终止 —— AetherJS 不设循环上限,死循环/长任务归脚本作者`;
        if (killOnTimeout) kill(reason);
        resolve({ ok: false, ms: timeoutMs, error: { kind: 'limit', message: killOnTimeout ? reason : `编译超时(${timeoutMs}ms),本次检查已放弃(Worker 忙)` } });
      }, timeoutMs);
    }
    pending.set(id, rec);
    worker.postMessage({ ...payload, id });
  });
}

/**
 * 运行一段 AetherJS 源码。
 * @param {string} source
 * @param {{print?: (text:string)=>void, timeoutMs?: number}} opts
 * @returns {Promise<{ok:true, value:any, ms:number} | {ok:false, ms:number, error:{kind:string,message:string,line:number|null,col:number|null}}>}
 */
export function runAether(source, { print, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  return request({ type: 'run', source, print }, timeoutMs, true);
}

/**
 * 只编译不执行(编辑器实时语法检查)。
 * @returns {Promise<{ok:true, ms:number} | {ok:false, ms:number, error:同上}>}
 */
export function checkAether(source, { timeoutMs = 1500 } = {}) {
  return request({ type: 'check', source }, timeoutMs, false);
}

/** Worker 终局清理(窗口关闭/测试收尾;未决调用以 limit 拒绝) */
export function stopAetherWorker() { kill('Worker 已被宿主终止'); }

/* ---------- 展示格式化(编辑器输出面板的「→ 程序值」行) ---------- */

/** 值 → 简短可读形式(字符串带引号,对象截断,环安全) */
export function formatAetherValue(v, depth = 0) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const ty = typeof v;
  if (ty === 'string') return JSON.stringify(v.length > 120 ? v.slice(0, 120) + '…' : v);
  if (ty === 'number' || ty === 'boolean') return String(v);
  if (ty === 'function') return '<function>';
  if (depth > 4) return '…';
  try {
    if (Array.isArray(v)) {
      const items = v.slice(0, 20).map((x) => formatAetherValue(x, depth + 1));
      const s = '[' + items.join(', ') + (v.length > 20 ? ', …' : '') + ']';
      return s.length > 200 ? s.slice(0, 200) + '…]' : s;
    }
    const keys = Object.keys(v);
    const body = keys.slice(0, 12)
      .map((k) => JSON.stringify(k) + ': ' + formatAetherValue(v[k], depth + 1))
      .join(', ') + (keys.length > 12 ? ', …' : '');
    const s = '{' + body + '}';
    return s.length > 200 ? s.slice(0, 200) + '…}' : s;
  } catch { return '(不可显示)'; }
}
