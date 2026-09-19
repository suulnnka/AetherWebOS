/* ============================================================
 * minimap.js —— 自研最小地图内核(替代 Leaflet)
 *
 * 为什么自己写:Leaflet 1.9.4 是 UMD 整体导入,无法 tree-shake,
 * 产物 149 KB(gzip 43.2 KB)+ 6.5 KB CSS,而地图/图寻两个应用只
 * 用到其中约 20 个 API。这里按"当前实际用到的子集"重写,
 * 对外刻意保持与 Leaflet 同名,方便两个应用切换时只改 import 行。
 *
 * 覆盖范围(不要再往里加"以后可能用"的东西):
 *  - Web Mercator(EPSG:3857)正反算 + 容器像素互转
 *  - XYZ 瓦片金字塔:视口裁剪 / 水平无限环绕 / 加载淡入 / 回收
 *  - 手势:拖拽惯性、滚轮锚点缩放、双指捏合、双击缩放
 *  - 矢量:circleMarker(像素半径)/ circle(米半径)/ polyline
 *  - 浮层:tooltip(常显)/ popup(带关闭)
 *  - 控件:缩放按钮 / 比例尺 / 版权
 *
 * 明确不做:GeoJSON、Canvas 渲染器、Marker 图标体系、CRS 切换、
 * 键盘导航、矢量编辑 —— 两个应用都没用到。
 * ============================================================ */
import './minimap.css';

const TILE = 256;
const MAX_LAT = 85.0511287798;      // Mercator 能表示的纬度上限,超过会算成 ±∞
const DEG = Math.PI / 180;
const ZOOM_MS = 250;                // 缩放动画时长,由 JS 收尾,不依赖 transitionend
const TILE_PAD = 1;                 // 视口外多加载一圈瓦片,平移时不露白
const EQ_MPP = 156543.03392;        // 赤道处 z=0 的「米/像素」= 2πR/256

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const div = (cls, parent) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (parent) parent.appendChild(d);
  return d;
};
const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);

/* 控件/浮层挂在容器里,若不挡住 pointerdown,容器会 setPointerCapture
 * 把后续指针事件抢走——按钮的 click 被重定向而失效,popup 上的点击会
 * 穿透到地图、滚轮会误缩放。等价于 Leaflet 的 disableClickPropagation */
const isolate = (el) => {
  for (const t of ['pointerdown', 'click', 'dblclick', 'contextmenu', 'wheel']) {
    el.addEventListener(t, (e) => e.stopPropagation());
  }
};

/* 经纬度 → 世界像素(z 级下整张地图 = 256 * 2^z 见方) */
function project(lat, lng, z) {
  const s = TILE * Math.pow(2, z);
  const la = clamp(lat, -MAX_LAT, MAX_LAT) * DEG;
  return {
    x: (lng / 360 + 0.5) * s,
    y: (0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI)) * s,
  };
}

/* 世界像素 → 经纬度(project 的逆运算) */
function unproject(x, y, z) {
  const s = TILE * Math.pow(2, z);
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))),
    lng: (x / s - 0.5) * 360,
  };
}

/* 当前纬度下 1 像素代表多少米 —— 比例尺与「按米画圆」都靠它 */
const metersPerPixel = (lat, z) => EQ_MPP * Math.cos(clamp(lat, -MAX_LAT, MAX_LAT) * DEG) / Math.pow(2, z);

/* 统一 [lat,lng] 数组与 {lat,lng} 对象两种写法 */
function toLatLng(v) {
  if (Array.isArray(v)) return { lat: Number(v[0]), lng: Number(v[1]) };
  return { lat: Number(v.lat), lng: Number(v.lng) };
}

/* ---------------- 事件 ---------------- */
class Events {
  constructor() { this._handlers = Object.create(null); }
  on(type, fn) {
    (this._handlers[type] || (this._handlers[type] = [])).push(fn);
    return this;
  }
  off(type, fn) {
    const list = this._handlers[type];
    if (list) this._handlers[type] = fn ? list.filter(f => f !== fn) : [];
    return this;
  }
  fire(type, data) {
    const list = this._handlers[type];
    // 复制一份再遍历:处理器里可能会 off 自己
    if (list) for (const fn of list.slice()) fn(data);
    return this;
  }
}

