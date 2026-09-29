/* ============================================================
 * 应用:数据库(SQL 查询器)
 *
 * 只读查询任意 .awdb 分页文档库(AetherWebDatabase):
 *   · 打开前须选择数据库文件地址 + 密码(明文库密码留空);
 *   · 仅支持 SELECT(SQL 引擎本身无 DML/DDL,写入语句直接解析报错);
 *   · 结果表格分页,每页 10 行;
 *   · 侧栏列出库内集合(表),点击填入查询模板。
 * 查询经集合物化:大库首查较慢(解密+解析),之后热查毫秒级。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './dbviewer.css';
import { requireLogin } from '../../core/loginpanel.js';
import { reopen } from '../../core/wm.js';
import fsCore, { fsReady, joinPath, parentPath, homePath } from '../../core/fs.js';
import { open, createFileBackend } from '../../../vendor/AetherWebDatabase/src/index.js';

const PAGE_SIZE = 10;
const AWDB_RE = /\.awdb$/i;

let openSeq = 0;   // open() 库名后缀,避免与 appdata 常驻句柄撞名

register({
  ...manifest,
  mount({ root, setTitle, bus, dialogs, fs, user }) {
    if (requireLogin(root, '数据库', () => { root.innerHTML = ''; reopen('dbviewer'); })) return;

    let db = null;
    let dbPath = null;
    let rows = [];
    let page = 0;
    let busy = false;
    let lastSql = '';
    let sqlArea = null;
    let resultHost = null;
    let tbPath = null;
    let mode = 'sql';        // 'sql' | 'builder'
    let builder = null;      // 生成器状态(见 newBuilder)
    let builderToken = 0;    // renderBuilder 异步防重入

    const statusL = el('span', {}, '');
    const statusR = el('span', { class: 'mono' }, '');
    const side = el('div', { class: 'app-side dbv-side' });
    const body = el('div', { class: 'app-body dbv-body' });

    /* ---------- 打开库 ---------- */

    async function doOpen(path, password) {
      path = String(path || '').trim();
      if (!path || busy) return;
      if (!fsCore.exists(path)) {
        dialogs.error({ title: '打开失败', message: '文件不存在', detail: path });
        return;
      }
      busy = true;
      statusL.textContent = '正在打开…';
      statusL.style.color = '';
      try {
        if (db) { db.close(); db = null; }
        /* 密码为空按明文打开;对明文库传入密码会触发"升级加密"写操作,故仅在
         * 用户明确输入时传递。 */
        db = await open(`dbv-${++openSeq}`, {
          storage: createFileBackend(fsCore, path, { as: user }),
          password: password || undefined,
        });
        dbPath = path;
        rows = [];
        page = 0;
        lastSql = '';
        if (tbPath) tbPath.textContent = path;
        renderWorkspace();
        bus.notify('数据库已打开', path);
      } catch (e) {
        db = null;
        dbPath = null;
        const enc = /需要密码|加密/.test(String(e?.message));
        dialogs.error({
          title: '打开失败',
          message: enc ? '密码错误或库已损坏' : String(e?.message || e),
          detail: enc ? '加密库需要正确密码才能解密读取。' : path,
        });
        renderConnect();
      } finally {
        busy = false;
      }
    }

    /* ---------- 连接屏 ---------- */

    function renderConnect() {
      setTitle('数据库');
      side.innerHTML = '';
      body.innerHTML = '';
      statusL.textContent = '未连接';
      statusL.style.color = '';
      statusR.textContent = '';
      if (tbPath) tbPath.textContent = '';
      mode = 'sql';
      modeSeg.style.visibility = 'hidden';
      segSql?.classList.add('active');
      segBuilder?.classList.remove('active');

      const pathInput = el('input', {
        class: 'input mono dbv-path-input',
        placeholder: '/home/<用户>/appdata/<应用>.awdb',
        spellcheck: 'false',
      });
      const passInput = el('input', { class: 'input', type: 'password', placeholder: '密码(明文库留空)' });
      const tryOpen = () => doOpen(pathInput.value, passInput.value);
      passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryOpen(); });
      pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passInput.focus(); });

      /* 默认路径:家目录/appdata(fs 就绪后回填) */
      void fsReady().then(() => {
        if (!pathInput.value && homePath(user)) pathInput.value = joinPath(homePath(user), 'appdata') + '/';
      });

      body.append(el('div', { class: 'dbv-connect' },
        el('div', { class: 'card dbv-connect-card' },
          el('div', { class: 'card-title' }, icon('grid', 15), '打开数据库'),
          el('div', { class: 'dim', style: { fontSize: '12px', margin: '2px 0 14px' } },
            '选择一个 .awdb 分页文档库,只读执行 SQL SELECT 查询。'),
          el('div', { class: 'dbv-field' },
            el('label', { class: 'dbv-label' }, '数据库地址'),
            el('div', { class: 'row', style: { gap: '6px' } },
              pathInput,
              el('button', {
                class: 'btn icon', title: '浏览选择 .awdb 文件',
                onClick: () => openBrowser((p) => { pathInput.value = p; passInput.focus(); }),
              }, icon('folder', 14)))),
          el('div', { class: 'dbv-field' },
            el('label', { class: 'dbv-label' }, '密码'),
            passInput),
          el('button', { class: 'btn primary', style: { width: '100%', marginTop: '14px' }, onClick: tryOpen },
            icon('lock', 13), '打开')),
        el('div', { class: 'dim dbv-connect-hint' },
          '· 加密库(如 webos 应用的 appdata)需要创建时设置的密码;明文库留空。',
          el('br'),
          '· 仅支持 SELECT;写入类语句会被引擎拒绝,不会改动数据。')));
      renderSideIdle();
    }

    function renderSideIdle() {
      side.innerHTML = '';
      side.append(el('div', { class: 'empty', style: { padding: '30px 8px' } },
        icon('grid', 34), '尚未连接数据库'));
    }

    /* ---------- 文件浏览(选 .awdb) ---------- */

    function openBrowser(onPick) {
      const list = el('div', { class: 'dbv-browser-list' });
      const crumb = el('div', { class: 'dbv-browser-path mono' }, '');
      const overlay = el('div', { class: 'dbv-browser' },
        el('div', { class: 'card dbv-browser-card' },
          el('div', { class: 'row', style: { alignItems: 'center', gap: '8px', marginBottom: '10px' } },
            el('b', { style: { fontSize: '13px' } }, '选择数据库文件'),
            el('span', { class: 'grow' }),
            el('button', { class: 'icon-btn', title: '关闭', onClick: () => overlay.remove() }, icon('close', 12))),
          crumb, list));
      body.append(overlay);

      let cwd = null;
      function load(dir) {
        cwd = dir;
        crumb.textContent = cwd;
        list.innerHTML = '';
        const entries = fsCore.list(cwd, { as: user });
        if (!entries) {
          list.append(el('div', { class: 'dim', style: { padding: '12px' } }, '无法读取该目录(权限或不存在)'));
          return;
        }
        if (parentPath(cwd) !== cwd) {
          list.append(el('button', { class: 'dbv-browser-item', onClick: () => load(parentPath(cwd)) },
            el('span', { class: 'ni' }, icon('reply', 14)), '..', el('span', { class: 'dim dbv-browser-meta' }, '上级目录')));
        }
        for (const e of entries) {
          if (e.dir) {
            list.append(el('button', { class: 'dbv-browser-item', onClick: () => load(e.path) },
              el('span', { class: 'ni' }, icon('folder', 14)), e.name,
              el('span', { class: 'dim dbv-browser-meta' }, '')));
          } else if (AWDB_RE.test(e.name)) {
            list.append(el('button', {
              class: 'dbv-browser-item dbv-browser-file',
              onClick: () => { overlay.remove(); onPick(e.path); },
            },
              el('span', { class: 'ni' }, icon('file', 14)), e.name,
              el('span', { class: 'dim dbv-browser-meta' }, fmtSize(e.size))));
          }
        }
        if (!list.children.length || (list.children.length === 1 && !entries.some((e) => e.dir || AWDB_RE.test(e.name)))) {
          list.append(el('div', { class: 'dim', style: { padding: '12px' } }, '此目录下没有 .awdb 文件或子目录'));
        }
      }
      load(homePath(user) || '/');
    }

    /* ---------- 工作区 ---------- */

    async function renderWorkspace() {
      setTitle(`数据库 — ${dbPath}`);
      modeSeg.style.visibility = '';
      const colNames = await db.listCollections();
      statusL.textContent = `${colNames.length} 个集合 · 只读`;
      statusL.style.color = '';
      statusR.textContent = '';
      side.innerHTML = '';
      side.append(el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '4px 10px 8px' } }, '集合(表)'));
      if (!colNames.length) {
        side.append(el('div', { class: 'dim', style: { padding: '0 10px' } }, '(空库,没有集合)'));
      }
      for (const name of colNames) {
        const cnt = el('span', { class: 'dim', style: { marginLeft: 'auto', fontSize: '11.5px' } }, '…');
        side.append(el('button', {
          class: 'nav-item',
          title: `SELECT * FROM ${name} LIMIT 100`,
          onClick: () => { sqlArea.value = `SELECT * FROM ${name} LIMIT 100`; sqlArea.focus(); },
        }, el('span', { class: 'ni' }, icon('grid', 15)), name, cnt));
        /* count() 无条件时是目录键计数,O(1),大库也即时 */
        db.collection(name).count().then((n) => { cnt.textContent = String(n); }).catch(() => { cnt.textContent = '?'; });
      }
      side.append(el('div', { class: 'card', style: { margin: '12px 10px', padding: '10px' } },
        el('div', { style: { fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' } },
          icon(db.encrypted ? 'lock' : 'circle', 12),
          db.encrypted ? '页级加密库' : '明文库'),
        el('div', { class: 'dim mono', style: { fontSize: '10.5px', marginTop: '6px', wordBreak: 'break-all' } }, dbPath)));

      renderTop();
      renderResult();
    }

    function setMode(m) {
      mode = m;
      segSql?.classList.toggle('active', m === 'sql');
      segBuilder?.classList.toggle('active', m === 'builder');
      if (m === 'sql') renderEditor();
      else renderBuilder();
    }

    function renderTop() { setMode(mode); }

    function renderEditor() {
      const ed = el('div', { class: 'dbv-editor' });
      sqlArea = el('textarea', {
        class: 'input mono dbv-sql',
        placeholder: 'SELECT … FROM 表 [JOIN … ON …] [WHERE …] [ORDER BY …] [LIMIT n OFFSET m]',
        spellcheck: 'false',
      });
      sqlArea.value = lastSql;
      const run = () => runQuery(sqlArea.value);
      sqlArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
        if (e.key === 'F5') { e.preventDefault(); run(); }
      });
      const runBtn = el('button', { class: 'btn primary icon', title: '执行(Ctrl+Enter / F5)', onClick: run },
        icon('play', 13), '执行');
      ed.append(sqlArea, runBtn);
      body.innerHTML = '';
      resultHost = el('div', { class: 'dbv-result-host' });
      body.append(ed, resultHost);
      sqlArea.focus();
    }

    /* ---------- 查询生成器(纯 GUI 构建 SQL,Navicat 式) ---------- */

    const OPS = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];
    const NO_VALUE = new Set(['IS NULL', 'IS NOT NULL']);
    const SQL_KW = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
      'AS', 'JOIN', 'INNER', 'LEFT', 'OUTER', 'ON', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS',
      'NULL', 'TRUE', 'FALSE', 'ASC', 'DESC', 'EXISTS', 'DISTINCT']);
    const AGG_FNS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];

    function newBuilder(table) {
      return {
        table,                                  // FROM 主表(别名 t)
        join: null,                             // { table, type: 'INNER'|'LEFT', lf, rf }(别名 j)
        cols: new Set(),                        // 勾选列('t.field');空 = *
        conds: [],                              // { field, op, value }
        joiner: 'AND',                          // 条件间连接词(全局)
        orders: [],                             // { field, desc }
        groupBy: '',                            // 't.field' 或 ''
        aggs: [],                               // { fn, field } field 可 '*'
        limit: '100',
        meta: {},                               // 表名 → { order: 字段序, types: 字段→类型 }
      };
    }

    /** 采样前 20 行发现字段与类型(物化后,无额外 IO) */
    async function fieldsOf(table) {
      if (!table) return { order: [], types: {} };
      if (builder?.meta?.[table]) return builder.meta[table];
      const docs = await db.collection(table).loadAll();
      const order = [];
      const types = {};
      for (const d of docs.slice(0, 20)) {
        for (const [k, v] of Object.entries(d)) {
          if (!order.includes(k)) order.push(k);
          if (types[k] == null && v != null) {
            types[k] = Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;
          }
        }
      }
      order.sort((a, b) => (a === 'id' ? -1 : b === 'id' ? 1 : 0) || a.localeCompare(b, 'zh'));
      const meta = { order, types };
      if (builder) (builder.meta ??= {})[table] = meta;
      return meta;
    }

    /** 两表全部字段(带别名前缀 key 't.f' / 'j.f') */
    function allFields() {
      if (!builder?.table) return [];
      const out = [];
      const push = (alias, table) => {
        for (const f of builder.meta[table]?.order ?? []) {
          out.push({ key: `${alias}.${f}`, alias, field: f, type: builder.meta[table]?.types[f] });
        }
      };
      push('t', builder.table);
      if (builder.join?.table) push('j', builder.join.table);
      return out;
    }

    /* 标识符/字面量安全引用(中文字段名等走双引号标识符) */
    function qid(name) {
      return /^[A-Za-z_$][\w$]*$/.test(name) && !SQL_KW.has(String(name).toUpperCase())
        ? name
        : `"${String(name).replace(/"/g, '""')}"`;
    }
    function qcol(key) {
      const dot = key.indexOf('.');
      return `${key.slice(0, dot)}.${qid(key.slice(dot + 1))}`;
    }
    function qval(raw, type) {
      const v = String(raw ?? '').trim();
      if (v === '') return null;
      if (/^(true|false)$/i.test(v)) return v.toLowerCase();
      if (type === 'number' && v !== '' && !Number.isNaN(+v)) return String(+v);
      return `'${v.replace(/'/g, "''")}'`;
    }

    function buildSQL() {
      const b = builder;
      if (!b?.table) return '';
      const sel = [];
      if (b.groupBy) {
        sel.push(qcol(b.groupBy));
        const aggs = b.aggs.length ? b.aggs : [{ fn: 'COUNT', field: '*' }];
        for (const a of aggs) {
          const f = a.field === '*' ? '*' : qcol(a.field);
          const tail = a.field === '*' ? 'all' : a.field.split('.').pop();
          sel.push(`${a.fn}(${f}) AS ${qid(`${a.fn.toLowerCase()}_${tail}`)}`);
        }
      } else if (b.cols.size) {
        for (const c of b.cols) sel.push(qcol(c));
      } else {
        sel.push(b.join?.table ? 't.*, j.*' : '*');
      }
      const parts = [`SELECT ${sel.join(', ')}`, `FROM ${qid(b.table)} t`];
      if (b.join?.table && b.join.lf && b.join.rf) {
        parts.push(`${b.join.type} JOIN ${qid(b.join.table)} j ON ${qcol(b.join.lf)} = ${qcol(b.join.rf)}`);
      }
      const fs = allFields();
      const typeOf = (key) => fs.find((f) => f.key === key)?.type;
      if (b.conds.length) {
        const cs = [];
        for (const c of b.conds) {
          if (!c.field) continue;
          const col = qcol(c.field);
          if (NO_VALUE.has(c.op)) { cs.push(`${col} ${c.op}`); continue; }
          if (c.op === 'IN' || c.op === 'NOT IN') {
            const vals = String(c.value ?? '').split(',').map((s) => s.trim())
              .filter(Boolean).map((s) => qval(s, typeOf(c.field))).filter(Boolean);
            if (vals.length) cs.push(`${col} ${c.op} (${vals.join(', ')})`);
            continue;
          }
          if (c.op === 'BETWEEN') {
            const [lo, hi] = String(c.value ?? '').split(',').map((s) => s.trim());
            const qlo = qval(lo, typeOf(c.field));
            const qhi = qval(hi, typeOf(c.field));
            if (qlo != null && qhi != null) cs.push(`${col} BETWEEN ${qlo} AND ${qhi}`);
            continue;
          }
          const v = qval(c.value, typeOf(c.field));
          if (v != null) cs.push(`${col} ${c.op} ${v}`);
        }
        if (cs.length) parts.push(`WHERE ${cs.join(` ${b.joiner} `)}`);
      }
      if (b.groupBy) parts.push(`GROUP BY ${qcol(b.groupBy)}`);
      const os = b.orders.filter((o) => o.field).map((o) => `${qcol(o.field)} ${o.desc ? 'DESC' : 'ASC'}`);
      if (os.length) parts.push(`ORDER BY ${os.join(', ')}`);
      const lim = String(b.limit ?? '').trim();
      if (lim && !Number.isNaN(+lim) && +lim >= 0) parts.push(`LIMIT ${+lim}`);
      return parts.join(' ');
    }

    async function renderBuilder() {
      const tok = ++builderToken;
      const colNames = await db.listCollections();
      if (!builder || !colNames.includes(builder.table)) builder = newBuilder(colNames[0] ?? '');
      await fieldsOf(builder.table);
      if (builder.join?.table) await fieldsOf(builder.join.table);
      if (tok !== builderToken) return;   // 期间又触发了重建

      body.innerHTML = '';
      resultHost = el('div', { class: 'dbv-result-host' });
      const host = el('div', { class: 'dbv-builder' });
      const preview = el('div', { class: 'mono dbv-preview' }, '');
      const updatePreview = () => { preview.textContent = buildSQL() || '(选择表后生成 SQL)'; };
      const rerender = () => renderBuilder();
      const b = builder;
      const hasJoin = !!b.join?.table;

      /* --- FROM / JOIN / LIMIT --- */
      const tableSel = el('select', { class: 'select dbv-sel' },
        ...colNames.map((n) => el('option', { value: n, selected: n === b.table ? '' : null }, n)));
      tableSel.value = b.table;
      tableSel.addEventListener('change', () => { builder = newBuilder(tableSel.value); rerender(); });

      const joinTypeSel = el('select', { class: 'select dbv-sel dbv-op' },
        el('option', { value: '' }, '不连接'),
        el('option', { value: 'INNER' }, 'INNER JOIN'),
        el('option', { value: 'LEFT' }, 'LEFT JOIN'));
      const joinableTables = colNames.filter((n) => n !== b.table);
      const joinTableSel = el('select', { class: 'select dbv-sel' },
        el('option', { value: '' }, '(选择表)'),
        ...joinableTables.map((n) => el('option', { value: n }, n)));
      const fieldSel = (val, onChange, withStar = false) => {
        const s = el('select', { class: 'select dbv-sel' });
        s.append(el('option', { value: '' }, '(字段)'));
        if (withStar) s.append(el('option', { value: '*' }, '*'));
        for (const f of allFields()) {
          s.append(el('option', { value: f.key }, hasJoin ? `${f.field}(${f.alias})` : f.field));
        }
        s.value = val ?? '';
        s.addEventListener('change', () => { onChange(s.value); updatePreview(); });
        return s;
      };
      const joinLf = fieldSel(b.join?.lf ?? '', (v) => { b.join.lf = v; });
      const joinRf = fieldSel(b.join?.rf ?? '', (v) => { b.join.rf = v; });
      if (b.join) {
        joinTypeSel.value = b.join.type;
        joinTableSel.value = b.join.table;
      }
      joinTypeSel.addEventListener('change', () => {
        if (!joinTypeSel.value) { b.join = null; rerender(); return; }
        b.join = { table: joinTableSel.value || joinableTables[0] || '', type: joinTypeSel.value, lf: '', rf: '' };
        rerender();
      });
      joinTableSel.addEventListener('change', () => {
        if (!joinTableSel.value) { b.join = null; } else if (b.join) { b.join.table = joinTableSel.value; b.join.lf = ''; b.join.rf = ''; }
        else { b.join = { table: joinTableSel.value, type: joinTypeSel.value || 'INNER', lf: '', rf: '' }; }
        rerender();
      });
      const limitInput = el('input', { class: 'input dbv-limit', type: 'number', min: '0', placeholder: '∞', value: b.limit });
      limitInput.addEventListener('input', () => { b.limit = limitInput.value; updatePreview(); });

      host.append(
        el('div', { class: 'dim dbv-bsec' }, '表(FROM)'),
        el('div', { class: 'row dbv-brow' }, tableSel,
          el('span', { class: 'dim' }, '· 连接(JOIN):'), joinTypeSel, joinTableSel,
          hasJoin ? el('span', { class: 'dim' }, 'ON') : null,
          hasJoin ? joinLf : null, hasJoin ? el('span', { class: 'dim' }, '=') : null, hasJoin ? joinRf : null,
          el('span', { class: 'grow' }), el('span', { class: 'dim' }, 'LIMIT'), limitInput));

      /* --- SELECT 列(勾选) --- */
      const chips = el('div', { class: 'dbv-chips' });
      if (b.groupBy) {
        chips.append(el('span', { class: 'dim', style: { fontSize: '11.5px' } }, '分组模式下:输出 = 分组字段 + 下方聚合'));
      } else {
        for (const f of allFields()) {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = b.cols.has(f.key);
          cb.addEventListener('change', () => { cb.checked ? b.cols.add(f.key) : b.cols.delete(f.key); updatePreview(); });
          chips.append(el('label', { class: 'dbv-chip', title: f.key }, cb, f.field));
        }
        if (!allFields().length) chips.append(el('span', { class: 'dim', style: { fontSize: '11.5px' } }, '(空表,无字段)'));
      }
      host.append(el('div', { class: 'dim dbv-bsec' }, '显示列(SELECT,不选 = 全部)'), chips);

      /* --- WHERE 条件行 --- */
      const condHost = el('div', { class: 'dbv-rows' });
      const condRow = (c, idx) => {
        const opS = el('select', { class: 'select dbv-sel dbv-op' }, ...OPS.map((o) => el('option', { value: o }, o)));
        opS.value = c.op ?? '=';
        const valueEl = NO_VALUE.has(opS.value)
          ? el('span', { class: 'dim', style: { fontSize: '11px', alignSelf: 'center' } }, opS.value === 'IS NULL' ? '空值' : '非空')
          : (() => {
            const ph = c.op === 'LIKE' || c.op === 'NOT LIKE' ? '如 %abc'
              : c.op === 'IN' || c.op === 'NOT IN' ? '逗号分隔: a, b'
                : c.op === 'BETWEEN' ? '低值, 高值' : '值';
            const i = el('input', { class: 'input dbv-val', placeholder: ph, value: c.value ?? '' });
            i.addEventListener('input', () => { c.value = i.value; updatePreview(); });
            return i;
          })();
        opS.addEventListener('change', () => { c.op = opS.value; c.value = ''; rerender(); });
        return el('div', { class: 'row dbv-brow' },
          fieldSel(c.field, (v) => { c.field = v; }),
          opS, valueEl,
          el('button', {
            class: 'icon-btn', title: '删除条件',
            onClick: () => { b.conds.splice(idx, 1); rerender(); },
          }, icon('close', 11)));
      };
      b.conds.forEach((c, i) => condHost.append(condRow(c, i)));
      const joinerSeg = el('div', { class: 'seg' },
        ...['AND', 'OR'].map((j) => el('button', {
          class: 'seg-btn' + (b.joiner === j ? ' active' : ''),
          onClick: () => { b.joiner = j; joinerSeg.querySelectorAll('.seg-btn').forEach((x, k) => x.classList.toggle('active', ['AND', 'OR'][k] === j)); updatePreview(); },
        }, j)));
      host.append(
        el('div', { class: 'dim dbv-bsec' }, '条件(WHERE)'),
        condHost,
        el('div', { class: 'row dbv-brow' },
          el('button', {
            class: 'btn icon',
            onClick: () => { b.conds.push({ field: '', op: '=', value: '' }); rerender(); },
          }, icon('plus', 12), '添加条件'),
          b.conds.length > 1 ? joinerSeg : null));

      /* --- ORDER BY --- */
      const orderHost = el('div', { class: 'dbv-rows' });
      b.orders.forEach((o, i) => {
        const dirSel = el('select', { class: 'select dbv-sel dbv-op' },
          el('option', { value: '' }, '升序'),
          el('option', { value: '1' }, '降序'));
        dirSel.value = o.desc ? '1' : '';
        dirSel.addEventListener('change', () => { o.desc = !!dirSel.value; updatePreview(); });
        orderHost.append(el('div', { class: 'row dbv-brow' },
          fieldSel(o.field, (v) => { o.field = v; }), dirSel,
          el('button', { class: 'icon-btn', title: '删除排序', onClick: () => { b.orders.splice(i, 1); rerender(); } }, icon('close', 11))));
      });
      host.append(
        el('div', { class: 'dim dbv-bsec' }, '排序(ORDER BY)'),
        orderHost,
        el('button', { class: 'btn icon', onClick: () => { b.orders.push({ field: '', desc: false }); rerender(); } },
          icon('plus', 12), '添加排序'));

      /* --- GROUP BY + 聚合 --- */
      const groupSel = fieldSel(b.groupBy, (v) => { b.groupBy = v; rerender(); });
      groupSel.firstChild.textContent = '(不分组)';
      const aggHost = el('div', { class: 'dbv-rows' });
      b.aggs.forEach((a, i) => {
        const fnSel = el('select', { class: 'select dbv-sel dbv-op' }, ...AGG_FNS.map((f) => el('option', { value: f }, f)));
        fnSel.value = a.fn;
        fnSel.addEventListener('change', () => { a.fn = fnSel.value; if (a.fn !== 'COUNT') a.field = a.field === '*' ? '' : a.field; rerender(); });
        aggHost.append(el('div', { class: 'row dbv-brow' },
          fnSel,
          fieldSel(a.field, (v) => { a.field = v; }, a.fn === 'COUNT'),
          el('button', { class: 'icon-btn', title: '删除聚合', onClick: () => { b.aggs.splice(i, 1); rerender(); } }, icon('close', 11))));
      });
      host.append(
        el('div', { class: 'dim dbv-bsec' }, '分组(GROUP BY)与聚合'),
        el('div', { class: 'row dbv-brow' }, groupSel,
          el('button', { class: 'btn icon', onClick: () => { b.aggs.push({ fn: 'COUNT', field: '*' }); rerender(); } },
            icon('plus', 12), '添加聚合'),
          el('span', { class: 'dim', style: { fontSize: '11px', alignSelf: 'center' } }, b.groupBy ? '不选聚合时默认 COUNT(*)' : '选择分组字段后生效')),
        aggHost);

      /* --- 预览与操作 --- */
      host.append(
        el('div', { class: 'dim dbv-bsec' }, 'SQL 预览'), preview,
        el('div', { class: 'row dbv-brow' },
          el('button', { class: 'btn primary icon', onClick: () => runQuery(buildSQL()) }, icon('play', 13), '执行'),
          el('button', {
            class: 'btn icon', title: '把生成的 SQL 填入编辑器继续手写',
            onClick: () => { const sql = buildSQL(); setMode('sql'); sqlArea.value = sql; sqlArea.focus(); },
          }, icon('pencil', 12), '在编辑器中打开'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn', onClick: () => { builder = null; rerender(); } }, '重置')));

      body.append(host, resultHost);
      updatePreview();
    }

    async function runQuery(sqlText) {
      sqlText = String(sqlText || '').trim().replace(/;\s*$/, '');
      if (!sqlText || !db || busy) return;
      if (!/^select\b/i.test(sqlText)) {
        showError(new Error('仅支持 SELECT 查询(本应用为只读)'));
        return;
      }
      busy = true;
      statusL.textContent = '查询中…';
      statusL.style.color = '';
      try {
        const t0 = performance.now();
        rows = await db.sql(sqlText);
        lastSql = sqlText;
        page = 0;
        const ms = performance.now() - t0;
        statusL.textContent = `${rows.length} 行`;
        statusR.textContent = `${ms.toFixed(ms < 100 ? 1 : 0)} ms`;
        renderResult();
      } catch (e) {
        rows = [];
        showError(e);
      } finally {
        busy = false;
      }
    }

    function showError(e) {
      const msg = String(e?.message || e);
      statusL.textContent = '查询失败';
      statusL.style.color = '#ef4444';
      if (resultHost) {
        resultHost.innerHTML = '';
        resultHost.append(el('div', { class: 'dbv-error' },
          icon('info', 14),
          el('div', {}, el('b', {}, 'SQL 错误'), el('div', { class: 'mono', style: { whiteSpace: 'pre-wrap' } }, msg))));
      }
      console.warn('[dbviewer] SQL 失败:', e);
    }

    /* ---------- 结果表格 + 分页 ---------- */

    function renderResult() {
      if (!resultHost) return;
      resultHost.innerHTML = '';
      if (!rows.length) {
        resultHost.append(el('div', { class: 'empty' }, icon('check', 36), '没有匹配的行'));
        return;
      }
      /* 列 = 首行键序在前,后续行新键追加 */
      const cols = [];
      for (const r of rows) {
        for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
      }
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      const slice = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

      const thead = el('tr', {}, ...cols.map((c) => el('th', {}, c)));
      const tbody = el('tbody');
      for (const r of slice) {
        tbody.append(el('tr', {}, ...cols.map((c) => {
          const v = r[c];
          const cell = el('td', { class: 'mono' });
          if (v === null || v === undefined) {
            cell.classList.add('dbv-null');
            cell.textContent = 'NULL';
          } else if (typeof v === 'object') {
            cell.textContent = JSON.stringify(v);
          } else {
            cell.textContent = String(v);
          }
          const text = cell.textContent;
          if (text.length > 60) cell.title = text;
          return cell;
        })));
      }
      const table = el('table', { class: 'dbv-table' }, el('thead', {}, thead), tbody);

      const prev = el('button', { class: 'btn icon', title: '上一页', disabled: page <= 0 ? '' : null },
        icon('reply', 12), '上一页');
      const next = el('button', { class: 'btn icon', title: '下一页', disabled: page >= pages - 1 ? '' : null },
        '下一页', icon('send', 12));
      prev.addEventListener('click', () => { if (page > 0) { page--; renderResult(); } });
      next.addEventListener('click', () => { if (page < pages - 1) { page++; renderResult(); } });
      const pager = el('div', { class: 'dbv-pager row' },
        prev,
        el('span', { class: 'dbv-page-ind mono' }, `第 ${page + 1} / ${pages} 页`),
        next,
        el('span', { class: 'grow' }),
        el('span', { class: 'dim', style: { fontSize: '11.5px' } }, `共 ${rows.length} 行 · 每页 ${PAGE_SIZE} 行`));

      resultHost.append(el('div', { class: 'dbv-table-wrap' }, table), pager);
    }

    /* ---------- 布局 ---------- */

    const segSql = el('button', { class: 'seg-btn active', title: '手写 SQL', onClick: () => setMode('sql') }, 'SQL');
    const segBuilder = el('button', { class: 'seg-btn', title: '查询生成器(纯点选构建 SQL)', onClick: () => setMode('builder') }, '生成器');
    const modeSeg = el('div', { class: 'seg', style: { visibility: 'hidden' } }, segSql, segBuilder);

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        el('b', { style: { fontSize: '13.5px' } }, '数据库'),
        modeSeg,
        tbPath = el('span', { class: 'dim mono dbv-tb-path' }, ''),
        el('span', { class: 'grow' }),
        el('button', {
          class: 'btn', title: '关闭当前库,选择其他数据库',
          onClick: () => { if (db) { db.close(); db = null; } renderConnect(); },
        }, icon('refresh', 13), '换库')),
      el('div', { class: 'app-mid' }, side, body),
      el('div', { class: 'app-status' }, statusL, el('span', { class: 'grow' }), statusR)));

    renderConnect();

    return {
      onClose() {
        if (db) { db.close(); db = null; }
        return true;
      },
    };
  },
});

/* ---------- 工具 ---------- */

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
