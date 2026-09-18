/* ============================================================
 * 应用:街景寻踪(类「图寻」玩法)
 * 随机空降到百度街景的某处街头 → 拖动环顾找线索 → 在右下角
 * 小地图上标记猜测 → 提交后按真实距离指数衰减计分,5 轮一局。
 * 街景来自百度地图 JS API GL(与地图应用共用 AK);
 * 猜测/结算底图为 Leaflet + OpenStreetMap(WGS-84),
 * 百度 BD-09 落点会换算成 WGS-84 后再计分,不受坐标系漂移影响。
 * ============================================================ */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './tuxun.css';

const AK = 'M6gP5GsIPshSgOh7JnGgnxgXlEj0gyRj';
const OSM_URL = 'https://tile.openstreetmap.de/{z}/{x}/{y}.png';
const OSM_OPTS = { maxZoom: 18, attribution: '© OpenStreetMap 贡献者' };
const ROUNDS = 5;
const SCORE_SCALE = 20000;        // 计分尺度(米):1km≈4755,5km≈3894,20km≈1839,50km≈771
const BEST_KEY = 'webos.tuxun.best';
const CITY_POOL = [               // 街景覆盖较稳的城市;实际落点在市内随机扰动(坐标为 BD-09)
  { name: '北京', lng: 116.397, lat: 39.909, r: 6000 },
  { name: '上海', lng: 121.473, lat: 31.230, r: 8000 },
  { name: '广州', lng: 113.264, lat: 23.129, r: 7000 },
  { name: '深圳', lng: 114.058, lat: 22.543, r: 7000 },
  { name: '成都', lng: 104.066, lat: 30.572, r: 8000 },
  { name: '杭州', lng: 120.155, lat: 30.274, r: 6000 },
  { name: '重庆', lng: 106.551, lat: 29.563, r: 9000 },
  { name: '西安', lng: 108.940, lat: 34.341, r: 6000 },
  { name: '武汉', lng: 114.305, lat: 30.593, r: 7000 },
  { name: '南京', lng: 118.797, lat: 32.060, r: 6000 },
  { name: '厦门', lng: 118.089, lat: 24.479, r: 5000 },
  { name: '青岛', lng: 120.382, lat: 36.067, r: 6000 },
  { name: '天津', lng: 117.190, lat: 39.125, r: 6000 },
  { name: '长沙', lng: 112.938, lat: 28.228, r: 6000 },
  { name: '苏州', lng: 120.585, lat: 31.299, r: 6000 },
];

/* ---- BD-09 → WGS-84(经 GCJ-02 近似逆变换,误差 1~2 米) ---- */
const X_PI = Math.PI * 3000 / 180;
function bd2gcj(lng, lat) {
  const x = lng - 0.0065, y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}
function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}
function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}
function wgs2gcj(lng, lat) {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - 0.00669342162296594323 * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (6378245 / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}
function bd2wgs(lng, lat) {
  const [gLng, gLat] = bd2gcj(lng, lat);
  const [mLng, mLat] = wgs2gcj(gLng, gLat);
  return { lng: lng * 2 - mLng, lat: lat * 2 - mLat };
}

/* Haversine 球面距离(米) */
function haversine(a, b) {
  const rad = Math.PI / 180, R = 6371000;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(1)} 公里`);
const calcScore = (m) => Math.round(5000 * Math.exp(-m / SCORE_SCALE));

/* 市内随机扰动:半径 r 米内均匀取点 */
function randOffset(city) {
  const a = Math.random() * Math.PI * 2;
  const d = Math.sqrt(Math.random()) * city.r;
  const lat = city.lat + (d * Math.sin(a)) / 111320;
  const lng = city.lng + (d * Math.cos(a)) / (111320 * Math.cos(city.lat * Math.PI / 180));
  return { lng, lat };
}

/* Photon 逆地理编码(境内可直连):坐标 → 城市名 */
async function reverseCity(lat, lng) {
  try {
    const resp = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=default`);
    const j = await resp.json();
    const p = j.features?.[0]?.properties || {};
    return p.city || p.town || p.county || p.state || p.name || '未知地区';
  } catch { return '未知地区'; }
}

let bmapPromise = null;
function loadBMapGL() {
  if (window.BMapGL) return Promise.resolve();
  if (bmapPromise) return bmapPromise;
  bmapPromise = new Promise((resolve, reject) => {
    const cb = '__tuxun_ready_' + Math.random().toString(36).slice(2);
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
    script.onerror = () => finish(false, new Error('百度街景脚本加载失败,请检查网络'));
    document.head.appendChild(script);
  });
  return bmapPromise;
}

