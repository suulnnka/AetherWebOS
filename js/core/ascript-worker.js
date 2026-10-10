/* ============================================================
 * AetherJS 脚本 Worker —— 普通脚本(非路由处理函数)的执行引导
 * ------------------------------------------------------------
 * vendor/AetherWebFramework 的 worker 后端面向 16.7 处理函数契约
 * (程序返回值必须是函数),不适合跑「程序值 = 顶层 return / 末表达式」
 * 的普通脚本,这里是 webos 自己的薄壳:同一份运行时(vendor
 * runtime.js 静态引入,只进本 Worker 的打包图,不进 core 开机 chunk)。
 *
 * 协议(结构化克隆跨界,与规格第 10 节边界同构):
 *   → {id, type:'run', source}     编译 + 执行,程序值回传
 *   → {id, type:'check', source}   只编译不执行(编辑器实时语法检查)
 *   ← {id, ok:true, value, ms} | {id, ok:false, kind, message, line?, col?}
 *   ← {type:'log', id, text}       print 输出转发(脚本唯一宿主能力)
 *
 * 超时 terminate / 惰性重生在宿主侧(ascript.js):AetherJS 语言层面
 * 不防死循环(规格第 11 节出域),Worker 化就是宿主侧的处置。
 * ============================================================ */
import { compile, makeAether } from '../../vendor/AetherWebFramework/src/runtime.js';

/* 平台级 worker 标签:本 worker 由 core(平台)引用、终端 node 与代码
 * 编辑器共用,不进任何单个应用包 —— tools/apps-manifest.mjs 靠这个
 * 字符串把产物 chunk 归因为平台(压缩不丢字符串字面量)。
 * 挂到 self 上供运行时自省,也保证不被 tree-shaking 摇掉。 */
const PLATFORM_WORKER_TAG = 'ascript-worker-v1';
self.__ascriptWorker = PLATFORM_WORKER_TAG;

/** 结构化克隆守卫:函数值不过界(显示占位;程序值是脚本向宿主输出的唯一通道) */
function cloneable(v, depth = 0) {
  if (typeof v === 'function') return '<function>';
  if (v === null || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => cloneable(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = cloneable(v[k], depth + 1);
  return o;
}

let cached = null; // { source, prog } 编译缓存:同一脚本重复运行/检查不再编译

self.onmessage = async (e) => {
  const m = e.data;
  if (!m || (m.type !== 'run' && m.type !== 'check')) return;
  const t0 = performance.now();
  // print 闭包捕获本次请求 id:宿主按 id 路由到对应的输出回调
  const print = (...a) => postMessage({ type: 'log', id: m.id, text: a.join(' ') });
  try {
    if (!cached || cached.source !== m.source) {
      cached = { source: m.source, prog: compile(m.source, { globals: ['print'] }) };
    }
    if (m.type === 'check') {
      postMessage({ id: m.id, ok: true, ms: performance.now() - t0 });
      return;
    }
    const mod = await cached.prog.load();   // blob 模块动态 import(规格 B.2)
    const value = mod.default(makeAether({ print }));
    postMessage({ id: m.id, ok: true, value: cloneable(value), ms: performance.now() - t0 });
  } catch (err) {
    postMessage({
      id: m.id, ok: false,
      kind: err?.kind || 'host',
      message: String(err?.message ?? err),
      ...(err?.line != null ? { line: err.line } : {}),
      ...(err?.col != null ? { col: err.col } : {}),
    });
  }
};
