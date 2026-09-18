/* ============================================================
 * 应用:街景寻踪(类「图寻」玩法)
 * 随机空降到百度街景的某处街头 → 拖动环顾找线索 → 在右下角
 * 小地图上标记猜测 → 提交后按真实距离指数衰减计分,5 轮一局。
 * 街景与底图均来自百度地图 JS API GL(与地图应用共用 AK)。
 * ============================================================ */
import { el, escapeHtml } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './tuxun.css';

const AK = 'M6gP5GsIPshSgOh7JnGgnxgXlEj0gyRj';
const ROUNDS = 5;
const SCORE_SCALE = 20000;        // 计分尺度(米):1km≈4755,5km≈3894,20km≈1839,50km≈771
const BEST_KEY = 'webos.tuxun.best';
const CITY_POOL = [               // 街景覆盖较稳的城市;实际落点在市内随机扰动
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
    script.onerror = () => finish(false, new Error('百度地图脚本加载失败,请检查网络'));
    document.head.appendChild(script);
  });
  return bmapPromise;
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

/* 距离 → 结果图缩放级别 */
function zoomForDist(m) {
  if (m < 1000) return 14;
  if (m < 5000) return 12;
  if (m < 20000) return 11;
  if (m < 100000) return 9;
  if (m < 500000) return 7;
  return 5;
}

