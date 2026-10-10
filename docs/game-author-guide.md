# AetherWebOS 剧情 / 游戏作者指南

AetherWebOS 内置一套完整的虚拟网络(`js/core/vnet.js`),配合邮件
(`js/core/mail.js`)与短信(`js/core/sms.js`),用于制作 Hacknet 风格的
解谜游戏。内网站点本身用 **AetherJS** 编写(见下),创作样例见
`js/game/sites/`(内置的《赛博档案》谜题链)。
对照阅读:浏览器应用(`js/apps/browser/`)与终端(`js/apps/terminal/`)。

## 一、虚拟网络系统

**浏览器是多标签的,地址按虚拟 DNS 自动分流,标签页随所在网络变色
(内网青色 / 外网琥珀色 / 起始页中性)**:

- 域名能被**虚拟 DNS** 解析(或私网 IP 字面量)→ 内网页面,
  即虚拟网络游戏世界;
- 解析失败 → 视为真实互联网域名,直达外网(iframe)。外网页面与
  虚拟网络完全隔离:读不到谜题状态,也不会触发 `vnet:http` 总线事件;
- 地址栏输入**搜索词**(带空格,或无点号又非 IP 的单词)→ 改道内网
  搜索引擎(Firefox 式,目标由 `setSearchHost()` 注册);
- 游戏作者可以通过**路径转换(proxy)** 把某个虚拟 URL 映射到
  真实互联网资源(例如一个在线 PDF),浏览器会以 iframe 加载 ——
  这是内网页面触达外网的唯一方式,且完全由作者数据决定。

### 内网站点 = AetherJS 站点应用(AetherWebFramework)

站点不再是 HTML 字符串,而是 `js/game/sites/<名>/` 目录:

```
js/game/sites/library/
  router.ajs    路由表(纯数据:domain / path / condition / script / template)
  login.ajs     处理函数((args, progress) => { template: 索引, data: 数据 })
  login.html    模板(白名单文法:{{插值}} {{#if}} {{#each}},值全走类型化槽)
  ok.html       同一路由的第二个模板(处理函数按状态选索引)
```

源码经 [AetherWebFramework](../vendor/AetherWebFramework)(沙盒语言 +
伪 SSR 模板 + Django 风格路由)编译分发:处理函数跑在白名单语言里,
模板只能产出白名单标签/属性,页面在浏览器侧注入前还过一道 DOMParser
复检。站点在首次被访问时惰性挂载(`js/core/aethersite.js` 桥接层)。

**注册一个新站点**:建目录 + 在 `js/game/site-defs.js` 补一条:

```js
// js/game/site-defs.js
search: { host: 'search.nexus', ip: '10.0.0.8', title: 'Aether 内网搜索', files: {} },
```

`files` 由 `js/game/sites.js` 经 Vite `?raw` 自动注入;`proxies` 见下。

**路由表(router.ajs 返回纯数据数组)**:

```js
return [
  { domain: "blackout.nexus", path: "/", condition: "library_ok === true", template: "home.html" },
  { domain: "blackout.nexus", path: "/archive.pdf", condition: "library_ok === true",
    script: "archive", template: ["proxy.html"] },
  { domain: "blackout.nexus", path: "*", script: "deny", template: ["deny.html"] },   // 兜底须最后
];
```

- `condition` 是 AetherJS 严格表达式,裸标识符读**游戏标志位快照**
  (`progress`):`library_ok === true`;不成立则向下继续匹配(叠层路由);
- `path` 支持 `/<number:页码>/` 参数与末段 `*` 前缀通配;参数与查询串
  都进 `args`;
- 沙盒内没有表单元素(白名单刻意不含 input/button)——交互用**链接**:
  例:《图书馆》登录页是键盘,每个数字键是一条把口令累积进查询串的
  链接(`/?user=reader&pass=52…`),全部状态由 URL 携带。

**处理函数的 data 指令**(webos 宿主约定,模板读不到这几个键):

```js
return (args, progress) => ({
  template: 0,
  data: {
    title: "登录成功 — 数字图书馆",  // 标签页标题(缺省站点标题)
    flag: "library_ok",              // 渲染成功后置位的标志位(flags: 数组亦可)
    redirect: "/",                   // 站内重定向(相对当前 URL,仅内网目标放行)
    httpStatus: 403,                 // 让浏览器渲染原生 403 错误页
    proxy: "archive",                // 「路径转换」键(见下),返回真实资源
  },
});
```

**「路径转换」(proxy)**:真实外网地址在 `site-defs.js` 的 `proxies`
表里声明(`archive: 'https://…/dummy.pdf'`),处理函数只能引用键 ——
沙盒代码选不了任意外网地址,与 DNS 一样是宿主把关口子。

