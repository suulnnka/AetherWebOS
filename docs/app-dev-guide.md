# WebOS 应用开发指南

面向 `js/apps/` 下第三方/内置应用的开发者。所有接口均以当前代码为准,
对照阅读:`js/core/registry.js`(注册)、`js/core/wm.js`(窗口与挂载)、`js/core/bus.js`(通信)。

## 1. 一个应用是什么

一个应用 = 一个目录 + 一份清单:

```
js/apps/<id>/
├── index.js     # 必须:register({...}) + mount(ctx)
└── <id>.css     # 可选:应用专属样式(需在 js/system/appstyles.js 补一行 import)
```

接入系统只需三步:

1. 在 `js/apps/<id>/index.js` 里 `register({...})`;
2. 在 `js/main.js` 里 `import './apps/<id>/index.js';`
3. 有样式表的话,在 `js/system/appstyles.js` 里补一行 `import '../apps/<id>/<id>.css';`

注册后应用自动出现在开始菜单与桌面(可用 `desktop: false` 关闭),
并获得一个唯一 IPC 地址(就是 `id`),其他应用可以给它发消息。

## 2. 最小可运行应用

```js
/* js/apps/hello/index.js */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';

register({
  id: 'hello',
  name: '你好',
  icon: 'info',                                   // js/core/icons.js 里的图标名
  color: 'linear-gradient(135deg,#64748b,#334155)', // 磁贴背景
  width: 360, height: 240,
  singleton: true,
  order: 99,
  mount({ root, setTitle }) {
    setTitle('你好 WebOS');
    let n = 0;
    const num = el('b', {}, '0');
    root.append(
      el('div', { class: 'app-body', style: { padding: '14px' } },
        el('p', {}, '点过 ', num, ' 次'),
        el('button', { class: 'btn', onClick: () => num.textContent = String(++n) }, '点我'),
      ),
    );
  },
});
```

## 3. 清单字段参考(`register(manifest)`)

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | 必须 | 唯一 ID,同时是 IPC 总线地址 |
| `name` | string | 必须 | 显示名(开始菜单/任务栏) |
| `mount(ctx)` | function | 必须 | 挂载函数,在 `ctx.root` 里构建界面 |
| `icon` | string | — | `js/core/icons.js` 中的图标名 |
| `color` | string | — | 磁贴背景,任意 CSS background 值 |
| `neon` | `{a,b}` | — | 霓虹未来皮肤的双色灯条(窗头流光) |
| `width`/`height` | number | 780/540 | 初始窗口尺寸 |
| `min` | `{w,h}` | 360/240 | 最小尺寸 |
| `singleton` | boolean | false | 单实例:再次 open 时聚焦已有窗口 |
| `resizable` | boolean | true | 是否允许拖拽调整大小 |
| `desktop` | boolean | true | 是否出现在桌面与开始菜单 |
| `order` | number | 100 | 菜单排序权重,小的在前 |
| `dialog` | boolean | false | 对话框型窗口(无最小化/最大化,配合模态遮罩) |

## 4. `mount(ctx)` 上下文

| 成员 | 说明 |
|---|---|
| `root` | 窗口内容根节点(`.win-body`),往里面 append 界面 |
| `win` | `{ id, appId }` 当前窗口标识 |
| `bus` | 本应用的总量总线实例,见 §5 |
| `params` | `open(id, { params })` 传入的参数 |
| `fs` / `settings` | 核心 API 直通,见 §5 |
| `setTitle(t)` | 改窗口标题(任务栏/IPC 同步广播) |
| `close()` | 关闭自己 |
| `focus()` | 激活自己 |
| `setSize(w, h)` | 程序化调整窗口尺寸 |
| `onContextMenu(fn)` | 注册应用内右键菜单,见 §7 |

`mount` 可以返回生命周期钩子:

```js
mount(ctx) {
  const url = URL.createObjectURL(blob);
  return {
    onClose() { URL.revokeObjectURL(url); },   // 返回 false 可拦截关闭
    onResize(w, h) { /* 跟随窗口尺寸重排 */ },
  };
}
```

## 5. 与系统对话

### 总线(`bus`)

```js
bus.on(type, (payload, msg) => {})   // 收:发往本应用的点对点消息(msg.reply 可回包)
bus.send(to, type, payload)          // 点对点发
bus.request(to, type, payload, timeout=2500)  // 请求-响应,返回 Promise
bus.broadcast(type, payload)         // 广播给所有应用
bus.notify(title, body)              // 系统通知(吐司 + 通知中心)
bus.onSys(type, fn)                  // 订阅系统事件(见下表)
```

常用系统事件(均通过 `bus.onSys` 订阅,`payload` 在第一个参数):

| 事件 | 触发时机 |
|---|---|
| `fs-changed` | 任何文件变动,`payload: { action, path }` |
| `settings-changed` | `settings.set` 后,`payload: { changed, patch }` |
| `theme-changed` | 亮/暗主题切换 |
| `volume-changed` | 音量/静音变化 |

### 文件系统(`fs`,持久化在 localStorage,全部同步 API)

```js
fs.read(path)             // 文件内容(字符串),不存在返回 null
fs.write(path, content)   // 写文件(父目录自动补齐)
fs.mkdir(path)            // 建目录
fs.rm(path)               // 删除(递归)
fs.rename(old, newPath)
fs.list(path)             // 目录项数组
fs.exists(p) / fs.isDir(p)
```

约定用户目录:`/home/desktop`(桌面图标实时映射此目录)、`/home/documents`、`/home/downloads`。
监听变动:`bus.onSys('fs-changed', ...)`,写文件后其他应用会自动收到通知。

