/* ============================================================
 * 应用:图寻(单图模式)
 * 每轮展示一张照片 → 在右下角 OSM 小地图上标记它的拍摄地 →
 * 提交后按真实距离指数衰减计分,5 轮一局。
 *
 * 全程无百度依赖:
 *  - 底图:自研内核 js/lib/minimap.js + tile.openstreetmap.de(OSM 数据,境内可直连)
 *  - 照片池:本地 ./photos/(坐标 WGS-84,见 photos/index.js 的扩充说明)
 *  - 反查城市名:Photon(Nominatim 同源数据的境内可达服务)
 * ============================================================ */
import L from '../../lib/minimap.js';
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import { PHOTOS } from './photos/index.js';
import './tuxun.css';

const OSM_URL = 'https://tile.openstreetmap.de/{z}/{x}/{y}.png';
const OSM_OPTS = { maxZoom: 18, attribution: '© OpenStreetMap 贡献者' };
const ROUNDS = 5;
const SCORE_SCALE = 20000;        // 计分尺度(米):1km≈4755,5km≈3894,20km≈1839,50km≈771
const BEST_KEY = 'webos.tuxun.best';

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

/* 本局照片序列:池子够大时不重复,不足时循环补齐 */
function newDeck() {
  const idx = PHOTOS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const deck = [];
  for (let r = 0; r < ROUNDS; r++) deck.push(PHOTOS[idx[r % idx.length]]);
  return deck;
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

register({
  ...manifest,
  mount({ root, setTitle }) {
    let guessMap = null;      // Leaflet 猜测小地图
    let resultMap = null;     // Leaflet 结算小地图(复用)
    let resultTile = null;
    let guessMarker = null;
    let disposed = false;

    let round = 0;            // 当前轮(1 基;0 = 未开局)
    let total = 0;
    let rounds = [];          // { city, dist, score }
    let truth = null;         // { lat, lng, title, city }
    let guessWgs = null;      // 猜测点(WGS-84)
    let playing = false;      // 本轮进行中(可标记/提交)
    let deck = [];

    /* ---------------- 骨架 ---------------- */
    const photoBox = el('div', { class: 'tx-photo' });
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
        el('div', { class: 'tx-panel-title' }, icon('mapPin', 22), '图寻'),
        el('div', { class: 'dim', style: { lineHeight: 1.8, fontSize: '12.5px' } },
          '看一张照片,判断它拍摄于哪里。在右下角地图上标记你的答案,提交后按真实距离得分:越近分越高,满分 5000/轮。',
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
          `偏离 ${fmtDist(res.dist)} · 拍摄地:${truth.title || '未知'}(${truth.city || '未知地区'})`),
        resultDiv,
        el('div', { class: 'tx-actions' },
          el('button', { class: 'btn', onClick: () => { roundOverlay.hidden = true; reopenChip.hidden = false; } }, '再看照片'),
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
      setTitle('总结 — 图寻');
    }

    /* ---------------- 布局 ---------------- */
    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        startBtn,
        el('span', { class: 'dim', style: { fontSize: '12px' } }, `看照片猜位置 · ${ROUNDS} 轮一局`),
        el('span', { class: 'grow' }),
        el('span', { class: 'badge-pill mono' }, '0')),
      el('div', { class: 'app-mid tx-stage' },
        photoBox, gmCard, reopenChip, startOverlay, roundOverlay, finalOverlay),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        statusR)));

    const roundBadge = root.querySelector('.badge-pill');

    /* ---------------- 游戏流程 ---------------- */
    function startGame() {
      round = 0; total = 0; rounds = [];
      deck = newDeck();
      startOverlay.hidden = true;
      finalOverlay.hidden = true;
      roundOverlay.hidden = true;
      reopenChip.hidden = true;
      nextRound();
    }

    function nextRound() {
      if (disposed || !guessMap) return;
      if (!PHOTOS.length) {
        renderStartOverlay(new Error('照片池为空:请往 js/apps/tuxun/photos/img/ 放入照片并在 photos/index.js 登记'));
        startOverlay.hidden = false;
        return;
      }
      round++;
      guessWgs = null;
      if (guessMarker) { guessMap.removeLayer(guessMarker); guessMarker = null; }
      playing = false;
      submitBtn.disabled = true;
      gmTip.textContent = '点击地图放置猜测';
      roundOverlay.hidden = true;
      reopenChip.hidden = true;
      roundBadge.textContent = `第 ${round}/${ROUNDS} 轮 · 0`;
      statusL.textContent = `第 ${round}/${ROUNDS} 轮 · 总分 ${total} · 这张照片拍自哪里?`;
      setTitle(`第 ${round} 轮 — 图寻`);

      const photo = deck[round - 1];
      truth = { lat: photo.lat, lng: photo.lng, title: photo.title || '', city: '定位中…' };
      photoBox.innerHTML = '';
      photoBox.append(el('img', { class: 'tx-photo-img', src: photo.src, alt: '这张照片拍摄于哪里?' }));
      // Photon 反查精确城市名(不阻塞作答)
      reverseCity(photo.lat, photo.lng).then((c) => { if (!disposed && truth) truth.city = c; });
      playing = true;
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
      const dist = haversine(truth, guessWgs);
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
      const real = [truth.lat, truth.lng];
      const guess = [guessWgs.lat, guessWgs.lng];
      L.polyline([real, guess], { color: '#f59e0b', weight: 3, opacity: 0.9 }).addTo(resultMap);
      L.circleMarker(real, { radius: 8, color: '#ef4444', weight: 3, fillColor: '#ef4444', fillOpacity: 0.5 })
        .addTo(resultMap).bindTooltip('真实位置', { permanent: true, direction: 'top', offset: [0, -6] });
      L.circleMarker(guess, { radius: 8, color: '#0ea5e9', weight: 3, fillColor: '#0ea5e9', fillOpacity: 0.5 })
        .addTo(resultMap).bindTooltip('你的猜测', { permanent: true, direction: 'top', offset: [0, -6] });
      resultMap.fitBounds(L.latLngBounds([real, guess]).pad(0.3));
      setTimeout(() => resultMap && resultMap.invalidateSize(), 150);
    }

    /* ---------------- 初始化 ---------------- */
    guessMap = L.map(guessMapDiv, { attributionControl: false });
    guessMap.setView([35.0, 104.0], 4);   // 全国视角开局
    L.tileLayer(OSM_URL, OSM_OPTS).addTo(guessMap);
    guessMap.on('click', onGuessClick);
    setTimeout(() => { if (!disposed && guessMap) guessMap.invalidateSize(); }, 300);

    renderStartOverlay();

    return {
      onResize: () => {
        if (guessMap) guessMap.invalidateSize();
        if (resultMap) resultMap.invalidateSize();
      },
      onClose: () => { disposed = true; guessMap?.remove(); resultMap?.remove(); },
    };
  },
});