/* ---------------- 图层基类 ---------------- */
class Layer extends Events {
  /* 必须返回图层自己(Leaflet 语义):应用里到处是
   * layer.addTo(map).bindPopup(...) 这种链式写法,
   * 返回 addLayer 的返回值(地图)会把链式调用引到地图上炸掉 */
  addTo(target) { target.addLayer(this); return this; }
  remove() { if (this._map) this._map.removeLayer(this); return this; }
}

/* 控件基类:带 _control 标记,eachLayer 不把它们当普通图层遍历 */
class Control extends Layer {
  constructor() { super(); this._control = true; }
}

/* ============================================================
 * 地图
 * ============================================================ */
/* 类名叫 Map 会遮蔽内置的 Map(K/V 容器):模块内任何 new Map() 都会
 * 变成「拿 undefined 当容器」来造地图而直接抛错,所以内部叫 MiniMap,
 * 只在 export 处以 Map 的名字对外(对外约定与 Leaflet 同名) */
class MiniMap extends Events {
  constructor(container, opts = {}) {
    super();
    if (!(container instanceof Element)) {
      throw new Error(`minimap: 容器必须是 DOM 元素,实际收到 ${Object.prototype.toString.call(container)}`);
    }
    this._container = container;
    this._opts = Object.assign({
      minZoom: 0, maxZoom: 18, zoomControl: true, attributionControl: true,
      center: [0, 0], zoom: 2,
    }, opts);

    this._center = toLatLng(this._opts.center);
    this._zoom = clamp(this._opts.zoom, this._opts.minZoom, this._opts.maxZoom);
    this._layers = [];
    this._attribs = new Set();
    this._animating = false;
    this._animTimer = 0;
    this._drag = null;

    const cs = getComputedStyle(container);
    if (cs.position === 'static') container.style.position = 'relative';
    container.classList.add('mm-container');

    /* 瓦片层与叠加层分开:缩放动画时两者要施加不同的 transform
     * (瓦片层是「先 scale 后 translate」,叠加层只有 scale) */
    this._tilePane = div('mm-pane mm-tile-pane', container);
    this._overlayPane = div('mm-pane mm-overlay-pane', container);
    this._svgRoot = svgEl('svg');
    this._svgRoot.setAttribute('class', 'mm-svg');
    this._overlayPane.appendChild(this._svgRoot);

    this._size = { x: container.clientWidth, y: container.clientHeight };
    this._bindEvents();
    this._update();

    if (this._opts.zoomControl) new ZoomControl().addTo(this);
    if (this._opts.attributionControl) new AttributionControl().addTo(this);

    // 容器尺寸变化自动重排(图寻的结算图一开始藏在浮层里、尺寸为 0)
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.invalidateSize());
      this._ro.observe(container);
    }
  }

  /* ---------- 视口 ---------- */
  getContainer() { return this._container; }
  getCenter() { return Object.assign({}, this._center); }
  getZoom() { return this._zoom; }
  getSize() { return Object.assign({}, this._size); }

  setView(center, zoom) {
    this._finishZoomAnim();          // 动画中改视图:先落到终态,否则收尾定时器会把新视图覆盖回去
    this._center = toLatLng(center);
    if (zoom != null) this._zoom = clamp(Math.round(zoom), this._opts.minZoom, this._opts.maxZoom);
    this._update();
    return this;
  }

  setZoom(z) {
    this._finishZoomAnim();
    return this._animateZoom(clamp(Math.round(z), this._opts.minZoom, this._opts.maxZoom), this._centerPx());
  }

  invalidateSize() {
    this._finishZoomAnim();
    const w = this._container.clientWidth, h = this._container.clientHeight;
    if (w === this._size.x && h === this._size.y) return this;
    this._size = { x: w, y: h };
    this._update();
    return this;
  }

  fitBounds(bounds, opts = {}) {
    const pad = opts.padding || 12;
    const s = this._size;
    const zMax = this._opts.maxZoom;
    const sw = project(bounds.getSouth(), bounds.getWest(), zMax);
    const ne = project(bounds.getNorth(), bounds.getEast(), zMax);
    // 从最大级别往下找第一个「装得下」的级别
    let z = zMax;
    for (; z > this._opts.minZoom; z--) {
      const k = Math.pow(2, zMax - z);
      if ((ne.x - sw.x) / k <= s.x - pad * 2 && (ne.y - sw.y) / k <= s.y - pad * 2) break;
    }
    return this.setView(bounds.getCenter(), z);
  }

  /* ---------- 坐标换算 ---------- */
  latLngToContainer(ll) {
    const p = project(ll.lat, ll.lng, this._zoom);
    const c = project(this._center.lat, this._center.lng, this._zoom);
    return { x: p.x - c.x + this._size.x / 2, y: p.y - c.y + this._size.y / 2 };
  }

  containerPointToLatLng(x, y) {
    const c = project(this._center.lat, this._center.lng, this._zoom);
    return unproject(c.x - this._size.x / 2 + x, c.y - this._size.y / 2 + y, this._zoom);
  }

  _centerPx() { return { x: this._size.x / 2, y: this._size.y / 2 }; }

  /* ---------- 图层 ---------- */
  addLayer(layer) {
    if (layer._map === this) return this;
    if (layer._map) layer._map.removeLayer(layer);
    this._layers.push(layer);
    layer._map = this;
    if (layer.onAdd) layer.onAdd(this);
    this._syncAttribs();
    return this;
  }

  removeLayer(layer) {
    const i = this._layers.indexOf(layer);
    if (i < 0) return this;
    this._layers.splice(i, 1);
    layer._map = null;
    if (layer.onRemove) layer.onRemove(this);
    this._syncAttribs();
    return this;
  }

  /* 只遍历普通图层:图寻结算时会 eachLayer 清掉上一轮的标记,
   * 若把控件也算进去,缩放按钮会被一并删掉(原 Leaflet 版就有这问题) */
  eachLayer(fn) {
    for (const l of this._layers.slice()) if (!l._control) fn(l);
    return this;
  }

  _syncAttribs() {
    for (const l of this._layers) if (l instanceof AttributionControl) l.refresh();
  }

  /* ---------- 浮层 ---------- */
  openPopup(popup) {
    if (this._openedPopup && this._openedPopup !== popup) this._openedPopup.remove();
    popup.addTo(this);
    this._openedPopup = popup;
    return this;
  }

  closePopup() {
    if (this._openedPopup) { this._openedPopup.remove(); this._openedPopup = null; }
    return this;
  }

  /* ---------- 渲染 ---------- */
  _update() {
    if (this._animating) return;
    const s = this._size;
    const c = project(this._center.lat, this._center.lng, this._zoom);
    const ox = c.x - s.x / 2, oy = c.y - s.y / 2;
    this._tilePane.style.transform = `translate3d(${-ox}px, ${-oy}px, 0)`;
    this._updateTiles();
    this._updateOverlay();
  }

  _updateOverlay() {
    for (const l of this._layers) if (l._project) l._project();
  }

  _updateTiles() {
    for (const l of this._layers) if (l._refreshTiles) l._refreshTiles();
  }

  /* 内容位移 (dx,dy) 像素:用于拖拽与惯性 */
  _panBy(dx, dy) {
    const c = project(this._center.lat, this._center.lng, this._zoom);
    const n = unproject(c.x - dx, c.y - dy, this._zoom);
    this._center = { lat: n.lat, lng: n.lng };
    this._update();
  }

  /**
   * 缩放动画:以 anchor(容器像素)为锚点,保证锚点下的地理位置不动。
   * 做法是让旧瓦片用 transform 过渡缩放,动画结束再换成新级别的瓦片 ——
   * 因为结束态的 transform 与新视图完全等价,所以换瓦片那一下没有跳变。
   */
  _animateZoom(toZoom, anchor) {
    const z0 = this._zoom;
    const z1 = clamp(Math.round(toZoom), this._opts.minZoom, this._opts.maxZoom);
    if (z1 === z0 || this._animating) return this;

    const k = Math.pow(2, z1 - z0);
    const s = this._size;
    const c0 = project(this._center.lat, this._center.lng, z0);
    const o0 = { x: c0.x - s.x / 2, y: c0.y - s.y / 2 };
    // 锚点相对容器中心的偏移;新中心 = 让同一个地理点仍落在 anchor 上
    const ax = anchor.x - s.x / 2, ay = anchor.y - s.y / 2;
    const c1 = { x: k * (c0.x + ax) - ax, y: k * (c0.y + ay) - ay };
    const o1 = { x: c1.x - s.x / 2, y: c1.y - s.y / 2 };
    const next = unproject(c1.x, c1.y, z1);

    this._animating = true;
    this._animEnd = { zoom: z1, center: next, o: o1 };
    const tp = this._tilePane, op = this._overlayPane;
    const ease = `transform ${ZOOM_MS}ms cubic-bezier(0.25,0.46,0.45,0.94)`;
    tp.style.transition = op.style.transition = ease;
    // 瓦片层是「先 scale 后 translate」,原点必须是 (0,0);
    // 叠加层没有 translate,直接以锚点为原点缩放
    tp.style.transformOrigin = '0 0';
    op.style.transformOrigin = `${anchor.x}px ${anchor.y}px`;
    tp.style.transform = `translate3d(${-o0.x}px, ${-o0.y}px, 0) scale(1)`;
    op.style.transform = 'scale(1)';
    void tp.offsetWidth;                       // 强制重排,否则起始态不生效、动画被整段跳过
    tp.style.transform = `translate3d(${-o1.x}px, ${-o1.y}px, 0) scale(${k})`;
    op.style.transform = `scale(${k})`;

    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => this._finishZoomAnim(), ZOOM_MS);
    return this;
  }

  /* 落到动画终态:定时器自然收尾与「被拖拽/设视图打断」共用同一条路,
   * 否则打断只清定时器的话 _animating 永远为 true,_update 全部早退,地图直接卡死 */
  _finishZoomAnim() {
    if (!this._animating) return;
    clearTimeout(this._animTimer);
    this._animating = false;
    this._zoom = this._animEnd.zoom;
    this._center = this._animEnd.center;
    const tp = this._tilePane, op = this._overlayPane;
    tp.style.transition = op.style.transition = '';
    tp.style.transformOrigin = op.style.transformOrigin = '';
    tp.style.transform = `translate3d(${-this._animEnd.o.x}px, ${-this._animEnd.o.y}px, 0)`;
    op.style.transform = '';
    this._update();
    this.fire('zoomend', { zoom: this._zoom });
  }

  /* ---------- 交互 ---------- */
  _bindEvents() {
    const c = this._container;

    c.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      this._finishZoomAnim();                   // 按下即打断缩放动画:直接落到终态再起拖拽
      cancelAnimationFrame(this._glideRaf);     // 按下即打断惯性滑行
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0, moved: 0 };
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener('pointermove', (e) => {
      const p = this._offsetOf(e);
      if (!this._drag) { this.fire('mousemove', { latlng: this.containerPointToLatLng(p.x, p.y) }); return; }
      const d = this._drag;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      const now = performance.now(), dt = now - d.t;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (dt > 0) {
        d.vx = dx / dt * 16;                    // 换算成「每帧位移」当惯性初速
        d.vy = dy / dt * 16;
        d.t = now;
      }
      d.x = e.clientX; d.y = e.clientY;
      if (d.moved > 2) c.classList.add('mm-dragging');
      this._panBy(dx, dy);
    });

    const endDrag = (e) => {
      const d = this._drag;
      if (!d) return;
      this._drag = null;
      c.classList.remove('mm-dragging');
      // click 事件在 pointerup 之后才派发,那时 _drag 已清空,
      // 所以要把位移量留下来给 click 判断「这是拖拽还是点击」
      this._lastMoved = d.moved;
      if (c.hasPointerCapture?.(d.id)) c.releasePointerCapture(d.id);
      // 快速划一下就松手 → 惯性滑行;慢慢拖着松手则不滑
      if (d.moved > 2 && performance.now() - d.t < 90) this._glide(d.vx, d.vy);
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    c.addEventListener('click', (e) => {
      if (this._lastMoved > 3) return;                       // 拖过就不算点击
      const p = this._offsetOf(e);
      this.fire('click', { latlng: this.containerPointToLatLng(p.x, p.y) });
    });

    c.addEventListener('dblclick', (e) => {
      const p = this._offsetOf(e);
      this._animateZoom(this._zoom + (e.shiftKey ? -1 : 1), p);
      this.fire('dblclick', { latlng: this.containerPointToLatLng(p.x, p.y) });
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this._animating) return;               // 动画期间丢掉滚轮,顺带把节流做了
      this._animateZoom(this._zoom + (e.deltaY < 0 ? 1 : -1), this._offsetOf(e));
    }, { passive: false });

    // 双指捏合:两指距离定级别,中点定锚点
    const touch = new Map();
    let pinch = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touch.size === 2) {
        const [a, b] = [...touch.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        this._drag = null;                       // 两指时不走拖拽
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !touch.has(e.pointerId)) return;
      touch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touch.size !== 2 || !pinch) return;
      const [a, b] = [...touch.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.abs(dist - pinch.dist) > 40) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this._animateZoom(this._zoom + (dist > pinch.dist ? 1 : -1),
          this._offsetOf({ clientX: mid.x, clientY: mid.y }));
        pinch.dist = dist;
      }
    });
    const dropTouch = (e) => { touch.delete(e.pointerId); if (touch.size < 2) pinch = null; };
    c.addEventListener('pointerup', dropTouch);
    c.addEventListener('pointercancel', dropTouch);
  }

  _offsetOf(e) {
    const r = this._container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _glide(vx, vy) {
    const v = { x: vx, y: vy };
    const step = () => {
      v.x *= 0.9; v.y *= 0.9;
      if (Math.hypot(v.x, v.y) < 0.3) return;
      this._panBy(v.x, v.y);
      this._glideRaf = requestAnimationFrame(step);
    };
    this._glideRaf = requestAnimationFrame(step);
  }

  remove() {
    clearTimeout(this._animTimer);
    cancelAnimationFrame(this._glideRaf);
    if (this._ro) this._ro.disconnect();
    for (const l of this._layers.slice()) this.removeLayer(l);
    this._container.classList.remove('mm-container');
    this._tilePane.remove();
    this._overlayPane.remove();
    return this;
  }
}