**登录态模式(推荐)**:登录状态**只写在玩家进度里**(标志位),
站点用 condition 分层路由判定已登录/未登录 —— 凭据只在验证那一次
请求里出现,成功后 `flag` 置位并 `redirect` 回干净地址,URL 不再携带
凭据(地址栏 / 历史 / 收藏都干净):

```js
// router.ajs:同路径叠层,已登录给会员视图,未登录落到登录页
return [
  { domain: "library.nexus", path: "/", condition: "library_ok === true", template: "ok.html" },
  { domain: "library.nexus", path: "/", script: "login", template: ["login.html", "ok.html"] },
];
// login.ajs 的成功分支:置位 + 重定向(模板渲染结果会被丢弃,
// 但契约要求所选模板能正常渲染 —— 选静态模板即可)
if (pass === PASS) {
  return { template: 1, data: { flag: "library_ok", redirect: "/" } };
}
```

**跨站点链接(/goto/ 中转)**:模板白名单只允许相对链接(不允许
scheme 与 `//` 开头),跨主机跳转写成
`<a href="/goto/?u=portal.nexus%2Fabout">`(u = 百分编码的 host/path)。
宿主校验目标必须能被虚拟 DNS 解析,否则 403。

**页面样式隔离**:模板只能带 class,样式由浏览器单方面供给
(`browser.css` 里 `.vw-page` 作用域下的 `vp-*` 类:`vp-hero`、
`vp-card`、`vp-keypad`、`vp-results` …)。内网页面不依赖也不污染
系统全局样式(`.card` 等),跨浏览器(含 Firefox)表现一致。

### 作者 API(在 `js/game/` 中注册)

```js
import { addDNS, addServer, setFlag, getFlag, setSearchHost } from '../core/vnet.js';
import siteDefs from './sites.js';

// 1) DNS 记录(listed: 出现在浏览器"内网导航"页)
addDNS({ host: 'portal.nexus', ip: '10.0.0.10', note: '集团门户', listed: true });

// 2) AetherJS 站点(目录 + site-defs.js 登记;见上)
siteDefs.forEach((s) => vnet.registerAetherSite(s.host, s));

// 3) 地址栏搜索引擎(可选)
setSearchHost('search.nexus');

// 4) SSH 服务器:口令 + 虚拟文件系统 + 自定义命令(谜题机关)
//    两种文件系统声明:
//      · server.fs —— 全机共享树(多用户同一棵树,配权限机关)
//      · users.<名>.fs —— 每用户私有树(旧式,单机单用户够用)
addServer('vault.nexus', {
  ip: '10.0.0.23',
  banner: 'NEXUS Research Node 3.1 (vault)',
  os: { hostname: 'vault-node', kernel: '5.15.0-nexus', uptime: '114 天' },   // 可选:uname/hostname/uptime 文案
  users: { researcher: {
    password: 'h3ll0w', home: '/home/researcher',
    fs: { home: { researcher: { 'notes.txt': '线索文本' } } },
    commands: { status: () => { setFlag('ssh_done'); return ['维护锁已释放']; } },
  } },
});

// 4b) 共享树 + 权限机关样例(内置实训靶机 lab.nexus 即此写法):
addServer('lab.nexus', {
  ip: '10.0.0.30',
  fs: {                                    // 全机一棵树,所有用户共见
    etc: {
      'passwd': 'root:x:0:0:…',
      'shadow': { $: 'root:$6$…', mode: 'rw-------', owner: 'root' },   // 带属性文件:仅 root 可读
    },
    home: { admin: { mode: 'rwx------', owner: 'admin' } },             // 目录也能带属性
    tmp: {},                                                              // rwxr-xr-x:人人可写
  },
  users: {
    guest: { password: 'guest' },
    root:  { password: '…', home: '/root' },
  },
});

// 5) 游戏标志位(持久化,通过 vnet:flag-changed 事件驱动剧情)
setFlag('quest_done');
```

> 旧式 `addSite()`(HTML 字符串路由)仍可用,仅建议存量兼容;
> 新站点一律走 AetherJS 目录。

### 模拟远程终端(SSH 会话引擎)

SSH 会话由 `core/vssh.js` 驱动,Hacknet 式玩法核心能力:

- **常用命令**:内建 `ls(-l/-a) cat cd pwd echo(支持 > >> 重定向) mkdir rm
  mv cp touch head tail grep wc find tree whoami id hostname uname date
  uptime ps df history clear help`,以及传输 `get <远端> [本地名]` /
  `put <本机> [远端名]` 和内网侦察 `scan`(列 DNS 可公开主机)。
  作者 `commands` 定义的命令**优先于**内建命令;
