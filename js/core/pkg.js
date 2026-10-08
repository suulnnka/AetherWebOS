/* ============================================================
 * Pkg —— 应用包管理(软件商店「真实资源下载」)
 *
 * 商店安装 = 把应用在部署产物里的全部文件真实下载到虚拟文件系统
 * 的 /app/<id>/ 下。/app 是 **root 私有**的系统包目录(种子与 pkg
 * 写入的目录/文件都是 rw----,普通用户三位全空),
 * 普通用户不可列、不可读、不可写 —— 应用包是系统内部物,不进
 * 用户的浏览视野(文件应用的「应用 /app」入口已随之移除)。
 * 包定义来自 apps.json:
 *   · 生产:vite build 后由 tools/apps-manifest.mjs 扫描 dist 生成
 *     (入口 chunk + 应用 CSS + 引擎 worker chunk + 模型/wasm 资产);
 *   · 开发:vite dev 中间件现场扫描 js/apps 源码树(轻量源码包,
 *     下载链路与生产一致,字节口径以生产为准)。
 *
 * 资源是**设备级共享缓存**:任何用户装过一次,/app/<id>/ 就在;
 * 后续其他用户安装免下载直接启用;最后一个用户卸载时由 install.js
 * 回收整个目录(包缓存 ≠ 应用数据,appdata 始终保留)。
 *
 * 下载失败(断网/清单缺失)向上抛错,调用方决定 UI;绝不写下
 * 半个残包后宣称安装成功(中断的残包因文件不齐会在下次重装)。
 *
 * 本模块是叶子模块(只依赖 fs),不 import install/registry,
 * 避免环状依赖。
 * ============================================================ */
import fs from './fs.js';

/** 设备级应用包根目录(root 私有;种子模式见 fs.js freshRoot) */
const PKG_ROOT = '/app';
/** 应用包权限:目录/文件都只给 root,普通用户三位全空(不可列/读/写);无 x(锁定位默认不锁) */
const PKG_DIR_MODE = 'rw----';
const PKG_FILE_MODE = 'rw----';
/** 文本类扩展名:按文本落盘,系统侧(终端 root / 调试)可直接读 */
const TEXT_EXT = /\.(?:js|css|json|html?|svg|txt|md|xml|csv)$/i;

/* ---- 包清单 ---- */

let catalogPromise = null;

/** 拉取(并缓存)应用包清单;失败不缓存,下次重试 */
export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('apps.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`apps.json → HTTP ${r.status}`);
        return r.json();
      })
      .catch((err) => { catalogPromise = null; throw err; });
  }
  return catalogPromise;
}

/** 某应用的包定义 { files, bytes };清单缺失或没有该应用 → null */
export async function pkgInfo(id) {
  const catalog = await loadCatalog();
  return catalog.apps?.[id] ?? null;
}

/** 字节数格式化(包体积/进度展示) */
export const fmtBytes = (n) =>
  n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(0) + ' KB'
      : n + ' B';

/* ---- 落盘 ---- */

const pkgPath = (id, file) => `${PKG_ROOT}/${id}/${file.split('/').pop()}`;

/** 包是否齐备(逐文件存在性;下载中断的残包不齐 → 下次重装重下) */
function resourcesPresent(id, files) {
  return files.every((f) => fs.exists(pkgPath(id, f)));
}

/** 单文件真实下载(流式读,经 onChunk 汇报当前文件字节进度) */
async function fetchFile(url, onChunk) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) {
    const data = new Uint8Array(await res.arrayBuffer());
    onChunk?.(data.length);
    return data;
  }
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onChunk?.(loaded);
  }
  const data = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }
  return data;
}

/**
 * 存量树模式归一:老版本写过的 /app(种子 r-xr-x)、/app/<id>(默认
 * DIR_MODE rwxr-x)与最早用 FILE_MODE rw-r-- 落盘的包文件,权限段残留
 * 对用户可读 —— 新语义下穿越免费,「知道路径即可到达」,残留 r 就是
 * 真泄露。统一 chmod 到 root 私有;幂等,缺哪些补哪些。
 */