/* ============================================================
 * 瓦片层
 * ============================================================ */
class TileLayer extends Layer {
  constructor(urlTemplate, opts = {}) {
    super();
    this._url = urlTemplate;
    this._opts = Object.assign({ minZoom: 0, maxZoom: 18, subdomains: 'abc', attribution: '' }, opts);
    this._tiles = new Map();       // key -> <img>
  }

  onAdd(map) {
    this._el = div('mm-tile-layer', map._tilePane);
    if (this._opts.attribution) map._attribs.add(this._opts.attribution);
    this._refreshTiles();
  }

  onRemove(map) {
    this._el?.remove();
    this._tiles.clear();
    if (this._opts.attribution) map._attribs.delete(this._opts.attribution);
  }

  _refreshTiles() {
    const map = this._map;
    if (!map || map._animating) return;
    // 地图级别超出本层的取瓦片范围时,用边界级别的瓦片整体缩放顶上,
    // 否则 pane 的 translate(按 map 级算)和瓦片坐标(按 z 级算)会错位
    const z = clamp(Math.round(map._zoom), this._opts.minZoom, this._opts.maxZoom);
    const k = Math.pow(2, map._zoom - z);
    this._el.style.transform = k === 1 ? '' : `scale(${k})`;
    this._el.style.transformOrigin = '0 0';

    const n = 1 << z;
    const s = map._size;
    const c = project(map._center.lat, map._center.lng, z);
    const ox = c.x - s.x / 2 / k, oy = c.y - s.y / 2 / k;
    const x0 = Math.floor(ox / TILE) - TILE_PAD, x1 = Math.floor((ox + s.x / k) / TILE) + TILE_PAD;
    const y0 = Math.floor(oy / TILE) - TILE_PAD, y1 = Math.floor((oy + s.y / k) / TILE) + TILE_PAD;

    const need = new Set();
    for (let tx = x0; tx <= x1; tx++) {
      // 水平无限环绕:列号取模,世界宽度以外的部分重复取同一列
      const wx = ((tx % n) + n) % n;
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;         // 纬度方向不环绕,超出就是空白
        const key = `${tx}/${ty}`;
        need.add(key);
        if (this._tiles.has(key)) continue;
        const img = document.createElement('img');
        img.className = 'mm-tile';
        img.style.left = `${tx * TILE}px`;
        img.style.top = `${ty * TILE}px`;
        img.alt = '';
        img.decoding = 'async';
        img.src = this._tileUrl(wx, ty, z);
        img.addEventListener('load', () => img.classList.add('mm-tile-ok'));
        img.addEventListener('error', () => {
          img.remove();
          this._tiles.delete(key);
          this.fire('tileerror', {});
        });
        this._tiles.set(key, img);
        this._el.appendChild(img);
      }
    }
    // 回收视口外的瓦片
    for (const [key, img] of this._tiles) {
      if (need.has(key)) continue;
      img.remove();
      this._tiles.delete(key);
    }
  }

  _tileUrl(x, y, z) {
    const subs = this._opts.subdomains || 'abc';
    const i = Math.abs(x + y) % subs.length;
    return this._url
      .replace('{z}', z).replace('{x}', x).replace('{y}', y)
      .replace('{s}', subs[i])
      .replace('{r}', window.devicePixelRatio > 1 ? '@2x' : '');
  }
}

