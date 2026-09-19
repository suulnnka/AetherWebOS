/* ============================================================
 * 应用:地图
 * 底图渲染用自研内核 js/lib/minimap.js(原 Leaflet 的轻量替代),
 * 对外接口与 Leaflet 同名,因此这里只换了 import 一行。
 * 数据生态仍然免密钥、免审核:
 *  - 底图:OSM 标准(tile.openstreetmap.de,失败自动切 CARTO)/
 *    Esri World Imagery 卫星 / Esri 地形(均为境内可直连服务;
 *    OSM 官方瓦片与 Nominatim 在境内不可达)
 *  - 搜索/逆地理:Photon(komoot 的 OSM 搜索服务)
 *  - 点击取坐标(WGS-84)/ 距离测量 / 浏览器定位 / 快捷城市
 * ============================================================ */
import L from '../../lib/minimap.js';
import { el, escapeHtml } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './map.css';

const QUICK_CITIES = [
  { name: '北京', lat: 39.909, lng: 116.397 },
  { name: '上海', lat: 31.230, lng: 121.473 },
  { name: '广州', lat: 23.129, lng: 113.264 },
  { name: '深圳', lat: 22.543, lng: 114.058 },
  { name: '杭州', lat: 30.274, lng: 120.155 },
  { name: '成都', lat: 30.572, lng: 104.066 },
  { name: '西安', lat: 34.341, lng: 108.940 },
  { name: '重庆', lat: 29.563, lng: 106.551 },
];

const BASE_LAYERS = {
  normal: () => L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap 贡献者',
  }),
  normalFallback: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap 贡献者 © CARTO',
  }),
  satellite: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: '© Esri & Maxar & Earthstar Geographics',
  }),
  topo: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: '© Esri & OpenStreetMap 贡献者',
  }),
};

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(2)} 公里`);

/* Haversine 球面距离(米) */
function haversine(a, b) {
  const rad = Math.PI / 180, R = 6371000;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* Photon(komoot 的 OSM 搜索服务,境内可直连) */
async function photonSearch(q) {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=default`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`搜索服务返回 ${resp.status}`);
  const j = await resp.json();
  return (j.features || []).map((f) => {
    const p = f.properties || {};
    return {
      lat: f.geometry?.coordinates?.[1],
      lng: f.geometry?.coordinates?.[0],
      name: p.name || p.city || p.state || q,
      display: [p.name, p.city, p.state, p.country].filter(Boolean).join(' · '),
      type: p.osm_value || p.type,
    };
  }).filter((it) => Number.isFinite(it.lat) && Number.isFinite(it.lng));
}

