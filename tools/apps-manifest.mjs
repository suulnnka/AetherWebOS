#!/usr/bin/env node
/* ============================================================
 * 应用包清单扫描(商店「真实资源下载」的包定义来源)
 *
 * 一份应用包 = 该应用在部署产物里真正需要下载的全部文件:
 *   · 入口 chunk(assets/app-<id>-<hash>.js,Vite 按应用目录命名)
 *   · 应用 CSS(assets/app-<id>-<hash>.css)
 *   · 引擎 worker chunk(assets/app-worker-<hash>.js,从引用关系扒出)
 *   · 重型资产(模型 .aewn / .wasm / 图片字体等,同上)
 * 平台公共块(core-*.js / index-*.js)不属于任何应用包 —— 它们是
 * 「操作系统本体」,随部署一起加载,不经商店分发。
 *
 * 两个口径:
 *   · distCatalog(dir)  —— 生产:扫描构建产物,含哈希文件名与真实字节;
 *                           由 tools/emit-apps-manifest.mjs 写成 dist/apps.json
 *   · sourceCatalog()   —— 开发:扫描 js/apps/<id>/ 源码树(dev 服务器中间件
 *                           现场生成 /apps.json)。源码包只有应用自身文件,
 *                           不含 vendor 引擎/模型 —— 开发环境安装走轻量包,
 *                           下载链路与生产完全一致,字节口径以生产为准。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS_DIR = path.join(ROOT, 'js', 'apps');

/** 全部应用 id:js/apps 下带 manifest.js 的目录 */
export function listAppIds(appsDir = APPS_DIR) {
  return fs.readdirSync(appsDir)
    .filter((f) => fs.existsSync(path.join(appsDir, f, 'manifest.js')))
    .sort();
}

/** 读清单纯数据字段(store 等)。manifest.js 约定为纯数据,可直接 import */
async function readManifest(appsDir, id) {
  const mod = await import(pathToFileURL(path.join(appsDir, id, 'manifest.js')).href);
  return mod.default || {};
}

/**
 * 开发口径:递归列出每个应用目录下的源码文件,给出可 fetch 的绝对路径。
 * @returns {{ generatedAt: number, apps: Record<string, { files: string[], bytes: number }> }}
 */
export function sourceCatalog(appsDir = APPS_DIR) {
  const apps = {};
  for (const id of listAppIds(appsDir)) {
    const files = [];
    let bytes = 0;
    const walk = (rel) => {
      const abs = path.join(appsDir, id, rel);
      for (const name of fs.readdirSync(abs).sort()) {
        const childRel = rel ? `${rel}/${name}` : name;
        const childAbs = path.join(abs, name);
        if (fs.statSync(childAbs).isDirectory()) walk(childRel);
        else {
          files.push(`/js/apps/${id}/${childRel}`);
          bytes += fs.statSync(childAbs).size;
        }
      }
    };
    walk('');
    apps[id] = { files, bytes };
  }
  return { generatedAt: Date.now(), apps };
}

/* ---- dist 扫描(生产口径)---- */

/** 产物文件名 token(哈希文件名含 _ - .,几乎不可能撞车):
 *  产物里的引用是相对 chunk 目录的裸文件名(new URL("app-worker-x.js",
 *  import.meta.url)),提取 token 后与 dist/assets 实际清单求交集 */
const TOKEN = /[A-Za-z0-9._-]+\.(?:js|css|aewn|wasm|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|json|txt|html)\b/g;
/** 平台公共块:属于操作系统本体,不入应用包 */
const PLATFORM = /^(?:core|index)-[A-Za-z0-9_-]+\.js$/;

/**
 * 生产口径:扫描 dist,按「入口 → 引用 BFS」把每个应用的文件归拢成包。
 * @returns {{ generatedAt: number, apps: Record<string, { files: string[], bytes: number }> }}
 */
