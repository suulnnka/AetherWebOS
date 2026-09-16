/* 应用样式加载器:为每个应用注入其专属样式表
 * (零构建环境:ES Modules 无法直接 import CSS,此处统一注入 <link>) */
const APP_STYLES = [
  'settings', 'localfiles', 'viewer', 'files', 'mail', 'todo', 'sms',
  'notes', 'calc', 'terminal', 'monitor', 'music', 'browser', 'weather', 'memo',
  'minesweeper', 'chess3d', 'reversi',
];

for (const name of APP_STYLES) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `js/apps/${name}/${name}.css`;
  document.head.append(link);
}