- **登录认证**:口令验证 3 次失败断开;同一 主机/用户 的口令定义在
  `users.<名>.password`;`root` 用户绕过全部权限检查;
- **权限机关**:节点带属主与 9 位模式(如 `rw-------`)。读文件/列目录
  查 r 位,写/建/删查父目录 w 位;默认文件 `rw-r--r--`、目录 `rwxr-xr-x`,
  root 不受限 —— 可以做「只有 root 能读的密件」「guest 写不进的系统目录」;
- **多会话**:同一 主机+用户 的远端文件树全局唯一 —— 开两个终端窗口
  同时连入,一端写另一端立刻可见;`get` 下载到本机 `~/downloads/`;
- **跳板嵌套**:远程会话里再输 `ssh <用户>@<主机>` 即从当前主机跳板
  深入(提示符随链路切换,`exit` 逐层退回),经典 Hacknet 代理链玩法;
- **scp**:本机终端 `scp <本地> <用户>@<主机>:<远端>`(方向对调即下载),
  口令验证一次、传输完即断,不进交互会话;
- **持久化**:远端写操作(写/删/建目录)记录为覆盖层,随游戏进度落在
  `webos.vnet.v1` 的 `sshFs` 字段,跨页面重载保留;`WebOS.vnet.resetState()`
  一并清空(靶机重置);
- 自定义命令拿到完整 session,除 `cwd/user/host` 外还有
  `readFile / writeFile / listDir / resolveP` 文件辅助 API 可用。

### 运行时行为

- 浏览器页面的 `<a>`/`<form>` 会被自动拦截转为虚拟导航(模板只有
  链接;起始页等宿主页可用表单);
- 终端 `curl` 走同一条 HTTP 管线(`vnet.httpGetAsync`),AetherJS
  站点对终端同样可见;
- SSH 会话内建常用命令与传输(见「模拟远程终端」一节),自定义命令优先;
- 所有虚拟网络活动通过总线广播(`vnet:http` / `vnet:ssh` /
  `vnet:flag-changed`),在系统监视器的 IPC 页面可以实时观测玩家的探索轨迹;
- `WebOS.vnet.resetState()` 可清空游戏进度(标志位 + 运行时 DNS +
  远端文件系统改动)。

### 示例游戏《赛博档案》

内置一条完整可玩的谜题链(`js/game/sites/` + `js/game/index.js`,
同时也是创作样例):

1. 浏览器内网导航 → `portal.nexus` 公告:图书馆账号 reader,口令=馆藏总数;
2. 门户「关于本馆」页显示馆藏 52,831 册 → 口令 `52831`;
3. `library.nexus` 键盘式登录页:按出口令(或地址栏直接访问
   `/?user=reader&pass=52831`)→ 置位 `library_ok` 并重定向回干净地址,
   会员视图泄露 SSH 凭据 `researcher/h3ll0w @ 10.0.0.23`(此后重访
   由进度判定,直接给会员视图);
4. 终端 `ssh researcher@vault.nexus` → `cat notes.txt` 得到隐藏站线索,
   `status` 命令解锁(触发标志位);
5. `blackout.nexus` 的《赛博档案 Vol.3》PDF 通过路径转换代理自真实互联网,
   集齐两把「钥匙」后触发通关通知;
6. `search.nexus` 全程可搜内网已收录页面(地址栏输入关键词即达)。

测试:`node tools/aether-sites-smoke.mjs`(Node 侧全站点断言)+
`tools/e2e.mjs` 的 T18 组(浏览器全链路,含键盘口令试错、403 门禁、
/goto/ 中转、下载联动、外网域名隔离验证)。

## 二、邮件系统(`core/mail.js`)

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

## 三、短信系统(`core/sms.js`)

会话按联系人归并,最近活跃在前;验证码消息(4-8 位)自动渲染「复制验证码」
按钮。API 与邮件同构:

```js
import sms from '../core/sms.js';
sms.deliver({ from: 'nexus-guard', fromName: '安全中心', text: '验证码 823741,5 分钟内有效' });
sms.deliverLater({ from: 'x', text: '…' }, 2000);
sms.onSend(({ to, text }) => to === 'nexus-hint' ? { text: '自动回信…' } : null);
```

系统联动:任务应用到期/逾期时自动向「任务提醒」会话发短信;
`hint@nexus` 的短信版服务台 `nexus-hint` 同样支持自动回信。
