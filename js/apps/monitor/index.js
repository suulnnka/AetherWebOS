/* ============ 应用:系统监视器 —— IPC 流量观测台 ============ */
import { el, formatBytes, fmtTime } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './monitor.css';
import { subscribe, msgLog } from '../../core/bus.js';
import fs from '../../core/fs.js';
import * as wm from '../../core/wm.js';
import { WebOS } from '../../core/exports.js';

register({
  ...manifest,
  mount({ root, bus }) {
    let tab = 'overview';
    let filter = '';

    const content = el('div', { class: 'app-body' });
    const tabs = el('div', { class: 'app-toolbar' },
      el('b', { style: { fontSize: '13.5px' } }, '系统监视器'),
      el('span', { class: 'grow' }),
      el('div', { class: 'seg' },
        ...[['overview', '概览'], ['ipc', 'IPC 消息'], ['storage', '存储']].map(([id, name]) =>
          el('button', {
            class: 'seg-btn' + (id === 'overview' ? ' active' : ''),
            'data-tab': id,
            onClick: (e) => {
              tab = id;
              tabs.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
              e.currentTarget.classList.add('active');
              render();
            },
          }, name))));

    /* ---- 概览 ---- */
    function renderOverview() {
      let timer;
      const heapEl = el('div', { class: 'st-value' }, '—');
      const winEl = el('div', { class: 'st-value' }, String(wm.count()));
      const tick = () => {
        winEl.textContent = String(wm.count());
        const m = performance.memory;
        heapEl.textContent = m ? formatBytes(m.usedJSHeapSize) : '不可用';
      };
      timer = setInterval(tick, 1000);
      content.innerHTML = '';
      content.append(el('div', { class: 'stat-cards' },
        stat('clock', '运行时间', uptime(), '', null),
        el('div', { class: 'stat' }, el('div', { class: 'st-label' }, icon('grid', 13), '打开的窗口'), winEl),
        el('div', { class: 'stat' }, el('div', { class: 'st-label' }, icon('message', 13), 'IPC 消息总数'), el('div', { class: 'st-value' }, String(msgLog.length))),
        el('div', { class: 'stat' }, el('div', { class: 'st-label' }, icon('hardDrive', 13), 'JS 堆内存'), heapEl),
        stat('sliders', 'CPU 逻辑核心', String(navigator.hardwareConcurrency || '?')),
        stat('monitor', '屏幕', `${screen.width}×${screen.height}`, devicePixelRatio.toFixed(1) + 'x DPI 缩放'),
        stat('user', '浏览器内核', navigator.userAgent.includes('Firefox') ? 'Gecko' : navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome') ? 'WebKit' : 'Blink'),
        stat('info', '用户代理', '', (navigator.userAgent.slice(0, 60) + '…'), 'ua'),
      ));
      content._cleanup = timer;
    }

    function stat(ico, label, value, sub = '', type = '') {
      return el('div', { class: 'stat' },
        el('div', { class: 'st-label' }, icon(ico, 13), label),
        el('div', { class: 'st-value', style: type === 'ua' ? { fontSize: '11px', fontWeight: 400 } : {} }, value || sub),
        value && sub ? el('div', { class: 'st-sub' }, sub) : null);
    }

    const uptime = () => {
      const ms = Date.now() - WebOS.bootTime;
      const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
      return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
    };

    /* ---- IPC ---- */
    let ipcRaf = null;

    function renderIPC() {
      content.innerHTML = '';
      content.style.overflow = 'hidden';
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      const filterInput = el('input', { class: 'input', placeholder: '过滤:输入 type / from / 频道…', style: { flex: '1' } });
      filterInput.addEventListener('input', () => { filter = filterInput.value.trim().toLowerCase(); renderTable(); });
      const countEl = el('span', { class: 'dim', style: { fontSize: '12px', whiteSpace: 'nowrap' } }, '');
      const tableBox = el('div', { style: { flex: '1', overflow: 'auto' } });
      const table = el('table', { class: 'table' });

      function renderTable() {
        const rows = [...msgLog].reverse()
          .filter(m => !filter || `${m.type} ${m.from} ${m.to} ${m.topic}`.toLowerCase().includes(filter));
        countEl.textContent = `共 ${msgLog.length} 条,显示 ${rows.length} 条`;
        table.innerHTML = '';
        table.append(el('thead', {}, el('tr', {},
          el('th', {}, '时间'), el('th', {}, '来源'), el('th', {}, '目标'),
          el('th', {}, '类型'), el('th', {}, '频道'), el('th', {}, '大小'))));
        const tb = el('tbody', {});
        for (const m of rows.slice(0, 200)) {
          tb.append(el('tr', {},
            el('td', { class: 'dim mono' }, fmtTime(new Date(m.ts), true)),
            el('td', {}, m.from),
            el('td', {}, m.to),
            el('td', { class: 'mono' }, m.type),
            el('td', { class: 'dim mono' }, m.topic),
            el('td', { class: 'dim' }, formatBytes(m.bytes))));
        }
        table.append(tb);
      }

      tableBox.append(table);
      content.append(
        el('div', { class: 'ipc-filter' },
          filterInput,
          el('button', { class: 'btn', onClick: () => { msgLog.length = 0; renderTable(); } }, icon('trash', 13), '清空'),
          countEl),
        tableBox);
      renderTable();
      ipcRaf = () => renderTable();
    }

    /* ---- 存储 ---- */
    function renderStorage() {
      const st = fs.stats();
      let total = 0;
      const rows = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const size = (k.length + (localStorage.getItem(k) || '').length) * 2;
        total += size;
        rows.push({ k, size });
      }
      content.innerHTML = '';
      const box = el('div', { style: { padding: '18px 20px', maxWidth: '620px' } });
      box.append(el('div', { class: 'card', style: { marginBottom: '14px' } },
        el('div', { class: 'card-title' }, icon('hardDrive', 15), `localStorage 已用 ${formatBytes(total)} / 约 5MB`),
        el('div', { class: 'usage-bar' }, el('i', { style: { width: Math.min(100, total / (5 * 1024 * 1024) * 100) + '%' } }))));
      box.append(el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, '存储键'), el('th', {}, '用途'), el('th', {}, '大小'))),
        el('tbody', {},
          ...rows.sort((a, b) => b.size - a.size).map(r => el('tr', {},
            el('td', { class: 'mono' }, r.k),
            el('td', { class: 'dim' }, describeKey(r.k)),
            el('td', {}, formatBytes(r.size))))),
        el('tbody', {},
          el('tr', { style: { fontWeight: 600 } },
            el('td', {}, `虚拟文件系统:${st.files} 文件 / ${st.dirs} 目录`),
            el('td', { class: 'dim' }, '内容总量'),
            el('td', {}, formatBytes(st.bytes))))));
      content.append(box);
    }

    function describeKey(k) {
      return { 'webos.settings.v1': '系统设置', 'webos.fs.v1': '虚拟文件系统', 'webos.iconpos.v1': '桌面图标位置' }[k] || '—';
    }

    function render() {
      if (content._cleanup) { clearInterval(content._cleanup); content._cleanup = null; }
      ipcRaf = null;
      content.style.overflow = '';
      content.style.display = '';
      content.style.flexDirection = '';
      if (tab === 'overview') renderOverview();
      else if (tab === 'ipc') renderIPC();
      else renderStorage();
    }

    root.append(el('div', { class: 'app' }, tabs, content));
    render();

    // IPC:响应终端等应用的 sysinfo 请求(request/response 演示的服务端)
    const offReq = bus.on('stats', (p, msg) => {
      msg.reply?.({
        windows: wm.count(),
        messages: msgLog.length,
        boot: WebOS.bootTime,
        storage: fs.stats(),
      });
    });

    // IPC 页面实时刷新:任何消息到达时若在 IPC 页则更新表格
    const offAll = subscribe('*', () => { if (tab === 'ipc' && ipcRaf) ipcRaf(); });
    const offFs = bus.onSys('fs-changed', () => { if (tab === 'storage') renderStorage(); });

    return {
      onClose() {
        if (content._cleanup) clearInterval(content._cleanup);
        offReq(); offAll(); offFs();
        return true;
      },
    };
  },
});
