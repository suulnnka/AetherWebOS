/* ============================================================
 * 应用:浏览器(虚拟网络专用)
 *
 * 只能访问虚拟网络(vnet)中注册的站点:
 *  - 输入的域名必须能被虚拟 DNS 解析,否则显示 DNS 错误页;
 *  - 游戏作者可以把某个路径「代理」到真实互联网地址(如 PDF),
 *    这是唯一触达外网的方式,且完全由作者数据决定;
 *  - 页面内的 <a> 链接与 <form> 表单都被拦截,转为虚拟导航。
 * ============================================================ */
import { el, escapeHtml } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import { httpGet, dnsList } from '../../core/vnet.js';

/** 内网导航起始页(由 DNS 中 listed 的记录生成) */
function startPage() {
  const hosts = dnsList();
  return `<div class="vw-hero">
      <h1>NEXUS 内网导航</h1>
      <p>NEXUS-ISP 虚拟网络 · 仅限内部访问</p>
    </div>
    <div class="card" style="margin-top:18px">
      <div class="card-title">${'<span></span>'}已知站点</div>
      ${hosts.length ? hosts.map(h => `
        <div class="vw-link-row">
          <a href="http://${h.host}/" class="vw-link">${h.host}</a>
          <span class="vw-ip mono">${h.ip}</span>
          <span class="dim">${escapeHtml(h.note)}</span>
        </div>`).join('') : '<p class="dim">虚拟网络中没有已登记的站点。</p>'}
    </div>
    <p class="dim" style="margin-top:16px;font-size:12px">
      提示:浏览器与终端只能访问虚拟网络;未解析的主机将被拒绝。
    </p>`;
}

const ERRORS = {
  dns: (h) => ({ title: '无法解析主机', body: `虚拟 DNS 中没有 «${escapeHtml(h)}» 的记录。这个主机可能不存在,或在现实互联网上 —— 本浏览器无法访问外网。` }),
  refused: (h, ip) => ({ title: '连接被拒绝', body: `${escapeHtml(h)} (${ip}) 没有运行 Web 服务。` }),
  404: (r) => ({ title: '404 Not Found', body: `${escapeHtml(r.host)} 上不存在路径 <span class="mono">${escapeHtml(r.path)}</span>。` }),
  403: (r) => ({ title: '403 Forbidden', body: `拒绝访问 <span class="mono">${escapeHtml(r.path)}</span> —— 你可能还没有获得授权(线索?)。` }),
  badurl: () => ({ title: '无效的地址', body: '仅支持 http:// 与 https:// 虚拟地址。' }),
};

