# WebOS —— 纯前端网页操作系统

一个类群晖 DSM / Windows 11 风格的网页操作系统。**零依赖、零构建、零后端**:
所有代码是原生 ES Modules,所有数据(设置、文件、图标位置)保存在浏览器
`localStorage` 中,用任意静态服务器打开即用。

> 灵感与架构参考:[win11React](https://github.com/blueedgetechno/win11React)、
> [OS.js](https://github.com/os-js/OS.js)、[Puter](https://github.com/HeyPuter/puter)。

## 功能一览

| 模块 | 说明 |
|---|---|
| 底部程序栏(任务栏) | 开始按钮、固定应用(右键动态固定/取消,持久化)、运行窗口按钮、系统托盘、显示桌面 |
| 开始菜单 | 应用搜索、磁贴网格、用户信息、电源(重启/关机) |
| 系统托盘 | 音量面板(滑杆+静音)、通知中心、时钟+日历 |
| 风格主题 | 整套系统皮肤一键切换:**现代 / 霓虹未来 / macOS / Win3.1 / Win98 / WinXP / Win7 / Ubuntu**(窗体、任务栏、开始菜单、按钮、弹窗全部跟随) |
| 系统设置 | 主题(浅色/深色/跟随系统)、强调色、壁纸、图标大小、亮度、音量、用户名、存储管理、重置系统 |
| 窗口系统 | 拖动、8 方向缩放、最小化/最大化/还原/关闭、焦点层级、级联定位、双击标题栏最大化 |
| 多窗口模式 | 网格平铺(末行拉伸)/层叠排列/拖拽贴边分屏、Alt+Q 切换活动窗口、**单活动窗口模式**(非活动窗口首次点击仅激活不穿透,内容变暗) |
| 系统对话框 | 错误/警告/信息/成功/确认/是·否/输入/密码/**进度**等模态系统窗口,Promise API,模态遮罩 + 焦点独占 |
| 桌面 | 应用快捷方式 + **桌面文件目录**(`/home/desktop`):右键新建文档/文件夹、F2 重命名、Delete 删除、Enter 打开、橡皮筋框选、Ctrl 多选/全选、拖动网格吸附、一键排列图标;开始菜单/任务栏右键**固定应用**(持久化) |
| 虚拟文件系统 | 目录/文件 CRUD,持久化,变更自动广播给所有应用 |
| IPC 消息总线 | 点对点、广播、请求-响应三种模式,带消息日志 |
| 通知系统 | 吐司 + 通知中心,应用通过一条 IPC 消息即可发通知 |
| 内置应用 | 文件管家、记事本、计算器、终端、系统设置、系统监视器、音乐播放器 |

## 快速开始

需要用 HTTP 方式访问(ES Modules 不支持 file:// 直开):

```bash
# 方式一:Python
python -m http.server 8080

# 方式二:Node
npx -y serve . -l 8080

# 或使用附带脚本(Windows 双击 serve.bat)
```

浏览器打开 <http://localhost:8080> 即可。首次进入会播放约 1 秒开机画面。

## 目录结构

```
webos/
├─ index.html            入口页面(桌面/任务栏/开始菜单骨架)
├─ css/
│  ├─ base.css           reset + 主题变量(明暗两套)
│  ├─ shell.css          桌面、任务栏、开始菜单、托盘、通知、开关机画面
│  ├─ window.css         窗体、窗头、窗口按钮、缩放手柄
│  ├─ appkit.css         应用通用组件(按钮/表单/列表/模态框/系统对话框…)
│  ├─ themes.css         风格主题包(neon/mac/win31/win98/winxp/win7/ubuntu)
│  └─ apps/              各应用专属样式(css/apps/<id>.css,由加载器注入)
├─ js/
│  ├─ main.js            启动入口:装配应用与外壳(纯 import 清单)
│  ├─ core/              内核
│  │  ├─ bus.js          ★ IPC 消息总线
│  │  ├─ wm.js           ★ 窗口管理器(含模态对话框支持)
│  │  ├─ store.js        系统设置(响应式 + 持久化)
│  │  ├─ fs.js           虚拟文件系统
│  │  ├─ vnet.js         虚拟网络(DNS/HTTP/SSH)
│  │  ├─ mail.js         虚拟邮件服务
│  │  ├─ sms.js          虚拟短信服务
│  │  ├─ dialogs.js      ★ 系统对话框服务
│  │  ├─ registry.js     应用注册表
│  │  ├─ icons.js        内联 SVG 图标库
│  │  ├─ menu.js         全局右键菜单
│  │  ├─ ui.js           应用内模态框(confirm/prompt)
│  │  ├─ audio.js        WebAudio 引擎(音量跟随系统)
│  │  ├─ utils.js        DOM/格式化工具
│  │  └─ exports.js      全局信息(window.WebOS)
│  ├─ system/            桌面外壳
│  │  ├─ boot.js         启动序列
│  │  ├─ desktop.js      桌面(壁纸 + 图标)
│  │  ├─ taskbar.js      任务栏(固定应用 + 运行窗口)
│  │  ├─ startmenu.js    开始菜单
│  │  ├─ tray.js         系统托盘(音量/日历/通知/开关机)
│  │  ├─ shortcuts.js    布局按钮 + 全局快捷键
│  │  └─ appstyles.js    应用样式注入器
│  └─ apps/              应用(每个应用一个目录)
│     └─ <id>/index.js   应用代码(mount + 逻辑)
├─ js/game/index.js      内置游戏内容(示例谜题链)
└─ README.md
```

**新增应用**:在 `js/apps/<id>/index.js` 实现 mount 并 register,在
`js/main.js` 加一行 import;若有专属样式,放 `css/apps/<id>.css` 并在
`js/system/appstyles.js` 的清单里加名字即可。

## 一、窗口系统

所有程序都运行在统一的窗体中(`wm.open()` 创建),窗体结构:

```
section.win
├─ header.win-head       窗头:应用图标 · 标题 · [最小化][最大化/还原][关闭]
├─ div.win-body          窗口主体:应用 mount() 的挂载点
└─ div.rz × 8            边缘与四角缩放手柄
```

窗口 API(`import * as wm from 'core/wm.js'`):

| 方法 | 说明 |
|---|---|
| `wm.open(appId, { params })` | 打开窗口(单例应用自动聚焦已有窗口并转发 params) |
| `wm.close(id)` / `wm.minimize(id)` / `wm.toggleMax(id)` / `wm.focus(id)` | 窗口操作 |
| `wm.taskList()` | 任务栏视图数据 |
| `wm.relayout()` | 视口变化后重新约束窗口 |

窗口生命周期事件通过总线广播:`sys:win-open / win-close / win-focus /
win-min / win-restore / win-max / win-unmax / win-title`,任务栏即基于这些事件驱动。

### 多窗口模式(单一活动窗口)

系统始终保证**同一时刻最多一个活动窗口**(焦点独占,`wm.focusedCount()`)。

| 能力 | 入口 | 说明 |
|---|---|---|
| 网格平铺 | 任务栏「窗口布局」按钮 | 全部可见窗口自动排满桌面,最后一行拉伸占满整行 |
| 层叠排列 | 任务栏「窗口布局」按钮 | 恢复经典级联布局 |
| 拖拽贴边分屏 | 拖窗口到屏幕左/右边缘 | 自动吸附为半屏;拖到顶部最大化 |
| 切换活动窗口 | `Alt+Q` / 布局菜单 | 按最近使用顺序循环 |
| 单活动窗口模式 | 设置 → 桌面与任务栏 / 布局菜单 | 开启后非活动窗口内容变暗,首次点击仅激活(不穿透到内容),再次点击才交互 |

API:`wm.tile()` / `wm.cascade()` / `wm.focusCycle()` / `wm.focusedCount()`。

### 系统对话框(`core/dialogs.js`)

一组系统自带窗口,任何应用一行代码即可调用(真窗口:可拖动、
任务栏可见、风格主题跟随;打开期间**模态遮罩阻挡其他窗口**,
焦点只在对话框之间切换,Alt+Q 不会离开对话框):

```js
import { dialogs } from '../core/dialogs.js';

await dialogs.error({ title: '错误', message: '写入失败', detail: 'E_ACCESS_DENIED (0x5)' });
await dialogs.warning({ title: '警告', message: '存储空间即将耗尽' });
await dialogs.info({ title: '提示', message: '已复制到剪贴板' });
await dialogs.success({ title: '完成', message: '更新成功' });

if (await dialogs.confirm({ title: '删除', message: '确定吗?', danger: true, okText: '删除' })) { … }
const v = await dialogs.prompt({ title: '重命名', value: '旧名' });   // string | null
const pw = await dialogs.password({ title: '需要密码' });
const r = await dialogs.yesno({ title: '保存更改?' });                 // 'yes'|'no'|null

const h = dialogs.progress({ title: '下载更新', cancelable: true });
h.set(45, '正在下载… 45%');
h.done('完成');                       // 或 h.cancel();await h.promise → true/false
```

特性:Enter 确认 / Esc 取消、错误/警告带提示音、进度条(定量/不定式)、
窗口高度自适应内容、控制台 `WebOS.dialogs.*` 可直接调用。
内置联动:文件管家的新建/重命名/删除已改用系统对话框;
终端 `alert` / `ask` / `progress` 命令可现场体验;
「设置 → 系统」提供全部对话框的测试按钮。

## 二、程序内部布局方案(AppKit)

每个应用的根元素是 `.app`,推荐的内部布局骨架:

```
div.app                      应用根(相对定位,可承载应用内模态框)
├─ div.app-toolbar           顶部工具栏(44px)
├─ div.app-mid               中段(可选侧栏)
│  ├─ div.app-side           侧边栏(180px)
│  └─ div.app-body           内容区(自动滚动)
└─ div.app-status            底部状态栏(26px)
```

通用组件类:`.btn(.primary/.danger/.icon)` `.input` `.select` `.field`
`.switch` `.seg` `.card` `.list/.list-item` `.nav-item` `.table`
`.modal-mask/.modal-box` `.empty` `.row` `.dim` `.mono` `.kbd`。

应用内对话框:`confirmBox / promptBox / modal`(见 `core/ui.js`,Promise 风格)。

## 三、应用开发方案

新建 `js/apps/hello.js`:

```js
import { el } from '../core/utils.js';
import { register } from '../core/registry.js';

register({
  id: 'hello',                    // 唯一 ID,也是 IPC 地址
  name: '你好世界',
  icon: 'message',                // icons.js 中的图标名
  color: 'linear-gradient(135deg,#06b6d4,#3b82f6)',
  width: 520, height: 380,
  min: { w: 380, h: 280 },
  singleton: true,                // 只允许开一个
  neon: { a: '#00e5ff', b: '#ff2ad4' },  // 霓虹皮肤专属灯条双色(可选,流光两端)
  order: 20,                      // 桌面/开始菜单排序
  mount(ctx) {
    const { root, bus, params, setTitle, close } = ctx;

    // —— IPC:监听点对点消息,并演示应答 ——
    bus.on('ping', (payload, msg) => {
      msg.reply({ pong: Date.now() });
    });
    // —— IPC:监听系统事件 ——
    bus.onSys('theme-changed', ({ theme }) => status.textContent = theme);

    const status = el('span', { class: 'dim' }, '...');
    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' }, el('b', {}, '你好世界'), el('span', { class: 'grow' }), status),
      el('div', { class: 'app-body', style: { padding: 20 } },
        el('button', { class: 'btn primary', onClick: () => bus.notify('来自 Hello', 'IPC 通知演示') }, '发通知'),
        el('button', { class: 'btn', onClick: () => bus.request('monitor', 'stats').then(console.log) }, '查询监视器')),
      el('div', { class: 'app-status' }, '就绪')));

    setTitle('你好世界 — v1.0');
    // 返回生命周期钩子(全部可选)
    return {
      onClose() { return true; },          // 返回 false 可阻止关闭
      onResize(w, h) {},
      onParams(p) {},                       // 单例应用收到新的 open(params)
    };
  },
});
```

再在 `js/main.js` 顶部加一行 `import './apps/hello.js';` 即完成安装
(桌面、开始菜单、任务栏自动出现新应用)。

### mount(ctx) 挂载上下文

| 成员 | 说明 |
|---|---|
| `ctx.root` | 挂载根元素,构建你的 DOM 到这里 |
| `ctx.bus` | 本应用绑定的消息总线(见下节) |
| `ctx.params` | `wm.open(id, { params })` 传入的参数 |
| `ctx.fs` / `ctx.settings` | 文件系统与系统设置 |
| `ctx.setTitle(t)` / `ctx.close()` / `ctx.focus()` | 窗口控制 |

## 四、IPC 信息交换方案

消息信封:`{ id, ts, topic, from, to, type, payload, replyTopic? }`

频道约定:`app:<id>`(点对点)、`app:*`(广播)、`sys:<name>`(系统事件)、
`reply:<uuid>`(请求-响应临时频道)。

应用侧 API(`ctx.bus.*`):

| 方法 | 模式 | 说明 |
|---|---|---|
| `bus.on(type, fn)` | 收 | 监听发给本应用的消息,`fn(payload, msg)`;`type='*'` 收全部;`msg.reply(data)` 应答 |
| `bus.send(to, type, payload)` | 发 | 点对点,单向 |
| `bus.request(to, type, payload)` | 请求-响应 | 返回 Promise,2.5s 超时 |
| `bus.broadcast(type, payload)` | 发 | 广播所有应用 |
| `bus.onSys(name, fn)` / `bus.sys(name, payload)` | 系统 | 监听/发布系统事件 |
| `bus.notify(title, body)` | 系统 | 发送系统通知 |

内置系统事件:

| 事件 | 载荷 |
|---|---|
| `sys:settings-changed` | `{ changed: [...keys], patch }` |
| `sys:theme-changed` | `{ theme: 'light' \| 'dark' }` |
| `sys:volume-changed` | `{ volume, muted }` |
| `sys:fs-changed` | `{ action, path }` |
| `sys:notify` | `{ title, body }` |
| `sys:win-*` | `{ id, appId, title? }` |

**可直接体验的 IPC 场景**:打开「系统监视器 → IPC 消息」页,然后:

1. 终端执行 `notify 你好` —— 一条 `sys:notify` 消息触发吐司;
2. 终端执行 `vol 30` —— 托盘音量图标实时变化(事件驱动);
3. 终端执行 `sysinfo` —— 向监视器发起 `request`,监视器 `msg.reply()` 回传数据;
4. 记事本保存文件 —— `sys:fs-changed` 让文件管家列表自动刷新。

## 自动化测试

内置一套零依赖端到端冒烟测试(需要本机装有 Chrome,走 CDP 协议):

```bash
python -m http.server 8080        # 先起服务
node tools/e2e.mjs                # 25 项断言 + .shots/ 全程截图
```

覆盖:桌面/开始菜单/窗口生命周期(最小化、最大化、关闭)/主题与壁纸切换及持久化/
风格皮肤切换(Win3.1/Win98/WinXP/Win7/macOS/Ubuntu/霓虹未来,`t15-*.png` ~ `t17-*.png` 为各皮肤截图)/
托盘三面板/文件管家与记事本联动/终端 IPC 三种模式(事件、命令、request-response)/
计算器/音乐/通知中心/刷新后数据恢复。`index.html` 中还内置了 `window.__errs`
错误收集器,控制台可随时查看运行期异常。

### 风格主题架构

皮肤通过 `<html data-style="...">` 属性驱动,全部实现在 `css/themes.css`,
不改动任何 DOM 与 JS 结构即可新增皮肤:

- 各皮肤覆盖 CSS 变量(调色板、圆角、任务栏高度 `--tb`、字体)与组件样式
  (窗头、窗口按钮、任务栏、开始菜单、弹出层、按钮斜面/渐变);
- 霓虹未来皮肤:强制全系统暗色调色板。**每个应用拥有自己的双色霓虹灯条**
  (manifest 的 `neon: { a, b }`,窗头 3px 光管在两色间循环流光,
  未聚焦窗口灯条停摆变暗,**活动窗口辉光呼吸脉动**);
  悬浮切角"战控台"任务栏(斜纹肌理 + 顶部四色流光 + 切角芯片按钮,
  活动芯片显示该应用的迷你流光灯条);**动态桌面**(漂移网格 +
  双色漂浮光球 + 周期扫描光带 + 全屏 CRT 扫描线);
  霓虹青强调色、等宽字体标题、按钮/输入框辉光描边;
- macOS 皮肤:红绿灯按钮移到左侧(flex order)、标题居中、悬浮居中 Dock、壁纸铺满全屏;
- Win3.1 皮肤:22px 纯海军蓝标题栏(无渐变)、左侧「系统菜单盒」样式的关闭钮、
  更细的银灰任务栏与 MS Sans Serif 字体栈;
- Win98 皮肤:强制经典银灰调色板(覆盖明暗主题变量)、立体斜面边框、
  「开始」文字按钮、经典开始菜单竖排侧边条;
- WinXP 皮肤:Luna 蓝渐变窗框与任务栏、绿色斜切开始按钮、米色控件;
- Win7 皮肤:Aero 玻璃任务栏与窗头辉光标题、圆形开始球、下圆角窗口按钮;
- Ubuntu 皮肤:任务栏移到屏幕顶部(GNOME 顶栏,时钟居中、隐藏日期)、
  headerbar 式窗口(标题居中、圆形按钮、Yaru 橙关闭钮)、
  强制 Yaru 橙强调色(整套系统的选中态/主按钮变橙)、
  顶部居中黑色胶囊通知;托盘弹出面板自动改为从顶栏下方弹出。

新增皮肤:在 `store.js` 的 `STYLES` 加一项,在 `themes.css` 写一段
`html[data-style="xxx"] { ... }` 即可,设置界面自动出现新选项。

## 开发调试

浏览器控制台可直接使用全局对象:

```js
WebOS.wm.open('terminal')            // 打开应用
WebOS.settings.get()                 // 读设置
WebOS.fs.list('/home/documents')     // 列目录
WebOS.bus.publish('sys:notify', { from:'console', payload:{ title:'hi' } })
WebOS.__errs                         // 运行期错误
```

## 五、数据持久化

| localStorage 键 | 内容 |
|---|---|
| `webos.settings.v1` | 全部系统设置 |
| `webos.fs.v1` | 虚拟文件系统整棵树 |
| `webos.iconpos.v1` | 桌面图标位置 |

「系统设置 → 系统」可查看用量并一键重置。虚拟文件系统 API
见 `core/fs.js`(`list/read/write/mkdir/rm/rename/stats`)。

## 内置应用

- **文件管家**:目录浏览、面包屑、新建/重命名/删除、双击调用记事本
- **本地资源**:浏览本电脑真实文件 —— 「打开文件夹」(File System Access
  API,可逐级进入子目录)/ 选择文件(兼容回退)/ 直接拖入文件或文件夹,
  全程只读、不经网络;双击文件交给文件预览
- **文件预览**:图片 / 视频(播放器)/ 音频 / PDF(内置查看器)/ 文本
  (等宽排版 + 行数统计),支持把文件拖进窗口;文本可一键「在记事本中
  编辑」(存入虚拟文件系统并调起记事本);对象 URL 随窗口关闭回收
- **记事本**:`Ctrl+S` 保存、另存为、未保存关闭三选一确认、多窗口
- **计算器**:手写词法+调度场算法求值(无 eval)、实时预览、键盘输入
- **终端**:`help` 查看 20+ 命令,是体验 IPC 的最佳入口
- **Bash 终端**:受限 bash 模拟器 —— 仅允许白名单内的 Linux 指令
  (`ls -l / cd / pwd / cat / echo / mkdir / rm -r / mv / cp / touch /
  head / tail / grep / wc / find / tree / which / man / uname / date /
  uptime / history / clear / exit`),其余一律 `command not found`
  (网络命令在此禁用);支持管道 `|`、重定向 `> >>`、引号、`#` 注释、
  Tab 补全(命令与文件名)、`Ctrl+L`/`Ctrl+C`,操作本地虚拟文件系统;
  Ubuntu 紫底 + 绿色用户名/蓝色路径提示符
- **系统监视器**:运行时概览、IPC 消息流水(可过滤)、存储用量
- **系统设置**:外观/壁纸/桌面/声音/显示/用户/系统 七大分区
- **音乐**:WebAudio 合成三首内置旋律,主增益实时跟随系统音量
- **浏览器**:虚拟网络专用浏览器(见下节)
- **邮件**:三栏虚拟邮件客户端 —— 收件箱/已发送/草稿箱/垃圾箱、未读与
  星标、写信/回复/存草稿、附件(`proxy` 经路径转换直通浏览器、`fs`
  转预览器)、正文链接直通虚拟浏览器;游戏作者用
  `mail.deliver / deliverLater / onSend` 投递剧情邮件与自动回信
- **短信**:会话式短信客户端 —— 会话列表(未读徽标)+ 聊天气泡、
  **验证码自动识别一键复制**、服务台自动回信;游戏作者用
  `sms.deliver / deliverLater / onSend` 投递剧情短信
- **任务**:项目分组 + 优先级 + 截止日期 + 星标 + 进度环,到期/逾期
  系统通知与短信提醒,清单一键导出到桌面文件,拖拽排序,持久化

## 虚拟网络系统(解谜游戏平台)

WebOS 内置一套完整的虚拟网络(`js/core/vnet.js`),用于制作 Hacknet
风格的解谜游戏。**浏览器与终端只能访问虚拟网络**:

- 输入的域名必须能被**虚拟 DNS** 解析,否则报"无法解析主机"
  (访问真实互联网域名会被拒绝,这是刻意的隔离);
- 游戏作者可以通过**路径转换(proxy)** 把某个虚拟 URL 映射到
  真实互联网资源(例如一个在线 PDF),浏览器会以 iframe 加载 ——
  这是用户触达外网的唯一通道,且完全由作者数据决定。

### 游戏作者 API(在 `js/game/` 中注册)

```js
import { addDNS, addSite, addServer, setFlag, getFlag } from '../core/vnet.js';

// 1) DNS 记录(listed: 出现在浏览器"内网导航"页)
addDNS({ host: 'portal.nexus', ip: '10.0.0.10', note: '集团门户', listed: true });

// 2) 虚拟网站:路径 → HTML 字符串 或 处理函数
//    处理函数 ctx = { path, query, flag(k), setFlag },可返回:
//    { body } | { proxy: 真实URL } | { redirect } | { status: 403 }
addSite('library.nexus', {
  ip: '10.0.0.11',
  title: '数字图书馆',
  routes: {
    '/': ({ query, setFlag }) => {
      if (query.pass === '52831') { setFlag('library_ok'); return { body: '<h1>登录成功</h1>…' }; }
      return { body: '<form action="/">口令 <input name="pass"><button>登录</button></form>' };
    },
    '/manual.pdf': () => ({ proxy: 'https://…/manual.pdf' }),  // 路径转换
  },
});

// 3) SSH 服务器:口令 + 独立虚拟文件系统 + 自定义命令(谜题机关)
addServer('vault.nexus', {
  ip: '10.0.0.23',
  users: { researcher: {
    password: 'h3ll0w', home: '/home/researcher',
    fs: { home: { researcher: { 'notes.txt': '线索文本' } } },
    commands: { status: () => { setFlag('ssh_done'); return ['维护锁已释放']; } },
  } },
});

// 4) 游戏标志位(持久化,通过 vnet:flag-changed 事件驱动剧情)
setFlag('quest_done');
```

浏览器页面的 `<a>`/`<form>` 会被自动拦截转为虚拟导航;SSH 会话内置
`ls cat cd pwd whoami echo get(下载到本机文件管家) exit` 命令,自定义命令优先。
所有虚拟网络活动通过总线广播(`vnet:http` / `vnet:ssh` / `vnet:flag-changed`),
在系统监视器的 IPC 页面可以实时观测玩家的探索轨迹。

### 示例游戏《赛博档案》

内置一条完整可玩的谜题链(`js/game/index.js`,同时也是创作样例):

1. 浏览器内网导航 → `portal.nexus` 公告:图书馆账号 reader,口令=馆藏总数;
2. 门户"关于本馆"页显示馆藏 52,831 册 → 口令 `52831`;
3. `library.nexus` 登录成功 → 泄露 SSH 凭据 `researcher/h3ll0w @ 10.0.0.23`;
4. 终端 `ssh researcher@vault.nexus` → `cat notes.txt` 得到隐藏站线索,
   `status` 命令解锁(触发标志位);
5. `blackout.nexus` 的《赛博档案 Vol.3》PDF 通过路径转换代理自真实互联网,
   集齐两把"钥匙"后触发通关通知。

测试:`tools/e2e.mjs` 的 T18 组覆盖上述全链路(含口令试错、403 门禁、
下载联动、外网域名隔离验证);`WebOS.vnet.resetState()` 可清空游戏进度。

### 邮件系统(`core/mail.js`)

面向**玩家**:三栏客户端(文件夹/列表/阅读),未读徽标进窗口标题,
新邮件弹系统通知;附件与正文链接联动浏览器(路径转换)与预览器;
全部状态持久化。控制台 `WebOS.mail.*`。

面向**游戏作者**:

```js
import mail from '../core/mail.js';

mail.deliver({ from: 'boss@nexus', fromName: '主管', subject: '紧急任务', body: '……<a href="http://portal.nexus/">门户</a>' });
mail.deliverLater({ from: 'x@nexus', subject: '迟来的回信', body: '…' }, 3000);  // 剧情节奏
mail.onSend((m) => {                    // 玩家发信钩子:返回回信 spec 即自动回复
  if (m.to === 'hint@nexus') return { subject: 'Re: ' + m.subject, body: '提示…' };
});
// 附件:{ name:'手册.pdf', kind:'proxy', url:'http://portal.nexus/manual.pdf' }
//      { name:'笔记', kind:'fs', path:'/home/desktop/便签.txt' }
```

内置示例:三封种子邮件(欢迎/图书馆口令线索/带 PDF 附件的通讯)、
`hint@nexus` 服务台自动回信(提到「档案」给针对性提示)、
谜题旗标联动(图书馆登录成功回执、通关奖励邮件附真实 PDF)。

### 短信系统(`core/sms.js`)

会话按联系人归并,最近活跃在前;验证码消息(4-8 位)自动渲染"复制验证码"
按钮。API 与邮件同构:

```js
import sms from '../core/sms.js';
sms.deliver({ from: 'nexus-guard', fromName: '安全中心', text: '验证码 823741,5 分钟内有效' });
sms.deliverLater({ from: 'x', text: '…' }, 2000);
sms.onSend(({ to, text }) => to === 'nexus-hint' ? { text: '自动回信…' } : null);
```

系统联动:任务应用到期/逾期时自动向「任务提醒」会话发短信;
`hint@nexus` 的短信版服务台 `nexus-hint` 同样支持自动回信。

## License

MIT
