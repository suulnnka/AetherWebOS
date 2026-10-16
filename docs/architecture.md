# AetherWebOS 系统架构

面向想了解系统内部组织的贡献者与维护者:目录怎么分层、启动走哪些步、
内核有哪些模块、数据落在何处。**写一个新应用**看
[app-dev-guide.md](app-dev-guide.md);窗口与 IPC 的逐项 API 看
[shell-api.md](shell-api.md);35 个内置应用看 [apps.md](apps.md)。

## 1. 分层总览

整个系统是一个纯前端单页应用:`index.html` 提供桌面 / 窗口层 / 任务栏 /
开始菜单的静态骨架,`js/main.js` 只负责装配,真正的逻辑分四层:

```
index.html(唯一页面:桌面、#windows、任务栏、开始菜单、托盘的静态骨架)
 └─ js/main.js(装配入口)
     ├─ js/core/    内核:总线、窗口管理、文件系统、设置、注册表…(无界面装配依赖)
     ├─ js/system/  桌面外壳:把内核能力组装成桌面体验(启动序列在这里)
     ├─ js/apps/    35 个应用,每个一目录,按需加载(见 §6)
     ├─ js/lib/     自研组件库:Markdown 内核、代码编辑器、语法高亮、地图内核
     └─ js/game/    内置游戏内容:内网站点源码与谜题链定义
```

依赖方向:应用只能 import `core/*` 与 `lib/*`(以及自身目录),`system/`
只被 main.js 装配引入;内核不反向依赖外壳与应用。唯一例外是经
vite `manualChunks` 划入稳定区的 `system/session.js`(见 §6)。

## 2. 目录结构

```
AetherWebOS/
├── index.html          # 唯一页面(静态骨架 + 启动错误捕获脚本)
├── vite.config.js      # 构建:应用独立 chunk、core 稳定区、dev 现场扫描 apps.json
├── js/
│   ├── main.js         # 启动入口:应用注册 → 对话框 → 游戏内容 → 外壳 → boot
│   ├── core/           # 内核 38 个文件,含 2 个 Worker(逐个见 §4)
│   ├── system/         # boot / desktop / taskbar / startmenu / tray / shortcuts /
│   │                   # session / sessionsave
│   ├── apps/           # 35 个应用:<id>/{manifest.js, index.js[, <id>.css]}
│   │   └── index.js    # 应用装配表(registerLazy + prefetch)
│   ├── lib/            # md.js(Markdown)/ mdedit.js(编辑器)/ cedit.js(代码编辑
│   │                   # 组件)/ chl.js(高亮)/ minimap.js(矢量地图内核)
│   └── game/           # site-defs.js(站点元数据)+ sites/<名>/{router.ajs,*.html}
├── css/
│   ├── base|shell|window.css   # 骨架三件套
│   ├── appkit.css              # 应用通用组件(按钮 / 输入框 / 弹层…)
│   ├── apps/                   # 跨应用共享的应用样式(如账号面板)
│   └── themes/                 # 风格皮肤,每套一个文件(见 §7)
├── tools/              # e2e、包清单扫描、各专项冒烟与历史探针(见 §9)
├── vendor/             # 8 个 git submodule(见下)
└── docs/               # 本文档所在
```

**vendor/ 子模块**(独立仓库,克隆时须 `--recurse-submodules`):
五个棋类引擎 `AetherChess3` / `AetherXiangqi` / `AetherGo` / `AetherOthello`
/ `AetherRenju`、3D 库 `Aether3DLib`(国际象棋 3D 视图)、加密库
`AetherWebDatabase`(.awdb 页级 AES-GCM)、站点框架 `AetherWebFramework`
(内网站点的 AetherJS 安全子集 + 伪 SSR 模板 + 路由)。

## 3. 启动序列(`js/system/boot.js`)

main.js 按序引入:应用装配表(只注册清单)→ 系统对话框 → 游戏内容 →
桌面外壳各模块 → `boot()`。boot 内部:

1. **OPFS 硬门禁**:文件系统以 OPFS 为唯一存储、无降级路径,不支持的
   浏览器直接拒绝启动(开机画面上给出提示);
2. `applyAllSettings()`:主题 / 风格 / 强调色 / 动效 / 亮度 / 图标尺寸;
3. `fsReady()` 等 OPFS 装载与迁移完成 → 无任何用户时自动创建默认账号登录;
4. 为当前用户建家目录、迁移旧版桌面快捷方式、播种应用快捷方式;
5. `/app` 包目录整树权限归一(root 私有,幂等兜底);
6. 渲染任务栏 / 开始菜单 / 托盘 / 桌面图标,时钟走针;
7. URL hash 为 `#open=<app>&…` 时直开指定应用(无交互渲染比对用),
   否则做**会话恢复**(刷新后把上次打开的窗口开回来);
8. 挂出全局调试接口 `window.WebOS`(见 §8),开机画面淡出
   (E2E 模式缩短动画)。

## 4. 内核模块一览(`js/core/`)

| 分组 | 模块 | 职责 |
|---|---|---|
| 窗口与界面 | `wm.js` | 窗口管理器:打开/关闭/最小化/最大化/贴边分屏/平铺/层叠/焦点 |
| | `dialogs.js` | 系统对话框(全 Promise):消息框、三选确认、输入、进度 |
| | `menu.js` | 全局右键菜单 |
| | `ui.js` | 界面小工具(el 构建器等) |
| | `utils.js` | DOM / 事件工具(`$`、`E2E` 测试标志等) |
| | `icons.js` | 全量 SVG 图标表 |
| | `rename.js` | 重命名浮层 |
| | `clipboard.js` | 文件剪贴板(桌面 / 文件管家共用) |
| | `audio.js` | 系统音量与提示音 |
| 通信 | `bus.js` | IPC 消息总线:点对点 / 广播 / 请求-响应 / 系统事件 |
| 文件与数据 | `fs.js` + `opfs.js` | 虚拟文件系统(元数据 JSON + OPFS `fsdata/` 内容),类 Unix 权限位、COW 快照 |
| | `appfs.js` | 应用侧文件系统视图(按用户根目录约束) |
| | `appdata.js` + `dbsql.js` | 应用数据统一落盘 `~/appdata/*.awdb`(页级 AES-GCM);dbsql 为只读 SQL 查询 Worker |
| | `crypto.js` | 文件级 AES 加密 |
| | `zip.js` | 压缩包读写 |
| | `trash.js` | 回收站 |
| | `openwith.js` | 「打开方式」路由:扩展名 → 应用 |
| | `exports.js` | `WebOS` 全局信息对象(boot 再扩充,见 §8) |
| 应用生命周期 | `registry.js` | 应用注册表:清单先行、chunk 按需加载、空闲预读 |
| | `install.js` | 安装门禁与安装状态(按用户),`sys:apps-changed` 联动 |
| | `pkg.js` | 商店包资源:`/app/<id>/` 设备级缓存与回收 |
| | `applink.js` | 桌面快捷方式播种 |
| | `mdopen.js` | Markdown 文档跨应用打开协作 |
| 设置与账号 | `store.js` | 设置中心(自动持久化 + `sys:settings-changed`),风格/主题表在此 |
| | `accounts.js` | 多用户账号、登录态、家目录绑定 |
| | `loginpanel.js` | 登录 / 注册 / 锁屏面板 |
| 虚拟世界 | `vnet.js` | 虚拟网络:DNS 注册表、剧情标志、SSH 口令检查 |
| | `vssh.js` | 模拟远程终端会话引擎:远端主机树、30+ 命令、get/put、跳板嵌套 |
| | `mail.js` / `sms.js` | 邮件与短信服务(剧情与常规应用共用,按身份成库) |
| | `weather.js` | 天气数据服务(实况 / 12 小时 / 7 日 / 历史回溯) |
| 脚本运行时 | `ascript.js`(+worker) | AetherJS 沙盒执行(5s 超时强杀),编辑器与终端 `node` 同源 |
| | `aexe.js` | EXE 打包与直击:`AEXE1:` 魔数 + 随机密钥 AES-GCM |
| | `aethersite.js` | 内网 AetherJS 站点:编译 AetherWebFramework 产物并白名单校验挂载 |