/* ============================================================
 * 矢量图元
 * ============================================================ */
class Path extends Layer {
  constructor(opts = {}) {
    super();
    this._opts = Object.assign({ color: '#3388ff', weight: 3, opacity: 1, fillColor: null, fillOpacity: 0.2 }, opts);
  }
  onAdd(map) { map._svgRoot.appendChild(this._el); this._project(); }
  onRemove() { this._el?.remove(); }
  _project() { }
}

class CircleMarker extends Path {
  constructor(latlng, opts = {}) {
    super(opts);
    this._latlng = toLatLng(latlng);
    this._radius = opts.radius ?? 6;             // 像素半径,不随缩放变
  }
  onAdd(map) {
    this._el = svgEl('circle');
    this._el.setAttribute('fill', this._opts.fillColor || this._opts.color);
    this._el.setAttribute('fill-opacity', this._opts.fillOpacity);
    this._el.setAttribute('stroke', this._opts.color);
    this._el.setAttribute('stroke-width', this._opts.weight);
    super.onAdd(map);
    // bindTooltip 只是登记,真正挂载要等图层加入地图
    if (this._tip) this._tip.addTo(map);
  }
  onRemove(map) {
    super.onRemove(map);
    this._tip?.remove();
    this._popup?.remove();
  }
  setLatLng(ll) {
    this._latlng = toLatLng(ll);
    this._tip?.setLatLng(this._latlng);       // 已绑定的浮层跟着挪
    this._popup?.setLatLng(this._latlng);
    this._project();
    return this;
  }
  _project() {
    if (!this._map) return;
    const p = this._map.latLngToContainer(this._latlng);
    this._el.setAttribute('cx', p.x);
    this._el.setAttribute('cy', p.y);
    this._el.setAttribute('r', this._radius);
  }
  bindPopup(html, opts) { this._popup = new Popup(html, opts).setLatLng(this._latlng); return this; }
  openPopup() { if (this._popup) this._map?.openPopup(this._popup); return this; }
  bindTooltip(text, opts) {
    this._tip?.remove();                       // 重复 bind 先摘旧的,别把上一条留在图上
    this._tip = new Tooltip(opts).setLatLng(this._latlng).setContent(text);
    // 图元已在图上才调用 bind* 的话(图寻结算图就是这么写的),按 Leaflet 语义立即挂载
    if (this._map) this._tip.addTo(this._map);
    return this;
  }
}

