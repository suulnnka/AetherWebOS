# WebOS 应用开发指南

面向 `js/apps/` 下第三方/内置应用的开发者。所有接口均以当前代码为准,
对照阅读:`js/core/registry.js`(注册)、`js/core/wm.js`(窗口与挂载)、`js/core/bus.js`(通信)。

## 1. 一个应用是什么

一个应用 = 一个目录 + 一份清单。应用代码**按需加载**:启动时系统只读入
清单(纯数据),应用本体在首次打开窗口时才以独立 chunk 拉取。

```
js/apps/<id>/
├── manifest.js  # 必须:清单纯数据(export default {...},不 import 任何东西)
├── index.js     # 必须:register({ ...manifest, mount(ctx) }) + 逻辑
└── <id>.css     # 可选:应用专属样式(在 index.js 顶部 import,随应用 chunk 加载)
```

接入系统只需三步:

1. 在 `js/apps/<id>/manifest.js` 写清单字段,`index.js` 里
   `register({ ...manifest, mount })`;
2. 在 `js/apps/index.js` 的 `APPS` 表补一行
   `[hello, () => import('./hello/index.js')]`(顶部同步 import 清单);
3. 有样式表的话,在 `index.js` 顶部 `import './hello.css';`

注册后应用自动出现在开始菜单与桌面(可用 `desktop: false` 关闭),
并获得一个唯一 IPC 地址(就是 `id`),其他应用可以给它发消息。

> **⚠️ import 边界**:应用只能 import `js/core/*` 与自身目录的文件,
> **不要 import `js/system/*` 或其他应用**。打包时 core 是独立稳定 chunk,
> 应用若引用了主包里的模块,该应用 chunk 就会跟着主包改名,破坏
> "改一个应用、其余应用缓存不失效"的性质(确需引用 system 模块时,
> 把该模块加入 vite.config.js 的 manualChunks 稳定区,像 session.js 一样)。

## 2. 最小可运行应用

```js
/* js/apps/hello/manifest.js —— 清单(纯数据,启动时即注册) */
export default {
  id: 'hello',
  name: '你好',
  icon: 'info',                                   // js/core/icons.js 里的图标名
  color: 'linear-gradient(135deg,#64748b,#334155)', // 磁贴背景
  width: 360, height: 240,
  singleton: true,
  order: 99,
};
```

```js
/* js/apps/hello/index.js —— 实现(首次打开窗口时才加载) */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './hello.css';                              // 可选

register({
  ...manifest,
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

**弹框分级** —— 所有方法都支持 `level`:

| 级别 | 语义 |
| --- | --- |
| `level: 1` | 非模态:不影响任何界面,其他窗口/任务栏/桌面照常可操作 |
| `level: 2` | 应用模态:锁定 `owner` 应用打开的所有窗口,其余系统照常 |
| `level: 3` | 系统模态:全屏锁定,关闭弹框前整个系统不可操作(默认) |

```js
dialogs.confirm({ level: 1, title: '随手记' })                      // 浮窗,不打断任何操作
dialogs.confirm({ level: 2, owner: 'notes', title: '未保存' })      // 只锁 notes 的窗口
dialogs.confirm({ level: 3, title: '系统更新' })                    // 全系统锁定
```

应用内推荐直接用 mount ctx 里的 `ctx.dialogs`——owner 自动绑定本应用、
**默认就是二级**,传 `{ level }` 可覆盖:

```js
export function mount({ dialogs }) {
  dialogs.confirm({ message: '删除这只影响本应用的其他窗口' });   // 二级
  dialogs.confirm({ level: 1, message: '浮窗提示' });             // 一级
}
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

- 专属样式写 `js/apps/<id>/<id>.css`,在应用 `index.js` 顶部 `import './<id>.css'`,
  样式随应用 chunk 按需加载/注入;
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

- [ ] `js/apps/<id>/manifest.js` + `index.js`(`register({ ...manifest, mount })`)
- [ ] `js/apps/index.js` 的 APPS 表补一行
- [ ] 样式表(可选):`<id>.css`,在 `index.js` 顶部 import,颜色只用 CSS 变量
- [ ] 需要登录:`requireLogin` + `accounts.userKey()` 命名空间存储
- [ ] 右键:`ctx.onContextMenu`;资源回收:`onClose`
- [ ] e2e:新增用例组,`npm run e2e -- T<新组号>` 单跑通过后跑全量
