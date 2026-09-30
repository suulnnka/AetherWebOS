/* ============================================================
 * 示例游戏:《赛博档案》(演示谜题链)
 * ------------------------------------------------------------
 * 谜题流程:
 *  1. 浏览器打开 portal.nexus(内网导航可见)→ 公告提到
 *     图书馆临时账号 reader,口令 = 馆藏总数(去「关于我们」找)
 *  2. portal.nexus/about 显示馆藏 52,831 册 → 口令 52831
 *  3. library.nexus 键盘式登录页提交 reader/52831 → 显示研究服务器
 *     凭据 researcher / h3ll0w @ 10.0.0.23(置 library_ok)
 *  4. 终端 ssh researcher@10.0.0.23 → cat notes.txt 提到运行
 *     status 命令解锁维护通道(置 ssh_done)
 *  5. blackout.nexus 首页需 library_ok;《赛博档案 Vol.3》PDF
 *     通过「路径转换」代理自真实互联网;两者齐备 → 通关
 *
 * 内网站点本身是 AetherJS 站点应用(sites/ 目录:路由表 + 处理函数
 * + 模板),经 AetherWebFramework 沙盒编译分发(见 core/aethersite.js);
 * 本文件只登记 DNS / SSH / 邮件短信剧情与标志位联动 —— 它仍是
 * 「游戏作者指南」的活样例。
 * ============================================================ */

import { addDNS, addServer, registerAetherSite, setSearchHost, setFlag, getFlag } from '../core/vnet.js';
import { subscribe, publish } from '../core/bus.js';
import mail from '../core/mail.js';
import sms from '../core/sms.js';
import siteDefs from './sites.js';

/* ================= DNS 记录 ================= */
addDNS({ host: 'portal.nexus', ip: '10.0.0.10', note: 'NEXUS 集团内网门户', listed: true, latency: 6 });
addDNS({ host: 'library.nexus', ip: '10.0.0.11', note: 'NEXUS 数字图书馆', listed: true, latency: 9 });
addDNS({ host: 'search.nexus', ip: '10.0.0.8', note: 'Aether 内网搜索引擎', listed: true, latency: 5 });
addDNS({ host: 'router.nexus', ip: '10.0.0.1', note: '网关(仅响应 ping)', listed: true, latency: 1 });
addDNS({ host: 'vault.nexus', ip: '10.0.0.23', note: '研究服务器(未公开)', latency: 14 });
addDNS({ host: 'blackout.nexus', ip: '10.0.0.66', note: '???', latency: 21 });

/* ================= AetherJS 站点(sites/ 目录) ================= */
// 「路径转换」目标(真实外网地址)在 sites.js 的 proxies 表声明,
// 沙盒内的处理函数只能引用键。
siteDefs.forEach((s) => registerAetherSite(s.host, s));
setSearchHost('search.nexus');   // 地址栏输入非 URL 文本 → 改道内网搜索(Firefox 式)

/* ================= SSH 服务器:vault.nexus ================= */
addServer('vault.nexus', {
  ip: '10.0.0.23',
  banner: 'NEXUS Research Node 3.1 (vault) — authorized users only',
  users: {
    researcher: {
      password: 'h3ll0w',
      home: '/home/researcher',
      motd: '上次登录:3 天前,自 10.0.0.2\n当前负载正常。输入 help 查看命令。',
      fs: {
        home: {
          researcher: {
            'notes.txt': `研究备忘 - #4471

1. 维护通道需要先跑一次 status 自检(它会顺带解锁维护锁)。
2. 黑市档案馆换了新址:blackout.nexus —— 里面的《赛博档案 Vol.3》
   据说是从我们这里流出去的扫描件。手快有,手慢无。
3. 别把口令写在这种文件里。(好像已经晚了)`,
            'todo.txt': 'TODO:\n- [x] 迁移数据库\n- [ ] 删除 notes.txt ← 这条一直没做\n- [ ] 下班',
            '.secret': { 'hint.txt': '口令规则:hello 变体,把 o 换成数字 0,再在末尾加 w。\n等等,这文件不是应该加密吗?' },
          },
        },
      },
      commands: {
        // 自定义命令:谜题机关(运行即解锁 ssh_done)
        status: (args, session) => {
          setFlag('ssh_done');
          publish('vnet:ssh', { from: 'vault', type: 'unlock', payload: { by: session.user } });
          return [
            'UPTIME : 114 days, 5:22',
            'LOAD   : 0.42 0.38 0.35',
            'DISK   : /archive 78% used',
            '',
            '维护锁已释放(maintenance lock released)',
          ];
        },
      },
    },
  },
});

