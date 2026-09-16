/* ============================================================
 * 示例游戏:《赛博档案》(演示谜题链)
 * ------------------------------------------------------------
 * 谜题流程:
 *  1. 浏览器打开 portal.nexus(内网导航可见)→ 公告提到
 *     图书馆临时账号 reader,口令 = 馆藏总数(去「关于我们」找)
 *  2. portal.nexus/about 显示馆藏 52,831 册 → 口令 52831
 *  3. library.nexus 登录表单提交 reader/52831 → 显示研究服务器
 *     凭据 researcher / h3ll0w @ 10.0.0.23(置 library_ok)
 *  4. 终端 ssh researcher@10.0.0.23 → cat notes.txt 提到运行
 *     status 命令解锁维护通道(置 ssh_done)
 *  5. blackout.nexus 首页需 library_ok;《赛博档案 Vol.3》PDF
 *     通过「路径转换」代理自真实互联网;两者齐备 → 通关
 *
 * 本文件同时是「游戏作者指南」的活样例:DNS / 站点 / SSH /
 * 路径转换 / 标志位 全部在此注册。
 * ============================================================ */

import { addDNS, addSite, addServer, setFlag, getFlag } from '../core/vnet.js';
import { subscribe, publish } from '../core/bus.js';
import mail from '../core/mail.js';
import sms from '../core/sms.js';

/* ================= DNS 记录 ================= */
addDNS({ host: 'portal.nexus', ip: '10.0.0.10', note: 'NEXUS 集团内网门户', listed: true, latency: 6 });
addDNS({ host: 'library.nexus', ip: '10.0.0.11', note: 'NEXUS 数字图书馆', listed: true, latency: 9 });
addDNS({ host: 'router.nexus', ip: '10.0.0.1', note: '网关(仅响应 ping)', listed: true, latency: 1 });
addDNS({ host: 'vault.nexus', ip: '10.0.0.23', note: '研究服务器(未公开)', latency: 14 });
addDNS({ host: 'blackout.nexus', ip: '10.0.0.66', note: '???', latency: 21 });

/* ================= 站点:portal.nexus ================= */
addSite('portal.nexus', {
  ip: '10.0.0.10',
  title: 'NEXUS 内网门户',
  routes: {
    '/': () => `
      <div class="vw-hero"><h1>NEXUS 集团内网门户</h1><p>员工专用 · 请勿外传</p></div>
      <div class="card"><div class="card-title">公告</div>
        <p><b>【临时通知】图书馆系统维护</b></p>
        <p>数字图书馆(library.nexus)已切换为只读模式。临时查询账号:<b>reader</b>。</p>
        <p>出于安全要求,口令为 <b>馆藏总量数字</b>。馆藏数据见
          <a href="/about">关于本馆</a> 页面。</p>
        <p class="dim">—— 信息管理部</p>
      </div>
      <div class="card"><div class="card-title">快捷入口</div>
        <p><a href="http://library.nexus/">数字图书馆</a></p>
      </div>`,
    '/about': () => `
      <div class="vw-hero"><h1>关于 NEXUS 数字图书馆</h1></div>
      <div class="card"><div class="card-title">馆藏规模</div>
        <p>截至目前,本馆共收藏数字化文献 <b style="font-size:20px">52,831</b> 册,
        其中孤本 217 册。</p>
        <p class="dim">统计口径:含期刊合订本。</p>
      </div>
      <p><a href="/">← 返回门户</a></p>`,
    // 「路径转换」示例:虚拟 URL → 真实互联网 PDF(邮件附件同用此地址)
    '/manual.pdf': () => ({
      proxy: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
      title: 'NEXUS 内网使用手册 v3.1',
    }),
  },
});

/* ================= 站点:library.nexus(口令谜题) ================= */
addSite('library.nexus', {
  ip: '10.0.0.11',
  title: 'NEXUS 数字图书馆',
  routes: {
    '/': ({ query }) => {
      // 提交了表单:验证口令
      if (query.user != null) {
        if (query.user === 'reader' && query.pass === '52831') {
          setFlag('library_ok');
          return `
            <div class="vw-hero ok"><h1>登录成功</h1><p>欢迎,读者 reader</p></div>
            <div class="card"><div class="card-title">🔒 馆际互借备忘(内部)</div>
              <p>研究服务器 <b>vault.nexus(10.0.0.23)</b> 维护通道:</p>
              <p class="mono">账号 researcher<br>口令 h3ll0w</p>
              <p class="dim">仅限研究部使用,严禁张贴。</p>
            </div>
            <p class="dim">提示:在终端使用 ssh researcher@10.0.0.23 登录。</p>`;
        }
        return `
          <div class="vw-hero err"><h1>口令错误</h1><p>账号或口令不正确,请重试。</p></div>
          ${loginForm(query.user)}`;
      }
      return `
        <div class="vw-hero"><h1>NEXUS 数字图书馆</h1><p>只读维护模式</p></div>
        ${loginForm('')}`;
    },
  },
});

const loginForm = (user) => `
  <div class="card"><div class="card-title">读者登录</div>
    <form action="/" method="get" class="vw-form">
      <label>账号<input name="user" value="${String(user).replace(/"/g, '&quot;')}" required></label>
      <label>口令<input name="pass" type="password" required placeholder="见门户公告"></label>
      <button class="btn primary" type="submit">登录</button>
    </form>
  </div>`;

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

/* ================= 站点:blackout.nexus(隐藏站 + 路径转换) ================= */
addSite('blackout.nexus', {
  ip: '10.0.0.66',
  title: 'Blackout 档案馆',
  routes: {
    '/': ({ flag }) => {
      if (!flag('library_ok')) return { status: 403 };
      return `
        <div class="vw-hero dark"><h1>BLACKOUT 档案馆</h1><p>匿名镜像 · 每周轮换</p></div>
        <div class="card"><div class="card-title">本周档案</div>
          <p>📄 <a href="/archive.pdf">《赛博档案 Vol.3》</a>
             <span class="dim">(外部代理资源,浏览器直接打开)</span></p>
          <p class="dim">* 镜像只对持有图书馆凭据的访客开放。</p>
        </div>`;
    },
    // 「路径转换」:虚拟 URL → 真实互联网 PDF(游戏作者配置的唯一外网通道)
    '/archive.pdf': ({ flag }) => {
      if (!flag('library_ok')) return { status: 403 };
      if (flag('ssh_done')) setFlag('quest_done');
      return {
        proxy: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
        title: '赛博档案 Vol.3',
      };
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
// 首次进入:播种三封初始邮件(带过去时间戳)
if (mail.stats().total === 0) {
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
}

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
