# AetherWebOS 应用开发指南

面向 `js/apps/` 下第三方/内置应用的开发者。所有接口均以当前代码为准,
对照阅读:`js/core/registry.js`(注册)、`js/core/wm.js`(窗口与挂载)、`js/core/bus.js`(通信)。

## 1. 一个应用是什么

一个应用 = 一个目录 + 一份清单。应用代码**按需加载**:启动时系统只读入
清单(纯数据),应用本体在首次打开窗口时才以独立 chunk 拉取——打开瞬间
窗口框架先立起(骨架加载态),chunk 到位后回填内容。高频应用(浏览器/
终端等)在清单标 `prefetch: true`,系统启动空闲后会后台预读,首次打开免等。

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

注册后应用自动出现在开始菜单(可用 `desktop: false` 关闭),并初始化时在
桌面生成 `.app` 快捷方式(桌面本身不自动生成图标,桌面就是 `/home/desktop`
目录,快捷方式可被用户删除/改名/收进文件夹;`desktopIcon: false` 跳过播种),
同时获得一个唯一 IPC 地址(就是 `id`),其他应用可以给它发消息。

> **⚠️ import 边界**:应用只能 import `js/core/*`、`js/lib/*`(自研库,
> 如地图内核 minimap)与自身目录的文件,
> **不要 import `js/system/*` 或其他应用**。打包时 core 是独立稳定 chunk
> (js/lib 也归入其中,开机引入),
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
    setTitle('你好 AetherWebOS');
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
| `min` | `{w,h}` | 360/240 | 最小尺寸(**整窗**,WM 直接用) |
| `contentMin` | `{w,h}` | — | 最小尺寸的**内容区**口径:WM 补上窗框(标题栏 + 边框)后再生效。适合「内容尺寸由代码算出来」的应用(见下) |
| `singleton` | boolean | false | 单实例:再次 open 时聚焦已有窗口 |
| `resizable` | boolean | true | 是否允许拖拽调整大小 |
| `desktop` | boolean | true | 是否出现在开始菜单;false 同时不参与桌面快捷方式播种 |
| `desktopIcon` | boolean | true | 初始化/迁移时是否在桌面生成 `.app` 快捷方式;设 false 则不播种(棋类应用收纳进「棋类游戏」文件夹即此模式) |
| `order` | number | 100 | 菜单排序权重,小的在前 |
| `prefetch` | boolean | false | 高频应用预读:启动空闲后后台拉取应用 chunk,首次打开免等(browser/terminal/files 已启用) |
| `hoverPrefetch` | boolean | true | 悬停预读:鼠标移到启动入口(桌面图标/开始菜单/任务栏)上时预读应用 chunk;重型应用可设 false 关闭(围棋:引擎包后续会很大,已关闭) |
| `dialog` | boolean | false | 对话框型窗口(无最小化/最大化,配合模态遮罩) |

## 4. `mount(ctx)` 上下文

| 成员 | 说明 |
|---|---|
| `root` | 窗口内容根节点(`.win-body`),往里面 append 界面 |
| `win` | `{ id, appId }` 当前窗口标识 |
| `bus` | 本应用的总量总线实例,见 §5 |
| `params` | `open(id, { params })` 传入的参数 |
| `fs` | **应用级文件系统**(读/写/建/删/权限),以执行用户鉴权,见 §5 |
| `user` | 本窗口执行用户(= `ctx.fs.user`;未登录为 `null`) |
| `executeAs` | 清单执行模式:`session`(默认)/ `root` / 固定用户名 |
| `settings` | 系统设置直通 |
| `setTitle(t)` | 改窗口标题(任务栏/IPC 同步广播) |
| `close()` | 关闭自己 |
| `focus()` | 激活自己 |
| `setSize(w, h)` | 程序化调整窗口尺寸(会被窗口下限夹住) |
| `setContentMin({w,h})` | 运行时上报「内容区」最小尺寸,窗框由 WM 补。内容尺寸由代码算出来时用这个(棋盘尺寸改了不必回头改清单);当前窗口比新下限小会被顺势撑开 |
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

