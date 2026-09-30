/* ============================================================
 * AetherSite —— vnet 与 AetherWebFramework 的桥接层
 * ------------------------------------------------------------
 * 内网站点不再用 HTML 字符串注册,而是 AetherJS 站点应用:
 *   router.ajs(纯数据路由表)+ <名>.ajs(处理函数)+ <名>.html(模板)
 * 经 AetherWebFramework(vendor/AetherWebFramework,沙盒语言 +
 * 伪 SSR 模板 + Django 风格路由)编译与分发,页面产物是白名单
 * HTML,浏览器侧 innerHTML 注入前已过 checkHtml 复检。
 *
 * webos 在框架契约(args → { template, data })之上叠加的 data
 * 指令(处理函数的宿主侧约定,模板不会读到这几个键):
 *   title      string   标签页标题(缺省站点标题)
 *   httpStatus number   403 → 浏览器渲染原生 403 错误页
 *   flag       string   渲染成功后置位的游戏标志位
 *   flags      array    同上(多个)
 *   proxy      string   「路径转换」键 → 站点注册表里声明的真实 URL
 *                        (沙盒代码只能引用键,选不了任意外网地址)
 *   redirect   string   站内重定向(相对当前 URL 解析,仅内网目标放行;
 *                        如登录成功置位标志位后回到干净地址 /)
 *
 * 另有一个宿主级路由 /goto/?u=<百分编码的完整URL>:模板白名单
 * 只允许相对链接,跨主机跳转(如搜索结果跳门户)经此中转;
 * 目标必须能被虚拟 DNS 解析,否则拒绝 —— 与 proxy 一样,是宿主
 * 代码在沙盒外把关的口子。
 *
 * 处理函数按框架「内联执行」路径跑(编译期白名单沙盒);死循环
 * 防护的 Worker 后端是框架的 dev 服务器形态,webos 内网站点是
 * 第一方内容,与旧 addSite 处理函数同一信任级。
 * ============================================================ */

const mounted = new Map(); // host -> { def, promise } 每站点挂载一次

/** 挂载一个站点:编译路由表/处理函数/模板(失败 reject,缓存负结果不重试) */
function mountSite(def) {
  const rec = mounted.get(def.host);
  if (rec) return rec.promise;
  const promise = (async () => {
    const { createRuntime, mountRouter } = await import('../../vendor/AetherWebFramework/src/index.js');
    const routes = await createRuntime({ print: (s) => console.log(`[aether:${def.host}]`, s) })
      .run(def.files['router.ajs']);
    if (!Array.isArray(routes)) throw new Error(`router.ajs 返回值必须是路由表数组`);
    const router = await mountRouter(routes, {
      loadScript: async (name) => def.files[`${name}.ajs`] ?? null,
      loadTemplate: async (name) => def.files[name] ?? null,
      hostGlobals: { print: (s) => console.log(`[aether:${def.host}]`, s) },
      log: (m) => console.warn(`[aether:${def.host}]`, m),
    });
    return router;
  })();
  mounted.set(def.host, { def, promise });
  return promise;
}

/** /goto/?u=… → 站内相对链接的跨主机中转;仅虚拟 DNS 可解析的目标放行。
 *  u 为百分编码的完整 URL 或 host/path 形式(缺协议按 http) */
function gotoRedirect(u, dnsResolve) {
  const raw = u.searchParams.get('u') || '';
  let target;
  try { target = new URL(decodeURIComponent(raw)); } catch { /* 无协议形式,补 http 再试 */ }
  if (!target) {
    try { target = new URL('http://' + decodeURIComponent(raw)); } catch { return { status: '403' }; }
  }
  if (!/^https?:$/.test(target.protocol) || !dnsResolve(target.hostname)) return { status: '403' };
  return { status: 'redirect', location: target.href };
}

/**
 * 分发一个已解析到 Aether 站点的请求。
 * @param def    站点定义(host/ip/title/files/proxies)
 * @param u      URL 对象
 * @param ctx    { flags(进度快照), setFlag, dnsResolve }
 * @returns vnet 结果对象(html/proxy/redirect/403/404;不含 ms,由调用方补)
 */
export async function aetherServe(def, u, ctx) {
  const p = (u.pathname || '/') + (u.search || '');
  // 宿主级中转路由:不进沙盒
  if (/^\/goto\/?$/.test(u.pathname)) {
    const g = gotoRedirect(u, ctx.dnsResolve);
    return { ...g, host: def.host, ip: def.ip, path: p, url: u.href, title: def.title };
  }

  let router;
  try { router = await mountSite(def); }
  catch (e) {
    console.warn('[aethersite] 站点挂载失败:', def.host, e);
    return { status: 'refused', host: def.host, ip: def.ip, url: u.href };
  }

  let out;
  try { out = await router.dispatch(u.href, ctx.flags); }
  catch (e) {
    console.warn('[aethersite] 分发失败:', def.host, e);
    return { status: '404', host: def.host, ip: def.ip, path: p, url: u.href, title: def.title };
  }

  if (out.status !== 200) {
    return { status: '404', host: def.host, ip: def.ip, path: p, url: u.href, title: def.title };
  }
  const d = out.data ?? {};
  const flagList = [];
  if (typeof d.flag === 'string' && d.flag) flagList.push(d.flag);
  if (Array.isArray(d.flags)) flagList.push(...d.flags.filter(f => typeof f === 'string' && f));
  flagList.forEach(f => ctx.setFlag(f));

  // 「路径转换」:键 → 站点声明的真实外网地址(作者数据,沙盒选不了)
  if (typeof d.proxy === 'string') {
    const proxyUrl = def.proxies?.[d.proxy];
    if (!proxyUrl) {
      console.warn(`[aethersite] 未声明的 proxy 键 "${d.proxy}"(${def.host})`);
      return { status: '403', host: def.host, ip: def.ip, path: p, url: u.href, title: def.title };
    }
    return {
      status: 'ok', type: 'proxy', proxyUrl,
      title: typeof d.title === 'string' && d.title ? d.title : def.title,
      host: def.host, ip: def.ip, path: p, url: u.href,
    };
  }
  // 站内重定向(如登录成功回到干净地址 /):值相对当前 URL 解析,
  // 目标必须仍是虚拟 DNS 可解析的内网主机(与 /goto/ 同一关口)
  if (typeof d.redirect === 'string' && d.redirect) {
    let target = null;
    try { target = new URL(d.redirect, u); } catch { /* 非法值忽略,照常渲染 */ }
    if (target && /^https?:$/.test(target.protocol) && ctx.dnsResolve(target.hostname)) {
      return { status: 'redirect', location: target.href, host: def.host, ip: def.ip, url: u.href, title: def.title };
    }
    console.warn(`[aethersite] redirect "${d.redirect}" 非内网地址,忽略(${def.host})`);
  }
  if (d.httpStatus === 403) {
    return { status: '403', host: def.host, ip: def.ip, path: p, url: u.href, title: def.title };
  }
  return {
    status: 'ok', type: 'html', body: out.html,
    title: typeof d.title === 'string' && d.title ? d.title : def.title,
    host: def.host, ip: def.ip, path: p, url: u.href,
  };
}

/** 开发/测试辅助:丢弃挂载缓存(站点文件热替换后重建) */
export function aetherReset() { mounted.clear(); }