/* 按「米」画的圆 —— 半径随纬度与级别换算成像素 */
class Circle extends CircleMarker {
  _project() {
    if (!this._map) return;
    const p = this._map.latLngToContainer(this._latlng);
    const r = (this._opts.radius || 0) / metersPerPixel(this._latlng.lat, this._map._zoom);
    this._el.setAttribute('cx', p.x);
    this._el.setAttribute('cy', p.y);
    this._el.setAttribute('r', r);
  }
}

class Polyline extends Path {
  constructor(latlngs, opts = {}) {
    super(opts);
    this._pts = latlngs.map(toLatLng);
  }
  onAdd(map) {
    this._el = svgEl('polyline');
    this._el.setAttribute('fill', 'none');
    this._el.setAttribute('stroke', this._opts.color);
    this._el.setAttribute('stroke-width', this._opts.weight);
    this._el.setAttribute('stroke-opacity', this._opts.opacity);
    this._el.setAttribute('stroke-linejoin', 'round');
    this._el.setAttribute('stroke-linecap', 'round');
    super.onAdd(map);
  }
  _project() {
    if (!this._map) return;
    this._el.setAttribute('points', this._pts.map(p => {
      const c = this._map.latLngToContainer(p);
      return `${c.x},${c.y}`;
    }).join(' '));
  }
}

