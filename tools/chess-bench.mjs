#!/usr/bin/env node
/* ============================================================
 * 对弈基准:把本引擎当选手,和外部 UCI 引擎打对抗赛,换算 Elo 差。
 *
 * 为什么需要它:perft / 战术单测只能证明"规则对、战术能看穿",
 * 证明不了"棋力有多强"。唯一能给出强度数字的办法是对弈。
 *
 * 对手侧:任何 UCI 引擎都行,默认用 stockfish@10 的 JS 构建
 *   (npmmirror 上 0.38MB tarball,wasm 版约 40~58 万 NPS,与本引擎同量级),
 *   通过 `go depth N` 限制强度 —— Stockfish 每加深一层大约 +50~70 Elo,
 *   所以「在哪个深度上打成 50%」就能反推我们的强度。
 *   用 `--sf <路径>` 指定别的引擎(如本机原生 Stockfish)。
 *
 * 两侧都用「确定性预算」而不是墙钟时间(本引擎给节点数,Stockfish 给深度),
 * 所以每个对局都是可复现的 —— 也正因此可以用 --shard 分片并行跑而不影响结果。
 *
 * 用法:
 *   node tools/chess-bench.mjs --depth 5               # 和 depth 5 的 Stockfish 打
 *   node tools/chess-bench.mjs --depth 3,5,7 --games 4 # 扫一档
 *   node tools/chess-bench.mjs --shard 0/4 --out a.json
 *   node tools/chess-bench.mjs --level master --depth 8
 * ============================================================ */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import process from 'node:process';

import {
  WHITE, BLACK, QUEEN, NAME,
  mFrom, mTo, mPromo,
  newPos, make, genLegal, hasLegalMove, inCheck,
  isThreefold, insufficientMaterial, replayMoves,
} from '../js/apps/chess3d/rules.js';
import { searchBest, LEVELS } from '../js/apps/chess3d/ai.js';

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const DEPTHS = argOf('--depth', '5').split(',').map(Number);
const GAMES = Number(argOf('--games', '4'));         // 每个深度打几局(必须是偶数,黑白各半)
const MAXPLY = Number(argOf('--maxply', '160'));
const LEVEL = argOf('--level', 'hard');
const SF_PATH = argOf('--sf', process.env.SF_PATH || defaultSfPath());
const OUT = argOf('--out', '');
const SHARD = argOf('--shard', '0/1');
const QUIET = argv.includes('--quiet');

/** 默认对手:优先 native stockfish(NPM 装的),否则用 nmrugg 的 JS 构建 */
function defaultSfPath() {
  const cands = [
    'C:/Users/thhid/sfbench/package/src/stockfish.js',
    './node_modules/.bin/stockfish.exe',
    'stockfish',
  ];
  for (const c of cands) if (c === 'stockfish' || fs.existsSync(c)) return c;
  return cands[0];
}

/* ---------- 走法编码:引擎打包格式 ↔ UCI 串 ---------- */
const PROMO_CH = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };
const toUci = (m) => NAME(mFrom(m)) + NAME(mTo(m)) + (mPromo(m) ? PROMO_CH[mPromo(m)] : '');

const sqOf = (s) => (8 - Number(s[1])) * 8 + 'abcdefgh'.indexOf(s[0]);
function uciToPacked(pos, str) {
  const from = sqOf(str.slice(0, 2)), to = sqOf(str.slice(2, 4));
  const promo = str.length > 4 ? 'nbrq'.indexOf(str[4]) + 2 : 0;
  const buf = new Int32Array(256);
  const n = genLegal(pos, buf);
  for (let i = 0; i < n; i++) {
    const m = buf[i];
    if (mFrom(m) !== from || mTo(m) !== to) continue;
    if (promo) { if (mPromo(m) === promo) return m; }
    else if (!mPromo(m)) return m;
  }
  return 0;
}
/** UCI 串序列 → 引擎局面 + 线格式序列((from<<6)|to) */
function setupFrom(ucis) {
  const pos = newPos();
  const wire = [];
  for (const u of ucis) {
    const m = uciToPacked(pos, u);
    if (!m) throw new Error('无法解析开局走法: ' + u);
    make(pos, m);
    wire.push((mFrom(m) << 6) | mTo(m));
  }
  return { pos, wire };
}

/* ---------- Stockfish 驱动 ----------
 * 关键经验:**一次只发一条命令、等它应答再发下一条**。
 * 把 setoption / isready / position / go 攒在同一个 tick 里一次性灌进去,
 * nmrugg 的 Stockfish.js 10 会只处理完 uci 就静默(拿不到 readyok 也拿不到 bestmove)。 */
