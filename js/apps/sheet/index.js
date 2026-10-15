/* ============================================================
 * 应用:电子表格
 *
 * 纯表格编辑器,刻意做减法:无公式(输入以 "=" 开头也只是普通
 * 文本)、无合并单元格;保留的能力 ——
 *   · 单元格文本编辑(双击 / 回车 / 直接打字进入编辑)
 *   · 列宽拖拽调整(拖列头右缘;双击复位;宽度按 100% 文档坐标
 *     存储,缩放只影响显示,拖拽位移按当前缩放反算)
 *   · 行 / 列 / 单元格块拖拽移动:按住行头 / 列头拖动 ≥5px 触发
 *     (以内仍是点选整行 / 整列),插入到目标行 / 列之前;按住已有
 *     选区内拖动则整块(值+样式+行高)移动落位,原地点击收缩选区;
 *     行移动使排序状态失效,列移动把排序指示随列迁移;固定行区
 *     内不与区外交换
 *   · 内容自适应行高:格子文字过长自动撑高所在行,硬上限 5 行文字
 *     (约 95px,按实测单行行高换算),装不下的尾部显示 …;高度随行
 *     内容迁移(排序 / 移动 / 剪切),列宽变化联动重算
 *   · 针对单元格的样式:加粗 / 斜体 / 删除线 / 下划线 /
 *     文字颜色 / 单元格背景色,支持框选一片后批量套用
 *   · 单元格剪贴板(非编辑态 Ctrl+C/X/V,编辑态仍是输入框原生):
 *     值+样式整块覆盖式粘贴,越界自动扩容;整行/整列/全选选择裁剪到
 *     实际有内容的边界(不做整列 500 行的无限复制),空选区不接管;
 *     剪切立即清源(粘到本应用或外部程序语义一致);复制剪切同步写
 *     系统剪贴板 TSV(与记事本/Excel 互通),内部空时可读系统剪贴板
 *     按 TSV 粘纯文本;数据模块级共享跨窗口可粘
 *   · 列排序:点列头 ↕ 小钮弹升/降菜单,整行随之重排(数字 < 文本,
 *     空行恒垫底;文本按系统「文本排序」设置,默认拼音),排序状态在
 *     列头显示 ▲/▼,内容再编辑即失效清除
 *   · 固定表头行(工具栏下拉,0~3 行):钉在列头下方,不随滚动、
 *     不参与排序,随文档入档
 *   · 整表缩放(工具栏 ± 与百分比标签,50%~200%),列宽行高
 *     字号同步真实缩放(非 transform,文字不糊),缩放随文档保存
 *
 * 保存格式 .axl:带 axl:1 版本标记的 JSON 文本 ——
 *   { axl:1, rows, cols, colw:[列宽px@100%], rowh:[行高px|null],
 *     zoom, sort:{c,dir}|null, fixed:0~3, cells:{ "r,c":{...} } }
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
const ROW_H = 28;                              // 默认行高(文档坐标 px @100%)
const ROW_CAP_LINES = 5;                       // 行高硬上限按"行数":内容过长自动撑高,最多 5 行文字(约 95px),再长截断显示 …
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

const emptyDoc = () => ({ axl: 1, rows: DEF_ROWS, cols: DEF_COLS, colw: [], rowh: [], cells: {}, zoom: 1, sort: null, fixed: 0 });

/** 校验并裁剪 .axl 文本为可用文档;结构非法抛错(由调用方提示)。
 *  rowCapPx:行高上限(5 行文字换算的像素,挂载后测量得出;缺省用宽松界) */
function parseDoc(text, rowCapPx = ROW_CAP_LINES * 40) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('不是有效的 JSON'); }
  if (!d || typeof d !== 'object' || d.axl !== 1) throw new Error('缺少 axl:1 版本标记');
  const doc = emptyDoc();
  doc.rows = clamp(Math.floor(+d.rows) || DEF_ROWS, 1, MAX_ROWS);
  doc.cols = clamp(Math.floor(+d.cols) || DEF_COLS, 1, MAX_COLS);
  doc.colw = Array.isArray(d.colw)
    ? d.colw.slice(0, doc.cols).map((w) => clamp(Math.round(+w) || DEF_COL_W, MIN_COL_W, MAX_COL_W))
    : [];
  doc.rowh = Array.isArray(d.rowh)
    ? d.rowh.slice(0, doc.rows).map((v) => (Number.isFinite(+v) ? clamp(Math.round(+v), ROW_H, rowCapPx) : null))
    : [];
  doc.zoom = clamp(Math.round(+d.zoom * 10) / 10 || 1, ZOOM_MIN, ZOOM_MAX);
  if (d.sort && Number.isInteger(+d.sort.c) && +d.sort.c >= 0 && +d.sort.c < doc.cols
    && (d.sort.dir === 1 || d.sort.dir === -1)) doc.sort = { c: +d.sort.c, dir: d.sort.dir };
  doc.fixed = clamp(Math.floor(+d.fixed) || 0, 0, 3);   // 固定表头行 0~3
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