/* ============================================================
 * 浮层:tooltip / popup
 * ============================================================ */
const TIP_POS = {
  top: 'translate(-50%, -100%)',
  bottom: 'translate(-50%, 0)',
  left: 'translate(-100%, -50%)',
  right: 'translate(0, -50%)',
  center: 'translate(-50%, -50%)',
};

class Tooltip extends Layer {
  constructor(opts = {}) {
    super();
    this._opts = Object.assign({ direction: 'top', offset: [0, 0], className: '' }, opts);
    this._latlng = null;
    this._el = div(`mm-tooltip ${this._opts.className}`.trim());
  }
  setLatLng(ll) { this._latlng = toLatLng(ll); this._project(); return this; }
  setContent(html) { this._el.innerHTML = html; return this; }
  onAdd(map) { map._overlayPane.appendChild(this._el); this._project(); }
  onRemove() { this._el.remove(); }
  _project() {
    if (!this._map || !this._latlng) return;
    const p = this._map.latLngToContainer(this._latlng);
    const [ox, oy] = this._opts.offset;
    this._el.style.left = `${p.x + ox}px`;
    this._el.style.top = `${p.y + oy}px`;
    this._el.style.transform = TIP_POS[this._opts.direction] || TIP_POS.top;
  }
}

class Popup extends Layer {
  constructor(html = '', opts = {}) {
    super();
    this._opts = Object.assign({ maxWidth: 260, offset: [0, -10] }, opts);
    this._latlng = null;
    this._el = div('mm-popup');
    isolate(this._el);
    this._el.style.maxWidth = `${this._opts.maxWidth}px`;
    this._body = div('mm-popup-body', this._el);
    this._body.innerHTML = html;
    const close = div('mm-popup-close', this._el);
    close.textContent = '×';
    close.addEventListener('click', () => this.remove());
  }
  setLatLng(ll) { this._latlng = toLatLng(ll); this._project(); return this; }
  setContent(html) { this._body.innerHTML = html; return this; }
  onAdd(map) { map._overlayPane.appendChild(this._el); this._project(); }
  onRemove() {
    this._el.remove();
    if (this._map?._openedPopup === this) this._map._openedPopup = null;
  }
  _project() {
    if (!this._map || !this._latlng) return;
    const p = this._map.latLngToContainer(this._latlng);
    const [ox, oy] = this._opts.offset;
    this._el.style.left = `${p.x + ox}px`;
    this._el.style.top = `${p.y + oy}px`;
  }
}

