/* ============================================================
 * Pkg —— 应用包管理(软件商店「真实资源下载」)
 *
 * 商店安装 = 把应用在部署产物里的全部文件真实下载到虚拟文件系统
 * 的 /app/<id>/ 下(root 所有的系统应用包目录,文件应用侧栏的
 * 「应用 /app」可见)。包定义来自 apps.json:
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

/** 设备级应用包根目录(root 所有,seed 见 fs.js freshRoot) */
const PKG_ROOT = '/app';
/** 文本类扩展名:按文本落盘,终端 cat / 文件应用可直接读 */
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
 * 确保应用包资源就位(幂等):齐备直接返回;缺失则逐文件真实下载,
 * 以 root 身份写入 /app/<id>/(系统包目录,普通用户只读)。
 * @param {Function} opts.onProgress ({ loaded, total, file }) —— 字节级进度
 * @returns {{ bytes: number, cached: boolean }}
 */
export async function ensureResources(id, opts = {}) {
  const pkg = await pkgInfo(id);
  if (!pkg?.files?.length) throw new Error('包清单缺失');
  const total = pkg.bytes || 0;
  if (resourcesPresent(id, pkg.files)) {
    opts.onProgress?.({ loaded: total, total, file: '' });
    return { bytes: total, cached: true };
  }
  let loaded = 0;
  opts.onProgress?.({ loaded: 0, total, file: '' });
  for (const file of pkg.files) {
    const url = new URL(file, document.baseURI).href;
    const data = await fetchFile(url, (n) => opts.onProgress?.({ loaded: loaded + n, total, file }));
    const p = pkgPath(id, file);
    const content = TEXT_EXT.test(file) ? new TextDecoder().decode(data) : data;
    if (!fs.write(p, content, { as: 'root', owner: 'root' })) {
      throw new Error(`写入 ${p} 失败`);
    }
    loaded += data.length;
    opts.onProgress?.({ loaded, total, file });
  }
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
