# WebOS —— 纯前端网页操作系统

一个类群晖 DSM / Windows 11 风格的网页操作系统。**纯前端、无后端**:
所有数据(设置、文件、图标位置)保存在浏览器 `localStorage` 中;运行时用到的
第三方库经 npm 安装并由 Vite 一并打包进产物(当前含 ogl),构建产物
放在任意静态服务器上即可运行。

> 灵感与架构参考:[win11React](https://github.com/blueedgetechno/win11React)、
> [OS.js](https://github.com/os-js/OS.js)、[Puter](https://github.com/HeyPuter/puter)。

**在线演示:<https://suulnnka.github.io/AetherWebOS/>**(每次推送 master 由
GitHub Actions 自动构建部署,棋类应用用的就是下面的引擎子项目)

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

需要 Node.js 20.19+ 或 22.12+。

**克隆时必须带上子模块**:五个棋类的引擎在各自独立的仓库里,以
git submodule 挂在 `vendor/AetherOthello`、`vendor/AetherChess`、`vendor/AetherXiangqi`、
`vendor/AetherGo` 与 `vendor/AetherRenju`(即 [AetherOthello](https://github.com/suulnnka/AetherOthello)、
[AetherChess](https://github.com/suulnnka/AetherChess)、
[AetherXiangqi](https://github.com/suulnnka/AetherXiangqi)、
[AetherGo](https://github.com/suulnnka/AetherGo) 与
[AetherRenju](https://github.com/suulnnka/AetherRenju))。不检出子模块,
`npm run build` / `npm run dev` 会因找不到引擎文件直接失败:

```bash
# 首次克隆:--recurse-submodules 一并拉齐引擎子模块
git clone --recurse-submodules https://github.com/suulnnka/AetherWebOS.git

# 已经普通 clone 了?进入仓库补一句即可:
git submodule update --init
```

构建与运行:

```bash
npm install        # 首次运行安装依赖(vite + ogl)
npm run dev        # 开发模式,http://localhost:8080

npm run build      # 产线构建,输出到 dist/(纯静态,任意服务器可跑)
npm run preview    # 本地预览构建产物
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
│  └─ themes/            风格主题包,每套一个文件(css/themes/<id>.css,modern 免样式表)
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
│  │  ├─ crypto.js       文件加密(AES-GCM + PBKDF2)
│  │  ├─ weather.js      模拟气象引擎(确定性,历史可回溯)
│  │  └─ zip.js          ZIP 压缩包(自研读写,STORE+DEFLATE 双向)
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
│  └─ apps/              应用(每个应用一个目录,按需独立加载)
│     ├─ index.js        装配表:注册各应用清单 + 动态 import 加载器
│     └─ <id>/
│        ├─ manifest.js  应用清单(纯数据,启动时即注册)
│        ├─ index.js     应用代码(mount + 逻辑,首次打开才加载)
│        └─ <id>.css     可选:应用专属样式(随应用 chunk 按需加载)
├─ js/game/index.js      内置游戏内容(示例谜题链)
├─ vendor/               git submodule:独立引擎子项目
│  ├─ AetherOthello/     黑白棋引擎(github.com/suulnnka/AetherOthello)
│  ├─ AetherChess/       国际象棋引擎(github.com/suulnnka/AetherChess)
│  ├─ AetherXiangqi/     中国象棋引擎(github.com/suulnnka/AetherXiangqi)
│  ├─ AetherGo/          9×9 围棋引擎(github.com/suulnnka/AetherGo)
│  └─ AetherRenju/       五子棋/连珠引擎(github.com/suulnnka/AetherRenju)
└─ README.md
```

**应用按需加载**:启动时只注册各应用的清单元数据(体积极小),应用代码与
样式由 Vite 拆成独立 chunk(`assets/app-<id>-[hash].js/.css`),首次打开
窗口时才拉取(wm.open → registry.ensureLoaded)。

**打包与缓存**:共享内核(含各应用清单)独立为 `core-[hash].js`,应用
chunk 只依赖 core、不依赖主包 —— 改某个应用的代码只会改名该应用与主包,
其余应用与内核的文件名不变,浏览器缓存照常命中。改 js/core 会改名全部
chunk(内核被所有人引用,属预期)。为保证这一性质,应用只能 import
`js/core/*` 与自身目录文件(唯一例外:reversi / chess3d / xiangqi / go 引用
`vendor/` 下的引擎子项目 —— 引擎只被单个应用 import,不会引入共享级联)。

**新增应用**:在 `js/apps/<id>/` 建目录:`manifest.js` 放清单字段,
`index.js` 里 `import manifest from './manifest.js'` 并
`register({ ...manifest, mount })`,有专属样式就在 index.js 顶部
`import './<id>.css'`;最后在 `js/apps/index.js` 的 APPS 表补一行即可。

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

内置一套端到端冒烟测试(需要本机装有 Chrome,走 CDP 协议),
共 44 个用例组,每组可独立运行:开始前自动重置到初始桌面,组内失败不影响其他组:

```bash
npm run dev                        # 先起开发服务器(8080 端口)
npm run e2e                        # 全部 44 组
npm run e2e -- --list              # 列出全部用例组
npm run e2e -- T22                 # 只跑某一组
npm run e2e -- T1-T5 邮件 天气     # 区间 / 组号 / 标题关键词,可混写
npm run e2e -- --parallel 3        # 指定并发数(默认 6,调试可 --parallel 1)
npm run e2e -- --clean             # 清空测试 profile,全新 localStorage 状态
```

默认 6 个浏览器并行,全量约 1 分钟(串行约 3.5 分钟);每个 worker 使用
独立的 Chrome profile 与系统分配的调试端口,localStorage 互不可见。

输出 PASS/FAIL 清单 + `.shots/` 截图;末尾的分组摘要含每组耗时,方便定位慢用例。

覆盖:桌面/开始菜单/窗口生命周期(最小化、最大化、关闭)/主题与壁纸切换及持久化/
风格皮肤切换(Win3.1/Win98/WinXP/Win7/macOS/Ubuntu/霓虹未来,`t15-*.png` ~ `t17-*.png` 为各皮肤截图)/
托盘三面板/文件管家与记事本联动/终端 IPC 三种模式(事件、命令、request-response)/
计算器/音乐/通知中心/刷新后数据恢复/虚拟网络谜题/多窗口管理/系统对话框/邮件、
任务、短信、笔记、日记、五子棋(双规则/禁手标记/AI 应答)等应用与账号隔离。`index.html` 中还内置了 `window.__errs`
错误收集器,控制台可随时查看运行期异常。

### 风格主题架构

默认风格为霓虹未来(暗色 + 动态背景)。皮肤通过 `<html data-style="...">` 属性驱动,全部实现在 `css/themes/<id>.css`
(neon 霓虹未来为默认外观),
不改动任何 DOM 与 JS 结构即可新增皮肤:

- 各皮肤覆盖 CSS 变量(调色板、圆角、任务栏高度 `--tb`、字体)与组件样式
  (窗头、窗口按钮、任务栏、开始菜单、弹出层、按钮斜面/渐变);
- 霓虹未来皮肤:强制全系统暗色调色板。**每个应用拥有自己的双色霓虹灯条**
  (manifest 的 `neon: { a, b }`,窗头 3px 光管在两色间循环流光,
  未聚焦窗口灯条停摆变暗,**活动窗口辉光呼吸脉动**);
  现代深色全宽任务栏(暗色玻璃 + 细霓虹上边线,活动按钮显示该应用的
  双色霓虹下划线);**动态桌面**:PS4 式背景色彩流动(大面积多色渐变
  缓慢变换色相)+ 漂移网格 + 双色漂浮光球;
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

新增皮肤:在 `store.js` 的 `STYLES` 加一项,新建 `css/themes/xxx.css` 写一段
`html[data-style="xxx"] { ... }` 并在 `index.html` 加一行 `<link>` 即可,
设置界面自动出现新选项。

## 开发经验教训(踩坑实录)

以下均为本项目迭代中**实际踩过并已修复**的坑,记录于此供后续开发避雷。

### 架构与规则类

- **窗口层必须对指针透明**:`#windows` 容器若默认接收指针事件,会整层
  挡住下方的桌面图标(真实点击永远落空,而合成事件测试无法发现——
  它不做命中测试)。修法:容器 `pointer-events: none`,仅窗口本体与
  模态遮罩恢复 `auto`。任何"覆盖式层级容器"都要检查这一点;
- **单例应用重开时必须重读持久化数据**:模块级 `state` 只在首次加载时
  从 localStorage 读一次,关闭再打开(或外部脚本写入)后若不重读,
  内存旧数据会把新数据覆盖回去(备忘录与任务都踩过)。修法:mount
  开头重新 load,或基于版本号(`seq`)的单向同步;
- **隐藏属性会被 display 规则覆盖**:对 `[hidden]` 元素设置过
  `display: grid` 之类规则时,UA 样式的 `[hidden]{display:none}` 会失效,
  出现"看不见却仍拦截点击/盖住全屏"的诡异现象。修法:全局加
  `[hidden] { display: none !important; }`;
- **绝对定位的标题栏文本要加 `pointer-events: none`**,否则居中标题
  会挡住右侧窗口按钮的点击。

### 测试类

- **合成事件与真实事件是两回事**:合成 `dispatchEvent` 直接派发给目标
  元素、不做命中测试,曾让"窗口层挡住真实点击"的 bug 存活多个版本。
  回归测试务必包含 `Input.dispatchMouseEvent` / `dispatchKeyEvent`
  注入的**真实输入管线**事件(`isTrusted=true`);
- **测试注入键盘的中文/特殊字符**:CDP 需 keyDown → `char`(带 text)
  → keyUp 三段式,否则字符丢失;`windowsVirtualKeyCode` 超过 255 的
  (如中文)必须省略;修饰键组合(Ctrl+A)不能带 char text,否则会
  意外插入字符破坏选区;
- ** headless Chrome 复用 profile 时 HTTP 缓存极其顽固**:同秒修改的
  CSS/JS 会因 `Last-Modified` 精度不足命中 304 旧缓存(CSSOM 停留在
  旧规则)。修法:`Network.setCacheDisabled`——保留 localStorage
  (持久化测试需要),只禁 HTTP 缓存;
- **断言不要写死应用数量/文件名**:应用总数、默认文件等会随迭代增长,
  断言用 `>=` 或动态发现;清档要连同**用户命名空间键**一起清
  (`webos.<app>.v1::<user>`),否则残留数据造成"时好时坏"的假失败;
- **CDP evaluate 的代码会被字符串拼接执行**:模板串里的注释若含
  控制字符(如真实 NUL)会让页面端报语法错误且极难定位——禁止把
  二进制/转义序列直接写进测试代码,用 `charCodeAt` 比较替代。

### 流程类

- **改文件用编辑工具,不要用脚本 heredoc**:转义(反斜杠/换行/NUL)
  多层嵌套极易出错,本项目曾有脚本把字面 NUL 与断行写进文件,
  反复排查数轮;
- **多进程并行开发时,先认领文件再动手**:一次 Vite 迁移与账号系统
  并行进行,双方都改 `e2e.mjs`/应用装配表,导致"修复没生效"、
  断言漂移、互相覆盖,排查成本远超功能本身;
- **全量回归只在收尾跑一次**,开发中用针对性冒烟(单应用/单功能)
  验证——190+ 用例每轮 3 分钟,反复全跑是最直接的时间黑洞;
- **`performance.timeOrigin` 可以验证页面是否真的重载了**:`goto()`
  相同 URL 后若 timeOrigin 未变,说明重载未发生,后续 evaluate
  仍打在旧页面上(本项目曾因此误判测试失败)。

## 开发调试

> 想给 WebOS 写一个新应用?看 **[应用开发指南](docs/app-dev-guide.md)**——
> 清单字段、mount 上下文、总线通信、右键菜单、样式变量与 e2e 测试的完整参考。

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

## 文件加密

虚拟文件系统支持对单个文件做 AES-256-GCM 加密(密码经 PBKDF2-SHA-256
15 万次迭代派生密钥,随机盐+IV,格式 `WEOS1:<salt>:<iv>:<ciphertext>`):

- **文件管家**:文件右键「加密…」/「解密…」(密码对话框,加密需二次确认);
  加密文件显示 🔒 锁图标;双击弹出密码解锁后以**只读预览**查看(明文不落盘)
- **终端**:`crypt encrypt <文件> <密码>` / `crypt decrypt <文件> <密码>` /
  `crypt islocked <文件>`(支持子命令分发)
- **终端(Bash)**:`cat` 加密文件会拒绝并提示(加密文件不可被管道/重定向读取)

密码错误时解密会明确报"密码错误或文件已损坏"(GCM 认证失败),
文件本身不受影响。控制台:`WebOS` → `import { encryptText } from './js/core/crypto.js'`。

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
- **终端**:唯一 shell 就是 Bash —— 一张命令表融合 Linux 指令与
  WebOS 扩展命令:文件目录(`ls -l / cd / cat / mkdir / rm -r / mv /
  cp / head / tail / grep / wc / find / tree / touch`),虚拟网络
  (`nslookup / ping / curl / ifconfig / ssh`,密码登录远程会话),
  应用与 IPC(`apps / open / edit / notify / vol / theme / wallpaper /
  sysinfo`,体验 IPC 的最佳入口),文件加密(`crypt
  encrypt|decrypt|islocked`),系统对话框(`alert / ask / progress`);
  支持管道 `|`、重定向 `> >>`、引号、`#` 注释、Tab 补全(命令与
  文件名)、`Ctrl+L`/`Ctrl+C`、命令历史;操作本地虚拟文件系统,
  网络命令只达虚拟网络(vnet);Ubuntu 紫底 + 绿色用户名/蓝色路径
  提示符,`man <命令>` 查看用法,`exit` 关闭终端
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
- **接龙(Klondike)**:标准规则 —— 7 列交替色降序、4 收牌堆同花色
  A→K、牌堆翻牌与重置、双击自动收牌、空列只收 K,步数与分数统计
- **记忆翻牌**:4×4 / 6×6 两种规模,3D 翻牌动画,配对全部翻开即胜,
  计步与计时
- **QQ 经典版**:仿 2005 即时通信 —— 登录页、好友分组(在线/离线、
  未读徽标)、聊天窗格(气泡消息/表情面板/对方正在输入),好友机器人
  性格化自动回复,消息持久化、刷新自动登录
- **推箱子**:6 个渐进关卡,方向键/WASD 移动,撤销(U)/重开(R),
  步数与推动统计,过关自动进入下一关
- **黑白棋**:8×8 经典 Reversi —— 合法位提示、夹翻动画、跳过与终局
  判定、实时子数比;位棋盘引擎(独立子项目 vendor/AetherOthello:双 32 位移位
  填充,经典 Zobrist 双散列置换表、深度兼容校验),PVS 迭代加深 + 残局完全
  求解(≤14 空,求解前 2→4→6 中层搜索定排序),三档难度(初级贪心 /
  中级 4 层 / 高级 8 层),搜索过程实时显示在窗口内;也可双人对弈
- **中国象棋**:10×9 传统棋盘(SVG 画线:河界、九宫斜线、炮兵位十字标)——
  完整规则(马蹩腿、象塞眼且不过河、炮翻山、士将限九宫、兵过河可横走、
  将帅对脸判非法),点自己的子看可走位置、可吃位置红圈提示、将军闪红;
  引擎为独立子项目 vendor/AetherXiangqi(alpha-beta 迭代加深 + 置换表 +
  吃子静态搜索,perft 对齐公认计数,四档难度),Worker 后台思考逐层回报,
  底栏实时显示档位/深度/节点数/耗时/评分;支持悔棋、双人对弈与换边
  (与 AI 互换执子方,棋盘随之翻转)
- **围棋**:9×9 棋盘(SVG 画线:五颗星位、A~J/1~9 边缘坐标)—— 完整规则
  (气尽提子、禁自杀、单劫禁回提、双停终局),悬停虚影预览落子、提子实时计数;
  引擎为独立子项目 vendor/AetherGo(MCTS/UCT + 中国规则数子,黑贴 5.5 目,
  四档难度按演棋局数分档),Worker 后台思考逐层回报,底栏实时显示
  档位/演棋数/耗时/胜率;支持停一手、悔棋、双人对弈与换边(棋盘不翻转,
  坐标恒定),双停后自动数子判胜负
- **五子棋**:15×15 棋盘(SVG 画线:天元 + 四星、A~O/15~1 边缘坐标)——
  **无禁 / 有禁双规则一键切换**:无禁(自由)长连也算胜;有禁(连珠)黑方
  恰好五连才胜,三三/四四/长连禁手点盘上标 × 且不可落(黑被禁手封盘判负),
  禁手判定按 RIF 规则递归展开(假活三自动识别),五连连线呼吸金圈高亮;
  引擎为独立子项目 vendor/AetherRenju(alpha-beta 迭代加深 + 置换表 +
  增量五元窗评估 + VCF 式静态搜索,禁手与独立暴力判定器逐点对拍,
  四档难度),Worker 后台思考逐层回报,底栏实时显示
  档位/深度/节点数/耗时/评分;支持悔棋、双人对弈与换边(棋盘对称不翻转)
- **扫雷**:初级/中级/高级三难度,首击安全、右键插旗、双击快开(chord)、
  LED 计时器与计雷器,胜利/失败判定
- **国际象棋**:2D / 3D 双视图一键切换 —— 3D 为 ogl(经 npm 打包,无 CDN)渲染的
  可旋转棋盘(拖拽旋转视角、滚轮缩放),2D 为平面棋盘,两视图共用局面与走子;
  完整规则(王车易位、吃过路兵、兵升变、将军/将死/逼和),
  引擎为独立子项目 vendor/AetherChess(PVS/置换表/静态搜索 + Texel 调参
  评估,四档强度;开局库内置引擎 src/book.js,ECO 谱线来自 lichess-org/chess-openings,
  查谱命中加权随机、谱外进搜索),Worker 后台思考不卡界面,支持换边与悔棋,也支持人人对战
- **笔记**:卡片式笔记(置顶/颜色/搜索/分类过滤),**每条可单独加密**
  (AES-GCM,锁标+模糊预览,密码解锁查看,忘记密码不可找回)
- **日记**:按日期记录每一天 —— 左侧月历导航(有日记的日子带圆点
  标记,点击切换、跨月自动翻页、「今天」一键回位),右侧编辑正文并
  选择心情(再点一次取消),输入即自动保存;按用户持久化
- **压缩包**:文件管家支持 `.zip` —— 右键解压到同名文件夹(保留包内
  目录结构)、选中文件/文件夹一键压缩为 ZIP(目录递归)、双击浏览包内
  条目(DEFLATE/STORE 标识);ZIP 读写为自研实现
  (`core/zip.js`,经 Compression Streams 压缩,UTF-8 文件名)
- **天气**:8 城市实况(体感/湿度/风速/气压/日出日落)+ 12 小时逐时 +
  7 日预报 + **历史天气查询**(任意日期回溯、趋势条形图);数据由
  确定性模拟气象引擎生成 —— 同城同日永远同天,符合季节与昼夜规律

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
