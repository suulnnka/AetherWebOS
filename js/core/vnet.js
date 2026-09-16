/* ============================================================
 * VNet —— 虚拟网络核心(解谜游戏平台)
 *
 * 由三部分组成:
 *   DNS     虚拟域名解析(游戏作者注册;运行时可增删)
 *   HTTP    虚拟网站路由:路径 → 页面 / 处理函数 / 代理(proxy)
 *           proxy 即「路径转换」:虚拟 URL 映射到真实互联网资源,
 *           这是用户触达外网的唯一通道,且只能由游戏作者配置。
 *   SSH     虚拟服务器:用户名/口令 + 独立虚拟文件系统 + 自定义命令
 *
 * 安全模型:浏览器与终端只能访问本模块解析得到的资源;
 * 任何真实网络请求仅发生在作者声明的 proxy 路径上。
 *
 * 所有活动通过总线广播(vnet:http / vnet:ssh / vnet:flag-changed),
 * 系统监视器可直接观测虚拟网络流量。
 * ============================================================ */

import { publish } from './bus.js';
import fs from './fs.js';

const KEY = 'webos.vnet.v1';
const dnsRecords = new Map(); // host -> 记录
const sites = new Map();      // hostOrIp -> 站点定义
const servers = new Map();    // hostOrIp -> 服务器定义

/** 可变状态(持久化):游戏标志位 + 运行时新增的 DNS 记录 */
let mutable = { flags: {}, dnsExtra: [] };
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

function matchRoute(site, path) {
  if (site.routes[path] != null) return site.routes[path];
  // 最长前缀匹配('/docs/' 之类目录路由)
  const best = Object.keys(site.routes)
    .filter(k => k.length > 1 && k.endsWith('/') && path.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (best) return site.routes[best];
  return site.routes['*'] ?? null;
}

/**
 * 虚拟 HTTP GET。返回:
 * { status:'ok', type:'html'|'proxy', body/proxyUrl, title, host, ip, path, url, ms }
 * 或 { status:'dns'|'refused'|'404'|'403'|'redirect'|'badurl', ... }
 */
export function httpGet(rawUrl) {
  const t0 = performance.now();
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : 'http://' + rawUrl); }
  catch { return { status: 'badurl', url: rawUrl }; }
  if (!/^https?:$/.test(u.protocol)) return { status: 'badurl', url: rawUrl };

  publish('vnet:http', { from: 'vnet', type: 'http', payload: { method: 'GET', host: u.hostname, path: u.pathname, url: u.href } });

  const rec = dnsResolve(u.hostname);
  if (!rec) return { status: 'dns', host: u.hostname, url: u.href };

  const site = sites.get(u.hostname) || sites.get(rec.ip);
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
 * server: { ip?, port?, banner?, users: { 用户名: { password, home, motd, fs, commands } } }
 * fs: 嵌套对象(目录=对象,文件=字符串)
 * commands: { 命令名: (args, session) => string[] }
 */
export function addServer(host, server) {
  servers.set(normHost(host), server);
  if (server.ip) servers.set(server.ip, server);
}

/* ---- 极简虚拟文件系统 ---- */
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
function fsGet(root, path) {
  let n = root;
  for (const s of path.split('/').filter(Boolean)) {
    if (typeof n !== 'object' || n === null || !(s in n)) return null;
    n = n[s];
  }
  return n;
}

/**
 * 建立 SSH 连接。
 * 返回 { ok:false, reason:'dns'|'auth' } 或 { ok:true, session, motd }
 * session.exec(cmdLine) → { lines: [{text, cls}], ended? }
 */
