/* ============================================================
 * 应用:地图
 * 基于百度地图 JS API GL(WebGL 版,BD-09 坐标系),AK 为浏览器测试密钥:
 * 地点搜索(分页)/ 标准·卫星·混合图切换 / 路况图层 /
 * 点击取坐标 / 距离测量 / 浏览器定位
 * GL 版 centerAndZoom 只接受 Point,城市名统一走 Geocoder/LocalCity。
 * ============================================================ */
import { el, escapeHtml } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './map.css';

const AK = 'M6gP5GsIPshSgOh7JnGgnxgXlEj0gyRj';
const DEFAULT_CENTER = [116.404, 39.915];   // 北京天安门附近
const QUICK_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都'];
const SEARCH_STATUS = {
  1: '该城市下没有找到,可换个关键词试试',
  2: '没能确定所在城市',
  3: '密钥无效或无权限',
  4: '搜索超时,请重试',
  5: '请求不合法',
  6: '搜索服务暂不可用',
};

/* ---- 异步加载百度地图 GL 脚本(JSONP callback;共享 Promise,失败可重试) ---- */
let bmapPromise = null;
function loadBMapGL() {
  if (window.BMapGL) return Promise.resolve();
  if (bmapPromise) return bmapPromise;
  bmapPromise = new Promise((resolve, reject) => {
    const cb = '__bmapgl_ready_' + Math.random().toString(36).slice(2);
    let done = false;
    const script = el('script', { src: `https://api.map.baidu.com/api?type=webgl&v=1.0&ak=${AK}&callback=${cb}` });
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[cb];
      script.onerror = null;
      if (ok) resolve();
      else { bmapPromise = null; script.remove(); reject(err); }
    };
    const timer = setTimeout(() => finish(false, new Error('加载超时,请检查网络')), 20000);
    window[cb] = () => finish(true);
    script.onerror = () => finish(false, new Error('百度地图脚本加载失败,请检查网络'));
    document.head.appendChild(script);
  });
  return bmapPromise;
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(2)} 公里`);

register({
  ...manifest,
  mount({ root, setTitle }) {
    let B = null;           // window.BMapGL(脚本就绪后缓存)
    let map = null;         // BMapGL.Map
    let local = null;       // BMapGL.LocalSearch
    let geocoder = null;    // BMapGL.Geocoder
    let disposed = false;   // 窗口提前关闭时放弃后续异步初始化
    let searched = false;   // 搜索过后不再让 IP 定城纠正视野
    let trafficOn = false;
    let measuring = false;
    let measure = null;     // { pts:[], line, dot, label }

    /* ---------------- 骨架 ---------------- */
    const mapDiv = el('div', { class: 'mp-canvas' });
    const overlay = el('div', { class: 'mp-overlay' });
    const side = el('div', { class: 'app-side mp-side' });
    const statusL = el('span', {}, '正在加载地图…');
    const statusR = el('span', { class: 'mono' }, '');

    const searchInput = el('input', {
      class: 'input mp-search', type: 'search', placeholder: '搜索地点,回车确认…',
    });
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    const typeSeg = el('div', { class: 'seg mp-seg' },
      segBtn('标准', true, () => setMapType('BMAP_NORMAL_MAP')),
      segBtn('卫星', false, () => setMapType('BMAP_SATELLITE_MAP')),
      segBtn('混合', false, () => setMapType('BMAP_HYBRID_MAP')));

    const trafficBtn = el('button', {
      class: 'btn mp-toggle', title: '实时路况图层', onClick: toggleTraffic,
    }, icon('activity', 14), '路况');
    const measureBtn = el('button', {
      class: 'btn mp-toggle', title: '测量地图上折线的实际距离', onClick: () => setMeasuring(!measuring),
    }, icon('sliders', 14), '测距');
    const locateBtn = el('button', {
      class: 'btn mp-toggle', title: '定位到浏览器当前位置', onClick: locate,
    }, icon('mapPin', 14), '定位');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar mp-toolbar' },
        searchInput,
        el('button', { class: 'btn primary', onClick: doSearch }, icon('search', 14), '搜索'),
        typeSeg,
        el('span', { class: 'grow' }),
        trafficBtn, measureBtn, locateBtn),
      el('div', { class: 'app-mid' }, side,
        el('div', { class: 'mp-wrap' }, mapDiv, overlay)),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        statusR)));

    function segBtn(text, active, onClick) {
      return el('button', { class: 'seg-btn' + (active ? ' active' : ''), onClick: (e) => {
        typeSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        onClick();
      } }, text);
    }

    /* ---------------- 侧栏 ---------------- */
    function renderSideDefault() {
      side.innerHTML = '';
      side.append(
        el('div', { class: 'mp-side-tip' },
          icon('info', 14),
          el('div', {}, '点击地图取坐标;「测距」模式下依次打点可量实际距离。')),
        el('div', { class: 'mp-side-head' }, '快捷城市'),
        el('div', { class: 'mp-chips' },
          ...QUICK_CITIES.map(c => el('button', { class: 'mp-chip', onClick: () => gotoCity(c) }, c))),
        el('div', { class: 'mp-side-head' }, '说明'),
        el('div', { class: 'dim', style: { fontSize: '11.5px', lineHeight: 1.7, padding: '0 12px 12px' } },
          '底图与搜索服务来自百度地图 JS API GL,坐标为 BD-09;定位使用浏览器定位并自动转换为百度坐标。'));
    }

    function renderSideError(msg, retry) {
      side.innerHTML = '';
      side.append(el('div', { class: 'mp-side-tip mp-side-err' },
        icon('alertTriangle', 14),
        el('div', {}, msg, el('br'),
          retry ? el('button', { class: 'btn', style: { marginTop: '8px' }, onClick: retry }, '重试') : null)));
    }

    /* ---------------- 城市 / 搜索 ---------------- */
    function gotoCity(name) {
      if (!map || !geocoder) return;
      statusL.textContent = `正在跳转到${name}…`;
      geocoder.getPoint(name, (pt) => {
        if (disposed || !map) return;
        if (!pt) { statusL.textContent = `没能定位到${name}`; return; }
        statusL.textContent = '';
        map.centerAndZoom(pt, 12);
        setTitle(`${name} — 地图`);
      });
    }

    function doSearch() {
      const kw = searchInput.value.trim();
      if (!kw || !local) return;
      statusL.textContent = `正在搜索「${kw}」…`;
      local.search(kw);
    }

    function onSearchDone(results) {
      if (disposed || !results) return;
      searched = true;
      const kw = searchInput.value.trim();
      const n = results.getCurrentNumPois ? results.getCurrentNumPois() : 0;
      statusL.textContent = '';
      if (local.getStatus() !== 0 || !n) {   // BMAP_STATUS_SUCCESS
        setTitle('地图');
        const reason = SEARCH_STATUS[local.getStatus()] || '没有找到相关地点';
        renderSideError(`「${kw}」:${reason}`, () => doSearch());
        return;
      }
      setTitle(`「${kw}」— 地图`);
      const pages = results.getNumPages ? results.getNumPages() : 1;
      const page = results.getPageIndex ? results.getPageIndex() : 0;
      side.innerHTML = '';
      side.append(el('div', { class: 'mp-side-head' }, `「${kw}」· ${n} 个结果`));
      for (let i = 0; i < n; i++) {
        const poi = results.getPoi(i);
        if (!poi) continue;
        side.append(el('button', { class: 'mp-poi', onClick: () => gotoPoi(poi) },
          el('b', {}, poi.title || '未命名地点'),
          el('span', {}, poi.address || [poi.province, poi.city].filter(Boolean).join(' ') || '无地址')));
      }
      if (pages > 1) {
        side.append(el('div', { class: 'mp-pager' },
          el('button', { class: 'btn icon', disabled: page <= 0, title: '上一页', onClick: () => local.gotoPage(page - 1) }, '‹'),
          el('span', { class: 'dim' }, `${page + 1} / ${pages}`),
          el('button', { class: 'btn icon', disabled: page >= pages - 1, title: '下一页', onClick: () => local.gotoPage(page + 1) }, '›')));
      }
    }

    function gotoPoi(poi) {
      if (!map || !poi?.point) return;
      map.openInfoWindow(new B.InfoWindow(
        `<b>${escapeHtml(poi.title || '未命名地点')}</b>` +
        `<div class="mp-iw-sub">${escapeHtml(poi.address || '')}</div>`,
        { width: 220 }), poi.point);
      map.panTo(poi.point);
    }

    /* ---------------- 图层与视图 ---------------- */
    function setMapType(constName) {
      if (!map) return;
      map.setMapType(window[constName]);
    }

    function toggleTraffic() {
      if (!map) return;
      trafficOn = !trafficOn;
      trafficBtn.classList.toggle('active', trafficOn);
      if (trafficOn) map.setTrafficOn(); else map.setTrafficOff();
    }

    /* ---------------- 点击取坐标 ---------------- */
    let coordMarker = null;   // 只保留最新取点标记,不动搜索/测距等其它覆盖物
    function showCoord(point) {
      const html = `<b>此处坐标(BD-09)</b><div class="mp-iw-sub mono">${point.lng.toFixed(6)}, ${point.lat.toFixed(6)}</div>`;
      const info = new B.InfoWindow(html, { width: 220 });
      if (coordMarker) map.removeOverlay(coordMarker);
      coordMarker = new B.Marker(point);
      coordMarker.addEventListener('click', () => map.openInfoWindow(info, point));
      map.addOverlay(coordMarker);
      map.openInfoWindow(info, point);
    }

    /* ---------------- 测距 ---------------- */
    function setMeasuring(on) {
      if (!map) return;
      if (on && measuring) return;
      measuring = on;
      measureBtn.classList.toggle('active', on);
      map.setDefaultCursor(on ? 'crosshair' : 'default');
      if (on) {
        clearMeasureOverlays();
        measure = { pts: [], line: null, dot: null, label: null };
        statusL.textContent = '测距:在地图上依次点击打点,双击或关闭按钮结束(保留画线)';
      } else {
        statusL.textContent = measure?.pts.length ? `测距结束,总长 ${fmtDist(measureTotal())}` : '';
      }
    }

    function measureTotal() {
      let sum = 0;
      const pts = measure?.pts || [];
      for (let i = 1; i < pts.length; i++) sum += map.getDistance(pts[i - 1], pts[i]);
      return sum;
    }

    function addMeasurePoint(pt) {
      measure.pts.push(pt);
      clearMeasureOverlays();
      measure.line = new B.Polyline(measure.pts, { strokeColor: '#22d3ee', strokeWeight: 3, strokeOpacity: 0.85 });
      const last = measure.pts[measure.pts.length - 1];
      measure.dot = new B.Circle(last, 3, { strokeWeight: 2, fillColor: '#22d3ee', fillOpacity: 0.9, strokeColor: '#22d3ee' });
      measure.label = new B.Label(fmtDist(measureTotal()), {
        position: last, offset: new B.Size(10, -16),
      });
      measure.label.setStyle({
        border: '1px solid #22d3ee', borderRadius: '6px', padding: '1px 6px',
        fontSize: '11px', color: '#0e7490', background: 'rgba(255,255,255,.92)', whiteSpace: 'nowrap',
      });
      for (const o of [measure.line, measure.dot, measure.label]) map.addOverlay(o);
    }

    function clearMeasureOverlays() {
      if (!measure) return;
      for (const o of [measure.line, measure.dot, measure.label]) if (o) map.removeOverlay(o);
      measure.line = measure.dot = measure.label = null;
    }

    /* ---------------- 定位 ---------------- */
    let locOverlays = [];     // 上次定位的标记 + 精度圈,再次定位时移除
    function locate() {
      if (!map) return;
      statusL.textContent = '正在定位…';
      const geo = new B.Geolocation();
      geo.getCurrentPosition((r) => {
        if (disposed) return;
        if (geo.getStatus() !== 0 || !r?.point) {   // BMAP_STATUS_SUCCESS
          statusL.textContent = '定位失败:浏览器未授权或不可用';
          return;
        }
        for (const o of locOverlays) map.removeOverlay(o);
        locOverlays = [new B.Marker(r.point)];
        if (r.accuracy) locOverlays.push(new B.Circle(r.point, r.accuracy, {
          fillColor: '#34d399', fillOpacity: 0.15, strokeColor: '#34d399', strokeWeight: 1, strokeOpacity: 0.5,
        }));
        for (const o of locOverlays) map.addOverlay(o);
        map.panTo(r.point);
        statusL.textContent = `已定位(精度约 ${Math.round(r.accuracy || 0)} 米)`;
      }, { enableHighAccuracy: true });
    }

    /* ---------------- 初始化 ---------------- */
    function showOverlay(node) {
      overlay.innerHTML = '';
      overlay.append(node);
      overlay.hidden = false;
    }

    function showError(err) {
      statusL.textContent = '地图加载失败';
      showOverlay(el('div', { class: 'mp-overlay-box' },
        icon('alertTriangle', 34),
        el('b', {}, '百度地图加载失败'),
        el('div', { class: 'dim' }, String(err?.message || err)),
        el('button', { class: 'btn primary', onClick: () => { showLoading(); boot(); } }, icon('refresh', 14), '重试')));
    }

    function showLoading() {
      showOverlay(el('div', { class: 'mp-overlay-box' },
        el('i', { class: 'mp-spin' }), el('span', {}, '正在加载百度地图…')));
    }

    function boot() {
      loadBMapGL().then(initMap).catch((err) => { if (!disposed) showError(err); });
    }

    function initMap() {
      if (disposed) return;
      B = window.BMapGL;
      map = new B.Map(mapDiv, { enableMapClick: false });
      map.centerAndZoom(new B.Point(DEFAULT_CENTER[0], DEFAULT_CENTER[1]), 11);
      map.enableScrollWheelZoom(true);
      map.addControl(new B.ScaleControl({ anchor: BMAP_ANCHOR_BOTTOM_LEFT }));
      map.addControl(new B.ZoomControl({ anchor: BMAP_ANCHOR_TOP_LEFT }));
      map.addControl(new B.OverviewMapControl({ isOpen: false, anchor: BMAP_ANCHOR_BOTTOM_RIGHT }));

      geocoder = new B.Geocoder();
      local = new B.LocalSearch(map, {
        onSearchComplete: onSearchDone,
        renderOptions: { map, selectFirstResult: false, autoViewport: true },
      });

      map.addEventListener('click', (e) => {
        if (measuring) addMeasurePoint(e.point);
        else showCoord(e.point);
      });
      map.addEventListener('dblclick', () => { if (measuring) setMeasuring(false); });
      map.addEventListener('mousemove', (e) => {
        if (e.point) statusR.textContent = `${e.point.lng.toFixed(5)}, ${e.point.lat.toFixed(5)} · 级别 ${map.getZoom()}`;
      });
      map.addEventListener('zoomend', () => {
        statusR.textContent = `级别 ${map.getZoom()}`;
      });

      overlay.hidden = true;
      statusL.textContent = '';
      renderSideDefault();
      setTitle('地图');

      // 按 IP 所在城市纠正初始视野(仅在没有搜索/取点动作前);
      // 级别限制在 10~14,避免百度返回过小的级别导致视野跨省
      try {
        new B.LocalCity().get((r) => {
          if (!disposed && !searched && r?.center) {
            map.centerAndZoom(r.center, Math.min(Math.max(r.level || 12, 10), 14));
            if (r.name) setTitle(`${r.name} — 地图`);
          }
        });
      } catch { /* IP 定城失败则维持默认视野 */ }

      // 出场动画期间窗口尺寸未定,稳定后再校正一次
      setTimeout(() => {
        if (disposed || !map) return;
        if (typeof map.checkResize === 'function') map.checkResize();
        else if (typeof map.resize === 'function') map.resize();
      }, 300);
    }

    renderSideDefault();
    showLoading();
    boot();

    return {
      onResize: () => {
        if (!map) return;
        if (typeof map.checkResize === 'function') map.checkResize();
        else if (typeof map.resize === 'function') map.resize();
      },
      onClose: () => { disposed = true; },
    };
  },
});