### 设置(`settings`,自动持久化 + 广播)

```js
settings.get('volume')   // 单项;settings.get() 全量
settings.set({ volume: 30 })   // 写入 → 应用到 DOM → 广播 sys:settings-changed
```

只存应用自己的数据时,不要塞进系统设置,用 localStorage 键 + `accounts.userKey()`(见 §6)。

### 系统对话框(`dialogs`,全 Promise)

```js
await dialogs.confirm({ title, message, danger, okText })   // → boolean
await dialogs.prompt({ title, message, value, placeholder }) // → string | null
await dialogs.password({ title })                            // → string | null
dialogs.error({ title, message, detail })
const h = dialogs.progress({ title, determinate: true })     // h.set(pct, msg) / h.done(msg) / h.promise
```

### 跨应用打开窗口

```js
import { open } from '../../core/wm.js';
open('notes', { params: { path: '/home/documents/a.txt' } });
```

目标应用在 `mount` 里读 `ctx.params`;**单实例应用**二次打开时不会重新挂载,
要通过 `bus.on('params', ...)` 响应新参数(参考 browser 应用)。

### 账号与数据隔离

需要登录的应用(如任务、备忘录):

```js
import { requireLogin } from '../../core/loginpanel.js';
import { accounts } from '../../core/accounts.js';

mount({ root, onLoginRetry }) {
  if (requireLogin(root, '我的应用', () => remount())) return;  // 未登录:渲染登录面板并中止
  const key = accounts.userKey('webos.myapp.v1');   // → 'webos.myapp.v1::用户名',未登录为 null
}
```

## 6. 右键菜单

系统会拦截窗口内所有右键(不再弹出浏览器菜单),优先级:

1. **应用自定义** —— `ctx.onContextMenu(({ x, y, target }) => items | null)`;
2. **系统默认** —— 选中了文字追加「复制」;空的 input/textarea 追加「全选」;
3. 都没有 → 仅吞掉浏览器菜单。

```js
onContextMenu(({ target }) => {
  const row = target.closest('.todo-item');
  if (!row) return null;                     // 不是任务行:交给系统默认
  const t = find(row.dataset.id);
  return [
    { label: '标记完成', icon: 'check', fn: () => {} },
    { sep: true },
    { label: '删除', icon: 'trash', danger: true, fn: () => {} },
  ];
});
```

需要手动弹菜单(如文件列表项)可用底层 API:

```js
import { showMenu, copyText } from '../../core/menu.js';
node.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, items); });
await copyText(text);   // Clipboard API + execCommand 回退
```

## 7. 样式

- 专属样式写 `js/apps/<id>/<id>.css`,在 `js/system/appstyles.js` 补 import,
  Vite 会自动注入/打包;
- **只用系统的 CSS 变量,不要写死颜色**,亮暗主题与 8 套皮肤才能全部生效:

| 变量 | 含义 |
|---|---|
| `--accent` | 强调色(随用户/皮肤变化) |
| `--panel` / `--panel-solid` / `--panel-2` | 面板背景(毛玻璃/实色/次级) |
| `--text` / `--text-2` | 主/次文字 |
| `--border` / `--hover` | 描边与悬停 |
| `--radius` / `--radius-s` | 圆角 |
| `--shadow` / `--shadow-2` | 投影 |
| `--tb` | 任务栏高度 |

- 通用结构类:`.app-side`(侧栏)/ `.app-body`(主区)/ `.app-toolbar`(工具条)/
  `.app-status`(底部状态栏)、按钮 `.btn` / `.btn.icon` / `.icon-btn`、输入 `.input`;
- `neon: { a, b }` 声明的双色会以 `--neon-a/--neon-b` 注入窗口,霓虹皮肤自动渲染窗头流光;
- 用户关闭动效时根节点带 `.no-effects`,大动画请写在 `html:not(.no-effects)` 分支。

## 8. 生命周期要点

- `singleton: true` 的应用重复 `open` 只聚焦不重挂,新参数靠 `bus.on('params')`;
- `mount` 返回的 `onClose` 里回收资源(对象 URL、定时器、事件监听);
- `onResize(w, h)` 跟随窗口拖拽/最大化/平铺触发,canvas 类应用在这里重设尺寸;
- 应用挂载抛异常不会拖垮系统:窗口内会显示"应用启动失败"错误卡。

## 9. 调试与测试

- **控制台全局对象**:`WebOS.wm/fs/settings/dialogs/bus/apps`、`window.__errs`(启动期错误收集);
- **打开应用**:`WebOS.wm.open('id')` 或 `WebOS.wm.open('id', { params: {...} })`;
- **e2e 冒烟测试**(`tools/e2e.mjs`):为应用新增一个 `group('T4x', '名称', async () => {...})` 用例组,
  每组自动重置到初始桌面、可独立运行(`npm run e2e -- T4x`);
  页面自带 `?e2e=1` 测试模式(跳过装饰性等待),剪贴板类断言先
  `c.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })`;
- **跑法**:`npm run dev` 起服务器(8080)→ `npm run e2e`(全量,默认 6 并行)或 `npm run e2e -- T41`。

## 10. 接入清单

- [ ] `js/apps/<id>/index.js`:`register` + `mount`
- [ ] `js/main.js`:加一行 import
- [ ] 样式表(可选):`<id>.css` + `appstyles.js` 加一行,颜色只用 CSS 变量
- [ ] 需要登录:`requireLogin` + `accounts.userKey()` 命名空间存储
- [ ] 右键:`ctx.onContextMenu`;资源回收:`onClose`
- [ ] e2e:新增用例组,`npm run e2e -- T<新组号>` 单跑通过后跑全量