register({
  ...manifest,
  mount({ root, setTitle }) {
    let B = null;             // window.BMapGL
    let pano = null;          // B.Panorama 街景实例
    let panoService = null;
    let geocoder = null;
    let guessMap = null;      // 右下角猜测小地图
    let resultMap = null;     // 每轮结算小地图(复用)
    let guessMarker = null;
    let disposed = false;

    let round = 0;            // 当前轮(1 基;0 = 未开局)
    let total = 0;
    let rounds = [];          // { city, dist, score }
    let truth = null;         // { id, point:{lng,lat}, city }
    let guessPoint = null;
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
      onClick: (e) => { gmCard.classList.toggle('big'); setTimeout(() => guessMap && guessMap.resize && guessMap.resize(), 200); },
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

    function renderStartOverlay(err) {
      startOverlay.innerHTML = '';
      startOverlay.append(el('div', { class: 'tx-panel' },
        el('div', { class: 'tx-panel-title' }, icon('mapPin', 22), '街景寻踪'),
        el('div', { class: 'dim', style: { lineHeight: 1.8, fontSize: '12.5px' } },
          '你被空降到某个城市的街头。拖动街景环顾四周寻找线索,在右下角地图上标记你认为所在的位置,提交后按真实距离得分:越近分越高,满分 5000/轮。',
          el('br'), `一局共 ${ROUNDS} 轮,合计满分 ${5000 * ROUNDS} 分。`),
        err
          ? el('div', { class: 'mp-side-err dim', style: { color: '#ef4444' } }, String(err.message || err))
          : null,
        el('button', { class: 'btn primary', onClick: () => startGame() },
          icon('play', 13), err ? '重试' : '开始游戏')));
    }

    function renderRoundOverlay(res) {
      roundOverlay.innerHTML = '';
      roundOverlay.append(el('div', { class: 'tx-panel tx-panel-wide' },
        el('div', { class: 'tx-score' }, String(res.score), el('small', {}, ' 分')),
        el('div', { class: 'dim' },
          `距离真实位置 ${fmtDist(res.dist)} · 真实位置:${escapeHtml(truth.city || '未知地区')}`),
        el('div', { class: 'tx-rmap' }, resultDiv),
        el('div', { class: 'tx-actions' },
          el('button', { class: 'btn', onClick: () => { roundOverlay.hidden = true; reopenChip.hidden = false; } }, '回到街景'),
          round < ROUNDS
            ? el('button', { class: 'btn primary', onClick: () => nextRound() }, '下一轮')
            : el('button', { class: 'btn primary', onClick: () => showFinal() }, '查看总结'))));
      roundOverlay.hidden = false;
      drawResultMap(res);
    }

    const resultDiv = el('div');

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
        el('span', { class: 'badge-pill mono', id: 'tx-round-badge' }, '未开局')),
      el('div', { class: 'app-mid tx-stage' },
        panoDiv, gmCard, loadingChip, reopenChip, startOverlay, roundOverlay, finalOverlay),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        statusR)));

    const roundBadge = root.querySelector('#tx-round-badge');
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
      guessPoint = null;
      if (guessMarker) { guessMap.removeOverlay(guessMarker); guessMarker = null; }
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
      truth = found;
      truth.city = '定位中…';
      try {
        geocoder.getLocation(new B.Point(truth.point.lng, truth.point.lat), (r) => {
          if (disposed || !truth) return;
          const ac = r?.addressComponents || {};
          truth.city = ac.city || ac.province || r?.address || '未知地区';
        });
      } catch { /* 反地理编码失败不影响游玩 */ }

      try { pano.setId(truth.id); } catch { pano.setPosition(new B.Point(truth.point.lng, truth.point.lat)); }
      playing = true;
      statusL.textContent = `第 ${round}/${ROUNDS} 轮 · 总分 ${total} · 环顾四周,右下角标记猜测`;
      roundBadge.textContent = `第 ${round}/${ROUNDS} 轮 · ${total}`;
      setTitle(`第 ${round} 轮 — 街景寻踪`);
    }

    function onGuessClick(e) {
      if (!playing || !e.point || !guessMap) return;
      guessPoint = e.point;
      if (guessMarker) guessMap.removeOverlay(guessMarker);
      guessMarker = new B.Marker(e.point);
      guessMap.addOverlay(guessMarker);
      submitBtn.disabled = false;
      gmTip.textContent = '已标记,可点击微调';
    }

    function submitGuess() {
      if (!playing || !guessPoint || !truth || !guessMap) return;
      playing = false;
      submitBtn.disabled = true;
      const realPt = new B.Point(truth.point.lng, truth.point.lat);
      const dist = guessMap.getDistance(realPt, guessPoint);
      const score = calcScore(dist);
      total += score;
      rounds.push({ city: truth.city, dist, score });
      roundBadge.textContent = `第 ${round}/${ROUNDS} 轮 · ${total}`;
      statusL.textContent = `第 ${round}/${ROUNDS} 轮 · 本轮 ${score} 分 · 总分 ${total}`;
      renderRoundOverlay({ dist, score });
    }

    /* ---------------- 结算小地图 ---------------- */
    function drawResultMap(res) {
      if (!B) return;
      if (!resultMap) {
        resultMap = new B.Map(resultDiv, { enableMapClick: false });
      }
      resultMap.clearOverlays();
      const realPt = new B.Point(truth.point.lng, truth.point.lat);
      const line = new B.Polyline([realPt, guessPoint], { strokeColor: '#f59e0b', strokeWeight: 3, strokeOpacity: 0.9 });
      const mkReal = new B.Marker(realPt, { title: '真实位置' });
      const mkGuess = new B.Marker(guessPoint, { title: '你的猜测' });
      const label = (text, pt) => {
        const l = new B.Label(text, { position: pt, offset: new B.Size(8, -30) });
        l.setStyle({
          border: '1px solid var(--border, #ccc)', borderRadius: '6px', padding: '1px 6px',
          fontSize: '11px', background: 'rgba(255,255,255,.94)', color: '#1c2333', whiteSpace: 'nowrap',
        });
        return l;
      };
      resultMap.addOverlay(line);
      resultMap.addOverlay(mkReal);
      resultMap.addOverlay(mkGuess);
      resultMap.addOverlay(label('真实位置', realPt));
      resultMap.addOverlay(label('你的猜测', guessPoint));
      const mid = new B.Point(
        (truth.point.lng + guessPoint.lng) / 2,
        (truth.point.lat + guessPoint.lat) / 2);
      resultMap.centerAndZoom(mid, zoomForDist(res.dist));
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
            if (data?.id && pos) {
              resolve({ id: data.id, point: { lng: pos.lng ?? pos.getLng?.(), lat: pos.lat ?? pos.getLat?.() } });
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
    function showStartLoading() {
      renderStartOverlay();
      startOverlay.hidden = false;
    }

    function init() {
      if (disposed) return;
      B = window.BMapGL;
      panoService = new B.PanoramaService();
      pano = new B.Panorama(panoDiv);
      geocoder = new B.Geocoder();

      guessMap = new B.Map(guessMapDiv, { enableMapClick: false });
      guessMap.centerAndZoom(new B.Point(104.0, 35.0), 4);   // 全国视角开局
      guessMap.enableScrollWheelZoom(true);
      guessMap.addEventListener('click', onGuessClick);
      setTimeout(() => { if (!disposed && guessMap && guessMap.resize) guessMap.resize(); }, 300);
    }

    renderStartOverlay();
    loadBMapGL().then(init).catch((err) => {
      if (disposed) return;
      statusL.textContent = '百度地图加载失败';
      renderStartOverlay(err);
      startOverlay.hidden = false;
    });

    return {
      onResize: () => {
        if (guessMap && guessMap.resize) guessMap.resize();
        if (resultMap && resultMap.resize) resultMap.resize();
      },
      onClose: () => { disposed = true; },
    };
  },
});
