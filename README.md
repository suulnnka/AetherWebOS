# AetherWebOS

AetherWebOS 是一个纯前端的网页操作系统:**无后端**,所有数据(设置、文件、
图标位置)都保存在浏览器 `localStorage` 中;运行时依赖经 npm 安装并由 Vite
一并打包,构建产物部署到任意静态服务器即可运行。

包含窗口系统(拖动/缩放/平铺/贴边分屏)、任务栏与开始菜单、系统托盘、
多套可切换的风格主题、系统设置与系统对话框、虚拟文件系统、IPC 消息总线、
通知/邮件/短信等二十余个内置应用、五个自带 AI 引擎的棋类游戏,以及一套
用于解谜游戏的虚拟网络。

**在线演示:<https://suulnnka.github.io/AetherWebOS/>**(每次推送 master 由
GitHub Actions 自动构建部署)

## 快速开始

需要 Node.js 20.19+ 或 22.12+。**克隆时必须带上子模块**:五个棋类的引擎在
各自独立的仓库,以 git submodule 挂在 `vendor/` 下。不检出子模块,
`npm run dev` / `npm run build` 会因找不到引擎文件直接失败:

```bash
# 首次克隆:--recurse-submodules 一并拉齐引擎子模块
git clone --recurse-submodules https://github.com/suulnnka/AetherWebOS.git

# 已经普通 clone 了?进入仓库补一句即可:
git submodule update --init
```

构建与运行:

```bash
npm install        # 首次运行安装依赖
npm run dev        # 开发模式,http://localhost:8080

npm run build      # 产线构建,输出到 dist/(纯静态,任意服务器可跑)
npm run preview    # 本地预览构建产物
```

浏览器打开 <http://localhost:8080> 即可。首次进入会播放约 1 秒开机画面。

## 自动化测试

内置一套端到端冒烟测试(需要本机装有 Chrome,走 CDP 协议),
开始前自动重置到初始桌面,组内失败不影响其他组:

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

## 文档与调试

想给系统写一个新应用,看 **[应用开发指南](docs/app-dev-guide.md)**
(清单字段、mount 上下文、总线通信、右键菜单、样式变量与 e2e 测试参考)。

更多参考文档:

- [系统外壳与 IPC 参考](docs/shell-api.md) —— 窗体结构、窗口 API、多窗口模式、消息信封与系统事件
- [剧情 / 游戏作者指南](docs/game-author-guide.md) —— 虚拟网络、邮件、短信的作者 API 与内置示例谜题链
- [开发经验教训](docs/lessons.md) —— 迭代中实际踩过并修复的坑

浏览器控制台可直接使用全局对象:

```js
WebOS.wm.open('terminal')            // 打开应用
WebOS.settings.get()                 // 读设置
WebOS.fs.list('/home/documents')     // 列目录
WebOS.__errs                         // 运行期错误
```
