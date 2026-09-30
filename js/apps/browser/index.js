/* ============================================================
 * 应用:浏览器(多标签 · 内/外网按虚拟 DNS 自动分流)
 *
 * 标签栏与地址栏的操作逻辑对齐 Firefox:
 *  - 标签栏:滚轮切换标签(标签溢出时改为滚动标签栏)、拖拽排序、
 *    中键关闭、右键菜单(新建 / 重载 / 复制 / 关闭)、「列出所有
 *    标签页」下拉、加载中的标签显示转圈;关闭最后一个标签页即
 *    关闭窗口;
 *  - 地址栏:点击 / 聚焦全选(Firefox urlbar 行为)、Esc 还原当前
 *    地址、Ctrl+L 聚焦;
 *  - 快捷键:Ctrl+T 新建、Ctrl+W 关闭、Ctrl+Tab / Ctrl+PgUp/PgDn
 *    切换、Ctrl+1..9 定位、Alt+←/→ 与 Backspace 前进后退
 *    (宿主浏览器保留的组合键无法拦截,属正常);
 *  - 刷新按钮在加载中变为「停止」。
 *  - 收藏(Firefox 式书签):地址栏旁星标一键收藏当前页,已收藏时
 *    星标菜单改名 / 删除;收藏夹面板逐条管理;起始页出现收藏卡片;
 *    Ctrl+D 收藏。数据按用户落 ~/appdata/browser.awdb。
 *
 * 分流:域名能被虚拟 DNS 解析(或私网 IP)→ 内网(vnet 游戏世界,
 * 含作者的 proxy 路径转换);否则直达真实互联网(iframe,跨源页面
 * 读不到标题 / 拦截跳转,部分站点拒绝被嵌入,可用「在系统外打开」)。
 * ============================================================ */
import { el, escapeHtml, clamp } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './browser.css';
import { httpGetAsync, dnsList, dnsResolve, getSearchHost } from '../../core/vnet.js';
import { copyText, showMenuAnchored } from '../../core/menu.js';
import { accounts } from '../../core/accounts.js';
import { loadState, saveState } from '../../core/appdata.js';

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** 私网 / 回环地址 → 属于虚拟内网;公网 IP → 外网 */
const isPrivateIP = (h) =>
  /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
  /^127\./.test(h) || /^0\./.test(h);

/** 主机是否属于内网:虚拟 DNS 可解析,或私网 IP 字面量 */
function hostIsIntranet(host) {
  const h = String(host || '').toLowerCase();
  if (IP_RE.test(h)) return isPrivateIP(h);
  return !!dnsResolve(h);
}

/**
 * 地址分流:'start'(起始页)| 'in'(内网)| 'out'(外网)| 'badurl'
 * 规则:虚拟 DNS 能解析的主机 / 私网 IP → 内网;其余 → 外网。
 */
function routeNet(url) {
  if (url === 'about:start') return 'start';
  let u;
  try { u = new URL(url); } catch { return 'badurl'; }
  if (!/^https?:$/.test(u.protocol)) return 'badurl';
  return hostIsIntranet(u.hostname) ? 'in' : 'out';
}

/**
 * 地址栏裸输入是否该当搜索词(Firefox 式):带空格,或首段无点又非
 * IP(内网主机名都是 xxx.nexus 形态)且非 about: → 交给内网搜索引擎。
 */