export function sshConnect(hostInput, user, password) {
  publish('vnet:ssh', { from: 'vnet', type: 'ssh-auth', payload: { host: normHost(hostInput), user } });
  const rec = dnsResolve(hostInput);
  if (!rec) return { ok: false, reason: 'dns', host: normHost(hostInput) };
  const server = servers.get(normHost(hostInput)) || servers.get(rec.ip);
  if (!server || !server.users?.[user]) return { ok: false, reason: 'auth' };
  const u = server.users[user];
  if (u.password !== password) return { ok: false, reason: 'auth' };

  const session = {
    user, host: rec.host, ip: rec.ip, server,
    cwd: u.home || '/home/' + user,
    fsRoot: u.fs || {},
    ended: false,
    short() { return isIP(this.host) ? this.host : this.host.split('.')[0]; },
    exec(cmdLine) {
      const parts = String(cmdLine).trim().split(/\s+/).filter(Boolean);
      const cmd = parts.shift();
      const out = [];
      const say = (text = '', cls = '') => out.push({ text, cls });
      if (!cmd) return { lines: out };
      if (cmd === 'exit' || cmd === 'logout') { this.ended = true; return { lines: out }; }
      if (cmd === 'clear') return { lines: [{ text: '', cls: 'clear' }] };

      // 服务器自定义命令优先(游戏作者注入谜题逻辑)
      const custom = u.commands?.[cmd];
      if (custom) {
        try { for (const line of (custom(parts, this) || [])) say(line); }
        catch (e) { say(String(e.message || e), 't-err'); }
        return { lines: out };
      }

      const path = (p) => vpath(this.cwd, p || '.');
      switch (cmd) {
        case 'help': {
          const customs = Object.keys(u.commands || {});
          say(`可用命令:ls  cat <文件>  cd <目录>  pwd  whoami  echo  get <文件>(下载到本机)  exit` +
            (customs.length ? `\n本机扩展命令:${customs.join('  ')}` : ''), 't-dim');
          break;
        }
        case 'ls': {
          const target = path(parts[0]);
          const node = fsGet(this.fsRoot, target);
          if (node == null) { say(`ls: 无法访问 ${target}: 没有那个文件或目录`, 't-err'); break; }
          if (typeof node === 'string') { say(target.split('/').pop()); break; }
          const names = Object.entries(node)
            .sort((a, b) => (typeof a[1] === 'object') - (typeof b[1] === 'object') || a[0].localeCompare(b[0]))
            .map(([n, v]) => typeof v === 'object' ? n + '/' : n);
          if (names.length) say(names.join('  '));
          break;
        }
        case 'cat': {
          if (!parts[0]) { say('用法: cat <文件>', 't-err'); break; }
          const node = fsGet(this.fsRoot, path(parts[0]));
          if (node == null) say(`cat: ${parts[0]}: 没有那个文件或目录`, 't-err');
          else if (typeof node !== 'string') say(`cat: ${parts[0]}: 是一个目录`, 't-err');
          else say(node);
          break;
        }
        case 'cd': {
          const target = path(parts[0] || ('/home/' + this.user));
          const node = fsGet(this.fsRoot, target);
          if (node == null || typeof node !== 'object') say(`cd: ${parts[0]}: 没有那个目录`, 't-err');
          else this.cwd = target;
          break;
        }
        case 'pwd': say(this.cwd); break;
        case 'whoami': say(this.user); break;
        case 'echo': say(parts.join(' ')); break;
        case 'get': case 'download': {
          // 把远程文件下载到本机虚拟文件系统(IPC 联动:写入后文件管家实时可见)
          if (!parts[0]) { say('用法: get <远程文件> [本地名]', 't-err'); break; }
          const node = fsGet(this.fsRoot, path(parts[0]));
          if (node == null || typeof node !== 'string') { say(`get: ${parts[0]}: 不可下载的文件`, 't-err'); break; }
          const local = '/home/downloads/' + (parts[1] || String(parts[0]).split('/').pop());
          fs.write(local, node);
          say(`已下载 → ${local}`, 't-ok');
          break;
        }
        default:
          say(`${cmd}: 未找到命令。输入 help 查看可用命令`, 't-err');
      }
      return { lines: out };
    },
  };
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

/** 清空游戏进度(标志位 + 运行时 DNS),站点/服务器定义保留 */
export function resetState() {
  mutable = { flags: {}, dnsExtra: [] };
  persist();
  publish('vnet:flag-changed', { from: 'vnet', type: 'reset', payload: {} });
}

export const vnet = { addDNS, dnsAdd, dnsResolve, dnsList, addSite, addServer, httpGet, sshConnect, setFlag, getFlag, allFlags, resetState };
export default vnet;