export function distCatalog(distDir) {
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`找不到 ${assetsDir} —— 先执行 vite build`);
  }
  const assets = new Set(fs.readdirSync(assetsDir));
  const sizeOf = (name) => fs.statSync(path.join(assetsDir, name)).size;
  /** 从 js/css 内容里扒出引用的产物文件名(平台公共块除外) */
  const refsOf = (src) => {
    const out = new Set();
    for (const m of src.matchAll(TOKEN)) {
      if (assets.has(m[0]) && !PLATFORM.test(m[0])) out.add(m[0]);
    }
    return out;
  };

  const apps = {};
  for (const id of listAppIds()) {
    const entry = [...assets].find((f) => new RegExp(`^app-${id}-[A-Za-z0-9_-]+\\.js$`).test(f));
    if (!entry) { apps[id] = { files: [], bytes: 0, missing: true }; continue; }
    const files = new Set([entry]);
    // CSS 与入口同级,按命名约定直接认领
    for (const f of assets) {
      if (new RegExp(`^app-${id}-[A-Za-z0-9_-]+\\.css$`).test(f)) files.add(f);
    }
    // BFS:js/css 里引用到的 worker chunk 与资产一并入包(worker 里还会
    // 再引用 wasm/模型,递归收拢);平台公共块(core/index)不入包也不深入
    const queue = [...files].filter((f) => f.endsWith('.js') || f.endsWith('.css'));
    while (queue.length) {
      const cur = queue.shift();
      const refs = refsOf(fs.readFileSync(path.join(assetsDir, cur), 'utf8'));
      for (const ref of refs) {
        if (files.has(ref)) continue;
        files.add(ref);
        if (ref.endsWith('.js') || ref.endsWith('.css')) queue.push(ref);
      }
    }
    const list = [...files].sort();
    apps[id] = { files: list.map((f) => 'assets/' + f), bytes: list.reduce((s, f) => s + sizeOf(f), 0) };
  }
  return { generatedAt: Date.now(), apps };
}

/** 校验:包完整性 —— 在售应用必须有包;包内文件必须真实存在。
 *  @returns {string[]} 问题列表(空 = 通过) */
export async function validate(distDir, catalog) {
  const problems = [];
  const assetsDir = path.join(distDir, 'assets');
  for (const id of listAppIds()) {
    const m = await readManifest(APPS_DIR, id);
    const pkg = catalog.apps[id];
    if (!pkg || pkg.missing || !pkg.files.length) {
      if (m.store === true) problems.push(`在售应用「${id}」没有构建出应用包(缺 app-${id}-*.js chunk)`);
      continue;
    }
    for (const f of pkg.files) {
      if (!fs.existsSync(path.join(distDir, f))) problems.push(`「${id}」包内文件缺失:${f}`);
    }
    if (m.store === true && !pkg.bytes) problems.push(`在售应用「${id}」包体积为 0`);
  }
  // 产物里不该有「孤儿」应用 chunk(有 chunk 但 js/apps 里没有对应目录)。
  // 哈希段可能含 - 和 _,不能反推 id —— 按已知 id 前缀逐一比对
  const ids = listAppIds();
  for (const f of fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []) {
    if (f.startsWith('app-worker-')) continue;   // 引擎 worker:已被所属应用的包收编
    if (!/^app-.*\.js$/.test(f)) continue;
    if (!ids.some((id) => f.startsWith(`app-${id}-`))) {
      problems.push(`产物里有未知应用的 chunk:${f}(js/apps 下没有对应应用目录?)`);
    }
  }
  return problems;
}

/** CLI:node tools/apps-manifest.mjs [--dir dist] —— 生成 dist/apps.json */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : 'dist';
  const catalog = distCatalog(dir);
  const problems = await validate(dir, catalog);
  if (problems.length) {
    for (const p of problems) console.error('✗ ' + p);
    process.exit(1);
  }
  const out = path.join(dir, 'apps.json');
  fs.writeFileSync(out, JSON.stringify(catalog));
  const total = Object.values(catalog.apps).reduce((s, a) => s + a.bytes, 0);
  const kb = (n) => (n / 1024).toFixed(1) + 'KB';
  console.log(`✓ 应用包清单已生成:${out}(${Object.keys(catalog.apps).length} 个应用,合计 ${kb(total)})`);
  for (const [id, p] of Object.entries(catalog.apps)) {
    console.log(`  ${id.padEnd(12)} ${String(p.files.length).padStart(3)} 个文件  ${kb(p.bytes)}`);
  }
}