## 5. 存储模型

全部数据都在浏览器本地,无任何后端:

| 存储 | 内容 | 写入方 |
|---|---|---|
| OPFS `fsdata/` | 文件**内容**,按路径存放 | `fs.js` / `opfs.js` |
| OPFS 元数据(JSON) | 目录树、权限位、快照遮蔽(`fsshadow` 私有域) | `fs.js` |
| localStorage | 设置、账号、桌面布局等系统态;vnet 剧情标志位 | `store.js` / `accounts.js` / `vnet.js` |
| VFS 内 `~/appdata/*.awdb` | 应用数据加密库(页级 AES-GCM,经 VFS 写入,库不直连 OPFS) | `appdata.js` |
| VFS 内 `/home/shared/appdata/` | 设备级库(短信)与按应用内身份成库(邮件按邮箱、QQ 按号码,`<app>#<身份>.awdb`) | `appdata.js` |
| VFS 内 `/app/<id>/` | 商店包资源(root 私有,设备级缓存,末位卸载回收) | `pkg.js` |

.awdb 库口令按「密钥材料 × 应用名」派生,不同应用互不相同;旧口令库
首次打开自动重加密迁移。日记 / 笔记在库之上另支持内容级加密(日记按天
设密码、笔记单条加密)。

### 5.1 落盘分层(fs-writeback)

`fs.js` 的元数据树按变更类型分层落盘(方案与决策记录见
[fs-writeback.md](fs-writeback.md)):

- **数据页 / 随机写字节**(`writeAt`):即时直写 OPFS,不变;
- **结构变更**(新建 / 删除 / 改名 / 权限 / 文本内容):30ms 微防抖——
  已发给浏览器的写最终进入内核页缓存、进程死亡不丢,防抖只为合并突发;
- **仅 mtime/size 变化**(对已存在文件的就地覆盖 / 追加):懒写,不设
  短计时,搭结构趟便车 + `pagehide` + `fs.flush()` + 30s 兜底;会话内
  读取全走内存态,crash 后由**启动校准**修复盘上树(size 按实际字节、
  mtime 以根上的 `savedAt` 哨兵 + `clockDelta` 换算判定,不裸搬
  `lastModified`,保住快照恢复 / 导入的历史时间戳);
- **`fs.batch`**:播种 / 装包 / 解压 / 回收站等循环写,批内抑制
  `sys:fs-changed` 逐次广播(经 `bus.js` 频道静默吸收),批末发一条
  `{action:'batch', paths:[…]}` 合并事件并强制一趟确定性落盘。

配套不变量:`readAt` 不按 inode.s 截断(懒写 s 的读侧前提);
cowGuard 实际遮蔽即升结构趟(快照注册表必须紧随遮蔽字节,否则强杀后
快照静默读到新内容);应用按键级持久化各自 ≥200ms 防抖,fs 不是唯一
合并层。

## 6. 应用加载与分包策略

- **清单先行**:启动只读入各应用 `manifest.js`(纯数据、体积极小),
  应用本体是独立 chunk,首次 `wm.open` 才拉取——窗口框架先立起(骨架
  加载态),chunk 到位后回填;
- **空闲预读**:清单标 `prefetch: true` 的高频应用(浏览器 / 终端等)
  启动空闲后后台预读,首次打开免等;
- **稳定区**:`vite.config.js` 的 `manualChunks` 把 core 与 lib 划为开机
  引入的稳定 chunk——改一个应用只让该应用 chunk 变化,其余应用缓存不
  失效。这也是应用不得 import `system/*` 的原因(会把主包拖进应用
  chunk);确需共享时把该模块划进稳定区(先例:`system/session.js`);