function looksLikeQuery(text) {
  const t = String(text).trim();
  if (!t || /\s/.test(t)) return !!t;
  const first = t.split(/[/?#]/)[0].split(':')[0];
  return !first.includes('.') && !IP_RE.test(first);
}

/** 起始页:内网站点(虚拟 DNS listed 记录)+ 外网常用站点(均允许嵌入) */
const WEB_LINKS = [
  { url: 'https://example.com', name: 'Example.com', note: '演示站点(总是允许嵌入)' },
  { url: 'https://www.w3.org', name: 'W3C', note: '万维网联盟' },
  { url: 'https://www.openstreetmap.org', name: 'OpenStreetMap', note: '开源世界地图' },
  { url: 'https://archive.org', name: 'Internet Archive', note: '互联网档案馆' },
];
function startPage(marks = []) {
  const hosts = dnsList();
  const sh = getSearchHost();
  return `<div class="vp-hero">
      <h1>NEXUS 导航</h1>
      <p>虚拟内网与真实外网 · 地址按虚拟 DNS 自动分流</p>
    </div>
    ${sh ? `<form class="vw-start-search" action="http://${sh}/search/" method="get">
      <input class="input" name="q" placeholder="搜索内网…(地址栏输入关键词亦可)" spellcheck="false">
      <button class="btn primary" type="submit">搜索</button>
    </form>` : ''}
    ${marks.length ? `<div class="vp-card" style="margin-top:18px">
      <div class="vp-card-title">收藏</div>
      ${marks.map(m => `
        <div class="vp-row">
          <a href="${escapeHtml(m.url)}" class="vw-link">${escapeHtml(m.name)}</a>
          <span class="vp-mono vp-dim">${escapeHtml(m.url.replace(/^https?:\/\//, ''))}</span>
        </div>`).join('')}
    </div>` : ''}
    <div class="vp-card" style="margin-top:18px">
      <div class="vp-card-title">内网站点(虚拟 DNS)</div>
      ${hosts.length ? hosts.map(h => `
        <div class="vp-row">
          <a href="http://${h.host}/" class="vw-link">${h.host}</a>
          <span class="vp-mono">${h.ip}</span>
          <span class="vp-dim">${escapeHtml(h.note)}</span>
        </div>`).join('') : '<p class="vp-dim">虚拟网络中没有已登记的站点。</p>'}
    </div>
    <div class="vp-card" style="margin-top:16px">
      <div class="vp-card-title">外网常用站点</div>
      ${WEB_LINKS.map(l => `
        <div class="vp-row">
          <a href="${l.url}" class="vw-link">${l.name}</a>
          <span class="vp-mono vp-dim">${escapeHtml(l.url.replace(/^https?:\/\//, ''))}</span>
          <span class="vp-dim">${escapeHtml(l.note)}</span>
        </div>`).join('')}
    </div>
    <p class="vp-dim" style="margin-top:16px;font-size:12px">
      提示:域名能被虚拟 DNS 解析即入内网,其余直达真实互联网;地址栏输入
      关键词(带空格或无点号)会改道内网搜索。部分真实站点会拒绝被嵌入
      (X-Frame-Options),页面空白或报错时,可用工具栏 ↗ 在系统外打开。
    </p>`;
}

const ERRORS = {
  dns: (h) => ({
    title: '无法解析主机',
    body: `虚拟 DNS 中没有 «${escapeHtml(h)}» 的记录。`,
  }),
  refused: (h, ip) => ({ title: '连接被拒绝', body: `${escapeHtml(h)} (${ip}) 没有运行 Web 服务。` }),
  404: (r) => ({ title: '404 Not Found', body: `${escapeHtml(r.host)} 上不存在路径 <span class="mono">${escapeHtml(r.path)}</span>。` }),
  403: (r) => ({ title: '403 Forbidden', body: `拒绝访问 <span class="mono">${escapeHtml(r.path)}</span> —— 你可能还没有获得授权(线索?)。` }),
  badurl: () => ({ title: '无效的地址', body: '仅支持 http:// 与 https:// 地址。' }),
};

/** 键盘事件目标是否正在文字输入(Backspace 后退不适用) */
const isTypingTarget = (t) =>
  !t || !t.closest ? false : !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/* ---- 收藏(书签):{ seq, marks:[{ id, url, name, created }] } ----
 * 按用户存加密库 ~/appdata/browser.awdb;未登录仅会话内存态(同 memo/todo)。
 * 模块级状态:浏览器为单例应用,所有窗口共享。 */
let bm = { seq: 1, marks: [] };
let bmDirty = false;   // 加载完成前用户已改动 → 丢弃盘上旧档,以内存为准

function bmNormalize(raw) {
  if (!raw || !Array.isArray(raw.marks)) return null;
  let seq = +raw.seq || 1;
  const marks = raw.marks
    .filter(m => m && typeof m.url === 'string' && /^(https?:|about:)/.test(m.url))
    .map(m => ({ id: m.id || `b${seq++}`, url: m.url, name: String(m.name || m.url), created: m.created || Date.now() }));
  return { seq, marks };
}

async function bmLoad() {
  const user = accounts.current();
  if (!user) return;
  try {
    const s = bmNormalize(await loadState('browser', user));
    if (s && !bmDirty) bm = s;
  } catch (e) { console.warn('[browser] 收藏加载失败', e); }
}

let bmT;
function bmPersist() {
  bmDirty = true;
  clearTimeout(bmT);
  bmT = setTimeout(async () => {
    const user = accounts.current();
    if (!user) return;   // 未登录:不落盘
    try { await saveState('browser', bm, user); }
    catch (e) { console.warn('[browser] 收藏保存失败', e); }
  }, 200);
}

register({
  ...manifest,
  mount({ root, close: closeWin, setTitle, bus, params, onContextMenu, dialogs }) {
    /** 标签页:{ history, hIdx, title, seq, net('in'|'out'|null), loading, page, frame, root, sl, sr }
     *  net 由当前地址经 routeNet 派生,仅用于着色与状态展示。 */
    const tabs = [];
    let active = -1;
    let tabSeq = 0;

    const addr = el('input', { class: 'input vw-addr', placeholder: '输入地址:内网如 portal.nexus,外网如 example.com', spellcheck: 'false' });
    const statusL = el('span', {}, '就绪');
    const statusR = el('span', { class: 'dim mono' }, '');
    const back = el('button', { class: 'btn icon', title: '后退', onClick: () => go(-1) }, icon('chevronL', 15));
    const fwd = el('button', { class: 'btn icon', title: '前进', onClick: () => go(1) }, icon('chevronR', 15));
    const reload = el('button', { class: 'btn icon', title: '刷新', onClick: () => {
      const tb = tabs[active];
      if (!tb) return;
      if (tb.loading) stopLoad(tb);
      else nav(tb, tb.history[tb.hIdx], { push: false });
    } });
    const home = el('button', { class: 'btn icon', title: '起始页', onClick: () => nav(tabs[active], 'about:start') }, icon('home', 14));
    const openExt = el('button', { class: 'btn icon', title: '在系统外打开(新浏览器窗口)', onClick: () => {
      const tb = tabs[active];
      const u = tb?.history[tb.hIdx] || '';
      if (routeNet(u) === 'out') window.open(u, '_blank', 'noopener');
    } }, icon('external', 14));
    paintReloadIcon(false);

    /* ---- 收藏(Firefox 式书签):星标 + 收藏夹面板 ---- */

    /** 当前标签的可收藏地址(起始页 / 错误页不算) */
    const curUrl = (tb) => {
      const u = tb?.history[tb?.hIdx];
      return u && u !== 'about:start' && /^https?:/.test(u) ? u : '';
    };
    const markOf = (url) => bm.marks.find(m => m.url === url);

    /** 星标随当前页点亮;起始页置灰(Firefox 空白页星标不可用) */
    function paintStar() {
      const u = curUrl(tabs[active]);
      const on = !!u && !!markOf(u);
      star.classList.toggle('on', on);
      star.disabled = !u;
      star.title = on ? '编辑收藏 (Ctrl+D)' : '收藏此页 (Ctrl+D)';
      bmBtn.title = `收藏夹(${bm.marks.length})`;
    }

    /** 起始页收藏卡片与收藏夹面板随增删实时刷新 */
    function refreshStart(tb) {
      if (!tb || tb.history[tb.hIdx] !== 'about:start' || tb.page.hidden) return;
      tb.page.innerHTML = startPage(bm.marks);
      wirePage(tb);
    }

    function addMark(tb, url) {
      let fallback = url;
      try { fallback = new URL(url).hostname.replace(/^www\./, ''); } catch { /* 保持原样 */ }
      const name = (tb?.title || fallback || url).trim();
      bm.marks.push({ id: `b${bm.seq++}`, url, name, created: Date.now() });
      bmPersist();
      if (tb) setStatus(tb, `已收藏「${name}」`);
      paintStar();
      refreshStart(tb);
      if (bmPop) renderBmPop();
    }

    function removeMark(url) {
      bm.marks = bm.marks.filter(m => m.url !== url);
      bmPersist();
      const tb = tabs[active];
      if (tb && curUrl(tb) === url) setStatus(tb, '已移除收藏');
      paintStar();
      refreshStart(tb);
      if (bmPop) renderBmPop();
    }

    async function renameMark(m) {
      const name = await dialogs.prompt({ title: '编辑收藏', message: '收藏名称', value: m.name });
      if (name == null) return;   // 取消 / 关闭
      m.name = name.trim() || m.name;
      bmPersist();
      const tb = tabs[active];
      if (tb && curUrl(tb) === m.url) refreshStart(tb);
      if (bmPop) renderBmPop();
    }

    /** 星标点击:未收藏 → 一键收藏;已收藏 → 编辑菜单(Firefox) */
    function onStarClick() {
      const tb = tabs[active];
      const u = curUrl(tb);
      if (!u) return;
      const m = markOf(u);
      if (!m) return addMark(tb, u);
      showMenuAnchored(star, [
        { label: '编辑名称…', icon: 'pencil', fn: () => renameMark(m) },
        { label: '删除收藏', icon: 'trash', danger: true, fn: () => removeMark(u) },
      ]);
    }
    const star = el('button', { class: 'btn icon vw-star', title: '收藏此页 (Ctrl+D)', onClick: onStarClick }, icon('star', 15));

    /* 收藏夹下拉面板(document.body 挂载,固定定位,点外部 / Esc / 导航关闭) */
    let bmPop = null;
    const closeBmPop = () => {
      if (!bmPop) return;
      bmPop.remove();
      bmPop = null;
      document.removeEventListener('pointerdown', bmPopOutside, true);
      document.removeEventListener('keydown', bmPopEsc, true);
    };
    function bmPopOutside(e) {
      if (bmPop && !bmPop.contains(e.target) && !bmBtn.contains(e.target)) closeBmPop();
    }
    function bmPopEsc(e) { if (e.key === 'Escape') closeBmPop(); }

    function renderBmPop() {
      if (!bmPop) return;
      bmPop.innerHTML = '';
      bmPop.append(el('div', { class: 'vw-bm-head' }, '收藏',
        el('span', { class: 'dim' }, ` ${bm.marks.length}`)));
      if (!bm.marks.length) {
        const u = curUrl(tabs[active]);
        bmPop.append(el('div', { class: 'vw-bm-empty' }, '暂无收藏:点击地址栏旁的 ★(或 Ctrl+D)收藏当前页'),
          u && !markOf(u)
            ? el('button', { class: 'btn vw-bm-add', onClick: () => addMark(tabs[active], u) }, '收藏当前页')
            : null);
        return;
      }
      const list = el('div', { class: 'vw-bm-list' });
      bm.marks.forEach(m => {
        const net = routeNet(m.url) === 'out' ? 'net-out' : 'net-in';
        list.append(el('div', {
          class: 'vw-bm-row',
          title: m.url,
          onClick: () => { if (tabs[active]) nav(tabs[active], m.url, { push: true }); closeBmPop(); },
        },
          el('span', { class: `vw-tab-dot ${net}` }),
          el('span', { class: 'vw-bm-main' },
            el('span', { class: 'vw-bm-name' }, m.name),
            el('span', { class: 'vw-bm-url mono' }, m.url.replace(/^https?:\/\//, ''))),
          el('button', { class: 'vw-bm-act', title: '编辑名称', onClick: (e) => { e.stopPropagation(); renameMark(m); } }, icon('pencil', 12)),
          el('button', { class: 'vw-bm-act', title: '移除收藏', onClick: (e) => { e.stopPropagation(); removeMark(m.url); } }, icon('close', 12))));
      });
      bmPop.append(list);
    }

    function toggleBmPop() {
      if (bmPop) return closeBmPop();
      bmPop = el('div', { class: 'vw-bm-pop' });
      renderBmPop();
      document.body.append(bmPop);
      // 右缘对齐按钮;下方放不下翻到上方,整体钳入视口
      const r = bmBtn.getBoundingClientRect();
      const left = clamp(r.right - bmPop.offsetWidth, 8, innerWidth - bmPop.offsetWidth - 8);
      let top = r.bottom + 6;
      if (top + bmPop.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - bmPop.offsetHeight - 6);
      bmPop.style.left = left + 'px';
      bmPop.style.top = top + 'px';
      document.addEventListener('pointerdown', bmPopOutside, true);
      document.addEventListener('keydown', bmPopEsc, true);
    }
    const bmBtn = el('button', { class: 'btn icon vw-bm-btn', title: '收藏夹', onClick: toggleBmPop }, icon('bookmark', 14));
    paintStar();

    /* ---- 标签栏:滚动区(标签)+ 固定的 + 与「列出所有标签页」 ---- */
    const scroller = el('div', { class: 'vw-tabs-scroll' });
    const plus = el('button', { class: 'vw-tab-plus', title: '新建标签页 (Ctrl+T)', onClick: () => makeTab() }, icon('plus', 13));
    const listBtn = el('button', { class: 'vw-tab-plus vw-tabs-list', title: '列出所有标签页', onClick: () => {
      showMenuAnchored(listBtn, tabs.map((tb, i) => ({
        label: `${tb.net === 'out' ? '外网 · ' : tb.net === 'in' ? '内网 · ' : ''}${tb.title || '新标签页'}`,
        icon: tb.net === 'out' ? 'external' : 'globe',
        fn: () => activateTab(i),
      })));
    } }, icon('grid', 12));
    const tabstrip = el('div', { class: 'vw-tabs' }, scroller, plus, listBtn);

    // 应用内右键:标签栏(标签管理)/ 页面地址栏(刷新 / 复制 / 转外网打开)
    onContextMenu(({ target }) => {
      const tabEl = target.closest('.vw-tab');
      if (tabEl) {
        const i = +tabEl.dataset.idx;
        const tb = tabs[i];
        // 静音仅对内网页面可控(跨源 iframe 无法编程静音,浏览器安全模型限制)
        const muteItem = tb && tb.net !== 'out'
          ? [{ label: tb.muted ? '取消静音标签页' : '静音标签页', icon: tb.muted ? 'volume' : 'volumeX', fn: () => toggleMute(i) }] : [];
        return [
          { label: '新建标签页', icon: 'plus', fn: () => makeTab() },
          { label: '重新载入标签页', icon: 'refresh', fn: () => { if (tb) nav(tb, tb.history[tb.hIdx], { push: false }); } },
          { label: '复制标签页', icon: 'copy', fn: () => { if (tb) makeTab(tb.history[tb.hIdx]); } },
          ...muteItem,
          { label: '关闭其他标签页', icon: 'trash', fn: () => closeOthers(i) },
          { label: '关闭标签页', icon: 'close', fn: () => closeTab(i) },
        ];
      }
      if (!target.closest('.vw-page, .vw-addr, .app-toolbar')) return null;
      const tb = tabs[active];
      const outItem = tb && routeNet(tb.history[tb.hIdx] || '') === 'out'
        ? [{ label: '在系统外打开', icon: 'external', fn: () => openExt.click() }] : [];
      const cur = tb ? curUrl(tb) : '';
      const bmItem = cur
        ? [markOf(cur)
          ? { label: '移除收藏', icon: 'star', fn: () => removeMark(cur) }
          : { label: '收藏此页', icon: 'star', fn: () => addMark(tb, cur) }]
        : [];
      return [
        { label: '刷新', icon: 'refresh', fn: () => reload.click() },
        ...(target.closest('.vw-addr') ? [{ label: '复制页面地址', icon: 'copy', fn: () => copyText(addr.value) }] : []),
        ...outItem,
        ...bmItem,
      ];
    });

    const content = el('div', { class: 'app-body vw-body' });

    /** 共享 UI(地址栏/状态栏/标题)只在标签页处于前台时更新 */
    function live(tb, fn) { if (tb === tabs[active]) fn(); }
    function setStatus(tb, l, r) {
      if (l != null) { tb.sl = l; live(tb, () => { statusL.textContent = l; }); }
      if (r !== undefined) { tb.sr = r; live(tb, () => { statusR.textContent = r; }); }
    }
    function setTabTitle(tb, title) {
      tb.title = title || '';
      renderTabs();
      live(tb, () => setTitle(tb.title ? `${tb.title} — 浏览器` : '浏览器'));
    }
    /** 加载状态:标签转圈 + 「刷新↔停止」按钮(Firefox 无顶部进度条) */
    function setLoading(tb, on) {
      tb.loading = on;
      if (!(tabDrag && tabDrag.moved)) renderTabs();
      live(tb, () => paintReloadIcon(on));
    }
    function paintReloadIcon(loading) {
      reload.title = loading ? '停止' : '刷新';
      reload.innerHTML = '';
      reload.append(icon(loading ? 'close' : 'refresh', 14));
    }

    function go(delta) {
      const tb = tabs[active];
      const ni = tb.hIdx + delta;
      if (ni < 0 || ni >= tb.history.length) return;
      tb.hIdx = ni;
      nav(tb, tb.history[tb.hIdx], { push: false });
    }

    /** 中止加载:取消未完成的虚拟加载阶段;外网页面退回空白并回到前一页 */
    function stopLoad(tb) {
      tb.seq++;
      setLoading(tb, false);
      if (tb.net === 'out') {
        tb.frame.src = 'about:blank';
        if (tb.hIdx > 0) { tb.hIdx--; paintChrome(); nav(tb, tb.history[tb.hIdx], { push: false }); }
        else setStatus(tb, '已取消');
      } else {
        setStatus(tb, '已取消');
      }
    }

    function paintChrome() {
      const tb = tabs[active];
      if (!tb) return;
      back.disabled = tb.hIdx <= 0;
      fwd.disabled = tb.hIdx >= tb.history.length - 1;
      const cur = tb.history[tb.hIdx];
      addr.value = !cur || cur === 'about:start' ? '' : cur.replace(/^https?:\/\//, '');
      openExt.disabled = routeNet(cur || '') !== 'out';
      paintStar();
    }

    /* ---- 标签页生命周期 ---- */

    function makeTab(url) {
      const t = {
        id: ++tabSeq, net: null, loading: false, muted: false,
        history: [url || 'about:start'], hIdx: 0,
        title: '', seq: 0, sl: '就绪', sr: '',
        page: el('div', { class: 'vw-page' }),
        // 外网/代理 iframe:禁止自动出声;sandbox 只剥夺「顶层导航权」
        // (阻止 target=_top 链接把整个 webos 页面劫持走,页面被迫留在标签内),
        // 其余能力(脚本/表单/弹窗/下载/对话框)全部保留,站点功能不受影响。
        // 注:跨源页面内的链接点击无法被网页 JS 感知或拦截(浏览器安全模型),
        // _self 链接在页内跳转、_blank 会在真实浏览器开新标签——均不可改道。
        frame: el('iframe', {
          class: 'vw-iframe', hidden: '',
          allow: "autoplay 'none'",
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
        }),
      };
      t.root = el('div', { class: 'vw-tabroot' }, t.page, t.frame);
      tabs.push(t);
      activateTab(tabs.length - 1);
      nav(t, t.history[0], { push: false });
      if (!url) setTimeout(() => { addr.focus(); addr.select(); }, 0);   // Firefox:新标签页聚焦地址栏
      return t;
    }

    /* ---- 标签静音(Firefox 式;仅内网页面的 audio/video 可控,跨源 iframe 无解) ---- */
    function applyMute(tb) {
      tb.page.querySelectorAll('audio, video').forEach(m => { m.muted = tb.muted; });
    }
    function toggleMute(i) {
      const tb = tabs[i];
      if (!tb) return;
      tb.muted = !tb.muted;
      applyMute(tb);
      renderTabs();
    }

    function activateTab(i) {
      if (i < 0 || i >= tabs.length || i === active) return;
      const prev = tabs[active];
      if (prev) { prev.root.remove(); setLoading(prev, false); }
      active = i;
      const tb = tabs[active];
      content.append(tb.root);
      renderTabs();
      paintChrome();
      statusL.textContent = tb.sl;
      statusR.textContent = tb.sr;
      setTitle(tb.title ? `${tb.title} — 浏览器` : '浏览器');
    }

    function closeTab(i) {
      const tb = tabs[i];
      if (!tb) return;
      if (tabs.length === 1) { closeWin(); return; }   // Firefox:关闭最后一个标签页即关闭窗口
      const wasActive = i === active;
      tb.root.remove();
      tabs.splice(i, 1);
      if (wasActive) { active = -1; activateTab(Math.min(i, tabs.length - 1)); }
      else {
        if (i < active) active--;
        renderTabs();
      }
    }

    function closeOthers(i) {
      const keep = tabs[i];
      if (!keep || tabs.length === 1) return;
      tabs.forEach(tb => { if (tb !== keep) tb.root.remove(); });
      tabs.length = 0;
      tabs.push(keep);
      active = -1;
      activateTab(0);
    }

    function renderTabs() {
      scroller.innerHTML = '';
      tabs.forEach((tb, i) => {
        const netCls = tb.net === 'out' ? 'net-out' : tb.net === 'in' ? 'net-in' : '';
        scroller.append(el('div', {
          class: `vw-tab ${netCls}${i === active ? ' active' : ''}${tb.loading ? ' loading' : ''}`,
          dataset: { idx: i },
          title: `${tb.net === 'out' ? '外网' : tb.net === 'in' ? '内网' : '起始页'} · ${tb.title || '新标签页'}`,
          onClick: () => { if (!suppressTabClick) activateTab(i); },
          onAuxclick: (e) => { if (e.button === 1) closeTab(i); },   // Firefox:中键关闭
          onPointerdown: (e) => startTabDrag(e, i),
        },
          el('span', { class: 'vw-tab-dot' }),
          el('span', { class: 'vw-tab-title' }, tb.title || '新标签页'),
          tb.muted ? el('span', { class: 'vw-tab-mute', title: '已静音' }, icon('volumeX', 10)) : null,
          el('button', {
            class: 'vw-tab-x', title: '关闭标签页',
            onClick: (e) => { e.stopPropagation(); closeTab(i); },
          }, icon('close', 10))));
      });
    }

    /* ---- 标签拖拽排序(Firefox:按住左键左右拖动) ---- */
    let tabDrag = null;
    let suppressTabClick = false;

    function startTabDrag(e, i) {
      if (e.button !== 0 || e.target.closest('.vw-tab-x')) return;
      tabDrag = { i, node: e.currentTarget, startX: e.clientX, pid: e.pointerId, w: e.currentTarget.offsetWidth, moved: false };
    }
    const onTabPointerMove = (e) => {
      if (!tabDrag || e.pointerId !== tabDrag.pid) return;
      const dx = e.clientX - tabDrag.startX;
      if (!tabDrag.moved) {
        if (Math.abs(dx) < 6) return;
        tabDrag.moved = true;
        tabDrag.node.classList.add('dragging');
        try { tabDrag.node.setPointerCapture(tabDrag.pid); } catch { /* 忽略 */ }
        tabDrag.rects = [...scroller.querySelectorAll('.vw-tab')].map((n, k) => ({ n, k, left: n.offsetLeft, w: n.offsetWidth }));
        tabDrag.self = tabDrag.rects.find(r => r.n === tabDrag.node);
      }
      // 拖拽限制在滚动区内;其余标签按经过的位置让位
      const lo = -tabDrag.self.left;
      const hi = scroller.clientWidth - tabDrag.self.left - tabDrag.self.w;
      const cx = clamp(dx, lo, hi);
      tabDrag.node.style.transform = `translateX(${cx}px)`;
      const center = tabDrag.self.left + cx + tabDrag.self.w / 2;
      tabDrag.rects.forEach(r => {
        if (r.n === tabDrag.node) return;
        const mid = r.left + r.w / 2;
        const after = r.k > tabDrag.self.k;
        const shift = after && center > mid ? -tabDrag.w : (!after && center < mid ? tabDrag.w : 0);
        r.n.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const endTabDrag = (e) => {
      if (!tabDrag || e.pointerId !== tabDrag.pid) return;
      const d = tabDrag;
      tabDrag = null;
      d.node.classList.remove('dragging');
      d.node.style.transform = '';
      if (!d.moved) return;
      (d.rects || []).forEach(r => { r.n.style.transform = ''; });
      suppressTabClick = true;
      setTimeout(() => { suppressTabClick = false; }, 0);
      // 落点 = 中心位于其左侧的标签数
      const lo = -d.self.left;
      const hi = scroller.clientWidth - d.self.left - d.self.w;
      const center = d.self.left + clamp(e.clientX - d.startX, lo, hi) + d.w / 2;
      const to = d.rects.filter(r => r.n !== d.node && r.left + r.w / 2 < center).length;
      const cur = tabs[active];
      const tb = tabs.splice(d.i, 1)[0];
      tabs.splice(clamp(to, 0, tabs.length), 0, tb);
      active = Math.max(0, tabs.indexOf(cur));
      renderTabs();
    };
    window.addEventListener('pointermove', onTabPointerMove);
    window.addEventListener('pointerup', endTabDrag);
    window.addEventListener('pointercancel', endTabDrag);

    // Firefox:滚轮在标签栏上切换标签;标签溢出时滚动标签栏
    scroller.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (scroller.scrollWidth > scroller.clientWidth + 4) {
        scroller.scrollLeft += e.deltaY || e.deltaX;
        return;
      }
      activateTab(clamp(active + (e.deltaY > 0 ? 1 : -1), 0, tabs.length - 1));
    }, { passive: false });

    /* ---- 渲染 ---- */

    function renderError(tb, kind, r) {
      tb.frame.hidden = true;
      tb.frame.src = 'about:blank';
      tb.page.hidden = false;
      const e = (ERRORS[kind] || ERRORS.badurl)(r?.host, r?.ip, r);
      tb.page.innerHTML = `<div class="vw-error">
        <h2>${e.title}</h2><p>${e.body}</p></div>`;
      setTabTitle(tb, e.title);
    }

    /** 拦截页面里的链接与表单(相对路径基于当前页解析) */
    function wirePage(tb) {
      const base = () => {
        const cur = tb.history[tb.hIdx];
        return cur && !cur.startsWith('about:') ? cur : null;
      };
      tb.page.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', (ev) => { ev.preventDefault(); nav(tb, a.getAttribute('href'), { base: base() }); });
      });
      tb.page.querySelectorAll('form').forEach(f => {
        f.addEventListener('submit', (ev) => {
          ev.preventDefault();
          const q = [...new FormData(f)]
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
          const action = f.getAttribute('action') || (base() ? base().split('?')[0] : '/');
          nav(tb, action + (q ? '?' + q : ''), { base: base() });
        });
      });
    }

    /* ---- 导航 ---- */

    /**
     * 导航到指定标签页(自动分流)。base 供页面内相对链接使用;
     * 来自地址栏(无 base)的裸文本:搜索词 → 内网搜索引擎;
     * 其余按 DNS 判定补协议:内网 http / 外网 https。
     */
    function nav(tb, input, { push = true, base } = {}) {
      const seq = ++tb.seq;
      closeBmPop();   // 导航即关收藏夹面板(面板行点击已在回调关闭,此处兜底)
      let url = String(input).trim();
      if (!/^([a-z][a-z0-9+.-]*:|about:)/i.test(url)) {
        if (base) { try { url = new URL(url, base).href; } catch { /* 保持原样 */ } }
        else {
          const sh = getSearchHost();
          if (sh && looksLikeQuery(url) && dnsResolve(sh)) {
            url = `http://${sh}/search/?q=${encodeURIComponent(url)}`;
          } else {
            const hostLike = url.split(/[/?#]/)[0].split(':')[0];
            url = (hostIsIntranet(hostLike) ? 'http://' : 'https://') + url;
          }
        }
      }
      if (push) { tb.history = tb.history.slice(0, tb.hIdx + 1); tb.history.push(url); tb.hIdx = tb.history.length - 1; }

      const kind = routeNet(url);
      tb.net = kind === 'in' || kind === 'out' ? kind : null;
      renderTabs();
      live(tb, paintChrome);
      setLoading(tb, true);

      if (kind === 'start') return navStart(tb, seq);
      if (kind === 'badurl') { setLoading(tb, false); return renderError(tb, 'badurl', {}); }
      if (kind === 'out') return navOut(tb, url, seq);
      navIn(tb, url, seq);
    }

    function navStart(tb, seq) {
      tb.frame.hidden = true;
      tb.frame.src = 'about:blank';
      setTimeout(() => {
        if (seq !== tb.seq) return;
        setLoading(tb, false);
        tb.page.hidden = false;
        tb.page.innerHTML = startPage(bm.marks);
        wirePage(tb);
        applyMute(tb);
        setStatus(tb, '导航页', '');
        setTabTitle(tb, '起始页');
      }, 120);
    }

    async function navIn(tb, url, seq) {
      tb.frame.hidden = true;
      tb.frame.src = 'about:blank';

      // 模拟加载阶段(DNS → 连接 → 响应);AetherJS 站点经沙盒编译分发,
      // 首访含挂载编译,响应阶段天然异步
      setStatus(tb, '正在解析 DNS…');
      let r;
      try { r = await httpGetAsync(url); } catch { r = { status: 'badurl' }; }

      const step = (ms, fn) => setTimeout(() => { if (seq === tb.seq) fn(); }, ms);
      step(220, () => {
        if (r.status === 'redirect') return nav(tb, r.location, { push: false });
        if (r.status === 'dns') { setLoading(tb, false); setStatus(tb, 'DNS 解析失败'); return renderError(tb, 'dns', r); }
        setStatus(tb, `正在连接 ${r.ip}…`);
        step(240, () => {
          if (r.status === 'refused') { setLoading(tb, false); setStatus(tb, '连接被拒绝'); return renderError(tb, 'refused', r); }
          setStatus(tb, '等待响应…');
          step(260, () => {
            setLoading(tb, false);
            if (r.status === '404') { setStatus(tb, '404'); return renderError(tb, '404', r); }
            if (r.status === '403') { setStatus(tb, '403'); return renderError(tb, '403', r); }
            if (r.status !== 'ok') { setStatus(tb, '错误'); return renderError(tb, 'badurl', r); }
            setStatus(tb, '完成', `${r.ip} · ${r.ms}ms`);
            setTabTitle(tb, r.title);
            if (r.type === 'proxy') {
              // 路径转换:虚拟 URL → 作者指定的真实互联网资源
              tb.page.hidden = true;
              tb.frame.hidden = false;
              tb.frame.src = r.proxyUrl;
              bus.notify('代理资源已加载', `${r.url} → ${r.proxyUrl}`);
            } else {
              tb.page.hidden = false;
              tb.page.innerHTML = r.body || '<p class="dim">(空白页)</p>';
              wirePage(tb);
              applyMute(tb);
            }
          });
        });
      });
    }

    /** 外网页面右上角的非阻塞提示:部分站点拒绝被嵌入(X-Frame-Options)会显示空白 */
    function showEmbedHint(tb) {
      tb.hint?.remove();
      const u = tb.history[tb.hIdx] || '';
      tb.hint = el('div', { class: 'vw-embed-hint' },
        el('span', {}, '页面空白?该站点可能拒绝被嵌入'),
        el('button', {
          class: 'btn', onClick: () => {
            if (/^https?:/.test(u)) window.open(u, '_blank', 'noopener');
            tb.hint?.remove();
          },
        }, '在系统外打开 ↗'),
        el('button', {
          class: 'btn icon', title: '关闭提示',
          onClick: () => tb.hint?.remove(),
        }, icon('close', 12)));
      tb.root.append(tb.hint);
      setTimeout(() => {
        if (!tb.hint) return;
        tb.hint.classList.add('fade');
        setTimeout(() => tb.hint?.remove(), 400);
      }, 8000);
    }

    function navOut(tb, url, seq) {
      tb.page.hidden = true;
      tb.hint?.remove();

      let u;
      try { u = new URL(url); } catch { return renderError(tb, 'badurl', {}); }

      setTabTitle(tb, u.hostname);
      setStatus(tb, `正在连接 ${u.hostname}…`, '外网');
      tb.frame.hidden = false;
      tb.frame.src = u.href;
      // 跨源 iframe 读不到内容、URL 与错误;load 事件是我们唯一的信号。
      // 首次 load 结束加载态,后续 load = 页面内跳转(地址栏无法同步)。
      let settled = false;
      if (tb.onFrameLoad) tb.frame.removeEventListener('load', tb.onFrameLoad);
      tb.onFrameLoad = () => {
        if (seq !== tb.seq) return;
        if (!settled) {
          settled = true;
          setLoading(tb, false);
          setStatus(tb, '完成(外网)', `${u.hostname} · 外网`);
          showEmbedHint(tb);
        } else {
          setStatus(tb, '页内已跳转(地址栏未同步)');
        }
      };
      tb.frame.addEventListener('load', tb.onFrameLoad);
      setTimeout(() => {
        if (settled || seq !== tb.seq) return;
        settled = true;
        setLoading(tb, false);
        setStatus(tb, '仍在加载或无法嵌入', `${u.hostname} · 外网`);
        showEmbedHint(tb);
      }, 6000);
    }

    /* ---- 地址栏(Firefox urlbar 行为) ---- */

    // 点击 / 聚焦即全选(Firefox;双击 / 三击仍按默认选词 / 选段)。
    // 程序化 focus() 会在事件后再放一次光标,须延迟一拍再选。
    addr.addEventListener('focus', () => { setTimeout(() => addr.select(), 0); });
    addr.addEventListener('click', (e) => { if (e.detail < 2) addr.select(); });
    addr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = addr.value.trim();
        if (!v) return;
        nav(tabs[active], v);
        addr.blur();
      } else if (e.key === 'Escape') {
        // Esc:有未提交的修改 → 还原为当前地址;无修改 → 失焦
        const tb = tabs[active];
        const cur = tb ? tb.history[tb.hIdx] : '';
        const want = !cur || cur === 'about:start' ? '' : cur.replace(/^https?:\/\//, '');
        if (addr.value !== want) { addr.value = want; addr.select(); }
        else addr.blur();
      }
    });

    /* ---- 快捷键(document 级,仅在窗口聚焦时生效;宿主保留键除外) ---- */
    const winEl = root.closest('.win');
    const onKey = (e) => {
      if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (!winEl || !winEl.classList.contains('focused')) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (k === 't' || k === 'T')) { e.preventDefault(); return makeTab(); }
      if (ctrl && (k === 'w' || k === 'W')) { e.preventDefault(); return closeTab(active); }
      if (ctrl && k === 'Tab') { e.preventDefault(); return cycleTab(e.shiftKey ? -1 : 1); }
      if (ctrl && (k === 'PageDown' || k === 'PageUp')) { e.preventDefault(); return cycleTab(k === 'PageDown' ? 1 : -1); }
      if (ctrl && /^[1-9]$/.test(k)) {
        e.preventDefault();
        return activateTab(Math.min(k === '9' ? tabs.length - 1 : +k - 1, tabs.length - 1));
      }
      if ((ctrl && (k === 'l' || k === 'L')) || k === 'F6' || (e.altKey && (k === 'd' || k === 'D'))) {
        e.preventDefault(); addr.focus(); addr.select(); return;
      }
      if (ctrl && (k === 'd' || k === 'D')) { e.preventDefault(); return onStarClick(); }
      if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); return go(-1); }
      if (e.altKey && k === 'ArrowRight') { e.preventDefault(); return go(1); }
      if (k === 'Backspace' && !isTypingTarget(e.target)) { e.preventDefault(); return go(-1); }
    };
    function cycleTab(d) { activateTab((active + d + tabs.length) % tabs.length); }   // Ctrl+Tab 循环
    document.addEventListener('keydown', onKey);

    root.append(el('div', { class: 'app' },
      tabstrip,
      el('div', { class: 'app-toolbar vw-toolbar' },
        back, fwd, reload, home,
        addr,
        star, bmBtn, openExt),
      content,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }), statusR)));

    // 收藏水合:完成后再刷一次星标与起始页卡片(此前渲染用空列表)
    bmLoad().then(() => {
      const tb = tabs[active];
      if (!tb) return;
      paintStar();
      refreshStart(tb);
    });

    makeTab(params?.url);

    // 外部导航:其他应用(邮件附件/正文链接等)请求打开地址,同样自动分流
    const navTo = (url) => { if (tabs[active]) nav(tabs[active], url); };
    bus.on('params', (p) => { if (p?.url) navTo(p.url); });
    bus.on('navigate', (p) => { if (p?.url) navTo(p.url); });
    setTimeout(() => addr.focus(), 60);

    // 窗口关闭时清理 document 级监听
    return {
      onClose() {
        closeBmPop();
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('pointermove', onTabPointerMove);
        window.removeEventListener('pointerup', endTabDrag);
        window.removeEventListener('pointercancel', endTabDrag);
      },
    };
  },
});