register({
  ...manifest,
  mount({ root, setTitle }) {
    let B = null;             // window.BMapGL(仅街景用)
    let pano = null;          // B.Panorama 街景实例
    let panoService = null;
    let guessMap = null;      // Leaflet 猜测小地图
    let resultMap = null;     // Leaflet 结算小地图(复用)
    let resultTile = null;
    let guessMarker = null;
    let disposed = false;

    let round = 0;            // 当前轮(1 基;0 = 未开局)
    let total = 0;
    let rounds = [];          // { city, dist, score }
    let truth = null;         // { id, wgs:{lng,lat}, city }
    let guessWgs = null;      // 猜测点(WGS-84)
    let playing = false;      // 本轮进行中(可标记/提交)

    /* ---------------- 骨架 ---------------- */
    const panoDiv = el('div', { class: 'tx-pano' });
    const statusL = el('span', {}, '来一局,测试一下你的地理直觉');
    const best = Number(localStorage.getItem(BEST_KEY) || 0);
    const statusR = el('span', { class: 'mono' }, best ? `最佳 ${best}` : '');

    const startBtn = el('button', { class: 'btn primary', onClick: () => startGame() },
      icon('play', 13), '开始游戏');

    /* 小地图卡片 */
    const guessMapDiv = el('div', { class: 'tx-gm-canvas' });
    const gmTip = el('span', { class: 'dim' }, '点击地图放置猜测');
    const submitBtn = el('button', { class: 'btn primary tx-submit', disabled: true, onClick: submitGuess },
      icon('check', 13), '提交猜测');
    const bigBtn = el('button', {
      class: 'btn icon', title: '放大 / 缩小小地图',
      onClick: () => { gmCard.classList.toggle('big'); setTimeout(() => guessMap && guessMap.invalidateSize(), 220); },
    }, icon('max', 12));
    const gmCard = el('div', { class: 'tx-gm' },
      el('div', { class: 'tx-gm-head' }, icon('mapPin', 13), gmTip, el('span', { class: 'grow' }), bigBtn),
      guessMapDiv,
      submitBtn);

    /* 加载提示 chip */
    const loadingChip = el('div', { class: 'tx-loading' }, el('i', { class: 'tx-spin' }), el('span', {}, '正在空降…'));

    /* 开局说明浮层 */
    const startOverlay = el('div', { class: 'tx-overlay' });
    /* 每轮结算浮层 */
    const roundOverlay = el('div', { class: 'tx-overlay' });
    /* 总结算浮层 */
    const finalOverlay = el('div', { class: 'tx-overlay' });
    /* 结算收起后的「查看结果」chip */
    const reopenChip = el('button', { class: 'btn tx-reopen', onClick: () => { reopenChip.hidden = true; roundOverlay.hidden = false; } },
      icon('activity', 13), '查看结果');
    reopenChip.hidden = true;
    const resultDiv = el('div', { class: 'tx-rmap' });

    function renderStartOverlay(err) {
      startOverlay.innerHTML = '';
      startOverlay.append(el('div', { class: 'tx-panel' },
        el('div', { class: 'tx-panel-title' }, icon('mapPin', 22), '街景寻踪'),
        el('div', { class: 'dim', style: { lineHeight: 1.8, fontSize: '12.5px' } },
          '你被空降到某个城市的街头。拖动街景环顾四周寻找线索,在右下角地图上标记你认为所在的位置,提交后按真实距离得分:越近分越高,满分 5000/轮。',
          el('br'), `一局共 ${ROUNDS} 轮,合计满分 ${5000 * ROUNDS} 分。`),
        err
          ? el('div', { class: 'dim', style: { color: '#ef4444' } }, String(err.message || err))
          : null,
        el('button', { class: 'btn primary', onClick: () => startGame() },
          icon('play', 13), err ? '重试' : '开始游戏')));
    }

    function renderRoundOverlay(res) {
      roundOverlay.innerHTML = '';
      roundOverlay.append(el('div', { class: 'tx-panel tx-panel-wide' },
        el('div', { class: 'tx-score' }, String(res.score), el('small', {}, ' 分')),
        el('div', { class: 'dim' },
          `距离真实位置 ${fmtDist(res.dist)} · 真实位置:${truth.city || '未知地区'}`),
        resultDiv,
        el('div', { class: 'tx-actions' },
          el('button', { class: 'btn', onClick: () => { roundOverlay.hidden = true; reopenChip.hidden = false; } }, '回到街景'),
          round < ROUNDS
            ? el('button', { class: 'btn primary', onClick: () => nextRound() }, '下一轮')
            : el('button', { class: 'btn primary', onClick: () => showFinal() }, '查看总结'))));
      roundOverlay.hidden = false;
      drawResultMap(res);
    }

    function showFinal() {
      roundOverlay.hidden = true;
      reopenChip.hidden = true;
      const prevBest = Number(localStorage.getItem(BEST_KEY) || 0);
      const isRecord = total > prevBest;
      if (isRecord) localStorage.setItem(BEST_KEY, String(total));
      statusR.textContent = `最佳 ${Math.max(prevBest, total)}`;

      finalOverlay.innerHTML = '';
      finalOverlay.append(el('div', { class: 'tx-panel' },
        el('div', { class: 'tx-panel-title' }, icon('star', 20), isRecord ? '新纪录!' : '本局结束'),
        el('div', { class: 'tx-score' }, String(total), el('small', {}, ` 分 / ${5000 * ROUNDS}`)),
        el('table', { class: 'table' },
          el('tr', {}, el('th', {}, '轮次'), el('th', {}, '偏离'), el('th', {}, '得分')),
          ...rounds.map((r, i) => el('tr', {},
            el('td', {}, `第 ${i + 1} 轮`),
            el('td', {}, fmtDist(r.dist)),
            el('td', {}, String(r.score))))),
        el('div', { class: 'dim', style: { fontSize: '12px' } }, `历史最佳:${Math.max(prevBest, total)} 分`),
        el('div', { class: 'tx-actions' },
          el('button', { class: 'btn primary', onClick: () => startGame() }, icon('refresh', 13), '再来一局'))));
      finalOverlay.hidden = false;
      setTitle('总结 — 街景寻踪');
    }

    /* ---------------- 布局 ---------------- */
    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        startBtn,
        el('span', { class: 'dim', style: { fontSize: '12px' } }, `${ROUNDS} 轮一局 · 越近分越高`),
        el('span', { class: 'grow' }),
        el('span', { class: 'badge-pill mono' }, '0')),
      el('div', { class: 'app-mid tx-stage' },
        panoDiv, gmCard, loadingChip, reopenChip, startOverlay, roundOverlay, finalOverlay),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        statusR)));

    const roundBadge = root.querySelector('.badge-pill');
    loadingChip.hidden = true;

    /* ---------------- 游戏流程 ---------------- */
    function startGame() {
      round = 0; total = 0; rounds = [];
      startOverlay.hidden = true;
      finalOverlay.hidden = true;
      roundOverlay.hidden = true;
      reopenChip.hidden = true;
      nextRound();
    }

    async function nextRound() {
      if (disposed || !B) return;
      round++;
      guessWgs = null;
      if (guessMarker) { guessMap.removeLayer(guessMarker); guessMarker = null; }
      playing = false;
      submitBtn.disabled = true;
      gmTip.textContent = '点击地图放置猜测';
      roundOverlay.hidden = true;
      reopenChip.hidden = true;
      loadingChip.hidden = false;
      roundBadge.textContent = `第 ${round}/${ROUNDS} 轮 · 0`;
      statusL.textContent = `第 ${round}/${ROUNDS} 轮 · 正在空降…`;
      setTitle(`空降中 — 街景寻踪`);

      const found = await findPano();
      if (disposed) return;
      loadingChip.hidden = true;
      if (!found) {
        statusL.textContent = '这一带找不到街景,请重试';
        renderStartOverlay(new Error('附近没有可用的街景数据,请重新开始或稍后再试'));
        startOverlay.hidden = false;
        round--;
        return;
      }
      truth = {
        id: found.id,
        wgs: bd2wgs(found.point.lng, found.point.lat),
        city: found.city,
      };
      // Nominatim 反查精确城市名(不阻塞游玩)
      reverseCity(truth.wgs.lat, truth.wgs.lng).then((c) => { if (!disposed && truth) truth.city = c; });

      try { pano.setId(truth.id); } catch { pano.setPosition(new B.Point(found.point.lng, found.point.lat)); }
      playing = true;
      statusL.textContent = `第 ${round}/${ROUNDS} 轮 · 总分 ${total} · 环顾四周,右下角标记猜测`;
      roundBadge.textContent = `第 ${round}/${ROUNDS} 轮 · ${total}`;
      setTitle(`第 ${round} 轮 — 街景寻踪`);
    }

    function onGuessClick(e) {
      if (!playing || !guessMap) return;
      guessWgs = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (guessMarker) guessMap.removeLayer(guessMarker);
      guessMarker = L.circleMarker(e.latlng, {
        radius: 7, color: '#0ea5e9', weight: 3, fillColor: '#0ea5e9', fillOpacity: 0.45,
      }).addTo(guessMap);
      submitBtn.disabled = false;
      gmTip.textContent = '已标记,可点击微调';
    }

    function submitGuess() {
      if (!playing || !guessWgs || !truth) return;
      playing = false;
      submitBtn.disabled = true;
      const dist = haversine(truth.wgs, guessWgs);
      const score = calcScore(dist);
      total += score;
      rounds.push({ city: truth.city, dist, score });
      roundBadge.textContent = `第 ${round}/${ROUNDS} 轮 · ${total}`;
      statusL.textContent = `第 ${round}/${ROUNDS} 轮 · 本轮 ${score} 分 · 总分 ${total}`;
      renderRoundOverlay({ dist, score });
    }

    /* ---------------- 结算小地图(Leaflet) ---------------- */
    function drawResultMap(res) {
      if (!resultMap) {
        resultMap = L.map(resultDiv, { attributionControl: false, zoomControl: true });
        resultTile = L.tileLayer(OSM_URL, { maxZoom: 19 }).addTo(resultMap);
      }
      resultMap.eachLayer((l) => { if (l !== resultTile) resultMap.removeLayer(l); });
      const real = [truth.wgs.lat, truth.wgs.lng];
      const guess = [guessWgs.lat, guessWgs.lng];
      L.polyline([real, guess], { color: '#f59e0b', weight: 3, opacity: 0.9 }).addTo(resultMap);
      L.circleMarker(real, { radius: 8, color: '#ef4444', weight: 3, fillColor: '#ef4444', fillOpacity: 0.5 })
        .addTo(resultMap).bindTooltip('真实位置', { permanent: true, direction: 'top', offset: [0, -6] });
      L.circleMarker(guess, { radius: 8, color: '#0ea5e9', weight: 3, fillColor: '#0ea5e9', fillOpacity: 0.5 })
        .addTo(resultMap).bindTooltip('你的猜测', { permanent: true, direction: 'top', offset: [0, -6] });
      resultMap.fitBounds(L.latLngBounds([real, guess]).pad(0.3));
      setTimeout(() => resultMap && resultMap.invalidateSize(), 150);
    }

    /* ---------------- 找一个有街景的落点 ---------------- */
    function getPanoAt(lng, lat) {
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 4000);
        try {
          panoService.getPanoramaByLocation(new B.Point(lng, lat), (data) => {
            clearTimeout(t);
            if (disposed) return resolve(null);
            const pos = data?.position;
            if (data && (data.id || data.panoId) && pos) {
              resolve({
                id: data.id || data.panoId,
                point: { lng: pos.lng ?? pos.getLng?.(), lat: pos.lat ?? pos.getLat?.() },
              });
            } else resolve(null);
          });
        } catch (e) { clearTimeout(t); resolve(null); }
      });
    }

    async function findPano(attempt = 0) {
      if (attempt >= 14) return null;
      const c = CITY_POOL[Math.floor(Math.random() * CITY_POOL.length)];
      const o = randOffset(c);
      const data = await getPanoAt(o.lng, o.lat);
      if (disposed) return null;
      if (data) return { ...data, city: c.name };
      return findPano(attempt + 1);
    }

    /* ---------------- 初始化 ---------------- */
    function init() {
      if (disposed) return;
      B = window.BMapGL;
      panoService = new B.PanoramaService();
      pano = new B.Panorama(panoDiv);

      guessMap = L.map(guessMapDiv, { attributionControl: false });
      guessMap.setView([35.0, 104.0], 4);   // 全国视角开局
      L.tileLayer(OSM_URL, OSM_OPTS).addTo(guessMap);
      guessMap.on('click', onGuessClick);
      setTimeout(() => { if (!disposed && guessMap) guessMap.invalidateSize(); }, 300);
    }

    renderStartOverlay();
    loadBMapGL().then(init).catch((err) => {
      if (disposed) return;
      statusL.textContent = '百度街景加载失败';
      renderStartOverlay(err);
      startOverlay.hidden = false;
    });

    return {
      onResize: () => {
        if (guessMap) guessMap.invalidateSize();
        if (resultMap) resultMap.invalidateSize();
      },
      onClose: () => { disposed = true; },
    };
  },
});