/* ================= 游戏事件:通关通知 ================= */
subscribe('vnet:flag-changed', ({ key }) => {
  if (key === 'quest_done') {
    publish('sys:notify', {
      from: 'game', type: 'notify',
      payload: { title: '🏆 谜题完成:《赛博档案》', body: '你集齐了图书馆凭据与维护密钥,成功取得档案!' },
    });
    // 奖励邮件:附件经「路径转换」直通真实 PDF
    mail.deliverLater({
      from: 'archivist@blackout.nexus',
      fromName: 'Blackout 档案馆',
      subject: '副本已归档 —— 《赛博档案 Vol.3》',
      body: `你的探索被记录在案。附件是承诺的副本(外部代理资源,点击后在浏览器中打开)。<br><br>另外:给 <b>hint@nexus</b> 写信可以随时获取提示。`,
      attachments: [{ name: '赛博档案 Vol.3.pdf', kind: 'proxy', url: 'http://blackout.nexus/archive.pdf' }],
    }, 2500);
  }
  if (key === 'library_ok') {
    mail.deliverLater({
      from: 'library@nexus',
      fromName: 'NEXUS 数字图书馆',
      subject: '登录成功通知',
      body: '临时账号 reader 于刚才成功登录。如非本人操作,请立即联系信息管理部。<br><br>馆藏查询入口:<a href="http://library.nexus/">library.nexus</a>',
    }, 1200);
  }
});

/* ================= 邮件:种子信件 + 提示自动回信 ================= */
mail.onFirstUse(() => {
  const H = 3600e3;
  mail.deliver({
    from: 'admin@nexus', fromName: 'NEXUS 系统管理员', subject: '欢迎接入 NEXUS 内网',
    body: `新同事你好,这是你的内网邮箱。<br><br>常用入口都在 <a href="http://portal.nexus/">内网门户</a> :
      数字图书馆、公告板与各部门通讯录。<br>遇到问题可以写信给 <b>hint@nexus</b>(内网服务台,自动回信)。`,
    date: Date.now() - 26 * H, read: true,
  });
  mail.deliver({
    from: 'library@nexus', fromName: 'NEXUS 数字图书馆', subject: '【重要】系统维护与临时口令',
    body: `图书馆系统进入只读维护模式。<br>临时查询账号:<b>reader</b>;口令为<b>馆藏总量数字</b>
      ——馆藏数据请见门户「关于本馆」页面,或 <a href="http://portal.nexus/about">直接打开</a>。<br><br>给你带来的不便敬请谅解。`,
    date: Date.now() - 20 * H,
  });
  mail.deliver({
    from: 'weekly@nexus', fromName: 'NEXUS 每周通讯', subject: '第 42 期 · 内网使用手册更新',
    body: '本期要点:内网使用手册已更新至 v3.1,见附件(外部代理资源)。',
    attachments: [{ name: '内网使用手册 v3.1.pdf', kind: 'proxy', url: 'http://portal.nexus/manual.pdf' }],
    date: Date.now() - 3 * H,
  });
});

// 服务台自动回信(玩家发信钩子)
mail.onSend((m) => {
  if (m.to !== 'hint@nexus') return null;
  if (/档案|blackout/i.test(m.subject + m.body)) {
    return { fromName: '服务台 · 自动回信', subject: 'Re: ' + m.subject,
      body: '关于「赛博档案」:先在图书馆确认凭据(reader 的口令就是馆藏数),再到研究服务器跑一次 status。' };
  }
  return { fromName: '服务台 · 自动回信', subject: 'Re: ' + m.subject,
    body: '已收到你的邮件。试试在主题或正文里提到「档案」,我们会给出针对性提示。' };
});


/* ================= 短信:种子会话 + 服务台短信钩子 ================= */
/* 种子要等水合完成后再判断:模块加载时短信还在从 appdata 异步装载,
 * 不等就投递会把种子重复写进当前会话用户的库,甚至覆盖已有会话。 */
sms.hydrate().then(() => {
  if (sms.stats().msgs === 0) {
    const H = 3600e3;
    sms.deliver({
      from: '10086', fromName: 'NEXUS 运营商',
      text: '欢迎接入 NEXUS 虚拟网络!本机号码 10-0000-0002。流量不限量,但仅限内网 :)',
      date: Date.now() - 26 * H,
    });
    sms.deliver({
      from: 'nexus-guard', fromName: '安全中心',
      text: '检测到新设备登录。验证码 823741,5 分钟内有效。若非本人操作请忽略。',
      date: Date.now() - 2 * H,
    });
  }
});

// 短信服务台:给 nexus-hint 发短信自动回信(玩家发信钩子)
sms.onSend(({ to, text }) => {
  if (to !== 'nexus-hint') return null;
  if (/档案|blackout/i.test(text)) {
    return { fromName: '服务台', text: '自动回信:图书馆凭据 reader 的口令=馆藏总数;研究服务器上记得先跑 status。' };
  }
  return { fromName: '服务台', text: '自动回信:已收到。提到「档案」可获得针对性提示。' };
});

/* 玩家提示(首次进入系统时提醒) */
setTimeout(() => {
  if (!getFlag('quest_done')) {
    publish('sys:notify', {
      from: 'game', type: 'notify',
      payload: { title: '新任务:消失的档案', body: '打开「浏览器」,从内网导航的 portal.nexus 开始调查。' },
    });
  }
}, 4000);
