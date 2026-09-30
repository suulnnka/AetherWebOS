/* AetherJS 站点定义(纯数据;文件内容由 sites.js 经 Vite ?raw 注入,
 * Node 冒烟测试 tools/aether-sites-smoke.mjs 直接读磁盘同源使用)。
 * proxies:「路径转换」键 → 真实外网地址(作者数据,沙盒只能引用键)。 */
export const SITE_DEFS = {
  portal: {
    host: 'portal.nexus', ip: '10.0.0.10', title: 'NEXUS 内网门户',
    files: {},
    proxies: {
      manual: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    },
  },
  library: { host: 'library.nexus', ip: '10.0.0.11', title: 'NEXUS 数字图书馆', files: {} },
  search: { host: 'search.nexus', ip: '10.0.0.8', title: 'Aether 内网搜索', files: {} },
  blackout: {
    host: 'blackout.nexus', ip: '10.0.0.66', title: 'Blackout 档案馆',
    files: {},
    proxies: {
      archive: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    },
  },
};
export default Object.values(SITE_DEFS);
