#!/usr/bin/env node
/* ============================================================
 * AetherJS 内网站点冒烟测试(Node 直接跑 core/aethersite.js 桥接层,
 * 与浏览器同一条代码路径:AetherWebFramework 编译 → 路由分发 →
 * data 指令映射)。站点文件改动后先跑这个,再进浏览器。
 *
 *   node tools/aether-sites-smoke.mjs
 * 退出码:0 全过 / 1 有失败(失败用例逐条打印)
 * ============================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aetherServe } from '../js/core/aethersite.js';
import { SITE_DEFS } from '../js/game/site-defs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 站点文件从磁盘装载(浏览器侧由 Vite ?raw 注入同一批文件) */
for (const [key, def] of Object.entries(SITE_DEFS)) {
  const dir = join(root, 'js/game/sites', key);
  for (const f of readdirSync(dir)) def.files[f] = readFileSync(join(dir, f), 'utf8');
}

const hosts = Object.values(SITE_DEFS);
const setFlags = [];
const ctx = (flags = {}) => ({
  flags,
  setFlag: (k) => setFlags.push(k),
  dnsResolve: (h) => (hosts.some(d => d.host === h || d.ip === h) ? { host: h, ip: '0.0.0.0' } : null),
});

let pass = 0, fail = 0;
async function check(name, url, flags, pred) {
  const def = hosts.find(d => url.includes(`//${d.host}`)) ?? hosts.find(d => d.host === 'portal.nexus');
  let r, err = null;
  try { r = await aetherServe(def, new URL(url), ctx(flags)); }
  catch (e) { err = e; }
  const problems = err ? [`异常:${err.message}`] : (pred(r) || []);
  if (problems.length) { fail++; console.log(`FAIL  ${name}  — ${problems.join('; ')}`); }
  else { pass++; console.log(`PASS  ${name}`); }
}
const has = (r, s) => (r.body || '').includes(s) ? [] : [`正文缺 "${s}"`];
const eq = (a, b, what) => (JSON.stringify(a) === JSON.stringify(b) ? [] : [`${what}:期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)}`]);

/* ---- portal.nexus ---- */
await check('门户首页', 'http://portal.nexus/', {},
  r => [...eq(r.status, 'ok', '状态'), ...has(r, 'NEXUS 集团内网门户'), ...has(r, '/goto/?u=library.nexus%2F')]);
await check('门户关于(馆藏数)', 'http://portal.nexus/about', {},
  r => [...eq(r.status, 'ok', '状态'), ...has(r, '52,831')]);
await check('门户使用手册(路径转换)', 'http://portal.nexus/manual.pdf', {},
  r => [...eq(r.status, 'ok', '状态'), ...eq(r.type, 'proxy', '类型'),
    ...eq(r.proxyUrl, SITE_DEFS.portal.proxies.manual, '代理地址'), ...eq(r.title, 'NEXUS 内网使用手册 v3.1', '标题')]);
await check('门户未知路径(404)', 'http://portal.nexus/nope', {}, r => eq(r.status, '404', '状态'));
await check('goto 中转(跨主机)', 'http://portal.nexus/goto/?u=library.nexus%2F', {},
  r => [...eq(r.status, 'redirect', '状态'), ...eq(r.location, 'http://library.nexus/', '目标')]);
await check('goto 拒绝外网目标', 'http://portal.nexus/goto/?u=evil.com%2Fx', {}, r => eq(r.status, '403', '状态'));

/* ---- library.nexus ---- */
await check('图书馆首页(键盘)', 'http://library.nexus/', {},
  r => [...eq(r.status, 'ok', '状态'), ...has(r, '读者登录'), ...has(r, '未输入'), ...has(r, 'vp-key')]);
await check('图书馆按键累积(●)', 'http://library.nexus/?user=reader&pass=52', {},
  r => [...eq(r.status, 'ok', '状态'), ...has(r, '●●'), ...has(r, 'pass=520')]);
