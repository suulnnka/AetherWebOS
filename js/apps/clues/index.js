/* ============================================================
 * 应用:线索(Clues)—— 节点式笔记
 *
 * 每个节点是一张便签(标题 + 内容),多节点视图只显示标题;
 * 节点之间用「单链」(有向边)人为连线,箭头指向线索方向,
 * 最终形成一张可平移/缩放的线索图。
 *
 * 交互:
 *  - 单击便签:选中(工具栏出现 编辑/连出/删除)
 *  - 双击便签:聚焦 —— 只显示它和直接相邻的便签(再双击邻居切换,
 *    双击空白 / Esc / 工具栏按钮退回全图)
 *  - 双击空白:在落点新建便签并打开编辑器
 *  - 拖动便签:移动位置;拖动便签右下角锚点:拉出一条单链
 *  - 空白拖动:平移画布;滚轮:缩放(以指针为中心)
 *  - 右键便签/连线/空白:编辑、连出、反转、删除、就地新建
 *  - Enter 编辑选中便签;Delete 删除选中的便签/连线;Esc 逐级退出
 *
 * 数据按系统用户独立存储(~/appdata/clues.awdb,含视口位置),
 * 未登录时可写但仅本次会话保留(状态栏提示)。
 * ============================================================ */
import { el, clamp, uuid } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './clues.css';
import { accounts } from '../../core/accounts.js';
import { subscribe } from '../../core/bus.js';
import { loadState, saveState } from '../../core/appdata.js';

/* 便签固定尺寸(连线端点几何按此计算) */
const NOTE_W = 152, NOTE_H = 62;
const COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff', '#fecaca'];

let state = null;

function defaultState() {
  const t = Date.now();
  return {
    seq: 4,
    nodes: [
      { id: 'n1', title: '案件:仓库失窃', body: '周五凌晨,三号仓库的货架被清空,监控恰好断电十分钟。', color: COLORS[0], x: 60, y: 70, created: t - 86400e3, updated: t - 86400e3 },
      { id: 'n2', title: '嫌疑人 M', body: '当晚值班,自称在打瞌睡;鞋底沾有仓库特有的蓝色粉尘。', color: COLORS[1], x: 340, y: 30, created: t - 43200e3, updated: t - 43200e3 },
      { id: 'n3', title: '断电十分钟', body: '配电箱有新撬痕,断电系人为 —— 内部作案可能性大。', color: COLORS[2], x: 330, y: 240, created: t - 3600e3, updated: t - 3600e3 },
    ],
    links: [
      { id: 'l1', from: 'n1', to: 'n2' },
      { id: 'l2', from: 'n1', to: 'n3' },
    ],
  };
}

function normalize(raw) {
  if (!raw || !Array.isArray(raw.nodes)) return null;
  const nodes = raw.nodes
    .filter(n => n && typeof n.id === 'string')
    .map(n => ({
      id: n.id,
      title: String(n.title ?? '无标题'),
      body: String(n.body ?? ''),
      color: COLORS.includes(n.color) ? n.color : COLORS[0],
      x: Number.isFinite(n.x) ? n.x : 0,
      y: Number.isFinite(n.y) ? n.y : 0,
      created: n.created ?? Date.now(),
      updated: n.updated ?? Date.now(),
    }));
  const ids = new Set(nodes.map(n => n.id));
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .filter(l => l && ids.has(l.from) && ids.has(l.to) && l.from !== l.to)
    .map(l => ({ id: String(l.id ?? uuid()), from: l.from, to: l.to }));
  /* 去重:同方向单链只留一条 */
  const seen = new Set();
  const uniq = links.filter(l => {
    const k = l.from + '→' + l.to;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    seq: Math.max(1, Number(raw.seq) || nodes.length + 1),
    nodes, links: uniq,
    view: raw.view && Number.isFinite(raw.view.x) ? raw.view : null,
  };
}

async function loadAsync() {
  const user = accounts.current();
  if (!user) return null;                       // 未登录:会话内存态,不落盘
  try {
    const s = await loadState('clues', user);
    return normalize(s);
  } catch (e) {
    console.warn('[clues] 加载失败', e);
    return null;
  }
}

let saveT;
const persist = (view) => {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const user = accounts.current();
    if (!user || !state) return;
    if (view) state.view = { x: view.x, y: view.y, scale: view.scale };
    try { await saveState('clues', state, user); }
    catch (e) { console.warn('[clues] 持久化失败', e); }
  }, 200);
};