class UciEngine {
  constructor(bin, opts = {}) {
    this.proc = /\.js$/.test(bin)
      ? spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.best = null;
    this.scoreCp = null;
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (l) => {
      this.lines.push(l);
      const bm = /^bestmove (\S+)/.exec(l);
      if (bm) this.best = bm[1];
      const sc = /score cp (-?\d+)/.exec(l);
      if (sc) this.scoreCp = Number(sc[1]);
      const mt = /score mate (-?\d+)/.exec(l);
      if (mt) this.scoreCp = Number(mt[1]) > 0 ? 30000 : -30000;
    });
    this.opts = opts;
  }
  send(s) { this.proc.stdin.write(s + '\n'); }
  /** 发一条命令并等某个应答行出现 */
  async cmd(line, expect, timeout = 30000) {
    const mark = this.lines.length;
    this.send(line);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.lines.slice(mark).some((l) => (typeof expect === 'function' ? expect(l) : l === expect))) return true;
      await sleep(5);
    }
    return false;
  }
  async init() {
    if (!(await this.cmd('uci', 'uciok'))) throw new Error('对手未回应 uci');
    for (const [k, v] of Object.entries(this.opts)) this.send(`setoption name ${k} value ${v}`);
    if (!(await this.cmd('isready', 'readyok'))) throw new Error('对手未回应 isready');
  }
  async newGame() { await this.cmd('ucinewgame', 'readyok', 60000); }
  /** 让对手按 `goCmd` 走一步,返回 UCI 串(顺便把评估分记下来,供裁定用) */
  async go(positionCmd, goCmd, timeout = 180000) {
    this.best = null;
    this.scoreCp = null;
    this.send(positionCmd);
    await sleep(6);                                     // 让引擎先消化 position 再收 go
    const t0 = Date.now();
    this.send(goCmd);
    while (!this.best && Date.now() - t0 < timeout) await sleep(4);
    if (!this.best) throw new Error('对手超时未返回 bestmove');
    return this.best;
  }
  stop() { try { this.send('quit'); } catch { /* 已退出 */ } this.proc.kill(); }
}

/* ---------- 单局对局 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MATE_CP = 25000;

function terminalReason(pos) {
  const buf = new Int32Array(256);
  if (!hasLegalMove(pos, buf)) return inCheck(pos) ? 'mate' : 'stalemate';
  if (insufficientMaterial(pos)) return 'material';
  if (isThreefold(pos)) return 'threefold';
  if (pos.half >= 100) return 'fiftymove';
  return null;
}

/**
 * 下一局。ourColor 是本引擎执的颜色。
 * 返回 { result, plies, reason, avgDepth } —— result 从「本引擎视角」看:win / loss / draw
 */
async function playGame(sf, ourCfg, opening, ourColor, sfDepth) {
  const { pos } = setupFrom(opening);
  const ucis = opening.slice();
  const depths = [];

  for (let ply = 0; ply < MAXPLY; ply++) {
    const term = terminalReason(pos);
    if (term) {
      if (term === 'mate') {
        const loser = pos.stm;                      // 走不了棋又被将军的一方是被将死
        return { result: loser === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'mate' };
      }
      return { result: 'draw', plies: ucis.length, reason: term };
    }

    const mover = pos.stm;
    let uci;
    if (mover === ourColor) {
      const r = searchBest(pos, ourCfg);
      if (!r.move) return { result: 'draw', plies: ucis.length, reason: 'no-move' };
      uci = toUci(r.move);
      depths.push(r.depth);
    } else {
      const posCmd = ucis.length ? `position startpos moves ${ucis.join(' ')}` : 'position startpos';
      uci = await sf.go(posCmd, `go depth ${sfDepth}`);
    }

    const m = uciToPacked(pos, uci);
    if (!m) return { result: mover === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'illegal-by-' + (mover === ourColor ? 'us' : 'sf') };
    make(pos, m);
    ucis.push(uci);
  }

  /* 步数上限:用对手的浅层评估裁定。
   * 不这么做的话,大量其实已分出胜负的长局会被算成和棋,把得分率压向 50%。 */
  const posCmd = `position startpos moves ${ucis.join(' ')}`;
  await sf.go(posCmd, 'go depth 12');
  const cp = sf.scoreCp ?? 0;
  const whitePov = pos.stm === WHITE ? cp : -cp;
  const avg = depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;
  if (Math.abs(whitePov) < 150) return { result: 'draw', plies: ucis.length, reason: `adjudicate ${whitePov}cp`, avgDepth: avg };
  const favored = whitePov > 0 ? WHITE : BLACK;
  return { result: favored === ourColor ? 'win' : 'loss', plies: ucis.length, reason: `adjudicate ${whitePov}cp`, avgDepth: avg };
}