/* ============================================================
 * 图层组
 * ============================================================ */
class LayerGroup extends Layer {
  constructor(layers = []) {
    super();
    this._layers = new Set();
    for (const l of layers) this.addLayer(l);
  }
  addLayer(l) { this._layers.add(l); if (this._map) this._map.addLayer(l); return this; }
  removeLayer(l) { this._layers.delete(l); if (this._map) this._map.removeLayer(l); return this; }
  clearLayers() {
    for (const l of [...this._layers]) this.removeLayer(l);
    return this;
  }
  eachLayer(fn) { for (const l of this._layers) fn(l); return this; }
  onAdd(map) { for (const l of this._layers) map.addLayer(l); }
  onRemove(map) { for (const l of this._layers) map.removeLayer(l); }
}

/* ============================================================
 * 经纬度范围
 * ============================================================ */
class LatLngBounds {
  constructor(latlngs = []) {
    this._s = 90; this._w = 180; this._n = -90; this._e = -180;
    this._empty = true;
    for (const p of latlngs) this.extend(p);
  }
  extend(v) {
    const p = toLatLng(v);
    if (this._empty) { this._s = this._n = p.lat; this._w = this._e = p.lng; this._empty = false; return this; }
    this._s = Math.min(this._s, p.lat); this._n = Math.max(this._n, p.lat);
    this._w = Math.min(this._w, p.lng); this._e = Math.max(this._e, p.lng);
    return this;
  }
  getSouth() { return this._s; }
  getNorth() { return this._n; }
  getWest() { return this._w; }
  getEast() { return this._e; }
  getCenter() { return { lat: (this._s + this._n) / 2, lng: (this._w + this._e) / 2 }; }
  pad(ratio) {
    const h = Math.abs(this._n - this._s) * ratio, w = Math.abs(this._e - this._w) * ratio;
    return new LatLngBounds([{ lat: this._s - h, lng: this._w - w }, { lat: this._n + h, lng: this._e + w }]);
  }
}