await check('图书馆错误口令被拒', 'http://library.nexus/?user=reader&pass=00000&go=1', {},
  r => [...eq(r.status, 'ok', '状态'), ...has(r, '口令错误')]);
{
  const before = setFlags.length;
  await check('图书馆正确口令(置位 + 重定向回干净地址)', 'http://library.nexus/?user=reader&pass=52831', {},
    r => [...eq(r.status, 'redirect', '状态'), ...eq(r.location, 'http://library.nexus/', '目标')]);
  const after = setFlags.length;
  const ok = after === before + 1 && setFlags[after - 1] === 'library_ok';
  console.log(ok ? 'PASS  图书馆置位 library_ok' : `FAIL  图书馆置位 library_ok  — setFlags=${JSON.stringify(setFlags)}`);
  ok ? pass++ : fail++;
}
await check('图书馆已登录视图(进度判定)', 'http://library.nexus/', { library_ok: true },
  r => [...eq(r.status, 'ok', '状态'), ...has(r, '已登录'), ...has(r, 'researcher'), ...has(r, 'h3ll0w')]);
await check('图书馆已登录不出现键盘', 'http://library.nexus/', { library_ok: true },
  r => (r.body.includes('vp-keypad') ? ['已登录视图不应渲染键盘'] : []));

/* ---- blackout.nexus ---- */
await check('隐藏站无凭据(403)', 'http://blackout.nexus/', {}, r => eq(r.status, '403', '状态'));
await check('隐藏站未知路径(403 兜底)', 'http://blackout.nexus/whatever', { library_ok: true }, r => eq(r.status, '403', '状态'));
await check('隐藏站首页(library_ok)', 'http://blackout.nexus/', { library_ok: true },
  r => [...eq(r.status, 'ok', '状态'), ...has(r, 'BLACKOUT 档案馆'), ...has(r, '/archive.pdf')]);
{
  const before = setFlags.length;
  await check('档案代理(未跑 status 不通关)', 'http://blackout.nexus/archive.pdf', { library_ok: true },
    r => [...eq(r.status, 'ok', '状态'), ...eq(r.type, 'proxy', '类型')]);
  let ok = setFlags.length === before;
  console.log(ok ? 'PASS  未置 quest_done(缺 ssh_done)' : `FAIL  未置 quest_done  — setFlags=${JSON.stringify(setFlags.slice(before))}`);
  ok ? pass++ : fail++;
}
{
  const before = setFlags.length;
  await check('档案代理(集齐钥匙通关)', 'http://blackout.nexus/archive.pdf', { library_ok: true, ssh_done: true },
    r => [...eq(r.status, 'ok', '状态'), ...eq(r.type, 'proxy', '类型'), ...eq(r.title, '赛博档案 Vol.3', '标题')]);
  const ok = setFlags.length === before + 1 && setFlags[before] === 'quest_done';
  console.log(ok ? 'PASS  置位 quest_done' : `FAIL  置位 quest_done  — setFlags=${JSON.stringify(setFlags.slice(before))}`);
  ok ? pass++ : fail++;
}

/* ---- search.nexus ---- */
await check('搜索首页(热门词)', 'http://search.nexus/', {}, r => [...eq(r.status, 'ok', '状态'), ...has(r, '热门搜索')]);
await check('搜索结果(命中+摘要)', 'http://search.nexus/search/?q=图书馆', {},
  r => [...eq(r.status, 'ok', '状态'), ...has(r, '找到约'), ...has(r, 'goto/?u='), ...has(r, '<b>图书馆</b>')]);
await check('搜索无结果', 'http://search.nexus/search/?q=zzz不存在的词', {},
  r => [...eq(r.status, 'ok', '状态'), ...has(r, '找不到')]);
await check('搜索空关键词', 'http://search.nexus/search/', {}, r => [...eq(r.status, 'ok', '状态'), ...has(r, '请输入关键词')]);
await check('搜索关于页', 'http://search.nexus/about/', {}, r => [...eq(r.status, 'ok', '状态'), ...has(r, 'AetherWebFramework')]);
await check('搜索未知路径(404)', 'http://search.nexus/nope', {}, r => eq(r.status, '404', '状态'));

console.log(`\n${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
