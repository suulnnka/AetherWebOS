# AetherWebOS

**纯前端网页操作系统** —— 无后端、无服务器 API:窗口系统、虚拟文件系统、
消息总线、软件商店与 35 个内置应用全部跑在浏览器里。文件系统建立在
OPFS 之上,系统状态在 `localStorage`,构建产物是纯静态文件,部署到任意
静态服务器即可运行。

**在线演示:<https://suulnnka.github.io/AetherWebOS/>**(推送 master 由
GitHub Actions 自动构建部署)

## 功能总览

**桌面外壳**

- 窗口:拖动、八向缩放、最大化、最小化、贴边分屏、网格平铺 / 层叠,
  任务栏(固定 + 任务 + 托盘时钟)、开始菜单(搜索 / 用户 / 电源)、
  通知吐司、全局右键菜单
- 8 套风格皮肤(现代 / 霓虹 / macOS / Win3.1 / Win98 / WinXP / Win7 /
  Ubuntu)× 深浅色主题,壁纸 / 强调色 / 动效 / 亮度可调
- 多用户账号与登录、开机 / 关机画面、会话恢复(意外刷新后窗口自动复原)

**虚拟文件系统**(OPFS,元数据 + 内容分存)

- 类 Unix 权限位(属主 / 其他 × 读 / 写 / 管理)、写时复制快照、回收站
- 压缩包、AES 文件加密、每用户家目录、文件「打开方式」路由
- 终端 `ls -l` / `chmod` / `snap` 等命令与文件系统联动

**应用数据安全**

- 应用数据统一落 `.awdb` **页级 AES-GCM 加密库**(AetherWebDatabase),
  口令按「密钥材料 × 应用名」派生,不同应用互不相同
- 三类归属:按用户(`~/appdata`)、设备级(短信收件箱)、应用自有身份
  (邮件按邮箱地址、QQ 按号码各成一库)

**软件商店**

- 19 个应用默认**未安装**,商店内一键安装 / 卸载;安装是**真实资源下载**:
  按构建清单逐文件下载进 root 私有的 `/app/<id>/`(失败可重试)
- 安装按用户隔离——甲装的应用乙看不到;末位卸载自动回收包资源,
  应用数据保留,重装即恢复

**开发体验:代码编辑器与 AetherJS**

- 自研编辑器组件 + AetherJS / CSS / HTML / JSON 四语言**自研语法高亮**
  (语言禁用总表直接标红并悬停提示理由)
- AetherJS 一键运行:沙盒 Worker 执行,print / 程序值进输出面板,编译
  错误带行列号可点击跳转,死循环 5 秒超时强杀、页面永不卡死
- **打包 EXE**:随机密钥 AES-GCM 加密 + 混淆,密文落盘(cat 看得见但
  看不懂),终端 `./程序.exe` 免 node 直接执行,篡改报解密失败
- 终端 `node <脚本.ajs>` 同一运行时;模拟远程终端(SSH 靶机)里同样
  可跑远端脚本与密文 exe

**浏览器与虚拟网络**

- 多标签浏览器,标签操作对齐 Firefox(滚轮切标签、拖拽排序、地址栏
  点击全选、Esc 还原)
- 地址按虚拟 DNS 自动分流:内网站点(青色标签)是虚拟网络世界,
  未注册域名(琥珀色标签)直达真实互联网;关键词改道内网搜索引擎
- 内网站点是 **AetherJS 沙盒站点应用**(AetherWebFramework 子模块:
  安全子集语言 + 伪 SSR 模板 + Django 风格路由,产物过白名单校验)
- 模拟远程终端:虚拟主机、登录认证、远端文件系统与权限机关、30+ 常用
  命令、get / put 传输、ssh 跳板嵌套,内置实训靶机

**35 个内置应用**:Markdown 编辑器(Typora 式所见即所得)、电子表格、
代码编辑器、终端、文件管家、邮件、地图、天气,以及五个自带 AI 引擎的
棋类(围棋 19 路神经网络引擎 / 中国象棋 / 国际象棋 / 黑白棋 / 五子棋)
等——完整名录见[应用名录](docs/apps.md)。

## 快速开始

构建需要 Node.js 20.19+ 或 22.12+;运行浏览器需支持 OPFS
(Chrome / Edge 86+ 等现代浏览器,不支持时系统拒绝启动)。

**克隆时必须带上子模块**——五个棋类引擎、3D 库、加密库与内网站点框架
共 8 个子模块在各自独立仓库,挂在 `vendor/` 下;不检出则
`npm run dev` / `npm run build` 直接失败:

```bash
# 首次克隆:--recurse-submodules 一并拉齐子模块
git clone --recurse-submodules https://github.com/suulnnka/AetherWebOS.git

# 已经普通 clone 了?进入仓库补一句即可:
git submodule update --init
```

```bash
npm install        # 首次运行安装依赖
npm run dev        # 开发模式,http://localhost:8080
npm run build      # 产线构建,输出到 dist/(纯静态,任意服务器可跑)
npm run preview    # 本地预览构建产物
```

首次进入播放约 1 秒开机画面,自动创建默认账号并直接进入桌面。

## 自动化测试

端到端冒烟测试(需本机装有 Chrome,走 CDP 协议),60 组用例;开始前
自动重置到初始桌面,组内失败不影响其他组:

```bash
npm run dev                        # 先起开发服务器(8080 端口)
npm run e2e                        # 全量
npm run e2e -- --list              # 列出全部用例组
npm run e2e -- T22                 # 只跑某一组
npm run e2e -- T1-T5 邮件 天气     # 区间 / 组号 / 标题关键词,可混写
npm run e2e -- --parallel 3        # 指定并发数(默认 6,调试可 --parallel 1)
npm run e2e -- --clean             # 清空测试 profile,全新 localStorage 状态
```

输出 PASS/FAIL 清单 + `.shots/` 截图,末尾含分组摘要与每组耗时。
另有三组无需浏览器的专项冒烟:`npm run test:sites`(内网 AetherJS
站点)、`npm run test:md`(Markdown 内核)、`npm run test:chess-worker`
(棋类引擎 Worker)。

## 文档

| 文档 | 内容 |
|---|---|
| [系统架构](docs/architecture.md) | 目录分层、启动序列、内核模块、存储模型、分包策略、主题、工具链 |
| [应用名录](docs/apps.md) | 35 个内置应用逐个说明(实例 / 分发 / 功能要点) |
| [应用开发指南](docs/app-dev-guide.md) | 写一个新应用:清单字段、mount 上下文、总线通信、样式与测试 |
| [系统外壳与 IPC 参考](docs/shell-api.md) | 窗体结构、窗口 API、消息信封与系统事件 |
| [快捷键总览](docs/shortcuts.md) | 全量约 115 条快捷键,含与浏览器默认行为的三层关系 |
| [剧情 / 游戏作者指南](docs/game-author-guide.md) | 虚拟网络、邮件、短信的作者 API 与内置谜题链 |
| [开发经验教训](docs/lessons.md) | 迭代中实际踩过并修复的坑 |
| [kix4 模式评估研究](docs/kix4-pattern-eval-study.md) | 围棋引擎模式权重压缩研究笔记 |

## 控制台调试

浏览器控制台可直接使用全局对象:

```js
WebOS.wm.open('terminal')            // 打开应用
WebOS.settings.get()                 // 读设置
WebOS.fs.list('/home/documents')     // 列目录
WebOS.apps.install('weather')        // 安装一个商店应用
WebOS.__errs                         // 运行期错误
```
