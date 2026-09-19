# AetherWebOS 剧情 / 游戏作者指南

AetherWebOS 内置一套完整的虚拟网络(`js/core/vnet.js`),配合邮件
(`js/core/mail.js`)与短信(`js/core/sms.js`),用于制作 Hacknet 风格的
解谜游戏。创作样例见 `js/game/index.js`(内置的《赛博档案》谜题链)。
对照阅读:浏览器应用(`js/apps/browser/`)与终端(`js/apps/terminal/`)。

## 一、虚拟网络系统

**浏览器与终端只能访问虚拟网络**:

- 输入的域名必须能被**虚拟 DNS** 解析,否则报「无法解析主机」
  (访问真实互联网域名会被拒绝,这是刻意的隔离);
- 游戏作者可以通过**路径转换(proxy)** 把某个虚拟 URL 映射到
  真实互联网资源(例如一个在线 PDF),浏览器会以 iframe 加载 ——
  这是用户触达外网的唯一通道,且完全由作者数据决定。

### 作者 API(在 `js/game/` 中注册)

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

### 运行时行为

- 浏览器页面的 `<a>`/`<form>` 会被自动拦截转为虚拟导航;
- SSH 会话内置 `ls cat cd pwd whoami echo get(下载到本机文件管家) exit`
  命令,自定义命令优先;
- 所有虚拟网络活动通过总线广播(`vnet:http` / `vnet:ssh` /
  `vnet:flag-changed`),在系统监视器的 IPC 页面可以实时观测玩家的探索轨迹;
- `WebOS.vnet.resetState()` 可清空游戏进度。

### 示例游戏《赛博档案》

内置一条完整可玩的谜题链(`js/game/index.js`,同时也是创作样例):

1. 浏览器内网导航 → `portal.nexus` 公告:图书馆账号 reader,口令=馆藏总数;
2. 门户「关于本馆」页显示馆藏 52,831 册 → 口令 `52831`;
3. `library.nexus` 登录成功 → 泄露 SSH 凭据 `researcher/h3ll0w @ 10.0.0.23`;
4. 终端 `ssh researcher@vault.nexus` → `cat notes.txt` 得到隐藏站线索,
   `status` 命令解锁(触发标志位);
5. `blackout.nexus` 的《赛博档案 Vol.3》PDF 通过路径转换代理自真实互联网,
   集齐两把「钥匙」后触发通关通知。

测试:`tools/e2e.mjs` 的 T18 组覆盖上述全链路(含口令试错、403 门禁、
下载联动、外网域名隔离验证)。

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
