# AetherWebOS 系统外壳与 IPC 参考

面向需要操作系统级能力(窗口管理、消息总线)的开发者。应用开发的完整流程
见 [app-dev-guide.md](app-dev-guide.md);本文是窗口系统与 IPC 的逐项 API
参考,对照阅读:`js/core/wm.js`(窗口管理器)、`js/core/bus.js`(消息总线)。

## 一、窗口系统

所有程序都运行在统一的窗体中(`wm.open()` 创建),窗体结构:

```
section.win
├─ header.win-head       窗头:应用图标 · 标题 · [最小化][最大化/还原][关闭]
├─ div.win-body          窗口主体:应用 mount() 的挂载点
└─ div.rz × 8            边缘与四角缩放手柄
```

### 窗口 API(`js/core/wm.js`)

| 方法 | 说明 |
|---|---|
| `wm.open(appId, { params })` | 打开窗口(单实例应用自动聚焦已有窗口并转发 params) |
| `wm.close(id)` / `wm.minimize(id)` / `wm.restoreWin(id)` / `wm.toggleMax(id)` / `wm.focus(id)` | 窗口操作 |
| `wm.taskList()` | 任务栏视图数据 |
| `wm.relayout()` | 视口变化后重新约束窗口 |
| `wm.toggleShowDesktop()` | 显示桌面(全部最小化 / 还原) |
| `wm.isOpen(appId)` / `wm.count()` / `wm.get(id)` | 状态查询 |

**同时任务上限**:`wm.MAX_WINS`(60)。窗口总数(含对话框,即任务栏按钮数)
达到上限后 `wm.open()` 拒绝再开并 toast 提示;对话框(`dialog: true`)不受
拦截也不占名额 —— 上限期系统提示必须仍能弹出。任务栏侧配套收缩策略:按钮
宽度随任务区可用宽收窄(下限 48px),最小宽也放不下时藏前面的留后面的,
溢出指示钮弹出被藏清单可随时取回。

### 窗口生命周期事件

窗口生命周期事件通过总线广播(载荷 `{ id, appId, title? }`):
`sys:win-open / win-close / win-focus / win-blur / win-min / win-restore / win-max /
win-unmax / win-title`,任务栏即基于这些事件驱动。

### 多窗口模式

系统始终保证**同一时刻最多一个活动窗口**(焦点独占,`wm.focusedCount()`),
**零个也是合法状态**。焦点语义:

- 点击窗口任意位置即激活,该次点击照常穿透到内容;
- 点击桌面(壁纸/空白/图标)→ 活动窗口失焦(`wm.blur()`),窗口内的键盘焦点一并收回;
- 最小化活动窗口(含「显示桌面」)→ 失焦;任务栏按钮还原 → 还原并激活;
- 关闭活动窗口 → 焦点接棒给最近激活的剩余可见窗口(关对话框时所属应用自然回焦),
  无人可接则进入无活动窗口状态;
- 键盘焦点与激活绑定:原生焦点落进未激活窗口时该窗口随之激活;失焦窗口内的
  输入框被收回焦点,打字不会漏进后台窗口;
- 窗口失焦时应用收到 `onBlur` 钩子与 `sys:win-blur` 事件。

| 能力 | 入口 | 说明 |
|---|---|---|
| 网格平铺 | 任务栏「窗口布局」按钮 | 全部可见窗口自动排满桌面,最后一行拉伸占满整行 |
| 层叠排列 | 任务栏「窗口布局」按钮 | 恢复经典级联布局 |

两种排列给每个窗口的格子可能小于应用的下限(棋类的下限来自棋盘),此时窗口**膨胀到下限** ——
宁可压住隔壁窗口也不缩棋盘;膨胀后左上角会往回收,尽量让整窗留在桌面内。
浏览器窗口缩放(`relayout`)同样受下限约束,并会触发应用的 `onResize`。
| 拖拽贴边分屏 | 拖窗口到屏幕左/右边缘 | 自动吸附为半屏;拖到顶部最大化 |
| 切换活动窗口 | `Alt+Q` / 布局菜单 | 按最近使用顺序循环 |

API:`wm.tile()` / `wm.cascade()` / `wm.focusCycle()` / `wm.focusedCount()` /
`wm.blur()`(取消激活)/ `wm.activeId()`(当前活动窗口 id,无则 null)。

## 二、IPC 消息总线详解

### 消息信封

`{ id, ts, topic, from, to, type, payload, replyTopic? }`

### 频道约定

- `app:<id>` —— 点对点(收件方是某个应用)
- `app:*` —— 广播
- `sys:<name>` —— 系统事件
- `reply:<uuid>` —— 请求-响应临时频道

### 应用侧 API(`ctx.bus.*`)

| 方法 | 模式 | 说明 |
|---|---|---|
| `bus.on(type, fn)` | 收 | 监听发给本应用的消息,`fn(payload, msg)`;`type='*'` 收全部;`msg.reply(data)` 应答 |
| `bus.send(to, type, payload)` | 发 | 点对点,单向 |
| `bus.request(to, type, payload)` | 请求-响应 | 返回 Promise,2.5s 超时 |
| `bus.broadcast(type, payload)` | 发 | 广播所有应用 |
| `bus.onSys(name, fn)` / `bus.sys(name, payload)` | 系统 | 监听/发布系统事件(`onSys` 内部订阅 `sys:<name>` 频道) |
| `bus.notify(title, body)` | 系统 | 发送系统通知 |

### 内置系统事件

| 事件 | 载荷 |
|---|---|
| `sys:settings-changed` | `{ changed: [...keys], patch }` |
| `sys:theme-changed` | `{ theme: 'light' \| 'dark' }` |
| `sys:volume-changed` | `{ volume, muted }` |
| `sys:fs-changed` | `{ action, path }`;批量合并事件 `{ action: 'batch', path: 公共祖先, paths: [...] }`(播种/装包/解压/回收站等 `fs.batch` 批末只发一条,`path` 仅供展示,逐路径判定请用 `paths`) |
| `sys:notify` | `{ title, body }` |
| `sys:win-*` | `{ id, appId, title? }` |

### 可直接体验的 IPC 场景

打开「系统监视器 → IPC 消息」页,然后:

1. 终端执行 `notify 你好` —— 一条 `sys:notify` 消息触发吐司;
2. 终端执行 `vol 30` —— 托盘音量图标实时变化(事件驱动);
3. 终端执行 `sysinfo` —— 向监视器发起 `request`,监视器 `msg.reply()` 回传数据;
4. 记事本保存文件 —— `sys:fs-changed` 让文件管家列表自动刷新。