/* ---------- 主流程 ---------- */
const OPENINGS = [
  [],
  ['e2e4'],
  ['d2d4'],
  ['c2c4'],
  ['g2g3'],
  ['e2e4', 'e7e5'],
  ['d2d4', 'd7d5'],
  ['e2e4', 'c7c5'],
  ['d2d4', 'g8f6'],
  ['e2e4', 'e7e6'],
];

function ourConfig(levelId) {
  const lv = LEVELS.find((l) => l.id === levelId);
  if (!lv) throw new Error('未知难度: ' + levelId + '(可选 ' + LEVELS.map((l) => l.id).join('/') + ')');
  return { nodes: lv.nodes, ms: lv.ms, depth: lv.depth };
}

function eloFromScore(s) {
  if (s <= 0) return -Infinity;
  if (s >= 1) return Infinity;
  return -400 * Math.log10(1 / s - 1);
}
const fmtElo = (e) => !isFinite(e) ? (e > 0 ? '>+800' : '<-800') : (e >= 0 ? '+' : '') + e.toFixed(0);

if (!QUIET) console.log(`本引擎: ${LEVEL}(${JSON.stringify(ourConfig(LEVEL))})   对手: ${SF_PATH}\n`);

if (SF_PATH !== 'stockfish' && !fs.existsSync(SF_PATH)) {
  console.error(`✗ 找不到对手引擎: ${SF_PATH}\n`);
  console.error('  取一个 UCI 引擎给它即可(体积最小的组合):');
  console.error('    npm pack stockfish@10.0.2 && tar -xzf stockfish-10.0.2.tgz');
  console.error('    node tools/chess-bench.mjs --sf package/src/stockfish.js --depth 5');
  console.error('  或指定本机原生引擎:  --sf /path/to/stockfish   (也可用环境变量 SF_PATH)');
  process.exit(2);
}

const sf = new UciEngine(SF_PATH, { 'Skill Level': 20, Threads: 1, Hash: 16, Ponder: 'false' });
await sf.init();

/* 任务表:每个深度 × 每个开局 × 两种执色;按 shard 切片 */
const [si, sn] = SHARD.split('/').map(Number);
const games = [];
for (const d of DEPTHS) {
  for (const o of OPENINGS.slice(0, Math.max(1, Math.ceil(GAMES / 2)))) {
    for (const ourColor of [WHITE, BLACK]) games.push({ depth: d, opening: o, ourColor });
  }
}
const mine = games.filter((_, i) => i % sn === si);

const results = [];
for (const g of mine) {
  await sf.newGame();
  const r = await playGame(sf, ourConfig(LEVEL), g.opening, g.ourColor, g.depth);
  results.push({ ...g, ...r });
  if (!QUIET) {
    const tag = r.result === 'win' ? '胜' : r.result === 'loss' ? '负' : '和';
    console.log(`d${String(g.depth).padStart(2)} ${(g.ourColor === WHITE ? '白' : '黑')} ${(g.opening.join(' ') || '(初始)').padEnd(14)} ${tag}  ${String(r.plies).padStart(3)}手  ${r.reason}`);
  }
}
sf.stop();

/* 汇总 */
const byDepth = {};
for (const r of results) {
  const b = byDepth[r.depth] ||= { w: 0, l: 0, d: 0, n: 0 };
  b.n++; if (r.result === 'win') b.w++; else if (r.result === 'loss') b.l++; else b.d++;
}
const summary = Object.entries(byDepth).sort((a, b) => a[0] - b[0]).map(([d, b]) => {
  const s = (b.w + b.d / 2) / b.n;
  return { depth: Number(d), ...b, score: s, elo: eloFromScore(s) };
});

if (!QUIET) {
  console.log('\n深度   局  胜  和  负   得分率    对 depth-N Stockfish 的 Elo 差');
  for (const s of summary) {
    console.log(`${String(s.depth).padStart(3)}  ${String(s.n).padStart(3)} ${String(s.w).padStart(3)} ${String(s.d).padStart(3)} ${String(s.l).padStart(3)}   ${(s.score * 100).toFixed(1).padStart(5)}%   ${fmtElo(s.elo).padStart(7)}`);
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ level: LEVEL, sfPath: SF_PATH, results, summary }, null, 2));
process.exit(0);
