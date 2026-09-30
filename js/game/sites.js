/* ============================================================
 * AetherJS 站点注册表
 * ------------------------------------------------------------
 * 每个内网站点是一个目录(js/game/sites/<名>/):router.ajs 路由表、
 * <名>.ajs 处理函数、<名>.html 模板。文件经 Vite ?raw 打包成字符串,
 * 首次访问时由 AetherWebFramework 编译挂载(见 core/aethersite.js);
 * 站点元数据(host/ip/title/proxies)在 site-defs.js,Node 冒烟测试
 * 与浏览器侧共用同一份。
 *
 * 新增站点:建 sites/<名>/ 目录 + 在 site-defs.js 补一条,浏览器起始页
 * 「内网站点」随 DNS listed 记录自动出现。
 * ============================================================ */

import { SITE_DEFS } from './site-defs.js';

const raw = import.meta.glob('./sites/**/*.{ajs,html}', { query: '?raw', import: 'default', eager: true });

for (const [path, src] of Object.entries(raw)) {
  const m = /^\.\/sites\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m || !SITE_DEFS[m[1]]) {
    console.warn('[sites] 未登记的站点目录,忽略:', path);
    continue;
  }
  SITE_DEFS[m[1]].files[m[2]] = src;
}

export default Object.values(SITE_DEFS);
