/* ============ 应用:软件商店 —— 发现、安装与管理应用 ============
 *
 * 在售目录 = 清单标 store:true 的应用:未安装时不进开始菜单、
 * 不播种桌面快捷方式,安装(installApp)后才出现,卸载则一并移除。
 * 安装是**真实资源下载**(core/pkg.js + core/install.js):按 apps.json
 * 包清单把应用文件逐个下载到 /app/<id>/,进度条由真实字节驱动,
 * 卡片体积也是包清单里的真实大小。本应用只做展示与编排。 */
import { el } from '../../core/utils.js';
import { icon, appTile } from '../../core/icons.js';
import { register, list as listApps } from '../../core/registry.js';
import manifest from './manifest.js';
import './appstore.css';
import * as wm from '../../core/wm.js';
import { installApp, uninstallApp, isInstalled } from '../../core/install.js';
import { loadCatalog, fmtBytes } from '../../core/pkg.js';

/* 氛围用伪元数据:评分 / 安装量由 id 哈希推导,每次打开都一致;
 * 包大小不在此列 —— 那是真实数据(pkgSizes,来自 apps.json) */
const hash = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
};
function fakeMeta(id) {
  const h = hash(id);
  const rating = Math.min(5, 3.6 + ((h >>> 9) % 15) / 10);
  const dl = (1 + (h >>> 14) % 200) * 10;   // 1万 ~ 200万
  return {
    rating: rating.toFixed(1),
    dl: dl >= 1000 ? `${(dl / 1000).toFixed(1)} million+` : `${dl} thousand+`,
  };
}

const CATS = [
  ['游戏', 'star'],
  ['工具', 'sliders'],
  ['效率', 'check'],
  ['社交', 'message'],
  ['娱乐', 'music'],
  ['系统', 'settings'],
];