- **商店包清单**:构建后 `tools/apps-manifest.mjs` 扫描 dist 产出
  `apps.json`(每个应用包含哪些文件、各多大);dev 模式由 vite 中间件
  现场扫描源码树。软件商店的「真实资源下载」即按此清单逐文件下载。

应用接入系统的三步与清单字段详见
[app-dev-guide.md](app-dev-guide.md)。

## 7. 主题与样式

- 两个正交维度:`html[data-theme]`(深 / 浅色)× `html[data-style]`
  (风格皮肤,8 套:现代 / 霓虹未来 / macOS / Win3.1 / Win98 / WinXP /
  Win7 / Ubuntu,定义在 `core/store.js`);
- 每套皮肤一个文件 `css/themes/<style>.css`,选择器以
  `html[data-style='<id>']` 作用域隔离;modern 即基础样式、无独立样式表;
  默认风格为 neon;
- 应用一律通过 CSS 变量(`--bg`、`--fg`、`--acc` 等)取色,换肤即全系统
  联动;应用专属样式的组织方式见 app-dev-guide §7。

## 8. 全局调试接口(`window.WebOS`)

`core/exports.js` 定义基础对象,boot 启动后合并入:bus / wm / settings /
accounts / fs / vnet / dialogs / mail / sms / weather / appdata / trash /
clipboard / openwith,以及 `apps: { list, install, uninstall, isInstalled }`。
控制台即开即用:

```js
WebOS.wm.open('terminal')         // 打开应用
WebOS.settings.get()              // 读设置
WebOS.fs.list('/home/documents')  // 列目录
WebOS.apps.install('weather')     // 安装一个商店应用
WebOS.__errs                      // index.html 捕获的运行期错误
```

## 9. 工具链(`tools/`)

| 脚本 | 用途 |
|---|---|
| `e2e.mjs` / `e2e-harness.mjs` / `e2e-groups/` | 端到端测试:CDP 驱动本机 Chrome,63 组用例,默认 6 并发,产出 PASS/FAIL 清单与 `.shots/` 截图。入口 `e2e.mjs` 只管 CLI、用例筛选与并行调度;`e2e-harness.mjs` 是公共设施(`t()` 断言、`group()` 注册表、浏览器连接与 `ev()`、`fresh()` 等共享助手);用例组按域分 7 个文件(shell / themes / files / net / apps / editors / games),新增用例放对应域文件即可;`E2E_PORT` 可指向另一端口的 Vite(如 worktree 检出的 HEAD 快照,避开本目录编辑触发的 HMR 重载) |
| `apps-manifest.mjs` | 扫描 dist 生成商店包清单 `apps.json`(`npm run build` 的一环) |
| `aether-sites-smoke.mjs` | 内网 AetherJS 站点冒烟(Node 直跑,无需浏览器) |
| `md-smoke.mjs` | Markdown 内核(`lib/md.js`)解析渲染冒烟,纯函数 |
| `chl-smoke.mjs` | 语法高亮库(`lib/chl.js`)冒烟:四语言词法 + 「产物去标签后与源码逐字符一致」不变量 |
| `chess-worker-smoke.mjs` | 棋类引擎 Worker 冒烟 |
| `audit-md.mjs` | Markdown 编辑器逐语法 WYSIWYG 审计(真实键入验证即时渲染) |
| `cdp.mjs` | 上述脚本共用的 CDP 封装 |
| `probe-*.mjs` | 历史调试探针(棋类 AI 走子 / 相机 / 命中率等一次性验证脚本) |

## 10. 部署

`npm run build` 产物为纯静态文件(dist/),任意静态服务器可跑。推送到
master 由 GitHub Actions(`.github/workflows/deploy-pages.yml`)自动构建
并部署到 GitHub Pages——**在线演示即这条流水线的产物**。流水线 checkout
时显式带上子模块(引擎缺失则构建直接失败,与本地行为一致)。