register({
  id: 'browser',
  neon: { a: '#00f0ff', b: '#3d7bff' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '浏览器',
  icon: 'globe',
  color: 'linear-gradient(135deg,#06b6d4,#0284c7)',
  width: 900, height: 620,
  min: { w: 520, h: 360 },
  singleton: true,
  order: 0,
  mount({ root, setTitle, bus, params }) {
    let history = ['about:start'];
    let hIdx = 0;
    let loadSeq = 0;

    const addr = el('input', { class: 'input vw-addr', placeholder: '输入内网地址,如 portal.nexus', spellcheck: 'false' });
    const statusL = el('span', {}, '就绪');
    const statusR = el('span', { class: 'dim mono' }, '');
    const back = el('button', { class: 'btn icon', title: '后退', onClick: () => go(-1) }, icon('chevronL', 15));
    const fwd = el('button', { class: 'btn icon', title: '前进', onClick: () => go(1) }, icon('chevronR', 15));
    const reload = el('button', { class: 'btn icon', title: '刷新', onClick: () => navigate(history[hIdx], { push: false }) }, icon('refresh', 14));
    const home = el('button', { class: 'btn icon', title: '内网导航', onClick: () => navigate('about:start') }, icon('home', 14));

    const page = el('div', { class: 'vw-page' });
    const frame = el('iframe', { class: 'vw-iframe', hidden: '' });
    const content = el('div', { class: 'app-body vw-body' }, page, frame);
    const bar = el('div', { class: 'loading-bar', hidden: '' }, el('i'));

    function go(delta) {
      const ni = hIdx + delta;
      if (ni < 0 || ni >= history.length) return;
      hIdx = ni;
      navigate(history[hIdx], { push: false });
    }

    function paintChrome() {
      back.disabled = hIdx <= 0;
      fwd.disabled = hIdx >= history.length - 1;
      addr.value = history[hIdx] === 'about:start' ? '' : history[hIdx].replace(/^https?:\/\//, '');
    }

    function renderError(kind, r) {
      frame.hidden = true;
      page.hidden = false;
      const e = (ERRORS[kind] || ERRORS.badurl)(r?.host, r?.ip, r);
      page.innerHTML = `<div class="vw-error">
        <h2>${e.title}</h2><p>${e.body}</p></div>`;
      setTitle(`${e.title} — 浏览器`);
    }

    /** 拦截虚拟页面里的链接与表单(相对路径基于当前页解析) */
    function wirePage() {
      const base = () => (history[hIdx] && !history[hIdx].startsWith('about:')) ? history[hIdx] : null;
      page.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', (ev) => { ev.preventDefault(); navigate(a.getAttribute('href'), { base: base() }); });
      });
      page.querySelectorAll('form').forEach(f => {
        f.addEventListener('submit', (ev) => {
          ev.preventDefault();
          const q = [...new FormData(f)]
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
          const action = f.getAttribute('action') || (base() ? base().split('?')[0] : '/');
          navigate(action + (q ? '?' + q : ''), { base: base() });
        });
      });
    }

    /**
     * 导航。base 供页面内相对链接使用;
     * 来自地址栏(无 base)时,裸文本视为主机名。
     */
    function navigate(input, { push = true, base } = {}) {
      const seq = ++loadSeq;
      frame.hidden = true;
      frame.src = 'about:blank';
      bar.hidden = false;
      let url = String(input).trim();
      if (!/^([a-z][a-z0-9+.-]*:|about:)/i.test(url)) {
        if (base) { try { url = new URL(url, base).href; } catch { /* 保持原样 */ } }
        else url = 'http://' + url;
      }
      if (push) { history = history.slice(0, hIdx + 1); history.push(url); hIdx = history.length - 1; }
      paintChrome();

      // 起始页
      if (url === 'about:start') {
        setTimeout(() => {
          if (seq !== loadSeq) return;
          bar.hidden = true;
          page.hidden = false;
          page.innerHTML = startPage();
          wirePage();
          statusL.textContent = '内网导航';
          statusR.textContent = '';
          setTitle('浏览器');
        }, 120);
        return;
      }

      // 模拟加载阶段(DNS → 连接 → 响应)
      statusL.textContent = '正在解析 DNS…';
      let r;
      try { r = httpGet(url); } catch { r = { status: 'badurl' }; }

      const step = (ms, fn) => setTimeout(() => { if (seq === loadSeq) fn(); }, ms);
      step(220, () => {
        if (r.status === 'redirect') return navigate(r.location, { push: false });
        if (r.status === 'dns') { bar.hidden = true; statusL.textContent = 'DNS 解析失败'; return renderError('dns', r); }
        statusL.textContent = `正在连接 ${r.ip}…`;
        step(240, () => {
          if (r.status === 'refused') { bar.hidden = true; statusL.textContent = '连接被拒绝'; return renderError('refused', r); }
          statusL.textContent = '等待响应…';
          step(260, () => {
            bar.hidden = true;
            if (r.status === '404') { statusL.textContent = '404'; return renderError('404', r); }
            if (r.status === '403') { statusL.textContent = '403'; return renderError('403', r); }
            if (r.status !== 'ok') { statusL.textContent = '错误'; return renderError('badurl', r); }
            statusL.textContent = '完成';
            statusR.textContent = `${r.ip} · ${r.ms}ms`;
            setTitle(`${r.title} — 浏览器`);
            if (r.type === 'proxy') {
              // 路径转换:虚拟 URL → 作者指定的真实互联网资源
              page.hidden = true;
              frame.hidden = false;
              frame.src = r.proxyUrl;
              bus.notify('代理资源已加载', `${r.url} → ${r.proxyUrl}`);
            } else {
              page.hidden = false;
              page.innerHTML = r.body || '<p class="dim">(空白页)</p>';
              wirePage();
            }
          });
        });
      });
    }

    addr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = addr.value.trim();
      if (!v) return;
      navigate(v.startsWith('about:') ? v : v);
    });

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        back, fwd, reload, home,
        addr,
        el('span', { class: 'badge-pill vw-badge' }, '虚拟网络')),
      el('div', { style: { position: 'relative' } }, bar),
      content,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }), statusR)));

    navigate(params.url || 'about:start', { push: !params.url });

    // 外部导航:其他应用(邮件附件/正文链接等)请求打开虚拟地址
    bus.on('params', (p) => { if (p?.url) navigate(p.url); });
    bus.on('navigate', (p) => { if (p?.url) navigate(p.url); });
    setTimeout(() => addr.focus(), 60);
  },
});
