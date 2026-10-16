#!/usr/bin/env node
/* ============================================================
 * i18n-extract —— 字典平面统一闸门(docs/i18n.md §11)
 *
 * 扫描 js/{core,system,lib,apps,game} 引号内中文字面量(含站点 html/ajs),
 * 对照各单元 i18n/en.js 字典:
 *   - 「源有译无」(t() 的键不在任何字典)→ 报错阻断
 *   - 「译有源无」(字典键在扫描源里找不到对应字面量 = 漂移死键)→ 报错阻断
 *   - 裸中文(未包 t())→ 仅按单元计数提示,不阻断(P1/P2 逐应用接入)
 * 用法:npm run i18n:check(或 node tools/i18n-extract.mjs)
 * ============================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
export function scanStrings(src) {
  const lits = [];          // { value, line, inT }
  let i = 0, line = 1, prev = '';   // prev:上一个有效字符(判 regex vs 除法)
  const n = src.length;

  /* 读一个字符串字面量(src[i] 为开引号);模板串的 ${} 插值按嵌套代码
   * 递归识别其中的字符串(t('…') 常见于插值内),静态段合并为整体字面量 */
  function readString() {
    const quote = src[i];
    const openPos = i, startLine = line;
    let s = '', hasInterp = false;
    i++;
    while (i < n && src[i] !== quote) {
      if (src[i] === '\\') {
        const e = src[i + 1];
        s += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === "'" ? "'" : e === '"' ? '"' : e === '`' ? '`' : e;
        i += 2; continue;
      }
      if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
        hasInterp = true; s += '\u0001';
        i += 2;
        let d = 1;
        while (i < n && d > 0) {
          const ch = src[i];
          if (ch === '\n') { line++; i++; continue; }
          if (ch === "'" || ch === '"' || ch === '`') { readString(); continue; }
          if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
          if (ch === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
            i += 2; continue;
          }
          if (ch === '{') d++;
          else if (ch === '}') d--;
          i++;
        }
        continue;
      }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;   // 闭合引号
    // 是否 t('…') 的首参:闭合引号后跟 , 或 ),开引号前是独立的 t 调用
    const afterOk = /^\s*[,)]/.test(src.slice(i, i + 8));
    const head = src.slice(Math.max(0, openPos - 60), openPos);
    const isTArg = afterOk && /(?:^|[^\w$.])t\s*\(\s*$/.test(head);
    lits.push({ value: s, line: startLine, inT: isTArg && !hasInterp, interp: hasInterp });
    prev = quote;
  }

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }   // 换行不重置 prev:正则可跨行跟在 [ =( 等之后
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    // 注释
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    // 字符串
    if (c === '"' || c === "'" || c === '`') { readString(); continue; }
    // 正则 vs 除法:上个有效字符属于这些 → 按正则跳过
    if (c === '/' && '(,=:[!&|?{};+-*%~^<>'.includes(prev)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        else if (src[i] === '\n') { line++; break; }
        if (src[i] === '\n') line++;
        i++;
      }
      i++;   // 跳过 flags
      prev = '/';
      continue;
    }
    prev = c; i++;
  }
  return lits;
}

/* ---- 主流程(直接执行时;被 import 时只暴露 scanStrings) ---- */
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '/dev/null').href;
if (isMain) main();

function main() {
const ROOT = new URL('..', import.meta.url).pathname;
const UNITS = ['core', 'system', 'lib', 'apps', 'game'];
const ZH = /[\u4e00-\u9fff]/;
/* ---- 收集扫描源 ---- */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'i18n' || e.name === 'node_modules') continue;   // 字典文件自身不进源侧
      walk(p, out);
    } else if (/\.(js|ajs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const sources = [];          // { unit, file, lits }
for (const unit of UNITS) {
  for (const file of walk(join(ROOT, 'js', unit))) {
    const lits = scanStrings(readFileSync(file, 'utf8'));
    sources.push({ unit, file, lits });
  }
}

/* ---- 收集字典 ---- */
const dictFiles = [];
function walkDicts(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDicts(p);
    else if (/i18n[\\/]en\.js$/.test(p) || /i18n[\\/]en-US\.js$/.test(p)) dictFiles.push(p);
  }
}
walkDicts(join(ROOT, 'js'));

const dict = new Map();      // key -> where
for (const f of dictFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/'((?:\\.|[^'\\])+)'(?=\s*:)/g)) {
    const key = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
    if (dict.has(key)) console.warn(`[i18n:check] 重复键(以首见为准):${JSON.stringify(key)}`);
    else dict.set(key, relative(ROOT, f));
  }
}

/* ---- 比对 ---- */
const tKeys = new Map();     // t() 键 -> 首见位置(源有译无检查)
const allLits = new Set();   // 全部含中文字面量(译有源无检查)
const bareByUnit = new Map();
for (const { unit, file, lits } of sources) {
  const rel = relative(ROOT, file);
  let bare = 0;
  for (const l of lits) {
    if (!ZH.test(l.value)) continue;
    allLits.add(l.value);
    if (l.inT) {
      const key = l.value;
      if (!tKeys.has(key)) tKeys.set(key, `${rel}:${l.line}`);
    } else bare++;
  }
  if (bare) bareByUnit.set(unit, (bareByUnit.get(unit) || 0) + bare);
}

let bad = 0;
for (const [key, where] of tKeys) {
  if (!dict.has(key)) { console.error(`[i18n:check] 源有译无:${JSON.stringify(key)}  (${where})`); bad++; }
}
for (const [key, where] of dict) {
  if (!allLits.has(key)) { console.error(`[i18n:check] 译有源无(死键):${JSON.stringify(key)}  (${where})`); bad++; }
}

console.log(`字典 ${dictFiles.length} 份 / ${dict.size} 键;t() 键 ${tKeys.size};扫描源 ${sources.length} 文件`);
for (const [unit, n] of bareByUnit) console.log(`  提示:${unit} 单元尚有 ${n} 处裸中文未包 t()(P1/P2 接入,不阻断)`);
if (bad) { console.error(`i18n:check 未通过:${bad} 处不一致`); process.exit(1); }
console.log('i18n:check 通过');
}