/* 单元格剪贴板(模块级:同一页面的多个表格窗口共享,跨窗口可粘)。
 * 结构 { rows, cols, cells:{ "r,c": cell } };r/c 为相对源区左上角的偏移 */
let clipData = null;

register({
  ...manifest,
  mount({ root, bus, params, setTitle, fs }) {
    let path = params.path || null;   // null = 未保存的新表格
    let dirty = false;
    let doc = emptyDoc();
    /* 选区:锚点 (r1,c1) 即样式按钮所反映的当前格,焦点 (r2,c2) 随导航/拖框移动 */
    let sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
    let editing = null;               // { r, c, input, old }
    let drag = null;                  // { mode:'cell' } 单元格拖选
    let mv = null;                    // 表头拖移 { kind:'row'|'col', from, sx, sy, moved, target }
    let pop = null;                   // 打开中的弹层(调色板 / 排序 / 固定行菜单)
    let copyMark = null;              // 本窗口的复制源虚线框(剪贴板数据在模块级)

    /* ---- DOM 骨架 ---- */
    const wrap = el('div', { class: 'sheet-wrap', tabIndex: 0 });
    const colgroup = el('colgroup');
    const thead = el('thead');
    const tbody = el('tbody');
    const table = el('table', { class: 'sheet-table' }, colgroup, thead, tbody);
    wrap.append(table);

    const nameEl = el('span', { class: 'dim sheet-name', style: { fontSize: '12.5px', marginLeft: '8px' } });
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

    function markDirty() {
      dirty = true;
      refreshChrome();
      if (autoSave && path) scheduleSave();
    }

    /* ---- 渲染 ---- */

    /** 把一个单元格的数据画到 td(文本进内层 .cell-txt,样式位 + 两色在 td 上) */
    function paint(td, r, c) {
      if (!td) return;
      const cell = cellAt(r, c);
      let txt = td.querySelector('.cell-txt');
      if (!txt) { td.textContent = ''; txt = el('div', { class: 'cell-txt' }); td.append(txt); }
      txt.textContent = cell?.t || '';
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
      /* 固定表头行:r < doc.fixed 的行钉在列头下方(不随滚动),行号着色示意;
       * 偏移量依赖各行实际行高(内容自适应后不再是统一值),由 applyFrozenTops 统一布置 */
      const fixedN = doc.fixed || 0;
      tbody.replaceChildren(...Array.from({ length: doc.rows }, (_, r) => {
        const fz = r < fixedN;
        const cls = (base) => base + (fz ? ' fz' + (r === fixedN - 1 ? ' fz-last' : '') : '');
        return el('tr', {},
          el('th', { class: cls('rowh'), dataset: { r: String(r) } }, String(r + 1)),
          ...Array.from({ length: doc.cols }, (_, c) => el('td', {
            class: fz ? 'fz' + (r === fixedN - 1 ? ' fz-last' : '') : '',
            dataset: { r: String(r), c: String(c) },
          }, el('div', { class: 'cell-txt' }))));
      }));
      for (const [k, cell] of Object.entries(doc.cells)) {
        const [r, c] = k.split(',').map(Number);
        paint(tdOf(r, c), r, c);
      }
      applyZoomStyle();
      for (let r = 0; r < doc.rows; r++) if (doc.rowh[r]) applyRowH(r);
      applyFrozenTops();
      renderSortMarks();
      renderCopyMark();
      if (fixedLabel) fixedLabel.textContent = String(fixedN);
      if (st) { wrap.scrollTop = st.t; wrap.scrollLeft = st.l; }
      renderSel();
    }

    /** 缩放件套:字号 / 默认行高 CSS 变量 / 列宽与角宽 / 自适应行高重刷 */
    function applyZoomStyle() {
      table.style.fontSize = Math.round(FONT * doc.zoom) + 'px';
      table.style.setProperty('--rowh', String(Math.round(ROW_H * doc.zoom)));
      colgroup.children[0].style.width = Math.round(CORNER_W * doc.zoom) + 'px';
      for (let c = 0; c < doc.cols; c++) colOf(c).style.width = colW(c) + 'px';
      for (let r = 0; r < doc.rows; r++) if (doc.rowh[r]) applyRowH(r);
      applyFrozenTops();
    }

    /* ---- 内容自适应行高(上限 ROW_CAP,超出截断显示 …) ---- */

    /** 隐形测量器:按文档坐标(13px 字号)量一段文本在指定列宽下的换行高度,与缩放无关 */
    const measurer = el('div', { class: 'cell-measure' });
    root.append(measurer);
    let LINE_H = 19;
    measurer.textContent = '测';
    LINE_H = measurer.offsetHeight || 19;
    const capPx = () => ROW_CAP_LINES * LINE_H + 2;   // 行高硬上限 = 5 行文字(+边框余量)
    function measureCell(text, widthDoc) {
      measurer.style.width = Math.max(16, Math.round(widthDoc) - 13) + 'px';   // 两侧 padding 6×2 + 边框 1
      measurer.textContent = text;
      return measurer.offsetHeight + 2;
    }

    /** 重算一行所需高度:行内所有格子取最大,夹到 [ROW_H, 5 行文字] */
    function autoRow(r) {
      let need = ROW_H;
      for (let c = 0; c < doc.cols; c++) {
        const t = doc.cells[cellKey(r, c)]?.t;
        if (!t) continue;
        const h = measureCell(t, doc.colw[c] || DEF_COL_W);
        if (h > need) need = h;
      }
      setRowH(r, Math.min(capPx(), need));
    }
    function setRowH(r, hDoc) {
      if ((doc.rowh[r] || ROW_H) === hDoc) return;
      doc.rowh[r] = hDoc === ROW_H ? null : hDoc;   // 默认高度不落盘
      applyRowH(r);
    }
    /** 应用一行高度到 DOM:行内联高(默认行回退 CSS 变量)+ 行级 --lc 截断行数 */
    function applyRowH(r) {
      const tr = tbody.children[r];
      if (!tr) return;
      const hDoc = doc.rowh[r] || ROW_H;
      const disp = Math.round(hDoc * doc.zoom);
      tr.style.setProperty('--lc', String(Math.max(1, Math.floor(hDoc / LINE_H))));
      for (const cel of tr.children) cel.style.height = hDoc === ROW_H ? '' : disp + 'px';
      if (r < (doc.fixed || 0)) applyFrozenTops();   // 冻结行高度变化影响下方冻结偏移
    }
    /** 固定表头行的 sticky 偏移 = 表头高 + 上方各行实际高度(缩放后取整) */
    function applyFrozenTops() {
      const fixedN = doc.fixed || 0;
      let off = ROW_H;
      for (let r = 0; r < fixedN && r < doc.rows; r++) {
        const top = Math.round(off * doc.zoom);
        for (const cel of tbody.children[r]?.children || []) cel.style.top = top + 'px';
        off += doc.rowh[r] || ROW_H;
      }
    }

    /** 选区绘制:td 高亮 + 锚点框 + 行列头联动高亮,并刷新工具栏 */
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

    /** 选区内写文本("" 清空;样式保留)。内容一变,原排序状态即不可信,清除指示;
     *  行高按新内容自适应重算 */
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
      autoRow(r);
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
     * 按第 c 列排序(dir: 1 升 / -1 降),所有行的单元格连同样式整体换位;
     * 固定表头行(doc.fixed)不参与排序。文本序跟随系统「文本排序」设置
     * (默认 zh = 拼音),'' 为码点序。
     */
    function sortCol(c, dir) {
      commitEdit();
      const fixed = doc.fixed || 0;
      const locale = settings.get('sortLocale') ?? 'zh';
      const coll = locale ? new Intl.Collator(locale, { numeric: true }) : null;
      const cmp = (ra, rb) => {
        const a = sortKeyOf(ra, c), b = sortKeyOf(rb, c);
        if (a.k !== b.k) return a.k - b.k;
        if (a.k === 0) return (a.n - b.n) * dir;
        if (a.k === 1) return (coll ? coll.compare(a.s, b.s) : (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)) * dir;
        return 0;
      };
      const all = Array.from({ length: doc.rows - fixed }, (_, i) => i + fixed);
      const order = [...all.filter((r) => sortKeyOf(r, c).k !== 2).sort(cmp),
                     ...all.filter((r) => sortKeyOf(r, c).k === 2)];
      const pos = new Array(doc.rows);                 // 旧行号 → 新行号(固定行原位)
      for (let r = 0; r < fixed; r++) pos[r] = r;
      order.forEach((oldR, i) => { pos[oldR] = i + fixed; });
      const cells = {};
      for (const [k, cell] of Object.entries(doc.cells)) {
        const i = k.indexOf(',');
        cells[pos[+k.slice(0, i)] + k.slice(i)] = cell;
      }
      doc.cells = cells;
      const rh = doc.rowh || [];                        // 行高随行内容一起迁移
      const rowh = Array.from({ length: doc.rows }, (_, i) => null);
      for (let r = 0; r < fixed; r++) rowh[r] = rh[r] ?? null;
      order.forEach((oldR, i) => { rowh[i + fixed] = rh[oldR] ?? null; });
      doc.rowh = rowh;
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
          ? `已按 ${colName(c)} 列${doc.sort.dir > 0 ? '升' : '降'}序,点击可改`
          : `按 ${colName(c)} 列排序`;
        btn.classList.toggle('on', !!on);
      }
    }

    /* ---- 单元格剪贴板(非编辑态 Ctrl+C/X/V;编辑态仍是输入框原生行为) ---- */

    /** 整行 / 整列 / 全选识别(选区覆盖整行宽度或整列高度):复制剪切时
     *  裁剪到内容边界;选区内拖动不作为整块移动(整行整列移动走表头拖拽) */
    function fullSpan(a) {
      return (a.c1 === 0 && a.c2 === doc.cols - 1) || (a.r1 === 0 && a.r2 === doc.rows - 1);
    }

    /** 复制 / 剪切选区:值+样式入模块级剪贴板,TSV 尽力写入系统剪贴板(与记事本/Excel 互通)。
     *  剪切(cut)立即清源 —— 内容与样式当场移出,粘到本应用或任何外部程序
     *  都是同一致的「移动」语义;内部剪贴板保留内容,可多次粘贴。
     *  整行/整列/全选(表头点选)裁剪到选区内实际有内容的边界矩形:只复制
     *  有内容的部分,不做整列 500 行的无限复制;选区内无内容则不接管。 */
    function copySel(cut = false) {
      let a = normSel();
      if (fullSpan(a)) {
        let br1 = -1, br2 = 0, bc1 = 0, bc2 = 0;
        for (const k of Object.keys(doc.cells)) {
          const i = k.indexOf(',');
          const r = +k.slice(0, i), c = +k.slice(i + 1);
          if (r < a.r1 || r > a.r2 || c < a.c1 || c > a.c2) continue;
          if (br1 < 0) { br1 = r; br2 = r; bc1 = c; bc2 = c; }
          else {
            if (r < br1) br1 = r;
            if (r > br2) br2 = r;
            if (c < bc1) bc1 = c;
            if (c > bc2) bc2 = c;
          }
        }
        if (br1 < 0) return;                    // 选区内无内容:不接管(原剪贴板保持)
        a = { r1: br1, r2: br2, c1: bc1, c2: bc2 };
      }
      const cells = {};
      const tsvRows = [];
      for (let r = 0; r <= a.r2 - a.r1; r++) {
        const row = [];
        for (let c = 0; c <= a.c2 - a.c1; c++) {
          const cell = doc.cells[cellKey(a.r1 + r, a.c1 + c)];
          if (cell) cells[r + ',' + c] = { ...cell };
          row.push(cell?.t ?? '');
        }
        tsvRows.push(row.join('\t'));
      }
      clipData = { rows: a.r2 - a.r1 + 1, cols: a.c2 - a.c1 + 1, cells };
      copyMark = { ...a };
      renderCopyMark();
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(tsvRows.join('\n')).catch(() => {});
      if (!cut) return;
      const touched = new Set();
      for (let r = a.r1; r <= a.r2; r++) for (let c = a.c1; c <= a.c2; c++) {
        delete doc.cells[cellKey(r, c)];
        paint(tdOf(r, c), r, c);
        touched.add(r);
      }
      for (const r of touched) autoRow(r);
      if (doc.sort) { doc.sort = null; renderSortMarks(); }
      markDirty();
    }

    /** 粘贴:内部剪贴板优先(带样式);为空时读系统剪贴板按 TSV 粘纯文本(无权限则静默) */
    async function pasteClip() {
      if (clipData) { pasteCells(clipData); return; }
      try {
        const text = await navigator.clipboard?.readText?.();
        if (text) pasteCells(tsToClip(text));
      } catch { /* 浏览器不给剪贴板读权限:忽略 */ }
    }

    /** TSV 文本 → 剪贴板结构(纯文本,不带样式) */
    function tsToClip(text) {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      while (lines.length && !lines[lines.length - 1]) lines.pop();   // 尾部空行不算宽度
      const cells = {};
      let cols = 0;
      lines.forEach((line, r) => {
        const parts = line.split('\t');
        cols = Math.max(cols, parts.length);
        parts.forEach((t, c) => { if (t) cells[r + ',' + c] = { t }; });
      });
      return { rows: lines.length, cols: Math.max(cols, 1), cells };
    }

    /** 以锚点为左上角粘贴矩形:覆盖式(矩形内无源格即清空),放不下先扩容(封顶) */
    function pasteCells(data) {
      if (!data?.rows || !data?.cols) return;
      commitEdit();
      const needR = sel.r1 + data.rows, needC = sel.c1 + data.cols;
      if (needR > doc.rows || needC > doc.cols) {
        doc.rows = Math.max(doc.rows, Math.min(MAX_ROWS, needR));
        doc.cols = Math.max(doc.cols, Math.min(MAX_COLS, needC));
        buildGrid(true);
      }
      for (let r = 0; r < data.rows; r++) for (let c = 0; c < data.cols; c++) {
        const tr = sel.r1 + r, tc = sel.c1 + c;
        if (tr >= doc.rows || tc >= doc.cols) continue;
        const src = data.cells[r + ',' + c];
        if (src) doc.cells[cellKey(tr, tc)] = { ...src };
        else delete doc.cells[cellKey(tr, tc)];
        paint(tdOf(tr, tc), tr, tc);
      }
      if (doc.sort) { doc.sort = null; renderSortMarks(); }
      copyMark = null;
      renderCopyMark();
      for (let r = 0; r < data.rows && sel.r1 + r < doc.rows; r++) autoRow(sel.r1 + r);
      markDirty();
    }

    /** 复制源虚线框(仅本窗口显示;数据在模块级,可粘到其他表格窗口) */
    function renderCopyMark() {
      for (const x of wrap.querySelectorAll('.copy-src')) x.classList.remove('copy-src');
      if (!copyMark) return;
      for (let r = copyMark.r1; r <= copyMark.r2; r++) {
        for (let c = copyMark.c1; c <= copyMark.c2; c++) tdOf(r, c)?.classList.add('copy-src');
      }
    }

    /* ---- 编辑 ---- */

    function startEdit(r, c, initial = null) {
      commitEdit();
      const td = tdOf(r, c);
      if (!td) return;
      const old = cellAt(r, c)?.t || '';
      const input = el('input', { class: 'cell-in', value: initial != null ? initial : old });
      td.classList.add('editing');   // 文本 div 由 CSS 隐藏,提交后 paint 恢复
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

    /* ---- 行 / 列拖拽移动(表头按住拖动 ≥5px 触发;插入到目标之前) ---- */

    /** 更新拖移目标:行移动不得跨越固定区,列自由,单元格块以悬停格为落位左上角 */
    function mvTarget(e) {
      const hit = hitCell(e.clientX, e.clientY);
      if (mv.kind === 'cells') {
        if (hit?.r == null || hit.c == null) return;
        if (mv.target && mv.target.r === hit.r && mv.target.c === hit.c) return;
        for (const x of wrap.querySelectorAll('.mv-to')) x.classList.remove('mv-to');
        mv.target = { r: hit.r, c: hit.c };
        const rowsN = mv.rect.r2 - mv.rect.r1 + 1, colsN = mv.rect.c2 - mv.rect.c1 + 1;
        for (let r = hit.r; r < hit.r + rowsN && r < doc.rows; r++)
          for (let c = hit.c; c < hit.c + colsN && c < doc.cols; c++)
            tdOf(r, c)?.classList.add('mv-to');
        return;
      }
      let t = null;
      if (mv.kind === 'row' && hit?.r != null) {
        const fixedN = doc.fixed || 0;
        if ((mv.from < fixedN) === (hit.r < fixedN)) t = hit.r;
      } else if (mv.kind === 'col' && hit?.c != null) {
        t = hit.c;
      }
      if (t === mv.from) t = null;
      if (t === mv.target) return;
      for (const x of wrap.querySelectorAll('.mv-ins')) x.classList.remove('mv-ins');
      mv.target = t;
      if (t != null) {
        if (mv.kind === 'row') tbody.children[t]?.classList.add('mv-ins');
        else for (const tr of tbody.children) tr.children[t + 1]?.classList.add('mv-ins');
      }
    }
    function clearMvVisual() {
      for (const x of wrap.querySelectorAll('.mv-src, .mv-ins, .mv-to')) x.classList.remove('mv-src', 'mv-ins', 'mv-to');
    }

    /** 执行移动:整行 / 整列连内容、样式、行高(列宽)一起换位;行移动使排序状态失效,
     *  列移动把排序指示随列迁移;固定行区内自行换位、不与区外交换 */
    function doMove(kind, from, t) {
      if (t === from || t < 0) return;
      commitEdit();
      const n = kind === 'row' ? doc.rows : doc.cols;
      if (t >= n) return;
      const order = Array.from({ length: n }, (_, i) => i);
      order.splice(from, 1);
      order.splice(t > from ? t - 1 : t, 0, from);
      const pos = new Array(n);                 // 旧索引 → 新索引
      order.forEach((old, i) => { pos[old] = i; });
      const cells = {};
      for (const [k, cell] of Object.entries(doc.cells)) {
        const i = k.indexOf(',');
        if (kind === 'row') cells[pos[+k.slice(0, i)] + k.slice(i)] = cell;
        else cells[k.slice(0, i + 1) + pos[+k.slice(i + 1)]] = cell;
      }
      doc.cells = cells;
      if (kind === 'row') {
        const rh = doc.rowh || [];
        doc.rowh = Array.from({ length: doc.rows }, (_, i) => rh[order[i]] ?? null);
        doc.sort = null;                        // 行序手工改变,排序状态不再可信
      } else {
        const cw = doc.colw || [];
        doc.colw = Array.from({ length: doc.cols }, (_, i) => cw[order[i]] ?? null);
        if (doc.sort) doc.sort = { c: pos[doc.sort.c], dir: doc.sort.dir };
      }
      copyMark = null;
      buildGrid(true);
      markDirty();
    }

    /** 拖拽移动单元格选区整块(值+样式):快照源块 → 清源 → 覆盖落位到锚点;
     *  与源重叠时目标覆盖(源先清);放不下先扩容(封顶);行高重算、
     *  排序状态与复制标记失效;选区随块落到目标位置 */
    function doCellMove(rect, anchor) {
      commitEdit();
      const rowsN = rect.r2 - rect.r1 + 1, colsN = rect.c2 - rect.c1 + 1;
      const snap = {};
      for (let r = 0; r < rowsN; r++) for (let c = 0; c < colsN; c++) {
        const cell = doc.cells[cellKey(rect.r1 + r, rect.c1 + c)];
        if (cell) snap[r + ',' + c] = { ...cell };
      }
      const needR = anchor.r + rowsN, needC = anchor.c + colsN;
      if (needR > doc.rows || needC > doc.cols) {
        doc.rows = Math.max(doc.rows, Math.min(MAX_ROWS, needR));
        doc.cols = Math.max(doc.cols, Math.min(MAX_COLS, needC));
        buildGrid(true);
      }
      const touched = new Set();
      for (let r = 0; r < rowsN; r++) for (let c = 0; c < colsN; c++) {   // 先清源(重叠区由目标覆盖)
        delete doc.cells[cellKey(rect.r1 + r, rect.c1 + c)];
        paint(tdOf(rect.r1 + r, rect.c1 + c), rect.r1 + r, rect.c1 + c);
        touched.add(rect.r1 + r);
      }
      for (let r = 0; r < rowsN; r++) for (let c = 0; c < colsN; c++) {
        const tr = anchor.r + r, tc = anchor.c + c;
        const src = snap[r + ',' + c];
        if (src) doc.cells[cellKey(tr, tc)] = { ...src };
        else delete doc.cells[cellKey(tr, tc)];
        paint(tdOf(tr, tc), tr, tc);
        touched.add(tr);
      }
      for (const r of touched) autoRow(r);
      if (doc.sort) { doc.sort = null; renderSortMarks(); }
      copyMark = null;
      renderCopyMark();
      sel = { r1: anchor.r, c1: anchor.c, r2: anchor.r + rowsN - 1, c2: anchor.c + colsN - 1 };
      renderSel();
      markDirty();
    }

    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.col-resize')) return;
      const hit = hitEl(e.target) || hitCell(e.clientX, e.clientY);
      if (!hit) return;
      commitEdit();
      const onSortBtn = !!e.target.closest('.col-sort');   // 排序小钮:不作为拖移起点
      if (hit.r == null) {                       // 列头:点选整列,拖动 = 移动整列
        if (e.shiftKey) sel.c2 = hit.c;
        else sel = { r1: 0, c1: hit.c, r2: doc.rows - 1, c2: hit.c };
        if (!e.shiftKey && !onSortBtn) mv = { kind: 'col', from: hit.c, sx: e.clientX, sy: e.clientY, moved: false, target: null };
      } else if (hit.c == null) {                // 行头:点选整行,拖动 = 移动整行
        if (e.shiftKey) sel.r2 = hit.r;
        else sel = { r1: hit.r, c1: 0, r2: hit.r, c2: doc.cols - 1 };
        if (!e.shiftKey) mv = { kind: 'row', from: hit.r, sx: e.clientX, sy: e.clientY, moved: false, target: null };
      } else if (e.shiftKey) {                   // 普通格 + shift:扩选
        sel.r2 = hit.r; sel.c2 = hit.c;
      } else {
        const a0 = normSel();
        const inside = hit.r >= a0.r1 && hit.r <= a0.r2 && hit.c >= a0.c1 && hit.c <= a0.c2;
        if (inside && !fullSpan(a0)) {
          /* 点在已有选区内:按住拖动 = 移动整块(Excel 式);原地点击 = 收缩为该格 */
          mv = { kind: 'cells', rect: { ...a0 }, hit: { r: hit.r, c: hit.c }, sx: e.clientX, sy: e.clientY, moved: false, target: null };
        } else {
          sel = { r1: hit.r, c1: hit.c, r2: hit.r, c2: hit.c };
          drag = { mode: 'cell' };
        }
      }
      renderSel();
      wrap.focus();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 合成事件无有效指针:跳过捕获 */ }
      e.preventDefault();
    });

    wrap.addEventListener('pointermove', (e) => {
      if (mv) {
        if (!mv.moved) {
          if (Math.hypot(e.clientX - mv.sx, e.clientY - mv.sy) < 5) return;   // 位移阈值:以内仍是点选
          mv.moved = true;
          if (mv.kind === 'row') {
            for (const cel of tbody.children[mv.from].children) cel.classList.add('mv-src');
          } else if (mv.kind === 'col') {
            for (const tr of tbody.children) tr.children[mv.from + 1]?.classList.add('mv-src');
          } else {
            for (let r = mv.rect.r1; r <= mv.rect.r2; r++)
              for (let c = mv.rect.c1; c <= mv.rect.c2; c++) tdOf(r, c)?.classList.add('mv-src');
          }
        }
        mvTarget(e);
        return;
      }
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
    const endDrag = () => {
      if (mv) {
        const { kind, from, target, moved } = mv;
        if (kind === 'cells') {
          const { rect, hit } = mv;
          mv = null;
          clearMvVisual();
          if (moved && target) doCellMove(rect, target);
          else {                                            // 原地点击:选区收缩为该格
            sel = { r1: hit.r, c1: hit.c, r2: hit.r, c2: hit.c };
            renderSel();
          }
        } else {
          mv = null;
          clearMvVisual();
          if (moved && target != null) doMove(kind, from, target);
        }
      }
      drag = null;
    };
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

    /* 角标:全选;列头 ↕ 小钮:排序菜单(升/降) */
    wrap.addEventListener('click', (e) => {
      const sortBtn = e.target.closest('.col-sort');
      if (sortBtn) {
        openSortMenu(sortBtn, +sortBtn.dataset.c);
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
        const lk = k.toLowerCase();
        const map = { b: 'b', i: 'i', u: 'u' };
        if (map[lk]) { e.preventDefault(); toggleFmt(map[lk]); return; }
        if (e.code === 'Digit5') { e.preventDefault(); toggleFmt('k'); return; }   // Excel 惯例:Ctrl+5 删除线
        if (lk === 'c') { e.preventDefault(); copySel(false); return; }  // 复制(整行/整列裁剪到内容边界)
        if (lk === 'x') { e.preventDefault(); copySel(true); return; }   // 剪切(立即清源,跨应用粘贴一致)
        if (lk === 'v') { e.preventDefault(); pasteClip(); return; }     // 粘贴
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
        case 'Escape': closePop(); copyMark = null; renderCopyMark(); break;
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
        if (moved) {
          /* 列宽变了,该列有内容的行重新自适应高度 */
          const touched = new Set();
          for (const k of Object.keys(doc.cells)) {
            const i = k.indexOf(',');
            if (+k.slice(i + 1) === c) touched.add(+k.slice(0, i));
          }
          for (const r of touched) autoRow(r);
          markDirty();
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    /* ---- 缩放(仅工具栏按钮与百分比标签,无快捷键) ---- */
    function setZoom(z) {
      const nz = clamp(Math.round(z * 10) / 10, ZOOM_MIN, ZOOM_MAX);
      if (nz === doc.zoom) return;
      doc.zoom = nz;
      zoomLabel.textContent = Math.round(nz * 100) + '%';
      applyZoomStyle();
      markDirty();
    }

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
    fgBtn.addEventListener('click', () => pop?.dataset.kind === 'fg' ? closePop() : openPalette(fgBtn, 'fg'));
    bgBtn.addEventListener('click', () => pop?.dataset.kind === 'bg' ? closePop() : openPalette(bgBtn, 'bg'));

    /* ---- 应用内弹层(调色板 / 排序菜单 / 固定行菜单共用一套定位与外点关闭) ---- */
    function openPop(btn, node) {
      closePop();
      pop = node;
      root.append(pop);
      /* 贴在按钮下方、右对齐,超出窗口内容区则夹回;下方放不下翻到上方 */
      const rb = root.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      const pb = pop.getBoundingClientRect();
      let x = bb.right - pb.width;
      let y = bb.bottom + 6;
      if (x + pb.width > rb.width - 8) x = rb.width - pb.width - 8;
      if (x < 8) x = 8;
      if (y + pb.height > rb.height - 8) y = bb.top - pb.height - 6;
      if (y < 8) y = 8;
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
      setTimeout(() => document.addEventListener('pointerdown', onPopOutside, true), 0);
    }
    function onPopOutside(e) { if (pop && !pop.contains(e.target)) closePop(); }
    function closePop() {
      if (!pop) return;
      pop.remove();
      pop = null;
      document.removeEventListener('pointerdown', onPopOutside, true);
    }

    /** 调色板弹层(文字/背景共用) */
    function openPalette(btn, kind) {
      openPop(btn, el('div', { class: 'sheet-palette', dataset: { kind } },
        el('div', { class: 'pal-title' }, kind === 'fg' ? '文字颜色' : '单元格颜色'),
        el('div', { class: 'pal-grid' },
          el('button', { class: 'btn pal-none', onClick: () => applyColor(kind, null) },
            kind === 'fg' ? '自动(无色)' : '无颜色'),
          ...PALETTE.map((hx) => el('button', {
            class: 'pal-sw', style: { background: hx }, title: hx,
            onClick: () => applyColor(kind, hx),
          })))));
    }
    function applyColor(kind, hx) {
      closePop();
      applyFormat({ [kind === 'fg' ? 'fg' : 'bg']: hx });
    }

    /** 下拉菜单行(✓ 标当前项) */
    const popItem = (label, cur, fn) => el('button', {
      class: 'pop-item' + (cur ? ' cur' : ''),
      onClick: () => { closePop(); fn(); },
    }, el('span', { class: 'pop-check' }, cur ? '✓' : ''), el('span', {}, label));

    /** 列排序菜单(挂在列头 ↕ 小钮上):升 / 降 */
    function openSortMenu(btn, c) {
      openPop(btn, el('div', { class: 'sheet-pop', dataset: { kind: 'sort' } },
        el('div', { class: 'pop-title' }, `按 ${colName(c)} 列排序`),
        popItem('↑ 升序(小 → 大)', doc.sort?.c === c && doc.sort.dir > 0, () => sortCol(c, 1)),
        popItem('↓ 降序(大 → 小)', doc.sort?.c === c && doc.sort.dir < 0, () => sortCol(c, -1))));
    }

    /** 固定表头行(0~3):钉在顶部,不随滚动、不参与排序(Numbers 式) */
    function setFixed(n) {
      if ((doc.fixed || 0) === n) return;
      doc.fixed = n;
      buildGrid(true);
      markDirty();
    }
    function openFixedMenu(btn) {
      openPop(btn, el('div', { class: 'sheet-pop', dataset: { kind: 'fixed' } },
        el('div', { class: 'pop-title' }, '固定表头行(不滚动 / 不排序)'),
        popItem('不固定', !(doc.fixed || 0), () => setFixed(0)),
        popItem('固定前 1 行', doc.fixed === 1, () => setFixed(1)),
        popItem('固定前 2 行', doc.fixed === 2, () => setFixed(2)),
        popItem('固定前 3 行', doc.fixed === 3, () => setFixed(3))));
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
      try { d = parseDoc(content, capPx()); } catch (err) {
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

    async function save(as = false, silent = false) {
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
      if (!silent) bus.notify('文件已保存', path);   // 自动保存静默,不打扰
      return true;
    }

    const fixedLabel = el('span', { class: 'sheet-fixed-n' }, String(doc.fixed || 0));
    const fixedBtn = el('button', {
      class: 'btn sheet-fixed', title: '固定表头行:钉在顶部,不随滚动、不参与排序(0~3 行),点击选择数量',
      onClick: () => (pop?.dataset.kind === 'fixed' ? closePop() : openFixedMenu(fixedBtn)),
    }, icon('pin', 13), fixedLabel, el('span', { class: 'sheet-caret' }, '▾'));

    /* 自动保存开关:图标式切换钮,.on 底色示按下;改动后 1.5s 静默写盘(需已有路径) */
    let autoSave = localStorage.getItem('webos.sheet.autosave') !== '0';   // 默认开
    let saveTimer = 0;
    const asBtn = el('button', {
      class: 'btn icon tgl' + (autoSave ? ' on' : ''),
      onClick: () => setAutoSave(!autoSave),
    }, icon('clock', 14));
    function setAutoSave(on) {
      autoSave = on;
      try { localStorage.setItem('webos.sheet.autosave', on ? '1' : '0'); } catch { /* 忽略 */ }
      asBtn.classList.toggle('on', on);
      refreshAsTitle();
      if (!on && saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      else if (on && dirty && path) scheduleSave();
    }
    function refreshAsTitle() {
      asBtn.title = autoSave
        ? '自动保存:已开启 —— 改动 1.5 秒后自动写盘(需已保存过,未命名新文档仍手动保存)'
        : '自动保存:已关闭 —— 点击开启';
    }
    refreshAsTitle();
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = 0;
        if (!autoSave || !dirty || !path) return;
        if (editing) { scheduleSave(); return; }             // 正在编辑:等提交后再存
        save(false, true);
      }, 1500);
    }

    const sep = () => el('span', { class: 'sheet-sep' });

    root.append(el('div', { class: 'app sheet-app' },
      el('div', { class: 'app-toolbar' },
        el('button', { class: 'btn icon', title: '打开(.axl 文档)', onClick: openFile }, icon('folder', 14)),
        el('button', { class: 'btn icon', title: '保存(Ctrl+S)', onClick: () => save(false) }, icon('save', 14)),
        el('button', { class: 'btn icon', title: '另存为(Ctrl+Shift+S)', onClick: () => save(true) }, icon('external', 14)),
        sep(),
        bBtn, iBtn, uBtn, kBtn,
        sep(),
        fgBtn, bgBtn,
        sep(),
        fixedBtn,
        asBtn,
        sep(),
        el('button', { class: 'btn icon', title: '缩小', onClick: () => setZoom(doc.zoom - ZOOM_STEP) }, icon('minus', 13)),
        zoomLabel,
        el('button', { class: 'btn icon', title: '放大', onClick: () => setZoom(doc.zoom + ZOOM_STEP) }, icon('plus', 13)),
        el('span', { class: 'grow' }),
        nameEl),
      wrap));

    /* 初始装载:params.path 直接开档,否则新表 */
    if (path) {
      const content = fs.read(path);
      if (content == null) { bus.notify('文件不存在', path); path = null; }
      else {
        try {
          doc = parseDoc(content, capPx());
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
