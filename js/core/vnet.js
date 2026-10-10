/* ============================================================
 * VNet —— 虚拟网络核心(解谜游戏平台)
 *
 * 由三部分组成:
 *   DNS     虚拟域名解析(游戏作者注册;运行时可增删)
 *   HTTP    虚拟网站路由:路径 → 页面 / 处理函数 / 代理(proxy)
 *           proxy 即「路径转换」:虚拟 URL 映射到真实互联网资源,
 *           这是用户触达外网的唯一通道,且只能由游戏作者配置。
 *   SSH     虚拟服务器:用户名/口令 + 虚拟文件系统 + 自定义命令
 *           (会话引擎在 core/vssh.js:多会话、远端文件读写、常用命令、
 *            跳板嵌套、传输 put/get,远端改动随游戏进度持久化)
 *
 * 安全模型:浏览器与终端只能访问本模块解析得到的资源;
 * 任何真实网络请求仅发生在作者声明的 proxy 路径上。
 *
 * 所有活动通过总线广播(vnet:http / vnet:ssh / vnet:flag-changed),
 * 系统监视器可直接观测虚拟网络流量。
 * ============================================================ */

import { publish } from './bus.js';
import fs from './fs.js';
import { aetherServe } from './aethersite.js';
import { openSession, resetLiveTrees } from './vssh.js';

const KEY = 'webos.vnet.v1';
const dnsRecords = new Map(); // host -> 记录
const sites = new Map();      // hostOrIp -> 站点定义(旧式:HTML 字符串路由)
const aetherSites = new Map(); // hostOrIp -> AetherJS 站点定义(见 aethersite.js)
const servers = new Map();    // hostOrIp -> 服务器定义
let searchHost = null;        // 地址栏非 URL 输入的搜索分流目标(游戏作者注册)

/** 可变状态(持久化):游戏标志位 + 运行时新增的 DNS + 远端文件系统覆盖层 */
let mutable = { flags: {}, dnsExtra: [], sshFs: {} };
try { Object.assign(mutable, JSON.parse(localStorage.getItem(KEY)) || {}); } catch { /* 忽略 */ }
let saveT;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(mutable)); } catch (e) { console.warn('[vnet] 持久化失败', e); }
  }, 200);
}

const normHost = (h) => String(h || '').trim().toLowerCase().replace(/\.+$/, '');
const isIP = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/* ================= DNS ================= */

/**
 * 注册 DNS 记录(游戏作者在启动时调用)
 * { host, ip, note, listed(是否出现在内网导航), latency }
 */
export function addDNS(rec) {
  dnsRecords.set(normHost(rec.host), {
    host: normHost(rec.host),
    ip: rec.ip,
    note: rec.note || '',
    listed: !!rec.listed,
    latency: rec.latency ?? 4 + Math.floor(Math.random() * 22),
  });
}

/** 运行时新增/覆盖 DNS(游戏事件调用,持久化) */
export function dnsAdd(rec) {
  const h = normHost(rec.host);
  mutable.dnsExtra = mutable.dnsExtra.filter(e => e.host !== h);
  mutable.dnsExtra.push({ host: h, ip: rec.ip, note: rec.note || '' });
  persist();
  publish('vnet:dns', { from: 'vnet', type: 'dns-add', payload: { host: h, ip: rec.ip } });
}

/** 解析:host → { host, ip, latency, listed, note };失败返回 null */
export function dnsResolve(hostInput) {
  const h = normHost(hostInput);
  if (isIP(h)) return { host: h, ip: h, latency: 2, listed: false, note: '' };
  const extra = mutable.dnsExtra.find(e => e.host === h);
  const rec = dnsRecords.get(h);
  if (!rec && !extra) return null;
  return {
    host: h,
    ip: extra?.ip ?? rec.ip,
    latency: rec?.latency ?? 12,
    listed: !!rec?.listed,
    note: extra?.note || rec?.note || '',
  };
}

/** 列出可公开展示的记录(浏览器内网导航页) */
export function dnsList() {
  return [...dnsRecords.values()].filter(r => r.listed);
}

/* ================= HTTP(虚拟网站) ================= */

/**
 * 注册站点(游戏作者调用)
 * site: { ip?, title, routes: { path: html字符串 | (ctx) => 结果 } }
 * 路由结果:string | { body } | { proxy: 真实URL } | { redirect } | { status:403 }
 * ctx = { path, query, flag(k), setFlag, dnsList }
 */