/* ============================================================
 * 控件
 * ============================================================ */
class ZoomControl extends Control {
  onAdd(map) {
    this._el = div('mm-control mm-zoom', map._container);
    isolate(this._el);
    const mk = (text, delta, title) => {
      const b = document.createElement('button');
      b.className = 'mm-zoom-btn';
      b.type = 'button';
      b.title = title;
      b.textContent = text;
      b.addEventListener('click', () => map.setZoom(map.getZoom() + delta));
      this._el.appendChild(b);
    };
    mk('+', 1, '放大');
    mk('−', -1, '缩小');
  }
  onRemove() { this._el?.remove(); }
}

const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
  20000, 50000, 100000, 200000, 500000, 1000000, 2000000];

class ScaleControl extends Control {
  constructor(opts = {}) { super(); this._opts = opts; }
  onAdd(map) {
    this._el = div('mm-control mm-scale', map._container);
    isolate(this._el);
    this._bar = div('mm-scale-bar', this._el);
    this._label = div('mm-scale-label', this._el);
    this._project();
  }
  onRemove() { this._el?.remove(); }
  _project() {
    if (!this._map || !this._el) return;
    const mpp = metersPerPixel(this._map._center.lat, this._map._zoom);
    let best = SCALE_STEPS[0];
    for (const m of SCALE_STEPS) if (m / mpp <= 150) best = m;
    this._bar.style.width = `${Math.round(best / mpp)}px`;
    this._label.textContent = best < 1000 ? `${best} 米` : `${best / 1000} 公里`;
  }
}

class AttributionControl extends Control {
  onAdd(map) { this._el = div('mm-control mm-attrib', map._container); isolate(this._el); this.refresh(); }
  onRemove() { this._el?.remove(); }
  refresh() { if (this._el) this._el.textContent = [...this._map._attribs].filter(Boolean).join(' | '); }
}

/* ============================================================
 * 对外接口:刻意沿用 Leaflet 的名字,应用切换只改 import 行
 * ============================================================ */
export const L = {
  map: (container, opts) => new MiniMap(container, opts),
  tileLayer: (url, opts) => new TileLayer(url, opts),
  circleMarker: (latlng, opts) => new CircleMarker(latlng, opts),
  circle: (latlng, opts) => new Circle(latlng, opts),
  polyline: (latlngs, opts) => new Polyline(latlngs, opts),
  tooltip: (opts) => new Tooltip(opts),
  layerGroup: () => new LayerGroup(),
  latLngBounds: (latlngs) => new LatLngBounds(latlngs),
  control: {
    scale: (opts) => new ScaleControl(opts),
  },
};

export default L;
export { MiniMap as Map, TileLayer, CircleMarker, Circle, Polyline, Tooltip, Popup, LayerGroup, LatLngBounds, project, unproject, metersPerPixel };
