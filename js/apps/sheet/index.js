/* ============================================================
 * 应用:电子表格
 *
 * 纯表格编辑器,刻意做减法:无公式(输入以 "=" 开头也只是普通
 * 文本)、无合并单元格、行高固定;保留的能力 ——
 *   · 单元格文本编辑(双击 / 回车 / 直接打字进入编辑)
 *   · 列宽拖拽调整(拖列头右缘;双击复位;宽度按 100% 文档坐标
 *     存储,缩放只影响显示,拖拽位移按当前缩放反算)
 *   · 针对单元格的样式:加粗 / 斜体 / 删除线 / 下划线 /
 *     文字颜色 / 单元格背景色,支持框选一片后批量套用
 *   · 列排序:列头 ↕ 小钮或工具栏「升序 / 降序」,整行随之重排
 *     (数字 < 文本,空行恒垫底;文本按系统「文本排序」设置,默认拼音),
 *     排序状态在列头显示 ▲/▼,内容再编辑即失效清除
 *   · 整表缩放(工具栏 ± 与 Ctrl+滚轮,50%~200%),列宽行高
 *     字号同步真实缩放(非 transform,文字不糊),缩放随文档保存
 *
 * 保存格式 .axl:带 axl:1 版本标记的 JSON 文本 ——
 *   { axl:1, rows, cols, colw:[列宽px@100%], zoom,
 *     sort:{c,dir}|null, cells:{ "r,c":{ t:文本, b/i/u/k:样式位, fg/bg:颜色 } } }
 * 空单元格不落盘;载入时逐字段校验裁剪,坏数据按缺省处理。
 * ============================================================ */
import { el, clamp } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './sheet.css';
import { modal, confirmBox } from '../../core/ui.js';
import { settings } from '../../core/store.js';

/* ---- 常量 ---- */
const DEF_ROWS = 50, DEF_COLS = 20;            // 初始网格
const MAX_ROWS = 500, MAX_COLS = 52;           // 上限(A..AZ;纯 DOM 网格,防失控)
const ROW_H = 28;                              // 行高(固定,文档坐标 px @100%)
const DEF_COL_W = 96, MIN_COL_W = 32, MAX_COL_W = 420;
const FONT = 13, CORNER_W = 46;
const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
const GROW_ROWS = 10, GROW_COLS = 4;           // 末行/末列落字后自动扩容的步长

/** 调色板(文字 / 背景共用) */
const PALETTE = [
  '#000000', '#404040', '#6b7280', '#9ca3af', '#c9cdd4', '#ffffff',
  '#7f1d1d', '#c2410c', '#ea580c', '#f59e0b', '#facc15', '#a16207',
  '#4d7c0f', '#16a34a', '#059669', '#0d9488', '#0891b2', '#2563eb',
  '#4f46e5', '#7c3aed', '#c026d3', '#db2777', '#e11d48', '#f43f5e',
];

const colName = (c) => { let s = '', n = c + 1; while (n > 0) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26); } return s; };
const cellKey = (r, c) => r + ',' + c;

const emptyDoc = () => ({ axl: 1, rows: DEF_ROWS, cols: DEF_COLS, colw: [], cells: {}, zoom: 1, sort: null });