export function addSite(host, site) {
  sites.set(normHost(host), site);
  if (site.ip) sites.set(site.ip, site);
}

/**
 * 注册 AetherJS 站点(AetherWebFramework 实现,推荐方式):
 * def: { ip, title, files: { 'router.ajs': 源码, '<名>.ajs': …, '<名>.html': … },
 *        proxies?: { 键: 真实外网URL } }
 * 站点在首次被访问时惰性挂载(编译进独立 chunk,不拖慢开机)。
 */
export function registerAetherSite(host, def) {
  const d = { ...def, host: normHost(host) };
  aetherSites.set(d.host, d);
  if (d.ip) aetherSites.set(d.ip, d);
}

/** 注册地址栏搜索引擎主机(浏览器对非 URL 输入改道搜索,Firefox 式) */
export function setSearchHost(host) { searchHost = host ? normHost(host) : null; }
export const getSearchHost = () => searchHost;

function matchRoute(site, path) {
  if (site.routes[path] != null) return site.routes[path];
  // 最长前缀匹配('/docs/' 之类目录路由)
  const best = Object.keys(site.routes)
    .filter(k => k.length > 1 && k.endsWith('/') && path.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (best) return site.routes[best];
  return site.routes['*'] ?? null;
}

/** httpGet / httpGetAsync 的公共前端:解析 + 总线事件 + DNS */
function frontMatter(rawUrl) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : 'http://' + rawUrl); }
  catch { return { err: { status: 'badurl', url: rawUrl } }; }
  if (!/^https?:$/.test(u.protocol)) return { err: { status: 'badurl', url: rawUrl } };

  publish('vnet:http', { from: 'vnet', type: 'http', payload: { method: 'GET', host: u.hostname, path: u.pathname, url: u.href } });

  const rec = dnsResolve(u.hostname);
  if (!rec) return { err: { status: 'dns', host: u.hostname, url: u.href } };
  return { u, rec };
}

/**
 * 虚拟 HTTP GET(异步:AetherJS 站点经 AetherWebFramework 分发,
 * 旧式 addSite 站点仍走同步路径)。返回形状与 httpGet 相同:
 * { status:'ok', type:'html'|'proxy', body/proxyUrl, title, host, ip, path, url, ms }
 * 或 { status:'dns'|'refused'|'404'|'403'|'redirect'|'badurl', ... }
 */
export async function httpGetAsync(rawUrl) {
  const t0 = performance.now();
  const f = frontMatter(rawUrl);
  if (f.err) return f.err;
  const { u, rec } = f;
  const adef = aetherSites.get(u.hostname) || aetherSites.get(rec.ip);
  if (adef) {
    const r = await aetherServe(adef, u, { flags: { ...mutable.flags }, setFlag, dnsResolve });
    return { ...r, ms: Math.round(performance.now() - t0) };
  }
  return httpGet(rawUrl);
}

/**
 * 虚拟 HTTP GET(旧式同步路径)。返回:
 * { status:'ok', type:'html'|'proxy', body/proxyUrl, title, host, ip, path, url, ms }
 * 或 { status:'dns'|'refused'|'404'|'403'|'redirect'|'badurl', ... }
 */
export function httpGet(rawUrl) {
  const t0 = performance.now();
  const f = frontMatter(rawUrl);
  if (f.err) return f.err;
  const { u, rec } = f;
  if (!site) return { status: 'refused', host: u.hostname, ip: rec.ip, url: u.href };

  const path = (u.pathname || '/') + (u.search || '');
  const route = matchRoute(site, u.pathname || '/');
  if (route == null) return { status: '404', host: rec.host, ip: rec.ip, path, url: u.href, title: site.title };

  const ctx = {
    path, query: Object.fromEntries(u.searchParams),
    flag: (k) => !!mutable.flags[k],
    setFlag,
    dnsList,
  };
  let result = typeof route === 'function' ? route(ctx) : route;
  if (typeof result === 'string') result = { body: result };

  if (result.redirect) return { status: 'redirect', location: result.redirect, url: u.href };
  if (result.status === 403) return { status: '403', host: rec.host, ip: rec.ip, path, url: u.href, title: site.title };
  if (result.proxy) {
    return {
      status: 'ok', type: 'proxy', proxyUrl: result.proxy,
      title: result.title || site.title, host: rec.host, ip: rec.ip, path, url: u.href,
      ms: Math.round(performance.now() - t0),
    };
  }
  return {
    status: 'ok', type: 'html', body: result.body ?? '',
    title: result.title || site.title, host: rec.host, ip: rec.ip, path, url: u.href,
    ms: Math.round(performance.now() - t0),
  };
}

