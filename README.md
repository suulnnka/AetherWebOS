# AetherWebOS

AetherWebOS 是一个纯前端的网页操作系统:**无后端**。虚拟文件系统的**元数据**
(JSON)与**文件内容**(OPFS `fsdata/` 下按路径)保存在浏览器 OPFS;设置、账号等
小状态仍在 `localStorage`。运行时依赖经 npm 安装并由 Vite 一并打包,构建产物
部署到任意静态服务器即可运行。

包含窗口系统(拖动/缩放/平铺/贴边分屏)、任务栏与开始菜单、系统托盘、
多套可切换的风格主题、系统设置与系统对话框、虚拟文件系统、IPC 消息总线、
通知/邮件/短信等三十余个内置应用(含 Typora 式所见即所得的 Markdown
编辑器,日记与笔记同样内嵌该编辑内核;**代码编辑器**:编辑器组件与
AetherJS/CSS/HTML/JSON 四语言语法高亮完全自研——禁用总表(var/==/反引号
等)直接标红并悬停提示理由,HTML 模式支持 AetherWebFramework 模板插值
与指令;内置 AetherJS 运行按钮,脚本在沙盒 Worker 里执行,print 输出与
程序值进底部输出面板,编译错误带行列号可点击跳转、输入停顿后实时语法
检查;终端的 `node <脚本.ajs>` 跑同一套运行时,「在终端运行」一键推送;
脚本还可「打包 EXE」成加密可执行文件 —— 随机密钥自动加密、混淆携带在
文件内,AES-GCM 密文落盘(cat 看得见但看不懂),终端 `./程序.exe` 免
node 直接执行(自动解密,按内容魔数识别、改名也能跑,篡改报解密失败);
模拟远程终端(SSH 靶机)里同样支持:`node <文件.ajs>` 读远端文件执行(按
读权限鉴权,root-only 文件拒跑),未命中命令回落远端 exe 直击(put 上传的
exe 也能跑),实训靶机 /opt/tools 自带明文演示脚本与密文 exe;死循环 5 秒
超时强杀,页面永不被脚本卡死)、五个自带 AI 引擎的棋类游戏,以及一套
用于解谜游戏的虚拟网络。浏览器支持多标签页,地址按虚拟 DNS 自动分流:
内网站点(青色标签)是虚拟网络游戏世界,未注册域名(琥珀色标签)直达
真实互联网;地址栏输入关键词改道内网搜索引擎(Firefox 式)。内网站点
是 **AetherJS 沙盒站点应用**([AetherWebFramework](vendor/AetherWebFramework)
子模块:安全子集语言 + 伪 SSR 模板 + Django 风格路由,页面产物过白名单
校验,样式收敛在浏览器作用域内、跨浏览器一致);标签栏与地址栏的操作
逻辑对齐 Firefox(滚轮切标签、拖拽排序、地址栏点击全选、Esc 还原等)。

**软件商店**:游戏、天气、日记、QQ 等十八个应用默认**未安装**——不出现在
开始菜单、没有桌面快捷方式、直接打开会被引导去商店;在「软件商店」里
一键安装,安装即**真实资源下载**:按构建产物扫描出的包清单(apps.json)
把应用文件(入口 chunk、引擎 worker、模型等)逐个下载进虚拟文件系统的
`/app/<id>/`(root 私有,普通用户不可见;进度条与卡片体积都是真实字节),成功才记安装
标志,失败可重试;卸载移除入口,最后一个用户卸载时连包资源一并回收
(应用数据保留,重装即恢复)。**安装按用户**:每个用户一份安装清单,
甲装的应用乙看不到,新用户从系统预装起步;旧版升级时各用户按自己桌面
上的快捷方式自动迁移(入口先落地,包资源后台补齐)。

应用数据经 `js/core/appdata.js` 落在 AetherWebDatabase **页级 AES-GCM 加密**库
(经虚拟文件系统写入,库不直连 OPFS),库口令按**「密钥材料 × 应用名」派生**
(不同应用互不相同;旧口令库首次打开自动重加密迁移)。库按归属分三类:

- **按系统用户**:短信时代以外的常规应用与日记/笔记/任务,落在
  `~/appdata/<app>.awdb`;日记与笔记**不设登录门槛**(未登录时可写,
  内容仅本次会话保留),并各自支持内容加密(日记按天设密码、笔记单条加密);
- **设备级**(一台设备一份,如短信收件箱):`/home/shared/appdata/<app>.awdb`;
- **应用自有账号体系**(独立于系统用户):邮件按**邮箱地址**、QQ 按**号码**
  各身份独立成库 `/home/shared/appdata/<app>#<身份>.awdb`。

**在线演示:<https://suulnnka.github.io/AetherWebOS/>**(每次推送 master 由
GitHub Actions 自动构建部署)

## 快速开始

需要 Node.js 20.19+ 或 22.12+。**克隆时必须带上子模块**:五个棋类的引擎
与内网站点框架(AetherWebFramework)在各自独立的仓库,以 git submodule
挂在 `vendor/` 下。不检出子模块,`npm run dev` / `npm run build` 会因
找不到引擎文件直接失败:

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
node tools/aether-sites-smoke.mjs  # 内网 AetherJS 站点冒烟(无需浏览器)
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