/* 便签微倾角:按 id 稳定散列(-1.4° ~ 1.4°),选中时摆正 */
const tiltOf = (id) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 5) - 2) * 0.7;
};

register({
  ...manifest,
  mount({ root, setTitle, bus, onContextMenu, dialogs }) {
    state = defaultState();

    /* ---------- 视口与交互态 ---------- */
    const view = { x: 0, y: 0, scale: 1 };
    let focusId = null;        // 聚焦便签(只显示它 + 直接相邻)
    let selId = null;          // 选中的便签
    let selLinkId = null;      // 选中的连线
    let linkingFrom = null;    // 正在连线(起点便签 id)
    let dragMovedAt = 0;       // 刚拖动过:吞掉随后的 click/dblclick

    const nodeById = (id) => state.nodes.find(n => n.id === id);
    const linkById = (id) => state.links.find(l => l.id === id);
    const neighborsOf = (id) => state.links
      .filter(l => l.from === id || l.to === id)
      .map(l => (l.from === id ? l.to : l.from));
    function visibleSet() {
      if (!focusId) return new Set(state.nodes.map(n => n.id));
      return new Set([focusId, ...neighborsOf(focusId)]);
    }

    /* ---------- 骨架 ---------- */
    const canvas = el('div', { class: 'clues-canvas', tabindex: '-1' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'clues-svg');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    /* 箭头两个配色(普通/选中):marker 内的 fill 不继承引用路径,需各写各的 */
    for (const [mid, fill] of [['clue-arr', '#8b94a1'], ['clue-arr-on', 'var(--accent)']]) {
      const mk = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      mk.setAttribute('id', mid);
      mk.setAttribute('viewBox', '0 0 10 10');
      mk.setAttribute('refX', '9');
      mk.setAttribute('refY', '5');
      mk.setAttribute('markerWidth', '7');
      mk.setAttribute('markerHeight', '7');
      mk.setAttribute('orient', 'auto-start-reverse');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M0 0 L10 5 L0 10 z');
      p.setAttribute('style', `fill:${fill}`);
      mk.append(p);
      defs.append(mk);
    }
    const gEdges = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.append(defs, gEdges);
    const world = el('div', { class: 'clues-world' });
    const emptyHint = el('div', { class: 'clues-empty' },
      icon('nodes', 40),
      el('div', {}, '还没有线索'),
      el('div', { class: 'dim' }, '双击画布空白处,写下第一条线索'));
    canvas.append(svg, world, emptyHint);

    /* 工具栏(选中态按钮由 updateToolbar 启停) */
    const btnEdit = el('button', { class: 'btn', title: '编辑选中便签(Enter)', onClick: () => { const n = nodeById(selId); if (n) openEditor(n); } }, icon('pencil', 13), '编辑');
    const btnLink = el('button', { class: 'btn', title: '从选中便签拉出一条单链', onClick: () => { if (selId) startLink(selId); } }, icon('arrowUp', 13), '连出');
    const btnDel = el('button', { class: 'btn danger', title: '删除选中便签(Delete)', onClick: () => { const n = nodeById(selId); if (n) removeNode(n); } }, icon('trash', 13), '删除');
    const focusChip = el('span', { class: 'clue-focus-chip', style: { display: 'none' } });
    const zoomLabel = el('span', { class: 'dim clue-zoom' }, '100%');
    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn primary', onClick: () => openEditor(null) }, icon('plus', 13), '新建便签'),
        btnEdit, btnLink, btnDel,
        el('span', { class: 'grow' }),
        focusChip,
        el('button', { class: 'btn icon', title: '适配视图(全图居中)', onClick: () => fitView() }, icon('max', 14))),
      canvas,
      (() => {
        const statusL = el('span', { class: 'clue-status-l' }, '');
        const statusR = el('span', { class: 'clue-status-r' }, '');
        const bar = el('div', { class: 'app-status' }, statusL, el('span', { class: 'grow' }), statusR);
        bar._l = statusL; bar._r = statusR;
        return bar;
      })()));

    /* ---------- 几何:便签矩形边缘上的连线端点 ---------- */
    const centerOf = (n) => ({ x: n.x + NOTE_W / 2, y: n.y + NOTE_H / 2 });
    function borderPoint(n, toward) {
      const c = centerOf(n);
      const dx = toward.x - c.x, dy = toward.y - c.y;
      if (!dx && !dy) return c;
      const sx = dx ? (NOTE_W / 2 + 3) / Math.abs(dx) : Infinity;
      const sy = dy ? (NOTE_H / 2 + 3) / Math.abs(dy) : Infinity;
      const s = Math.min(sx, sy);
      return { x: c.x + dx * s, y: c.y + dy * s };
    }

    /* ---------- 视口 ---------- */
    function applyView() {
      world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.scale})`;
      gEdges.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
      canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;   // 点阵随平移走
      zoomLabel.textContent = Math.round(view.scale * 100) + '%';
    }
    const toWorld = (cx, cy) => ({ x: (cx - view.x) / view.scale, y: (cy - view.y) / view.scale });
    function fitView() {
      const vis = state.nodes.filter(n => visibleSet().has(n.id));
      if (!vis.length) return;
      const x1 = Math.min(...vis.map(n => n.x)), y1 = Math.min(...vis.map(n => n.y));
      const x2 = Math.max(...vis.map(n => n.x + NOTE_W)), y2 = Math.max(...vis.map(n => n.y + NOTE_H));
      const { clientWidth: cw, clientHeight: ch } = canvas;
      const pad = 70;
      view.scale = clamp(Math.min((cw - pad * 2) / (x2 - x1), (ch - pad * 2) / (y2 - y1), 1.4), 0.35, 1.4);
      view.x = (cw - (x2 - x1) * view.scale) / 2 - x1 * view.scale;
      view.y = (ch - (y2 - y1) * view.scale) / 2 - y1 * view.scale;
      applyView();
    }

    /* ---------- 渲染 ---------- */
    const noteEls = new Map();   // id → 便签元素(render 间拖动复用,免整树重建)

    function noteEl(n) {
      const t = tiltOf(n.id);
      const card = el('div', { class: 'clue-card' },
        el('span', { class: 'clue-tape' }),
        el('div', { class: 'clue-title' }, n.title));
      const note = el('div', {
        class: 'clue-note' + (n.body ? ' has-body' : ''),
        dataset: { id: n.id },
        style: { width: NOTE_W + 'px', height: NOTE_H + 'px', '--tilt': t + 'deg', background: 'transparent' },
        title: n.body ? `${n.title}\n\n${n.body.slice(0, 120)}` : n.title,
      },
        card,
        el('button', { class: 'clue-anchor', title: '拖出单链' }));
      card.style.background = n.color;
      note.style.transform = `translate(${n.x}px,${n.y}px)`;
      bindNote(note, n);
      return note;
    }

    function render() {
      const vis = visibleSet();
      for (const [id, elx] of noteEls) {
        if (!vis.has(id)) elx.remove(), noteEls.delete(id);
      }
      for (const n of state.nodes) {
        if (!vis.has(n.id)) continue;
        let elx = noteEls.get(n.id);
        if (!elx) { elx = noteEl(n); noteEls.set(n.id, elx); world.append(elx); }
        elx.style.transform = `translate(${n.x}px,${n.y}px)`;
        elx.classList.toggle('has-body', !!n.body);
        elx.classList.toggle('sel', n.id === selId);
        elx.classList.toggle('is-focus', n.id === focusId);
        elx.querySelector('.clue-title').textContent = n.title;
        elx.title = n.body ? `${n.title}\n\n${n.body.slice(0, 120)}` : n.title;
        const card = elx.querySelector('.clue-card');
        if (card) card.style.background = n.color;
      }
      emptyHint.style.display = state.nodes.length ? 'none' : 'flex';
      drawEdges();
      updateToolbar();
      refreshStatus();
      refreshTitle();
    }

    function drawEdges() {
      gEdges.innerHTML = '';
      const vis = visibleSet();
      for (const l of state.links) {
        if (!vis.has(l.from) || !vis.has(l.to)) continue;
        const a = nodeById(l.from), b = nodeById(l.to);
        if (!a || !b) continue;
        const path = edgePath(l, a, b);
        const cls = 'clue-edge' + (l.id === selLinkId ? ' on' : '');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', path);
        p.setAttribute('class', cls);
        p.setAttribute('marker-end', `url(#clue-arr${l.id === selLinkId ? '-on' : ''})`);
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', path);
        hit.setAttribute('class', 'clue-edge-hit');
        hit.dataset.id = l.id;
        hit.addEventListener('click', (e) => {
          e.stopPropagation();
          if (linkingFrom) return;
          selectNode(null);
          selLinkId = l.id;
          render();
        });
        gEdges.append(p, hit);
      }
    }

    /** 连线路径:矩形边缘端点 + 箭头让位;有反向链时弯开避免重叠 */
    function edgePath(l, a, b) {
      const ca = centerOf(b);
      let p1 = borderPoint(a, ca);
      const cb = centerOf(a);
      let p2 = borderPoint(b, cb);
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const dist = Math.hypot(dx, dy) || 1;
      /* 目标端回退 7px 给箭头 */
      p2 = { x: p2.x - dx / dist * 7, y: p2.y - dy / dist * 7 };
      const hasReverse = state.links.some(x => x.from === l.to && x.to === l.from);
      if (hasReverse) {
        const k = Math.min(dist * 0.22, 26);
        const cx = (p1.x + p2.x) / 2 - dy / dist * k;
        const cy = (p1.y + p2.y) / 2 + dx / dist * k;
        return `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`;
      }
      return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    }

    /* ---------- 便签交互 ---------- */
    function selectNode(id) {
      selId = id;
      if (id) selLinkId = null;
      render();
    }

    function bindNote(note, n) {
      let drag = null;

      note.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.clue-anchor')) return;   // 锚点有自己的拖拽
        e.stopPropagation();                             // 不落到画布平移
        drag = {
          sx: e.clientX, sy: e.clientY,
          nx: n.x, ny: n.y, moved: false,
          ids: [n.id, ...neighborsOf(n.id)],
        };
        note.setPointerCapture(e.pointerId);
      });
      note.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = (e.clientX - drag.sx) / view.scale;
        const dy = (e.clientY - drag.sy) / view.scale;
        if (!drag.moved && Math.hypot(dx, dy) > 2) drag.moved = true;
        if (!drag.moved) return;
        n.x = Math.round(drag.nx + dx);
        n.y = Math.round(drag.ny + dy);
        note.style.transform = `translate(${n.x}px,${n.y}px)`;
        drawEdges();                                     // 只重画线,便签树不动
      });
      note.addEventListener('pointerup', () => {
        if (drag?.moved) { persist(view); dragMovedAt = Date.now(); }
        drag = null;
      });
      note.addEventListener('pointercancel', () => { drag = null; });

      note.addEventListener('click', (e) => {
        if (Date.now() - dragMovedAt < 200) return;      // 拖动尾随的 click 吞掉
        if (linkingFrom) { completeLink(linkingFrom, n.id); return; }
        selectNode(n.id);
      });
      note.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (linkingFrom || Date.now() - dragMovedAt < 250) return;
        setFocus(n.id);
      });

      /* 锚点:按住拖出一条单链,落到目标便签上松手 */
      const anchor = note.querySelector('.clue-anchor');
      anchor.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        startLink(n.id, { viaDrag: true });
        anchor.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const rect = canvas.getBoundingClientRect();
          const wpt = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
          ghostEdge(centerOf(n), wpt);
          const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.clue-note');
          hoverDrop(over && over !== note ? over.dataset.id : null);
        };
        const up = (ev) => {
          anchor.removeEventListener('pointermove', move);
          anchor.removeEventListener('pointerup', up);
          anchor.removeEventListener('pointercancel', up);
          ghostEdge(null);
          const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.clue-note');
          hoverDrop(null);
          if (over && over !== note) completeLink(n.id, over.dataset.id);
          else cancelLink();
        };
        anchor.addEventListener('pointermove', move);
        anchor.addEventListener('pointerup', up);
        anchor.addEventListener('pointercancel', up);
      });
    }

    /* 拖链虚线 */
    let ghost = null;
    function ghostEdge(from, to) {
      ghost?.remove();
      ghost = null;
      if (!to) return;
      ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const p1 = borderPoint(nodeById(linkingFrom) ?? { x: from.x - NOTE_W / 2, y: from.y - NOTE_H / 2 }, to);
      ghost.setAttribute('d', `M ${p1.x} ${p1.y} L ${to.x} ${to.y}`);
      ghost.setAttribute('class', 'clue-edge-ghost');
      gEdges.append(ghost);
    }
    function hoverDrop(id) {
      for (const [nid, elx] of noteEls) elx.classList.toggle('drop', nid === id);
    }

    /* ---------- 连线 ---------- */
    function startLink(fromId, { viaDrag = false } = {}) {
      linkingFrom = fromId;
      selLinkId = null;
      canvas.classList.add('linking');
      if (!viaDrag) selectNode(fromId);
      refreshStatus();
    }
    function cancelLink() {
      if (!linkingFrom) return;
      linkingFrom = null;
      canvas.classList.remove('linking');
      hoverDrop(null);
      refreshStatus();
    }
    function completeLink(fromId, toId) {
      const a = nodeById(fromId), b = nodeById(toId);
      const wasDrag = !!linkingFrom;
      linkingFrom = null;
      canvas.classList.remove('linking');
      hoverDrop(null);
      if (!a || !b) return;
      if (a === b) { bus.notify('线索笔记', '同一张便签不能连自己'); refreshStatus(); return; }
      if (state.links.some(l => l.from === fromId && l.to === toId)) {
        bus.notify('线索笔记', `「${a.title}」→「${b.title}」已存在单链`);
        refreshStatus();
        return;
      }
      state.links.push({ id: 'l' + (state.seq++), from: fromId, to: toId });
      persist(view);
      render();
      if (wasDrag) bus.notify('已连线', `${a.title} → ${b.title}`);
    }

    /* ---------- 聚焦 ---------- */
    function setFocus(id) {
      focusId = id;
      render();
      fitView();
    }
    function exitFocus() {
      if (!focusId) return;
      focusId = null;
      render();
    }

    /* ---------- 画布交互(平移 / 缩放 / 空白双击) ---------- */
    let pan = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.clue-note') || e.target.closest('.clue-edge-hit')) return;
      pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('panning');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pan) return;
      view.x = pan.vx + (e.clientX - pan.sx);
      view.y = pan.vy + (e.clientY - pan.sy);
      applyView();
    });
    const endPan = () => { if (pan) { pan = null; canvas.classList.remove('panning'); persist(view); } };
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);

    canvas.addEventListener('click', (e) => {
      if (e.target.closest('.clue-note') || e.target.closest('.clue-edge-hit')) return;
      if (linkingFrom) { cancelLink(); return; }         // 连线模式点空白 = 取消
      if (selId || selLinkId) { selId = null; selLinkId = null; render(); }
    });
    canvas.addEventListener('dblclick', (e) => {
      if (e.target.closest('.clue-note') || e.target.closest('.clue-edge-hit')) return;
      if (focusId) { exitFocus(); return; }              // 聚焦态双击空白 = 回全图
      const rect = canvas.getBoundingClientRect();
      const w = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      openEditor(null, { x: Math.round(w.x - NOTE_W / 2), y: Math.round(w.y - NOTE_H / 2) });
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const before = toWorld(sx, sy);
      view.scale = clamp(view.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.35, 2.5);
      view.x = sx - before.x * view.scale;
      view.y = sy - before.y * view.scale;
      applyView();
    }, { passive: false });

    /* ---------- 编辑器 ---------- */
    function openEditor(node, pos) {
      const titleIn = el('input', { class: 'input', value: node?.title ?? '', placeholder: '标题(便签上只显示标题)', style: { width: '100%' } });
      const bodyIn = el('textarea', {
        class: 'input clue-body-in', rows: 8, placeholder: '内容…(点击便签可先看摘要,悬停有预览)',
      }, node?.body ?? '');
      let color = node?.color ?? COLORS[state.seq % COLORS.length];
      const swatches = el('div', { class: 'row', style: { flexWrap: 'wrap' } },
        ...COLORS.map(c => el('button', {
          class: 'clue-swatch' + (c === color ? ' on' : ''),
          style: { background: c },
          onClick: (e) => {
            color = c;
            e.currentTarget.parentElement.querySelectorAll('.clue-swatch').forEach(s => s.classList.remove('on'));
            e.currentTarget.classList.add('on');
          },
        })));

      const box = el('div', { class: 'modal-box clue-editor', style: { width: 'min(480px, 92%)' } },
        el('h3', {}, node ? '编辑便签' : '新建便签'),
        el('div', { class: 'field' }, el('span', { class: 'f-label' }, '标题'), titleIn),
        el('div', { class: 'field' }, el('span', { class: 'f-label' }, '内容'), bodyIn),
        el('div', { class: 'row', style: { alignItems: 'center', gap: '10px' } },
          el('span', { class: 'dim', style: { fontSize: '12px' } }, '便签颜色'), swatches),
        el('div', { class: 'modal-actions', style: { marginTop: '14px' } },
          el('button', { class: 'btn', onClick: () => box.remove() }, '取消'),
          el('button', {
            class: 'btn primary',
            onClick: () => {
              const title = titleIn.value.trim() || '无标题';
              const body = bodyIn.value.replace(/\s+$/, '');
              if (node) {
                node.title = title; node.body = body; node.color = color; node.updated = Date.now();
              } else {
                const n = {
                  id: 'n' + (state.seq++), title, body, color,
                  x: pos?.x ?? 0, y: pos?.y ?? 0,
                  created: Date.now(), updated: Date.now(),
                };
                if (pos == null) {   // 工具栏新建:落在当前视口中心
                  const rect = canvas.getBoundingClientRect();
                  const c = toWorld(rect.width / 2, rect.height / 2);
                  n.x = Math.round(c.x - NOTE_W / 2 + (Math.random() * 40 - 20));
                  n.y = Math.round(c.y - NOTE_H / 2 + (Math.random() * 40 - 20));
                }
                state.nodes.push(n);
                selId = n.id;
                if (focusId && !visibleSet().has(n.id)) focusId = null;   // 聚焦挡住了新便签就退回全图
              }
              persist(view);
              box.remove();
              render();
              bus.notify(node ? '便签已更新' : '已新建便签', title);
            },
          }, '保存')));
      const mask = el('div', { class: 'modal-mask' }, box);
      mask.addEventListener('pointerdown', (e) => { if (e.target === mask) box.remove(); });
      document.body.append(mask);
      setTimeout(() => titleIn.focus(), 50);
    }

    async function removeNode(n) {
      const linked = state.links.filter(l => l.from === n.id || l.to === n.id).length;
      const ok = await dialogs.confirm({
        title: '删除便签',
        message: `删除「${n.title}」?`,
        detail: linked ? `与之相连的 ${linked} 条单链会一并删除。` : '',
        danger: true, okText: '删除',
      });
      if (!ok) return;
      state.nodes = state.nodes.filter(x => x.id !== n.id);
      state.links = state.links.filter(l => l.from !== n.id && l.to !== n.id);
      if (selId === n.id) selId = null;
      if (focusId === n.id) focusId = null;
      persist(view);
      render();
      bus.notify('已删除便签', n.title);
    }
    function removeLink(l) {
      state.links = state.links.filter(x => x.id !== l.id);
      if (selLinkId === l.id) selLinkId = null;
      persist(view);
      render();
    }
    function reverseLink(l) {
      if (state.links.some(x => x.from === l.to && x.to === l.from)) {
        bus.notify('线索笔记', '反方向的单链已存在');
        return;
      }
      [l.from, l.to] = [l.to, l.from];
      persist(view);
      render();
    }

    /* ---------- 右键菜单 ---------- */
    onContextMenu(({ x, y, target }) => {
      const noteHit = target.closest?.('.clue-note');
      if (noteHit) {
        const n = nodeById(noteHit.dataset.id);
        if (!n) return null;
        return [
          { label: '编辑', icon: 'pencil', fn: () => openEditor(n) },
          { label: '从此连出…', icon: 'arrowUp', fn: () => startLink(n.id) },
          { sep: true },
          { label: `聚焦${n.id === focusId ? '(当前)' : ''}`, icon: 'search', fn: () => setFocus(n.id) },
          { sep: true },
          { label: '删除便签', icon: 'trash', danger: true, fn: () => removeNode(n) },
        ];
      }
      const edgeHit = target.closest?.('.clue-edge-hit');
      if (edgeHit) {
        const l = linkById(edgeHit.dataset.id);
        if (!l) return null;
        return [
          { label: '反转方向', icon: 'refresh', fn: () => reverseLink(l) },
          { sep: true },
          { label: '删除连线', icon: 'trash', danger: true, fn: () => removeLink(l) },
        ];
      }
      let at = null;
      if (typeof x === 'number' && typeof y === 'number') {
        const rect = canvas.getBoundingClientRect();
        const w = toWorld(x - rect.left, y - rect.top);
        at = { x: Math.round(w.x - NOTE_W / 2), y: Math.round(w.y - NOTE_H / 2) };
      } else {
        const rect = canvas.getBoundingClientRect();
        const c = toWorld(rect.width / 2, rect.height / 2);
        at = { x: Math.round(c.x - NOTE_W / 2), y: Math.round(c.y - NOTE_H / 2) };
      }
      return [
        { label: '新建便签(此处)', icon: 'plus', fn: () => openEditor(null, at) },
        { label: '适配视图', icon: 'max', fn: () => fitView() },
        ...(focusId ? [{ sep: true }, { label: '显示全部(退出聚焦)', icon: 'grid', fn: () => exitFocus() }] : []),
      ];
    });

    /* ---------- 键盘(仅本窗口聚焦且无弹窗时) ---------- */
    function onKey(e) {
      if (!root.closest('.win')?.classList.contains('focused')) return;
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (root.querySelector('.modal-mask')) return;
      if (e.key === 'Escape') {
        if (linkingFrom) cancelLink();
        else if (focusId) exitFocus();
        else if (selId || selLinkId) { selId = null; selLinkId = null; render(); }
      } else if (e.key === 'Delete') {
        if (selLinkId) removeLink(linkById(selLinkId));
        else if (selId) removeNode(nodeById(selId));
      } else if (e.key === 'Enter' && selId) {
        const n = nodeById(selId);
        if (n) openEditor(n);
      }
    }
    window.addEventListener('keydown', onKey);

    /* ---------- 工具栏 / 状态 ---------- */
    function updateToolbar() {
      const has = !!selId && !!nodeById(selId);
      btnEdit.disabled = btnLink.disabled = btnDel.disabled = !has;
      if (focusId) {
        const n = nodeById(focusId);
        focusChip.style.display = '';
        focusChip.replaceChildren(
          icon('search', 12),
          el('span', { class: 'clue-focus-name' }, n ? `聚焦:${n.title}` : '聚焦'),
          el('button', { class: 'clue-focus-x', title: '显示全部(Esc)', onClick: () => exitFocus() }, icon('close', 11)));
      } else {
        focusChip.style.display = 'none';
      }
    }
    function refreshTitle() {
      const parts = [`线索 — ${state.nodes.length} 节点 · ${state.links.length} 单链`];
      if (focusId) {
        const n = nodeById(focusId);
        if (n) parts.push(`聚焦「${n.title}」`);
      }
      setTitle(parts.join(' · '));
    }
    function refreshStatus() {
      const bar = root.querySelector('.app-status');
      const vis = visibleSet().size;
      bar._l.textContent = `${state.nodes.length} 节点 · ${state.links.length} 单链`
        + (focusId ? `(聚焦显示 ${vis})` : '')
        + (accounts.current() ? '' : ' · 未登录,内容仅本次会话保留');
      bar._r.textContent = linkingFrom
        ? '点击目标便签完成连线 · 点空白/Esc 取消'
        : '双击空白新建 · 拖锚点连线 · 双击便签聚焦';
      bar._r.classList.toggle('accent', !!linkingFrom);
    }

    /* ---------- 启动 ---------- */
    render();
    applyView();
    fitView();
    loadAsync().then((s) => {
      if (s) {
        state = s;
        selId = selLinkId = null;
        focusId = null;
        if (state.view) Object.assign(view, state.view);
        noteEls.clear();
        world.replaceChildren();
        render();
        applyView();
        if (!state.view) fitView();
      }
    });

    /* 登录 / 切换账号 / 注销:自动装载对应用户的数据 */
    const offAcc = subscribe('accounts:changed', (payload, msg) => {
      const t = msg?.type;
      if (t !== 'login' && t !== 'register' && t !== 'created' && t !== 'logout') return;
      loadAsync().then((s) => {
        state = s || defaultState();
        selId = selLinkId = null;
        focusId = null;
        if (state.view) Object.assign(view, state.view); else fitView();
        noteEls.clear();
        world.replaceChildren();
        render();
        applyView();
      });
    });

    return {
      onClose() {
        window.removeEventListener('keydown', onKey);
        offAcc();
        /* 关窗即冲:防抖中的最后一次保存立即落盘,不等 200ms */
        clearTimeout(saveT);
        const user = accounts.current();
        if (user && state) saveState('clues', state, user).catch(() => {});
        return true;
      },
    };
  },
});