/* ================= SSH(虚拟服务器) ================= */

/**
 * 注册 SSH 服务器(游戏作者调用)
 * server: { ip?, port?, banner?, os?: { hostname, kernel, uptime },
 *           fs?(全机共享文件系统), users: { 用户名: { password, home, motd, fs?, commands } } }
 * fs(共享树或 users.<名>.fs 私有树):嵌套对象,目录=对象,文件=字符串,
 *   或 { $: 内容, mode: 'rw-------', owner: 'root' } 带属性文件
 * commands: { 命令名: (args, session) => string[] }(谜题机关,优先于内建命令)
 * 会话引擎(远端文件系统/常用命令/多会话/持久化)见 core/vssh.js
 */
export function addServer(host, server) {
  server.__key = server.ip || normHost(host);   // 活动树/覆盖层的规范键(域名/IP 连接归并)
  servers.set(normHost(host), server);
  if (server.ip) servers.set(server.ip, server);
}

/* ---- 极简路径归一(旧公共工具,保留兼容) ---- */
export function vpath(cwd, p) {
  const abs = String(p).startsWith('/') ? p : (cwd === '/' ? '' : cwd) + '/' + p;
  const out = [];
  for (const s of abs.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return '/' + out.join('/');
}

/**
 * 建立 SSH 连接(DNS 解析 + 口令检查在本层,会话引擎在 vssh)。
 * opts.localFs:本机文件系统接口(put/get 传输用;缺省用核心 fs)
 * 返回 { ok:false, reason:'dns'|'auth' } 或 { ok:true, session, motd, banner }
 * session.exec(cmdLine) → { lines: [{text, cls}], ended? }
 */
export function sshConnect(hostInput, user, password, opts = {}) {
  publish('vnet:ssh', { from: 'vnet', type: 'ssh-auth', payload: { host: normHost(hostInput), user } });
  const rec = dnsResolve(hostInput);
  if (!rec) return { ok: false, reason: 'dns', host: normHost(hostInput) };
  const server = servers.get(normHost(hostInput)) || servers.get(rec.ip);
  if (!server || !server.users?.[user] || server.users[user].password !== password) {
    publish('vnet:ssh', { from: 'vnet', type: 'ssh-deny', payload: { host: normHost(hostInput), user } });
    return { ok: false, reason: 'auth' };
  }
  const u = server.users[user];
  const session = openSession(server, {
    host: rec.host, ip: rec.ip, user,
    dnsList,
    /* 覆盖层:远端写操作随游戏进度落盘(与 flags 同库) */
    overlay: { data: mutable.sshFs, persist },
    localFs: opts.localFs || fs,
  });
  publish('vnet:ssh', { from: 'vnet', type: 'ssh-open', payload: { host: rec.host, ip: rec.ip, user } });
  return { ok: true, session, motd: u.motd || '', banner: server.banner || '' };
}

/* ================= 游戏标志位 ================= */

export function setFlag(key, value = true) {
  if (mutable.flags[key] === value) return;
  mutable.flags[key] = value;
  persist();
  publish('vnet:flag-changed', { from: 'vnet', type: 'flag-changed', payload: { key, value } });
}
export const getFlag = (key) => !!mutable.flags[key];
export const allFlags = () => ({ ...mutable.flags });

/** 清空游戏进度(标志位 + 运行时 DNS + 远端文件系统覆盖层),站点/服务器定义保留 */
export function resetState() {
  mutable = { flags: {}, dnsExtra: [], sshFs: {} };
  resetLiveTrees();   // 活动树一并丢弃:下次连接从作者声明树重建
  persist();
  publish('vnet:flag-changed', { from: 'vnet', type: 'reset', payload: {} });
}

export const vnet = {
  addDNS, dnsAdd, dnsResolve, dnsList,
  addSite, registerAetherSite, setSearchHost, getSearchHost,
  addServer, httpGet, httpGetAsync, sshConnect,
  setFlag, getFlag, allFlags, resetState,
};
export default vnet;