function normalizeModes(id, files) {
  if (!fs.exists(PKG_ROOT)) return;
  fs.chmod(PKG_ROOT, PKG_DIR_MODE, { as: 'root' });
  const dir = `${PKG_ROOT}/${id}`;
  if (fs.exists(dir)) fs.chmod(dir, PKG_DIR_MODE, { as: 'root' });
  for (const f of files) {
    const p = pkgPath(id, f);
    if (fs.exists(p)) fs.chmod(p, PKG_FILE_MODE, { as: 'root' });
  }
}

/**
 * 归一 /app 整棵树的模式(递归):老版本写过的残留(/app 种子 r-xr-x、
 * 早期包目录 rwxr-x、最早包文件 rw-r--)在穿越免费的新语义下是真实泄露
 * (目录名/文件名可列、知道路径即可读)。统一 chmod 到 root 私有;幂等,
 * 开机兜底一次,安装/重装路径也会顺带跑。
 */
export function normalizeAllModes() {
  if (!fs.exists(PKG_ROOT)) return;
  fs.chmod(PKG_ROOT, PKG_DIR_MODE, { as: 'root' });
  const walk = (p) => {
    for (const e of fs.list(p, { as: 'root' }) || []) {
      const child = `${p.replace(/\/$/, '')}/${e.name}`;
      if (e.dir) { fs.chmod(child, PKG_DIR_MODE, { as: 'root' }); walk(child); }
      else fs.chmod(child, PKG_FILE_MODE, { as: 'root' });
    }
  };
  walk(PKG_ROOT);
  fs.flush().catch(() => {});
}

/**
 * 确保应用包资源就位(幂等):齐备直接返回(顺带归一存量模式);缺失则
 * 逐文件真实下载,以 root 身份写入 /app/<id>/(目录/文件均 rw----,用户
 * 不可列/不可读/不可写)。
 * @param {Function} opts.onProgress ({ loaded, total, file }) —— 字节级进度
 * @returns {{ bytes: number, cached: boolean }}
 */
export async function ensureResources(id, opts = {}) {
  const pkg = await pkgInfo(id);
  if (!pkg?.files?.length) throw new Error('包清单缺失');
  const total = pkg.bytes || 0;
  if (resourcesPresent(id, pkg.files)) {
    normalizeAllModes();
    opts.onProgress?.({ loaded: total, total, file: '' });
    return { bytes: total, cached: true };
  }
  if (!fs.exists(PKG_ROOT)) fs.mkdir(PKG_ROOT, { as: 'root', silent: true });
  fs.chmod(PKG_ROOT, PKG_DIR_MODE, { as: 'root' });
  let loaded = 0;
  opts.onProgress?.({ loaded: 0, total, file: '' });
  for (const file of pkg.files) {
    const url = new URL(file, document.baseURI).href;
    const data = await fetchFile(url, (n) => opts.onProgress?.({ loaded: loaded + n, total, file }));
    const p = pkgPath(id, file);
    /* 应用包目录逐个建(root 私有),不靠 fs.write 的自动补目录(默认世界可读) */
    fs.mkdir(PKG_ROOT + '/' + id, { as: 'root', owner: 'root', mode: PKG_DIR_MODE, silent: true });
    const content = TEXT_EXT.test(file) ? new TextDecoder().decode(data) : data;
    if (!fs.write(p, content, { as: 'root', owner: 'root', mode: PKG_FILE_MODE })) {
      throw new Error(`写入 ${p} 失败`);
    }
    loaded += data.length;
    opts.onProgress?.({ loaded, total, file });
  }
  normalizeAllModes();           // 兜底:任何路径写进来的残留模式一并归一
  fs.flush().catch(() => {});   // 下载完成即冲刷,防刷新后「复活」
  return { bytes: loaded, cached: false };
}

/** 回收应用包资源(最后一个用户卸载时由 install.js 调用) */
export function removeResources(id) {
  const p = `${PKG_ROOT}/${id}`;
  if (!fs.exists(p)) return true;
  const ok = fs.rm(p, { as: 'root' });
  if (ok) fs.flush().catch(() => {});
  return ok;
}