### 文件系统(`ctx.fs`,持久化在 localStorage,全部同步 API)

应用窗口打开时绑定**执行用户** `ctx.user`(默认 = 当时登录用户)。
`ctx.fs` 上的读/写/建/删/权限检查都以该用户进行;新建文件属主 = 执行用户。
业务读写请用 `ctx.fs`,不要 `import` 全局 `core/fs.js`(那会绕过应用执行身份)。

```js
mount({ root, fs, user }) {
  fs.read(path)                // 字符串;不存在或无读权限 → null
  fs.write(path, content)      // boolean;父目录自动补齐(需父可写)
  fs.create(path, content='')  // 新建文件
  fs.mkdir(path)               // 目录 node | null
  fs.rm(path)                  // boolean(递归删除)
  fs.rename(old, newPath)      // boolean
  fs.list(path)                // 目录项数组 | null(无读权限)
  fs.exists(p) / fs.isDir(p) / fs.stat(p)
  fs.can(p, 'r'|'w'|'x')       // 权限探测
  fs.chmod(path, '644')        // 仅属主或 root 执行身份
  fs.homePath() / fs.desktopPath()
  fs.joinPath / basename / parentPath / normPath
}
```

清单字段 `executeAs`:`'session'`(默认)/ `'root'` / 固定用户名。
约定目录(相对执行用户):`~/desktop`、`~/documents`、`~/downloads`。
监听变动:`bus.onSys('fs-changed', ...)`,写文件后其他应用会自动收到通知。

`.app` 应用快捷方式:内容为应用 ID 的文本文件(如「国际象棋.app」内容为 `chess3d`)。
桌面/文件管家按应用磁贴渲染并隐藏扩展名,双击/`open` 命令直达应用;
创建用 `js/core/applink.js` 的 `createAppLink(dir, appId)`,识别用 `isAppLink` / `appLinkApp`。

### 文件加密(`core/crypto.js`)

对单个文件做 AES-256-GCM 加密(密码经 PBKDF2-SHA-256 15 万次迭代派生
密钥,随机盐 + IV,格式 `WEOS1:<salt>:<iv>:<ciphertext>`):

- **文件管家**:文件右键「加密…」/「解密…」(密码对话框,加密需二次确认);
  加密文件显示 🔒 锁图标;双击弹出密码解锁后以**只读预览**查看(明文不落盘);
- **终端**:`crypt encrypt <文件> <密码>` / `crypt decrypt <文件> <密码>` /
  `crypt islocked <文件>`(支持子命令分发);`cat` 加密文件会拒绝并提示
  (加密文件不可被管道/重定向读取);
- 密码错误时解密会明确报「密码错误或文件已损坏」(GCM 认证失败),
  文件本身不受影响;
- 代码:`import { isEncrypted, encryptText, decryptText } from '../../core/crypto.js'`。

### 设置(`settings`,自动持久化 + 广播)

```js
settings.get('volume')   // 单项;settings.get() 全量
settings.set({ volume: 30 })   // 写入 → 应用到 DOM → 广播 sys:settings-changed
```

只存应用自己的数据时,不要塞进系统设置。推荐 `js/core/appdata.js`:
数据落在虚拟路径 `/home/<user>/appdata/<app>.awdb`(AetherWebDatabase 页加密库,
经 VFS 写入,库不直连 OPFS);旧 localStorage 键可用 `migrateFromLocalStorage` 一次性迁入。

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
| `level: 3` | 系统模态:全屏遮罩 + 任务栏锁定(inert、开始菜单/托盘面板收起),关闭弹框前整个系统不可操作(默认) |

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

### 通用弹窗(`wm.popup` / `ctx.popup`)

弹窗不等于消息框:内容可以是复杂配置页,甚至是真正渲染游戏的画布。
`popup()` 建一个任意内容、任意尺寸的模态窗口,内容由 `mount` 回调自己画:

```js
const h = wm.popup({
  title: '高级设置', icon: 'sliders',
  width: 720, height: 520, resizable: true,   // 复杂页面常需要缩放
  level: 2,                                    // 三级模态同样适用(如游戏弹窗锁全系统)
  mount({ root, close, setSize }) {
    root.append(/* 表单 / canvas / 任意 DOM */);
    // close(value):关闭弹窗,promise 以 value 兑现
    saveBtn.onclick = () => close({ quality: 'high' });
    // 需要键盘/RAF(如游戏):挂 document 监听,并在 onClose 里清理
    return { onClose() { /* cancelAnimationFrame / removeEventListener */ } };
  },
});
const result = await h.promise;   // close(value) 的 value;点关闭钮 → undefined
h.close('ok');                    // 也可从外部关闭
```

- `onClose` 返回 `false` 可拦截关闭(游戏中误触标题栏 × 时先弹确认)。
- 游戏类弹窗推荐 `level: 3`(系统锁定,专注游戏)或 `level: 2`;键盘输入挂
  `document`,弹窗是真实窗口,canvas/RAF/鼠标事件与普通页面无异。
- ctx 里同样有绑定好的 `ctx.popup`(owner 自动为本应用,默认二级)。

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

### 存储位置

| 位置 | 内容 |
|---|---|
| **OPFS** `webos/fs.v2.json` | 虚拟文件系统**元数据树**(inode 式,无文件内容) |
| **OPFS** `webos/fsdata/<path>` | 各文件真实内容(如 `fsdata/home/u/appdata/sms.awdb`) |
| **VFS** `/home/<user>/appdata/<app>.awdb` | 应用页加密库(`js/core/appdata.js` → AetherWebDatabase,不直连 OPFS) |
| localStorage `webos.settings.v1` | 全部系统设置 |
| localStorage `webos.iconpos.v1` | 桌面图标位置 |
| localStorage `webos.accounts.v1` / `webos.account-session.v1` / `webos.session-locked.v1` | 账号 / 当前会话 / 锁屏状态 |
| localStorage `webos.vnet.v1` | 虚拟网络状态与游戏旗标 |
| localStorage `webos.<app>.v1` | 旧应用私有数据(短信/邮件/任务等已迁 appdata,键仅作迁移源) |

「系统设置 → 系统」可查看用量并一键重置。

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

- 应用骨架(AppKit 推荐布局):

  ```
  div.app                      应用根(相对定位,可承载应用内模态框)
  ├─ div.app-toolbar           顶部工具栏(44px)
  ├─ div.app-mid               中段(可选侧栏)
  │  ├─ div.app-side           侧边栏(180px)
  │  └─ div.app-body           内容区(自动滚动)
  └─ div.app-status            底部状态栏(26px)
  ```

- 通用组件类:`.btn`(.primary/.danger/.icon)、`.input` / `.select`、
  `.field`、`.switch`、`.seg`、`.card`、`.list` / `.list-item`、`.nav-item`、
  `.table`、`.badge-pill`、`.modal-mask` / `.modal-box`、`.empty`、
  `.row`、`.dim`、`.mono`、`.kbd`(实现见 `css/appkit.css`);
- **应用内对话框**(轻量确认/输入,非系统窗口):`core/ui.js` 的
  `modal(root, opts)` / `confirmBox(root, title, body, danger)` /
  `promptBox(root, title, placeholder, value)`,Promise 风格;
  需要系统级窗口(可拖动、跨应用、三级模态)时改用 `dialogs`(见 §5);
- `neon: { a, b }` 声明的双色会以 `--neon-a/--neon-b` 注入窗口,霓虹皮肤自动渲染窗头流光;
- 用户关闭动效时根节点带 `.no-effects`,大动画请写在 `html:not(.no-effects)` 分支。

## 8. 生命周期要点

- `singleton: true` 的应用重复 `open` 只聚焦不重挂,新参数靠 `bus.on('params')`;
- `mount` 执行时窗口框架已进入 DOM(惰性应用为骨架回填),mount 里可直接测量布局;
- `mount` 返回的 `onClose` 里回收资源(对象 URL、定时器、事件监听);
- `onResize(w, h)` 跟随窗口拖拽/最大化/平铺/浏览器窗口缩放触发,canvas 类应用在这里重设尺寸;
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