register({
  ...manifest,
  mount({ root, setTitle }) {
    let map = null;
    let baseLayer = null;
    let searchMarker = null, coordMarker = null;
    let measuring = false;
    let measurePts = [], measureGroup = null;
    let closed = false;
    const disposed = () => closed;

    /* ---------------- 骨架 ---------------- */
    const mapDiv = el('div', { class: 'mp-canvas' });
    const side = el('div', { class: 'app-side mp-side' });
    const statusL = el('span', {}, '');
    const statusR = el('span', { class: 'mono' }, '');

    const searchInput = el('input', {
      class: 'input mp-search', type: 'search', placeholder: '搜索地点,回车确认…',
    });
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    const typeSeg = el('div', { class: 'seg mp-seg' },
      segBtn('标准', true, () => setBase('normal')),
      segBtn('卫星', false, () => setBase('satellite')),
      segBtn('地形', false, () => setBase('topo')));

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
        measureBtn, locateBtn),
      el('div', { class: 'app-mid' }, side,
        el('div', { class: 'mp-wrap' }, mapDiv)),
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
          el('div', {}, '点击地图取坐标(WGS-84);「测距」模式下依次打点可量实际距离。')),
        el('div', { class: 'mp-side-head' }, '快捷城市'),
        el('div', { class: 'mp-chips' },
          ...QUICK_CITIES.map(c => el('button', { class: 'mp-chip', onClick: () => {
            map.setView([c.lat, c.lng], 12);
            setTitle(`${c.name} — 地图`);
          } }, c.name))),
        el('div', { class: 'mp-side-head' }, '说明'),
        el('div', { class: 'dim', style: { fontSize: '11.5px', lineHeight: 1.7, padding: '0 12px 12px' } },
          '底图数据 © OpenStreetMap 贡献者(CARTO/Esri 渲染,境内可直连);搜索由 Photon 提供;坐标为 WGS-84,全程无需密钥。'));
    }

    function renderSideError(msg, retry) {
      side.innerHTML = '';
      side.append(el('div', { class: 'mp-side-tip mp-side-err' },
        icon('alertTriangle', 14),
        el('div', {}, msg, el('br'),
          retry ? el('button', { class: 'btn', style: { marginTop: '8px' }, onClick: retry }, '重试') : null)));
    }

    /* ---------------- 搜索(Photon) ---------------- */
    async function doSearch() {
      const kw = searchInput.value.trim();
      if (!kw || !map) return;
      statusL.textContent = `正在搜索「${kw}」…`;
      side.innerHTML = '';
      side.append(el('div', { class: 'mp-side-head' }, `搜索「${kw}」…`));
      try {
        const list = await photonSearch(kw);
        if (disposed()) return;
        statusL.textContent = '';
        if (!list.length) {
          setTitle('地图');
          renderSideError(`「${kw}」:没有找到相关地点,可换个说法重试`, doSearch);
          return;
        }
        setTitle(`「${kw}」— 地图`);
        renderResults(kw, list);
      } catch (e) {
        if (disposed()) return;
        statusL.textContent = '';
        renderSideError(`「${kw}」:搜索失败(${e.message})`, doSearch);
      }
    }

    function renderResults(kw, list) {
      side.innerHTML = '';
      side.append(el('div', { class: 'mp-side-head' }, `「${kw}」· ${list.length} 个结果`));
      for (const item of list) {
        const title = item.name || String(item.display || '').split(',')[0];
        side.append(el('button', { class: 'mp-poi', onClick: () => gotoResult(item) },
          el('b', {}, title),
          el('span', {}, item.display || '')));
      }
    }

    function gotoResult(item) {
      // 注意字段名:Photon 结果里是 lng,写成 lon 会算出 NaN 把地图拖飞
      const latlng = [Number(item.lat), Number(item.lng)];
      map.setView(latlng, item.type === 'city' || item.type === 'state' ? 12 : 16);
      if (searchMarker) map.removeLayer(searchMarker);
      searchMarker = L.circleMarker(latlng, {
        radius: 8, color: '#0ea5e9', weight: 3, fillColor: '#0ea5e9', fillOpacity: 0.35,
      }).addTo(map);
      searchMarker.bindPopup(
        `<b>${escapeHtml(item.name || String(item.display || '').split(',')[0])}</b>` +
        `<div class="mp-iw-sub">${escapeHtml(item.display || '')}</div>`, { maxWidth: 260 }).openPopup();
    }

    /* ---------------- 底图切换(标准图连续瓦片失败时自动切 CARTO) ---------------- */
    function setBase(kind) {
      if (!map) return;
      if (baseLayer) map.removeLayer(baseLayer);
      baseLayer = BASE_LAYERS[kind]();
      let errs = 0;
      baseLayer.on('tileerror', () => {
        errs++;
        if (errs === 4 && kind === 'normal') {
          const keep = baseLayer;
          baseLayer = BASE_LAYERS.normalFallback();
          map.removeLayer(keep);
          baseLayer.addTo(map);
          statusL.textContent = '标准图源不可达,已自动切换备用源';
        }
      });
      baseLayer.addTo(map);
    }

    /* ---------------- 点击取坐标 ---------------- */
    function showCoord(latlng) {
      const html = `<b>此处坐标(WGS-84)</b><div class="mp-iw-sub mono">${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}</div>`;
      if (coordMarker) map.removeLayer(coordMarker);
      coordMarker = L.circleMarker(latlng, {
        radius: 7, color: '#0ea5e9', weight: 3, fillColor: '#0ea5e9', fillOpacity: 0.35,
      }).addTo(map).bindPopup(html, { maxWidth: 240 }).openPopup();
    }

    /* ---------------- 测距 ---------------- */
    function setMeasuring(on) {
      if (!map) return;
      if (on && measuring) return;
      measuring = on;
      measureBtn.classList.toggle('active', on);
      map.getContainer().style.cursor = on ? 'crosshair' : '';
      if (on) {
        clearMeasureOverlays();
        measurePts = [];
        statusL.textContent = '测距:在地图上依次点击打点,双击或关闭按钮结束(保留画线)';
      } else {
        statusL.textContent = measurePts.length > 1 ? `测距结束,总长 ${fmtDist(measureTotal())}` : '';
      }
    }

    function measureTotal() {
      let sum = 0;
      for (let i = 1; i < measurePts.length; i++) sum += haversine(measurePts[i - 1], measurePts[i]);
      return sum;
    }

    function addMeasurePoint(latlng) {
      measurePts.push(latlng);
      measureGroup.clearLayers();
      L.polyline(measurePts, { color: '#22d3ee', weight: 3, opacity: 0.85 }).addTo(measureGroup);
      for (const p of measurePts) {
        L.circleMarker(p, { radius: 4, color: '#22d3ee', weight: 2, fillColor: '#22d3ee', fillOpacity: 0.9 }).addTo(measureGroup);
      }
      const last = measurePts[measurePts.length - 1];
      L.tooltip({ permanent: true, direction: 'right', offset: [8, 0] })
        .setLatLng(last).setContent(fmtDist(measureTotal())).addTo(measureGroup);
      statusL.textContent = `测距中,已 ${fmtDist(measureTotal())}`;
    }

    function clearMeasureOverlays() {
      if (measureGroup) measureGroup.clearLayers();
    }

    /* ---------------- 定位 ---------------- */
    function locate() {
      if (!map || !navigator.geolocation) {
        statusL.textContent = '浏览器不支持定位';
        return;
      }
      statusL.textContent = '正在定位…';
      navigator.geolocation.getCurrentPosition((pos) => {
        if (disposed()) return;
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        map.setView([lat, lng], 15);
        L.circleMarker([lat, lng], { radius: 7, color: '#34d399', weight: 3, fillColor: '#34d399', fillOpacity: 0.5 })
          .addTo(map).bindPopup(`你在这里(精度约 ${Math.round(accuracy || 0)} 米)`).openPopup();
        L.circle([lat, lng], { radius: accuracy || 0, color: '#34d399', weight: 1, fillColor: '#34d399', fillOpacity: 0.12 }).addTo(map);
        statusL.textContent = `已定位(精度约 ${Math.round(accuracy || 0)} 米)`;
      }, () => { if (!disposed()) statusL.textContent = '定位失败:浏览器未授权或不可用'; },
      { enableHighAccuracy: true });
    }

    /* ---------------- 初始化 ---------------- */
    initMap();

    function initMap() {
      map = L.map(mapDiv, { zoomControl: true });
      map.setView([39.909, 116.397], 11);
      setBase('normal');
      measureGroup = L.layerGroup().addTo(map);
      L.control.scale({ imperial: false }).addTo(map);

      map.on('click', (e) => {
        if (measuring) addMeasurePoint(e.latlng);
        else showCoord(e.latlng);
      });
      map.on('dblclick', () => { if (measuring) setMeasuring(false); });
      map.on('mousemove', (e) => {
        statusR.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)} · 级别 ${map.getZoom()}`;
      });
      map.on('zoomend', () => { statusR.textContent = `级别 ${map.getZoom()}`; });

      renderSideDefault();
      setTitle('地图');
      window.__map = map;            // 浏览器探针 tools/probe-map.mjs 用(与 reversi 的 __reversi 同约定)
      setTimeout(() => { if (map) map.invalidateSize(); }, 300);
    }

    return {
      onResize: () => { if (map) map.invalidateSize(); },
      onClose: () => {
        closed = true;
        map?.remove();
        if (window.__map === map) window.__map = null;   // 探针句柄别留已关闭的旧地图
      },
    };
  },
});
