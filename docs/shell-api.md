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

### 窗口生命周期事件

窗口生命周期事件通过总线广播(载荷 `{ id, appId, title? }`):
`sys:win-open / win-close / win-focus / win-min / win-restore / win-max /
win-unmax / win-title`,任务栏即基于这些事件驱动。

### 多窗口模式

系统始终保证**同一时刻最多一个活动窗口**(焦点独占,`wm.focusedCount()`)。

| 能力 | 入口 | 说明 |
|---|---|---|
| 网格平铺 | 任务栏「窗口布局」按钮 | 全部可见窗口自动排满桌面,最后一行拉伸占满整行 |
| 层叠排列 | 任务栏「窗口布局」按钮 | 恢复经典级联布局 |
| 拖拽贴边分屏 | 拖窗口到屏幕左/右边缘 | 自动吸附为半屏;拖到顶部最大化 |
| 切换活动窗口 | `Alt+Q` / 布局菜单 | 按最近使用顺序循环 |
| 单活动窗口模式 | 设置 → 桌面与任务栏 / 布局菜单 | 开启后非活动窗口内容变暗,首次点击仅激活(不穿透到内容),再次点击才交互 |

API:`wm.tile()` / `wm.cascade()` / `wm.focusCycle()` / `wm.focusedCount()`。

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
| `sys:fs-changed` | `{ action, path }` |
| `sys:notify` | `{ title, body }` |
| `sys:win-*` | `{ id, appId, title? }` |

### 可直接体验的 IPC 场景

打开「系统监视器 → IPC 消息」页,然后:

1. 终端执行 `notify 你好` —— 一条 `sys:notify` 消息触发吐司;
2. 终端执行 `vol 30` —— 托盘音量图标实时变化(事件驱动);
3. 终端执行 `sysinfo` —— 向监视器发起 `request`,监视器 `msg.reply()` 回传数据;
4. 记事本保存文件 —— `sys:fs-changed` 让文件管家列表自动刷新。