/** 校验并裁剪 .axl 文本为可用文档;结构非法抛错(由调用方提示) */
function parseDoc(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('不是有效的 JSON'); }
  if (!d || typeof d !== 'object' || d.axl !== 1) throw new Error('缺少 axl:1 版本标记');
  const doc = emptyDoc();
  doc.rows = clamp(Math.floor(+d.rows) || DEF_ROWS, 1, MAX_ROWS);
  doc.cols = clamp(Math.floor(+d.cols) || DEF_COLS, 1, MAX_COLS);
  doc.colw = Array.isArray(d.colw)
    ? d.colw.slice(0, doc.cols).map((w) => clamp(Math.round(+w) || DEF_COL_W, MIN_COL_W, MAX_COL_W))
    : [];
  doc.zoom = clamp(Math.round(+d.zoom * 10) / 10 || 1, ZOOM_MIN, ZOOM_MAX);
  if (d.sort && Number.isInteger(+d.sort.c) && +d.sort.c >= 0 && +d.sort.c < doc.cols
    && (d.sort.dir === 1 || d.sort.dir === -1)) doc.sort = { c: +d.sort.c, dir: d.sort.dir };
  if (d.cells && typeof d.cells === 'object') {
    for (const [k, v] of Object.entries(d.cells)) {
      const m = /^(\d+),(\d+)$/.exec(k);
      if (!m || +m[1] >= doc.rows || +m[2] >= doc.cols || !v || typeof v !== 'object') continue;
      const cell = {};
      if (typeof v.t === 'string' && v.t) cell.t = v.t;
      for (const f of ['b', 'i', 'u', 'k']) if (v[f]) cell[f] = 1;
      if (/^#[0-9a-f]{6}$/i.test(v.fg || '')) cell.fg = v.fg;
      if (/^#[0-9a-f]{6}$/i.test(v.bg || '')) cell.bg = v.bg;
      if (Object.keys(cell).length) doc.cells[k] = cell;
    }
  }
  return doc;
}

register({
  ...manifest,
  mount({ root, bus, params, setTitle, fs }) {
    let path = params.path || null;   // null = 未保存的新表格
    let dirty = false;
    let doc = emptyDoc();
    /* 选区:锚点 (r1,c1) 即样式按钮所反映的当前格,焦点 (r2,c2) 随导航/拖框移动 */
    let sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
    let editing = null;               // { r, c, input, old }
    let drag = null;                  // { mode:'cell'|'row'|'col' }
    let palette = null;               // 打开中的调色板

    /* ---- DOM 骨架 ---- */
    const wrap = el('div', { class: 'sheet-wrap', tabIndex: 0 });
    const colgroup = el('colgroup');
    const thead = el('thead');
    const tbody = el('tbody');
    const table = el('table', { class: 'sheet-table' }, colgroup, thead, tbody);
    wrap.append(table);

    const nameEl = el('span', { class: 'dim', style: { fontSize: '12.5px', marginLeft: '8px' } });
    const selInfo = el('span', {}, '');
    const zoomLabel = el('span', {
      class: 'sheet-zoom-label', title: '点击恢复 100%',
      onClick: () => setZoom(1),
    }, '100%');

    /* ---- 基础访问 ---- */
    const tdOf = (r, c) => tbody.children[r]?.children[c + 1] || null;
    const colOf = (c) => colgroup.children[c + 1];
    const cellAt = (r, c) => doc.cells[cellKey(r, c)];
    /** 列宽(文档坐标),按 100% 显示坐标换算 */
    const colW = (c) => Math.round((doc.colw[c] || DEF_COL_W) * doc.zoom);
    const normSel = () => ({
      r1: Math.min(sel.r1, sel.r2), r2: Math.max(sel.r1, sel.r2),
      c1: Math.min(sel.c1, sel.c2), c2: Math.max(sel.c1, sel.c2),
    });
    const eachSel = (fn) => {
      const a = normSel();
      for (let r = a.r1; r <= a.r2; r++) for (let c = a.c1; c <= a.c2; c++) fn(r, c, tdOf(r, c));
    };

    function markDirty() { dirty = true; refreshChrome(); }

    /* ---- 渲染 ---- */

    /** 把一个单元格的数据画到 td(文本 + 四个样式位 + 两色) */
    function paint(td, r, c) {
      if (!td) return;
      const cell = cellAt(r, c);
      td.textContent = cell?.t || '';
      td.classList.toggle('b', !!cell?.b);
      td.classList.toggle('i', !!cell?.i);
      td.classList.toggle('u', !!cell?.u);
      td.classList.toggle('k', !!cell?.k);
      td.style.color = cell?.fg || '';
      td.style.background = cell?.bg || '';
    }

    /** 全量重建网格(载入/新建/扩容时;保留滚动位置由调用方决定) */
    function buildGrid(keepScroll = false) {
      const st = keepScroll ? { t: wrap.scrollTop, l: wrap.scrollLeft } : null;
      colgroup.replaceChildren(
        el('col', { style: { width: Math.round(CORNER_W * doc.zoom) + 'px' } }),
        ...Array.from({ length: doc.cols }, (_, c) => el('col', { style: { width: colW(c) + 'px' } })),
      );
      thead.replaceChildren(el('tr', {},
        el('th', { class: 'corner', dataset: { all: '1' }, title: '全选' }),
        ...Array.from({ length: doc.cols }, (_, c) => el('th', { dataset: { c: String(c) } },
          colName(c),
          el('span', { class: 'col-sort', dataset: { c: String(c) } }, '↕'),
          el('span', { class: 'col-resize', dataset: { c: String(c) }, title: '拖拽调列宽 · 双击复位' })))));
      tbody.replaceChildren(...Array.from({ length: doc.rows }, (_, r) => el('tr', {},
        el('th', { class: 'rowh', dataset: { r: String(r) } }, String(r + 1)),
        ...Array.from({ length: doc.cols }, (_, c) => el('td', { dataset: { r: String(r), c: String(c) } })))));
      for (const [k, cell] of Object.entries(doc.cells)) {
        const [r, c] = k.split(',').map(Number);
        paint(tdOf(r, c), r, c);
      }
      applyZoomStyle();
      renderSortMarks();
      if (st) { wrap.scrollTop = st.t; wrap.scrollLeft = st.l; }
      renderSel();
    }

    /** 缩放三件套:字号 / 行高 CSS 变量 / 列宽与角宽 */
    function applyZoomStyle() {
      table.style.fontSize = Math.round(FONT * doc.zoom) + 'px';
      table.style.setProperty('--rowh', String(Math.round(ROW_H * doc.zoom)));
      colgroup.children[0].style.width = Math.round(CORNER_W * doc.zoom) + 'px';
      for (let c = 0; c < doc.cols; c++) colOf(c).style.width = colW(c) + 'px';
    }

    /** 选区绘制:td 高亮 + 锚点框 + 行列头联动高亮,并刷新工具栏/状态栏 */
    function renderSel() {
      for (const x of wrap.querySelectorAll('.sel, .cur, .hd-sel')) x.classList.remove('sel', 'cur', 'hd-sel');
      const a = normSel();
      for (let r = a.r1; r <= a.r2; r++) {
        const tr = tbody.children[r];
        for (let c = a.c1; c <= a.c2; c++) tr?.children[c + 1]?.classList.add('sel');
      }
      tdOf(sel.r1, sel.c1)?.classList.add('cur');
      const headRow = thead.children[0];
      for (let c = a.c1; c <= a.c2; c++) headRow?.children[c + 1]?.classList.add('hd-sel');
      for (let r = a.r1; r <= a.r2; r++) tbody.children[r]?.children[0].classList.add('hd-sel');
      refreshToolbar();
    }

    /* ---- 数据修改 ---- */

    /** 选区内写文本("" 清空;样式保留)。内容一变,原排序状态即不可信,清除指示 */
    function setText(r, c, text) {
      const k = cellKey(r, c);
      const cell = doc.cells[k];
      if (text) {
        doc.cells[k] = { ...(cell || {}), t: text };
      } else if (cell) {
        delete cell.t;
        if (!cell.b && !cell.i && !cell.u && !cell.k && !cell.fg && !cell.bg) delete doc.cells[k];
      }
      if (doc.sort) { doc.sort = null; renderSortMarks(); }
      paint(tdOf(r, c), r, c);
    }

    /** 选区批量套样式:patch 里 null = 清除该属性;空格子自动回收 */
    function applyFormat(patch) {
      eachSel((r, c, td) => {
        const k = cellKey(r, c);
        const next = { ...(doc.cells[k] || {}) };
        for (const [f, v] of Object.entries(patch)) {
          if (v == null) delete next[f]; else next[f] = v;
        }
        if (!next.t && !next.b && !next.i && !next.u && !next.k && !next.fg && !next.bg) delete doc.cells[k];
        else doc.cells[k] = next;
        paint(td, r, c);
      });
      markDirty();
      refreshToolbar();
    }

    /** 样式开关按锚点现状取反,套到整个选区(与 Word 一致的直觉) */
    const toggleFmt = (f) => applyFormat({ [f]: cellAt(sel.r1, sel.c1)?.[f] ? null : 1 });

    /* ---- 列排序(整行重排) ---- */

    /** 排序键:数字 < 文本 < 空(空恒垫底,不随方向翻,Excel 语义) */
    function sortKeyOf(r, c) {
      const t = doc.cells[cellKey(r, c)]?.t ?? '';
      if (!t) return { k: 2 };
      const n = Number(t);
      if (t.trim() !== '' && !isNaN(n)) return { k: 0, n };
      return { k: 1, s: t };
    }

    /**
     * 按第 c 列排序(dir: 1 升 / -1 降),所有行的单元格连同样式整体换位。
     * 文本序跟随系统「文本排序」设置(默认 zh = 拼音),'' 为码点序。
     */
    function sortCol(c, dir) {
      commitEdit();
      const locale = settings.get('sortLocale') ?? 'zh';
      const coll = locale ? new Intl.Collator(locale, { numeric: true }) : null;
      const cmp = (ra, rb) => {
        const a = sortKeyOf(ra, c), b = sortKeyOf(rb, c);
        if (a.k !== b.k) return a.k - b.k;
        if (a.k === 0) return (a.n - b.n) * dir;
        if (a.k === 1) return (coll ? coll.compare(a.s, b.s) : (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)) * dir;
        return 0;
      };
      const all = Array.from({ length: doc.rows }, (_, r) => r);
      const order = [...all.filter((r) => sortKeyOf(r, c).k !== 2).sort(cmp),
                     ...all.filter((r) => sortKeyOf(r, c).k === 2)];
      const pos = new Array(doc.rows);                 // 旧行号 → 新行号
      order.forEach((oldR, i) => { pos[oldR] = i; });
      const cells = {};
      for (const [k, cell] of Object.entries(doc.cells)) {
        const i = k.indexOf(',');
        cells[pos[+k.slice(0, i)] + k.slice(i)] = cell;
      }
      doc.cells = cells;
      doc.sort = { c, dir };
      buildGrid(true);
      markDirty();
    }

    /** 列头排序钮状态(▲/▼/↕ 悬停浮现) */
    function renderSortMarks() {
      const headRow = thead.children[0];
      if (!headRow) return;
      for (let c = 0; c < doc.cols; c++) {
        const btn = headRow.children[c + 1]?.querySelector('.col-sort');
        if (!btn) continue;
        const on = doc.sort && doc.sort.c === c;
        btn.textContent = on ? (doc.sort.dir > 0 ? '▲' : '▼') : '↕';
        btn.title = on
          ? (doc.sort.dir > 0 ? `已按 ${colName(c)} 列升序,点击改降序` : `已按 ${colName(c)} 列降序,点击改升序`)
          : `按 ${colName(c)} 列升序排序`;
        btn.classList.toggle('on', !!on);
      }
    }

    /* ---- 编辑 ---- */

    function startEdit(r, c, initial = null) {
      commitEdit();
      const td = tdOf(r, c);
      if (!td) return;
      const old = cellAt(r, c)?.t || '';
      const input = el('input', { class: 'cell-in', value: initial != null ? initial : old });
      td.classList.add('editing');
      td.textContent = '';
      td.append(input);
      input.focus();
      if (initial != null) input.select();
      else input.setSelectionRange(old.length, old.length);
      editing = { r, c, input, old };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(); moveSel(1, 0, false); }
        else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); moveSel(0, 1, false); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      });
      input.addEventListener('blur', () => { if (editing?.input === input) commitEdit(); });
    }

    function commitEdit() {
      if (!editing) return;
      const { r, c, input, old } = editing;
      editing = null;
      const v = input.value;
      input.remove();
      const td = tdOf(r, c);
      td?.classList.remove('editing');
      if (v !== old) {
        setText(r, c, v);
        markDirty();
        /* 末行/末列落字自动扩容,打字永远打不穿边界 */
        if (v && r >= doc.rows - 1 && doc.rows < MAX_ROWS) growRows();
        if (v && c >= doc.cols - 1 && doc.cols < MAX_COLS) growCols();
      } else paint(td, r, c);
      wrap.focus();
    }

    function cancelEdit() {
      if (!editing) return;
      const { r, c, input } = editing;
      editing = null;
      input.remove();
      const td = tdOf(r, c);
      td?.classList.remove('editing');
      paint(td, r, c);
      wrap.focus();
    }

    /* ---- 选区交互 ---- */

    function moveSel(dr, dc, extend) {
      if (extend) {
        sel.r2 = clamp(sel.r2 + dr, 0, doc.rows - 1);
        sel.c2 = clamp(sel.c2 + dc, 0, doc.cols - 1);
      } else {
        sel = {
          r1: clamp(sel.r2 + dr, 0, doc.rows - 1),
          c1: clamp(sel.c2 + dc, 0, doc.cols - 1),
          r2: clamp(sel.r2 + dr, 0, doc.rows - 1),
          c2: clamp(sel.c2 + dc, 0, doc.cols - 1),
        };
      }
      renderSel();
      /* 锚点滚入可视区(行高列宽按缩放后的显示尺寸) */
      tdOf(sel.r2, sel.c2)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    /** 按元素定位格子/表头(td → {r,c};列头 → {c};行头 → {r}) */
    function hitEl(n) {
      const td = n?.closest?.('tbody td');
      if (td && wrap.contains(td)) return { r: +td.dataset.r, c: +td.dataset.c };
      const th = n?.closest?.('thead th:not(.corner)');
      if (th?.dataset.c != null && wrap.contains(th)) return { c: +th.dataset.c };
      const rh = n?.closest?.('tbody th.rowh');
      if (rh && wrap.contains(rh)) return { r: +rh.dataset.r };
      return null;
    }
    /** 按视口坐标定位(拖拽延续用;开场动画等过渡态下可能被装饰层遮挡) */
    const hitCell = (x, y) => hitEl(document.elementFromPoint(x, y));

    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.col-resize')) return;
      const hit = hitEl(e.target) || hitCell(e.clientX, e.clientY);
      if (!hit) return;
      commitEdit();
      if (hit.r == null) {                       // 列头:整列
        if (e.shiftKey) sel.c2 = hit.c;
        else sel = { r1: 0, c1: hit.c, r2: doc.rows - 1, c2: hit.c };
        drag = { mode: 'col' };
      } else if (hit.c == null) {                // 行头:整行
        if (e.shiftKey) sel.r2 = hit.r;
        else sel = { r1: hit.r, c1: 0, r2: hit.r, c2: doc.cols - 1 };
        drag = { mode: 'row' };
      } else if (e.shiftKey) {                   // 普通格 + shift:扩选
        sel.r2 = hit.r; sel.c2 = hit.c;
      } else {
        sel = { r1: hit.r, c1: hit.c, r2: hit.r, c2: hit.c };
        drag = { mode: 'cell' };
      }
      renderSel();
      wrap.focus();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 合成事件无有效指针:跳过捕获 */ }
      e.preventDefault();
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const hit = hitCell(e.clientX, e.clientY);
      if (!hit) return;
      if (drag.mode === 'col' && hit.c != null) sel.c2 = hit.c;
      else if (drag.mode === 'row' && hit.r != null) sel.r2 = hit.r;
      else if (drag.mode === 'cell') {
        if (hit.r != null) sel.r2 = hit.r;
        if (hit.c != null) sel.c2 = hit.c;
      }
      renderSel();
    });
    const endDrag = () => { drag = null; };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);

    wrap.addEventListener('dblclick', (e) => {
      const handle = e.target.closest('.col-resize');
      if (handle) {                              // 双击列宽手柄:复位默认宽
        doc.colw[+handle.dataset.c] = DEF_COL_W;
        applyZoomStyle();
        markDirty();
        return;
      }
      const td = e.target.closest('tbody td');
      if (td) startEdit(+td.dataset.r, +td.dataset.c);
    });

    /* 角标:全选;列头 ↕ 小钮:升/降序切换 */
    wrap.addEventListener('click', (e) => {
      const sortBtn = e.target.closest('.col-sort');
      if (sortBtn) {
        const c = +sortBtn.dataset.c;
        sortCol(c, doc.sort && doc.sort.c === c ? -doc.sort.dir : 1);
        return;
      }
      if (e.target.closest('th.corner')) {
        commitEdit();
        sel = { r1: 0, c1: 0, r2: doc.rows - 1, c2: doc.cols - 1 };
        renderSel();
      }
    });

    /* ---- 键盘:导航 / 编辑入口 / 样式快捷键 ---- */
    wrap.addEventListener('keydown', (e) => {
      if (editing) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (mod && !e.shiftKey) {
        const map = { b: 'b', i: 'i', u: 'u' };
        if (map[k.toLowerCase()]) { e.preventDefault(); toggleFmt(map[k.toLowerCase()]); return; }
        if (e.code === 'Digit5') { e.preventDefault(); toggleFmt('k'); return; }   // Excel 惯例:Ctrl+5 删除线
        return;
      }
      switch (k) {
        case 'ArrowUp': e.preventDefault(); moveSel(-1, 0, e.shiftKey); break;
        case 'ArrowDown': e.preventDefault(); moveSel(1, 0, e.shiftKey); break;
        case 'ArrowLeft': e.preventDefault(); moveSel(0, -1, e.shiftKey); break;
        case 'ArrowRight': e.preventDefault(); moveSel(0, 1, e.shiftKey); break;
        case 'Home': e.preventDefault(); moveSel(-doc.rows, -doc.cols, e.shiftKey); break;
        case 'End': e.preventDefault(); moveSel(0, doc.cols, e.shiftKey); break;
        case 'Enter': case 'F2': e.preventDefault(); startEdit(sel.r2, sel.c2); break;
        case 'Tab': e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1, false); break;
        case 'Delete': case 'Backspace':
          e.preventDefault();
          eachSel((r, c, td) => setText(r, c, ''));
          markDirty(); refreshToolbar();
          break;
        case 'Escape': closePalette(); break;
        default:
          if (k.length === 1 && !mod && !e.altKey) { e.preventDefault(); startEdit(sel.r2, sel.c2, k); }
      }
    });

    /* Ctrl+S / Ctrl+Shift+S(捕获阶段,编辑中也生效) */
    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      }
    }, true);

    /* ---- 列宽拖拽(双击复位) ---- */
    wrap.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.col-resize');
      if (!handle || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const c = +handle.dataset.c;
      let moved = false;
      const startX = e.clientX;
      const startW = doc.colw[c] || DEF_COL_W;
      const move = (ev) => {
        moved = true;
        doc.colw[c] = clamp(Math.round(startW + (ev.clientX - startX) / doc.zoom), MIN_COL_W, MAX_COL_W);
        colOf(c).style.width = colW(c) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) markDirty();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    /* ---- 缩放 ---- */
    function setZoom(z) {
      const nz = clamp(Math.round(z * 10) / 10, ZOOM_MIN, ZOOM_MAX);
      if (nz === doc.zoom) return;
      doc.zoom = nz;
      zoomLabel.textContent = Math.round(nz * 100) + '%';
      applyZoomStyle();
      markDirty();
    }
    wrap.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(doc.zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }, { passive: false });

    /* ---- 扩容 ---- */
    function growRows() {
      if (doc.rows >= MAX_ROWS) return;
      doc.rows = Math.min(MAX_ROWS, doc.rows + GROW_ROWS);
      buildGrid(true);
      markDirty();
    }
    function growCols() {
      if (doc.cols >= MAX_COLS) return;
      doc.cols = Math.min(MAX_COLS, doc.cols + GROW_COLS);
      buildGrid(true);
      markDirty();
    }

    /* ---- 工具栏 ---- */
    const bBtn = el('button', { class: 'btn sheet-fmt b', title: '加粗 (Ctrl+B)', onClick: () => toggleFmt('b') }, el('span', {}, 'B'));
    const iBtn = el('button', { class: 'btn sheet-fmt i', title: '斜体 (Ctrl+I)', onClick: () => toggleFmt('i') }, el('span', {}, 'I'));
    const uBtn = el('button', { class: 'btn sheet-fmt u', title: '下划线 (Ctrl+U)', onClick: () => toggleFmt('u') }, el('span', {}, 'U'));
    const kBtn = el('button', { class: 'btn sheet-fmt k', title: '删除线 (Ctrl+5)', onClick: () => toggleFmt('k') }, el('span', {}, 'S'));
    const fgA = el('span', { class: 'a' }, 'A');
    const fgBar = el('span', { class: 'bar' });
    const fgBtn = el('button', { class: 'btn sheet-color', title: '文字颜色' }, fgA, fgBar);
    const bgFill = el('span', { class: 'fill' });
    const bgBtn = el('button', { class: 'btn sheet-color', title: '单元格颜色' }, bgFill);
    fgBtn.addEventListener('click', () => palette?.dataset.kind === 'fg' ? closePalette() : openPalette(fgBtn, 'fg'));
    bgBtn.addEventListener('click', () => palette?.dataset.kind === 'bg' ? closePalette() : openPalette(bgBtn, 'bg'));

    /** 调色板弹层(文字/背景共用) */
    function openPalette(btn, kind) {
      closePalette();
      palette = el('div', { class: 'sheet-palette', dataset: { kind } },
        el('div', { class: 'pal-title' }, kind === 'fg' ? '文字颜色' : '单元格颜色'),
        el('div', { class: 'pal-grid' },
          el('button', { class: 'btn pal-none', onClick: () => applyColor(kind, null) },
            kind === 'fg' ? '自动(无色)' : '无颜色'),
          ...PALETTE.map((hx) => el('button', {
            class: 'pal-sw', style: { background: hx }, title: hx,
            onClick: () => applyColor(kind, hx),
          }))));
      root.append(palette);
      /* 贴在按钮下方、右对齐,超出窗口内容区则夹回 */
      const rb = root.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      const pb = palette.getBoundingClientRect();
      let x = bb.right - pb.width;
      let y = bb.bottom + 6;
      if (x + pb.width > rb.width - 8) x = rb.width - pb.width - 8;
      if (x < 8) x = 8;
      if (y + pb.height > rb.height - 8) y = bb.top - pb.height - 6;
      palette.style.left = x + 'px';
      palette.style.top = y + 'px';
      setTimeout(() => document.addEventListener('pointerdown', onPalOutside, true), 0);
    }
    function onPalOutside(e) { if (palette && !palette.contains(e.target)) closePalette(); }
    function closePalette() {
      if (!palette) return;
      palette.remove();
      palette = null;
      document.removeEventListener('pointerdown', onPalOutside, true);
    }
    function applyColor(kind, hx) {
      closePalette();
      applyFormat({ [kind === 'fg' ? 'fg' : 'bg']: hx });
    }

    /** 反映锚点格样式到按钮态 */
    function refreshToolbar() {
      const cell = cellAt(sel.r1, sel.c1);
      bBtn.classList.toggle('on', !!cell?.b);
      iBtn.classList.toggle('on', !!cell?.i);
      uBtn.classList.toggle('on', !!cell?.u);
      kBtn.classList.toggle('on', !!cell?.k);
      fgA.style.color = cell?.fg || '';
      fgBar.style.background = cell?.fg || 'var(--accent)';
      bgFill.style.background = cell?.bg || '';
      bgFill.classList.toggle('none', !cell?.bg);
      const a = normSel();
      selInfo.textContent = a.r1 === a.r2 && a.c1 === a.c2
        ? `${colName(sel.c1)}${sel.r1 + 1} · ${doc.rows} 行 × ${doc.cols} 列`
        : `${colName(a.c1)}${a.r1 + 1}:${colName(a.c2)}${a.r2 + 1} · ${(a.r2 - a.r1 + 1) * (a.c2 - a.c1 + 1)} 格`;
    }

    /* ---- 窗口标题 / 状态 ---- */
    function refreshChrome() {
      const name = path ? fs.basename(path) : '未命名';
      nameEl.textContent = path || '尚未保存到文件系统';
      setTitle((dirty ? '● ' : '') + name + ' — 电子表格');
    }

    /* ---- 文件读写(.axl) ---- */
    async function loadPath(p) {
      const content = fs.read(p);
      if (content == null) { bus.notify('无法打开', `文件不存在或无读权限:${p}`); return; }
      let d;
      try { d = parseDoc(content); } catch (err) {
        bus.notify('无法打开', `不是有效的 .axl 文档:${err.message}`);
        return;
      }
      if (dirty && !(await confirmBox(document.body, '放弃未保存的更改?', `打开「${fs.basename(p)}」将丢弃当前未保存的修改。`))) return;
      cancelEdit();
      path = p;
      doc = d;
      sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
      dirty = false;
      zoomLabel.textContent = Math.round(doc.zoom * 100) + '%';
      buildGrid();
      wrap.scrollTop = wrap.scrollLeft = 0;
      refreshChrome();
    }

    async function openFile() {
      const def = `${fs.homePath() || '/home'}/documents/`;
      const p = await modal(document.body, {
        title: '打开电子表格',
        input: { placeholder: def, value: def },
        body: '输入文件路径(.axl)',
        confirmText: '打开',
      });
      if (p == null) return;
      const t = fs.normPath(p.trim() || '');
      if (t && t !== '/') loadPath(t);
    }

    async function save(as = false) {
      let target = path;
      if (as || !target) {
        const def = `${fs.homePath() || '/home'}/documents/未命名.axl`;
        const p = await modal(document.body, {
          title: '保存表格',
          input: { placeholder: def, value: target || def },
          body: '输入文件保存路径(自动创建目录,格式 .axl)',
          confirmText: '保存',
        });
        if (p == null) return false;
        target = fs.normPath(p.trim() || '');
        if (!target || target === '/') return false;
      }
      commitEdit();
      if (!fs.write(target, JSON.stringify(doc))) {
        bus.notify('保存失败', `无写入权限或路径无效:${target}`);
        return false;
      }
      path = target;
      dirty = false;
      refreshChrome();
      bus.notify('文件已保存', path);
      return true;
    }

    async function newDoc() {
      if (dirty && !(await confirmBox(document.body, '放弃未保存的更改?', '新建表格将丢弃当前未保存的修改。'))) return;
      cancelEdit();
      path = null;
      doc = emptyDoc();
      sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
      dirty = false;
      zoomLabel.textContent = '100%';
      buildGrid();
      refreshChrome();
    }

    const sep = () => el('span', { class: 'sheet-sep' });

    root.append(el('div', { class: 'app sheet-app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn', onClick: newDoc }, icon('filePlus', 13), '新建'),
        el('button', { class: 'btn', onClick: openFile }, icon('folder', 13), '打开'),
        el('button', { class: 'btn', onClick: () => save(false) }, icon('save', 13), '保存'),
        el('button', { class: 'btn', onClick: () => save(true) }, icon('external', 13), '另存为'),
        sep(),
        bBtn, iBtn, uBtn, kBtn,
        sep(),
        fgBtn, bgBtn,
        el('button', {
          class: 'btn', title: '清除选区样式(保留文字)',
          onClick: () => applyFormat({ b: null, i: null, u: null, k: null, fg: null, bg: null }),
        }, icon('refresh', 13), '清除格式'),
        sep(),
        el('button', {
          class: 'btn',
          title: '按当前列升序:整行重排,数字在前、文本在后(拼音序),空行恒在最后',
          onClick: () => sortCol(sel.c1, 1),
        }, '↑ 升序'),
        el('button', {
          class: 'btn', title: '按当前列降序(整行重排,空行恒在最后)',
          onClick: () => sortCol(sel.c1, -1),
        }, '↓ 降序'),
        sep(),
        el('button', { class: 'btn icon', title: '缩小 (Ctrl+滚轮)', onClick: () => setZoom(doc.zoom - ZOOM_STEP) }, icon('minus', 13)),
        zoomLabel,
        el('button', { class: 'btn icon', title: '放大 (Ctrl+滚轮)', onClick: () => setZoom(doc.zoom + ZOOM_STEP) }, icon('plus', 13)),
        el('span', { class: 'grow' }),
        nameEl),
      wrap,
      el('div', { class: 'app-status' },
        selInfo,
        el('span', { class: 'grow' }),
        el('button', { class: 'btn sheet-grow', onClick: growRows }, '+10 行'),
        el('button', { class: 'btn sheet-grow', onClick: growCols }, '+4 列'),
        el('span', {}, '双击/回车编辑 · 列头 ↕ 排序 · 拖列头右缘调宽 · Ctrl+滚轮缩放 · Ctrl+S 保存'))));

    /* 初始装载:params.path 直接开档,否则新表 */
    if (path) {
      const content = fs.read(path);
      if (content == null) { bus.notify('文件不存在', path); path = null; }
      else {
        try {
          doc = parseDoc(content);
          zoomLabel.textContent = Math.round(doc.zoom * 100) + '%';
        } catch (err) { bus.notify('无法打开', `不是有效的 .axl 文档:${err.message}`); path = null; }
      }
    }
    buildGrid();
    refreshChrome();
    wrap.focus();

    /* 其他入口(文件管家/桌面/终端)推来新路径 */
    const off = bus.on('params', (p) => { if (p?.path) loadPath(p.path); });

    /* 调试/e2e 柄:只读快照 */
    root.querySelector('.sheet-app').$sheet = {
      doc: () => JSON.parse(JSON.stringify(doc)),
      path: () => path,
      dirty: () => dirty,
    };

    return {
      onClose() {
        if (!dirty) { off(); return true; }
        const done = (a) => {
          mask.remove();
          if (a === 'save') save(false).then((ok) => { if (ok) { off(); dirty = false; bus.close(); } });
          else if (a === 'discard') { off(); dirty = false; bus.close(); }
        };
        const box = el('div', { class: 'modal-box' },
          el('h3', {}, '有未保存的更改'),
          el('div', { class: 'm-body' }, `「${path ? fs.basename(path) : '未命名'}」尚未保存,关闭窗口将丢失这些更改。`),
          el('div', { class: 'modal-actions' },
            el('button', { class: 'btn', onClick: () => done('discard') }, '不保存'),
            el('button', { class: 'btn', onClick: () => done('cancel') }, '取消'),
            el('button', { class: 'btn primary', onClick: () => done('save') }, '保存并关闭')));
        const mask = el('div', { class: 'modal-mask' }, box);
        mask.addEventListener('pointerdown', (e) => { if (e.target === mask) done('cancel'); });
        document.body.append(mask);
        return false;
      },
    };
  },
});