register({
  ...manifest,
  mount({ root, bus, dialogs, params }) {
    let view = 'store';   // store = 发现(在售) | mine = 我的应用(已安装)
    let cat = '';         // '' = 全部分类(仅发现视图使用)
    let q = '';
    let focusId = null;   // 渲染后要高亮的卡片(来自安装引导的 focus 参数)

    const storeCount = () => listApps().filter(a => a.store === true).length;
    const mineCount = () => listApps().filter(a => a.desktop !== false && isInstalled(a.id)).length;

    /* 应用包真实大小(apps.json 到手后填充;未到手显示占位符) */
    const pkgSizes = {};
    loadCatalog().then((catalog) => {
      for (const [id, p] of Object.entries(catalog.apps || {})) pkgSizes[id] = p.bytes;
      renderAll();
    }).catch((err) => console.warn('[appstore] 包清单不可用:', err));

    /** 当前视图的应用池:发现 = 在售(未安装排前);我的 = 已安装 */
    function pool() {
      let apps = listApps().filter(a => a.desktop !== false);
      apps = view === 'store'
        ? apps.filter(a => a.store === true)
        : apps.filter(a => isInstalled(a.id));
      if (cat) apps = apps.filter(a => (a.category || '系统') === cat);
      if (q) {
        const s = q.toLowerCase();
        apps = apps.filter(a =>
          `${a.name} ${a.desc || ''} ${a.category || ''}`.toLowerCase().includes(s));
      }
      if (view === 'store') {
        apps.sort((a, b) => (isInstalled(a.id) ? 1 : 0) - (isInstalled(b.id) ? 1 : 0)
          || (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
      }
      return apps;
    }

    /* ---- 安装 / 卸载编排(按钮态切换 + core 副作用) ---- */

    /** 安装按钮 → 真实下载进度(字节级,来自 core/install 的 onProgress)
     *  → 落地 installApp。失败时安装标志不置位,重绘回「安装」可重试。 */
    function installFlow(app, btn) {
      const prog = el('div', { class: 'st-prog', title: `正在下载 ${app.name} 的应用包` },
        el('div', { class: 'st-prog-bar' }, el('i')),
        el('span', { class: 'st-prog-t' }, '连接中…'));
      btn.replaceWith(prog);
      const bar = prog.querySelector('i');
      const txt = prog.querySelector('.st-prog-t');
      installApp(app.id, {
        onProgress: (p) => {
          const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
          bar.style.width = pct + '%';
          txt.textContent = p.total
            ? `${pct}% · ${fmtBytes(p.loaded)} / ${fmtBytes(p.total)}`
            : fmtBytes(p.loaded);
        },
      }).then(() => {
        /* 成败都重绘:成功出「打开」,失败回「安装」(通知里带原因) */
        renderAll();
      });
    }

    async function uninstallFlow(app) {
      const ok = await dialogs.confirm({
        title: `卸载「${app.name}」`,
        message: '将从开始菜单与桌面移除该应用;应用数据保留,重新安装后恢复。',
        okText: '卸载', danger: true,
      });
      if (!ok) return;
      uninstallApp(app.id);
      renderAll();
    }

    function cardBtns(app) {
      if (!isInstalled(app.id)) {
        return [el('button', {
          class: 'btn primary st-install',
          onClick: (e) => { e.stopPropagation(); installFlow(app, e.currentTarget); },
        }, icon('download', 13), '安装')];
      }
      const btns = [el('button', {
        class: 'btn st-open',
        onClick: (e) => { e.stopPropagation(); wm.open(app.id); },
      }, '打开')];
      if (app.store === true) {
        btns.push(el('button', {
          class: 'btn icon st-uninstall', title: '卸载',
          onClick: (e) => { e.stopPropagation(); uninstallFlow(app); },
        }, icon('trash', 13)));
      }
      return btns;
    }

    function card(app) {
      const m = fakeMeta(app.id);
      const inst = isInstalled(app.id);
      const size = pkgSizes[app.id];
      return el('div', { class: 'st-card' + (inst ? ' on' : ''), 'data-app': app.id },
        appTile(app, 48, 25),
        el('div', { class: 'st-info' },
          el('div', { class: 'st-name' },
            app.name,
            inst ? el('span', { class: 'st-ok' }, app.store === true ? '已安装' : '系统应用') : null),
          el('div', { class: 'st-line' },
            `${app.category || '系统'} · ${size != null ? fmtBytes(size) : '—'}`),
          el('div', { class: 'st-desc' }, app.desc || ''),
          el('div', { class: 'st-meta' }, `★${m.rating} · ${m.dl} 安装`),
        ),
        el('div', { class: 'st-act' }, ...cardBtns(app)),
      );
    }

    /* ---- 视图 ---- */

    function hero() {
      return el('div', { class: 'st-hero' },
        el('div', { class: 'st-hero-deco' }, icon('store', 46)),
        el('div', { class: 'st-hero-txt' },
          el('b', {}, 'Aether 商店'),
          el('span', {}, '把喜欢的应用装进开始菜单与桌面')),
        el('div', { class: 'st-hero-nums' },
          el('div', {}, el('b', {}, String(storeCount())), '在售'),
          el('div', {}, el('b', {}, String(mineCount())), '已安装')));
    }

    function renderCards() {
      content.innerHTML = '';
      if (view === 'store' && !cat && !q) content.append(hero());
      const apps = pool();
      if (!apps.length) {
        content.append(el('div', { class: 'empty' },
          icon('search', 34), q ? `没有找到「${q}」相关的应用` : '这里还没有应用'));
        return;
      }
      content.append(el('div', { class: 'st-grid' }, ...apps.map(card)));
      if (focusId) {
        const node = content.querySelector(`.st-card[data-app="${CSS.escape(focusId)}"]`);
        if (node) {
          node.scrollIntoView({ block: 'center' });
          node.classList.add('flash');
          setTimeout(() => node?.classList.remove('flash'), 1600);
        }
        focusId = null;
      }
    }

    function renderNav() {
      navBox.innerHTML = '';
      const catCount = (c) => listApps().filter(a => a.store === true && (a.category || '系统') === c).length;
      const items = [
        { key: 'all', label: '发现', ico: 'store', n: storeCount(), on: view === 'store' && !cat },
        { key: 'mine', label: '我的应用', ico: 'grid', n: mineCount(), on: view === 'mine' },
        { sep: true },
        ...CATS.map(([c, ico]) => ({ key: c, label: c, ico, n: catCount(c), on: view === 'store' && cat === c })),
      ];
      for (const it of items) {
        if (it.sep) { navBox.append(el('div', { class: 'st-nav-sep' })); continue; }
        navBox.append(el('button', {
          class: 'nav-item' + (it.on ? ' active' : ''),
          'data-cat': it.key,
          onClick: () => {
            if (it.key === 'mine') { view = 'mine'; cat = ''; }
            else { view = 'store'; cat = it.key === 'all' ? '' : it.key; }
            renderAll();
          },
        },
          el('span', { class: 'ni' }, icon(it.ico, 15)),
          el('span', { class: 'st-nav-label' }, it.label),
          el('span', { class: 'st-nav-n' }, String(it.n))));
      }
    }

    function renderAll() {
      renderNav();
      renderCards();
      const total = mineCount();
      statusL.textContent = view === 'store'
        ? `在售 ${storeCount()} 个应用`
        : `已安装 ${total} 个应用`;
    }

    /* ---- 骨架 ---- */
    const search = el('input', {
      class: 'input st-search', type: 'search', placeholder: '搜索应用…',
      onInput: () => { q = search.value.trim(); renderCards(); },
    });
    const navBox = el('div', { class: 'st-nav' });
    const content = el('div', { class: 'app-body st-body' });
    const statusL = el('span', {});
    root.append(
      el('div', { class: 'app' },
        el('div', { class: 'app-toolbar' },
          el('b', { style: { fontSize: '13.5px' } }, '软件商店'),
          el('span', { class: 'grow' }),
          search),
        el('div', { class: 'app-mid' },
          el('div', { class: 'app-side' }, navBox),
          content),
        el('div', { class: 'app-status' }, statusL, el('span', { class: 'grow' }), 'Aether 商店 · 全部应用免费')));

    /* 安装引导跳转:未安装应用被打开时,商店定位并高亮对应卡片 */
    function focusApp(id) {
      const app = listApps().find(a => a.id === id);
      if (!app) return;
      view = 'store';
      cat = '';
      q = '';
      search.value = '';
      focusId = id;
      renderAll();
    }
    if (params?.focus) focusApp(params.focus);   // focusApp 内部已渲染(含高亮)
    else renderAll();
    bus.on('params', (p) => { if (p?.focus) focusApp(p.focus); });

    /* 其他入口(开始菜单 / e2e API)安装卸载 → 实时刷新 */
    bus.onSys('apps-changed', renderAll);
  },
});
