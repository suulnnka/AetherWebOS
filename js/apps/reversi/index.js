/* ============================================================
 * 应用:黑白棋(Reversi / Othello)
 * 8×8 棋盘;完整规则:夹翻、无合法棋自动跳过、双方无棋终局;
 * 合法位置提示;人机对弈。
 *
 * AI 引擎(见"搜索引擎"段,整体采用位棋盘):
 *   位棋盘 — 每色用低/高两个 32 位字表示 64 格,移位 + 列掩码
 *            生成合法步掩码与翻子掩码(每方向"穿越填充"6 层);
 *   难度   — 初级:贪心选点(位置权重+翻子数),不搜索;
 *            中级:PVS 迭代加深至 4 层,残局 ≤8 空完全求解;
 *            高级:PVS 迭代加深至 8 层,残局 ≤14 空完全求解
 *            (求解前先跑 2→4→6 中层搜索确定根排序);
 *   搜索   — PVS 负极大 + 置换表(中局 2^16 / 残局 2^20 槽,Zobrist 校验);
 *   评估   — 位置权重表 + 行动力差。
 * 搜索过程(深度/最佳步/评分/节点数/耗时)实时写入窗口内信息行。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import { dialogs } from '../../core/dialogs.js';

/* ==================== 搜索引擎(位棋盘) ==================== */
const EMPTY = 0, BLACK = 1, WHITE = 2;

/** 难度分档:depth=0 为纯贪心;end 为进入完全求解的空格阈值 */
const LEVELS = [
  { name: '初级', desc: '贪心选点(位置权重+翻子数)', depth: 0, end: 0 },
  { name: '中级', desc: 'PVS 搜索 4 层 · 残局 8 空完全求解', depth: 4, end: 8 },
  { name: '高级', desc: 'PVS 搜索 8 层 · 残局 14 空完全求解', depth: 8, end: 14 },
];
const PRE_ENDGAME_DEPTH = 6; // 残局前置中层搜索深度(只为完全求解确定排序)
const INF = 1 << 30;
const F_EXACT = 1, F_LOWER = 2, F_UPPER = 3;

/** 位置权重表(角最贵,角旁负分;按 位序=行×8+列 展平为 64 格) */
const W64 = new Int32Array([
  120, -20, 20, 5, 5, 20, -20, 120,   // 第 1 行
  -20, -40, -5, -5, -5, -5, -40, -20, // 第 2 行
  20, -5, 15, 3, 3, 15, -5, 20,       // 第 3 行
  5, -5, 3, 3, 3, 3, -5, 5,           // 第 4 行
  5, -5, 3, 3, 3, 3, -5, 5,           // 第 5 行
  20, -5, 15, 3, 3, 15, -5, 20,       // 第 6 行
  -20, -40, -5, -5, -5, -5, -40, -20, // 第 7 行
  120, -20, 20, 5, 5, 20, -20, 120,   // 第 8 行
]);

/* 位棋盘状态:P = 行棋方,O = 对方;每色低/高两个 32 位字
 * (低字 = 第 0-3 行 = 位 0-31,高字 = 第 4-7 行 = 位 32-63,位 p = 行 r×8+列 c) */
let PLO = 0, PHI = 0, OLO = 0, OHI = 0;
let MLO = 0, MHI = 0;      // genMoves 输出:合法着掩码
let _lo = 0, _hi = 0;      // 各位棋盘原语的输出暂存
let nodes = 0;

/* 文件 A = 每字节位 0(0xfe…),文件 H = 每字节位 7(0x7f…):
 * ±1 / ±7 / ±9 的移位先掩掉源端边列,防止跨行回绕 */
const NA = 0xfefefefe, NH = 0x7f7f7f7f;

function popcnt(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/** 64 位 Zobrist 风格散列(双 32 位):局面(4 字)+ 行棋方 → _k1/_k2。
 *  残局完全搜索动辄数十万节点,单 32 位校验必生碰撞污染精确分,
 *  双散列联合校验后伪命中概率约 2^-64,可忽略 */
let _k1 = 0, _k2 = 0;
function hashPos(player) {
  let h1 = (0x811c9dc5 ^ Math.imul(player, 0x9e3779b9)) | 0;
  let h2 = (0x9e3779b9 ^ Math.imul(player, 0x811c9dc5)) | 0;
  h1 = (Math.imul(h1, 0x01000193) ^ PLO) | 0; h2 = (Math.imul(h2, 0x85ebca6b) ^ Math.imul(PLO, 0x27d4eb2f)) | 0;
  h1 = (Math.imul(h1, 0x01000193) ^ PHI) | 0; h2 = (Math.imul(h2, 0x85ebca6b) ^ Math.imul(PHI, 0x27d4eb2f)) | 0;
  h1 = (Math.imul(h1, 0x01000193) ^ OLO) | 0; h2 = (Math.imul(h2, 0x85ebca6b) ^ Math.imul(OLO, 0x27d4eb2f)) | 0;
  h1 = (Math.imul(h1, 0x01000193) ^ OHI) | 0; h2 = (Math.imul(h2, 0x85ebca6b) ^ Math.imul(OHI, 0x27d4eb2f)) | 0;
  _k1 = h1; _k2 = h2;
}

/** 置换表:始终替换;中局 2^16 槽 / 残局 2^20 槽(完全搜索节点量大,
 *  表小冲突替换严重;两表评分语义不同,不混用) */
const TT_MASK_MID = (1 << 16) - 1, TT_MASK_END = (1 << 20) - 1;
function makeTT(mask) {
  const size = mask + 1;
  return {
    key: new Int32Array(size),
    key2: new Int32Array(size),
    depth: new Int8Array(size),
    flag: new Int8Array(size),
    score: new Int32Array(size),
    move: new Int8Array(size),
  };
}
const TT_MID = makeTT(TT_MASK_MID), TT_END = makeTT(TT_MASK_END);

/* ---- 8 方向"穿越填充":从源格集出发穿过连续 O(最多 6 格),结果 → _lo/_hi。
 *      每步先按方向掩掉边列再移位;±1 按字内移位,±7/±8/±9 做字间进位 ---- */

/** 东(+1):源不得在 H 列 */
function fillE(lo, hi, olo, ohi) {
  let t = ((lo & NH) << 1) & olo, th = ((hi & NH) << 1) & ohi;
  t |= ((t & NH) << 1) & olo; th |= ((th & NH) << 1) & ohi;
  t |= ((t & NH) << 1) & olo; th |= ((th & NH) << 1) & ohi;
  t |= ((t & NH) << 1) & olo; th |= ((th & NH) << 1) & ohi;
  t |= ((t & NH) << 1) & olo; th |= ((th & NH) << 1) & ohi;
  t |= ((t & NH) << 1) & olo; th |= ((th & NH) << 1) & ohi;
  _lo = t; _hi = th;
}

/** 西(-1):源不得在 A 列 */
function fillW(lo, hi, olo, ohi) {
  let t = ((lo & NA) >>> 1) & olo, th = ((hi & NA) >>> 1) & ohi;
  t |= ((t & NA) >>> 1) & olo; th |= ((th & NA) >>> 1) & ohi;
  t |= ((t & NA) >>> 1) & olo; th |= ((th & NA) >>> 1) & ohi;
  t |= ((t & NA) >>> 1) & olo; th |= ((th & NA) >>> 1) & ohi;
  t |= ((t & NA) >>> 1) & olo; th |= ((th & NA) >>> 1) & ohi;
  t |= ((t & NA) >>> 1) & olo; th |= ((th & NA) >>> 1) & ohi;
  _lo = t; _hi = th;
}

/** 南(+8,下一行):字间进位取自低字高 8 位 */
function fillS(lo, hi, olo, ohi) {
  let t = (lo << 8) & olo, th = (((hi << 8) | (lo >>> 24)) & ohi);
  th |= (((th << 8) | (t >>> 24)) & ohi); t |= ((t << 8) & olo);
  th |= (((th << 8) | (t >>> 24)) & ohi); t |= ((t << 8) & olo);
  th |= (((th << 8) | (t >>> 24)) & ohi); t |= ((t << 8) & olo);
  th |= (((th << 8) | (t >>> 24)) & ohi); t |= ((t << 8) & olo);
  th |= (((th << 8) | (t >>> 24)) & ohi); t |= ((t << 8) & olo);
  _lo = t; _hi = th;
}

/** 北(-8,上一行):字间进位取自高字低 8 位 */
function fillN(lo, hi, olo, ohi) {
  let t = (((lo >>> 8) | (hi << 24)) & olo), th = ((hi >>> 8) & ohi);
  t |= (((t >>> 8) | (th << 24)) & olo); th |= ((th >>> 8) & ohi);
  t |= (((t >>> 8) | (th << 24)) & olo); th |= ((th >>> 8) & ohi);
  t |= (((t >>> 8) | (th << 24)) & olo); th |= ((th >>> 8) & ohi);
  t |= (((t >>> 8) | (th << 24)) & olo); th |= ((th >>> 8) & ohi);
  t |= (((t >>> 8) | (th << 24)) & olo); th |= ((th >>> 8) & ohi);
  _lo = t; _hi = th;
}

/** 西南(+7:下一行左一列):源不得在 A 列 */
function fillSW(lo, hi, olo, ohi) {
  const l = lo & NA, h = hi & NA;
  let t = (l << 7) & olo, th = (((h << 7) | (l >>> 25)) & ohi);
  th |= ((((th & NA) << 7) | ((t & NA) >>> 25)) & ohi); t |= (((t & NA) << 7) & olo);
  th |= ((((th & NA) << 7) | ((t & NA) >>> 25)) & ohi); t |= (((t & NA) << 7) & olo);
  th |= ((((th & NA) << 7) | ((t & NA) >>> 25)) & ohi); t |= (((t & NA) << 7) & olo);
  th |= ((((th & NA) << 7) | ((t & NA) >>> 25)) & ohi); t |= (((t & NA) << 7) & olo);
  th |= ((((th & NA) << 7) | ((t & NA) >>> 25)) & ohi); t |= (((t & NA) << 7) & olo);
  _lo = t; _hi = th;
}

/** 东北(-7:上一行右一列):源不得在 H 列 */
function fillNE(lo, hi, olo, ohi) {
  const l = lo & NH, h = hi & NH;
  let t = (((l >>> 7) | (h << 25)) & olo), th = ((h >>> 7) & ohi);
  t |= ((((t & NH) >>> 7) | ((th & NH) << 25)) & olo); th |= (((th & NH) >>> 7) & ohi);
  t |= ((((t & NH) >>> 7) | ((th & NH) << 25)) & olo); th |= (((th & NH) >>> 7) & ohi);
  t |= ((((t & NH) >>> 7) | ((th & NH) << 25)) & olo); th |= (((th & NH) >>> 7) & ohi);
  t |= ((((t & NH) >>> 7) | ((th & NH) << 25)) & olo); th |= (((th & NH) >>> 7) & ohi);
  t |= ((((t & NH) >>> 7) | ((th & NH) << 25)) & olo); th |= (((th & NH) >>> 7) & ohi);
  _lo = t; _hi = th;
}

/** 东南(+9:下一行右一列):源不得在 H 列 */
function fillSE(lo, hi, olo, ohi) {
  const l = lo & NH, h = hi & NH;
  let t = (l << 9) & olo, th = (((h << 9) | (l >>> 23)) & ohi);
  th |= ((((th & NH) << 9) | ((t & NH) >>> 23)) & ohi); t |= (((t & NH) << 9) & olo);
  th |= ((((th & NH) << 9) | ((t & NH) >>> 23)) & ohi); t |= (((t & NH) << 9) & olo);
  th |= ((((th & NH) << 9) | ((t & NH) >>> 23)) & ohi); t |= (((t & NH) << 9) & olo);
  th |= ((((th & NH) << 9) | ((t & NH) >>> 23)) & ohi); t |= (((t & NH) << 9) & olo);
  th |= ((((th & NH) << 9) | ((t & NH) >>> 23)) & ohi); t |= (((t & NH) << 9) & olo);
  _lo = t; _hi = th;
}

/** 西北(-9:上一行左一列):源不得在 A 列 */
function fillNW(lo, hi, olo, ohi) {
  const l = lo & NA, h = hi & NA;
  let t = (((l >>> 9) | (h << 23)) & olo), th = ((h >>> 9) & ohi);
  t |= ((((t & NA) >>> 9) | ((th & NA) << 23)) & olo); th |= (((th & NA) >>> 9) & ohi);
  t |= ((((t & NA) >>> 9) | ((th & NA) << 23)) & olo); th |= (((th & NA) >>> 9) & ohi);
  t |= ((((t & NA) >>> 9) | ((th & NA) << 23)) & olo); th |= (((th & NA) >>> 9) & ohi);
  t |= ((((t & NA) >>> 9) | ((th & NA) << 23)) & olo); th |= (((th & NA) >>> 9) & ohi);
  t |= ((((t & NA) >>> 9) | ((th & NA) << 23)) & olo); th |= (((th & NA) >>> 9) & ohi);
  _lo = t; _hi = th;
}

/** 合法着掩码(对行棋方 P 而言)→ MLO/MHI。
 *  每方向:从全部 P 子穿越 O 填充,再沿该方向走一步落在空格即合法。
 *  8 个方向的 P 侧填充缓存到模块变量,供 moveFlips 复用(双向填充求交)。 */
let feLo = 0, feHi = 0, fwLo = 0, fwHi = 0, fsLo = 0, fsHi = 0, fnLo = 0, fnHi = 0;
let fswLo = 0, fswHi = 0, fneLo = 0, fneHi = 0, fseLo = 0, fseHi = 0, fnwLo = 0, fnwHi = 0;

function genMoves(plo, phi, olo, ohi) {
  const elo = ~(plo | olo) | 0, ehi = ~(phi | ohi) | 0;
  let m = 0, mh = 0;
  fillE(plo, phi, olo, ohi); feLo = _lo; feHi = _hi;
  m |= ((feLo & NH) << 1) & elo; mh |= ((feHi & NH) << 1) & ehi;
  fillW(plo, phi, olo, ohi); fwLo = _lo; fwHi = _hi;
  m |= ((fwLo & NA) >>> 1) & elo; mh |= ((fwHi & NA) >>> 1) & ehi;
  fillS(plo, phi, olo, ohi); fsLo = _lo; fsHi = _hi;
  m |= (fsLo << 8) & elo; mh |= ((fsHi << 8) | (fsLo >>> 24)) & ehi;
  fillN(plo, phi, olo, ohi); fnLo = _lo; fnHi = _hi;
  m |= ((fnLo >>> 8) | (fnHi << 24)) & elo; mh |= (fnHi >>> 8) & ehi;
  fillSW(plo, phi, olo, ohi); fswLo = _lo; fswHi = _hi;
  m |= ((fswLo & NA) << 7) & elo; mh |= (((fswHi & NA) << 7) | ((fswLo & NA) >>> 25)) & ehi;
  fillNE(plo, phi, olo, ohi); fneLo = _lo; fneHi = _hi;
  m |= (((fneLo & NH) >>> 7) | ((fneHi & NH) << 25)) & elo; mh |= ((fneHi & NH) >>> 7) & ehi;
  fillSE(plo, phi, olo, ohi); fseLo = _lo; fseHi = _hi;
  m |= ((fseLo & NH) << 9) & elo; mh |= (((fseHi & NH) << 9) | ((fseLo & NH) >>> 23)) & ehi;
  fillNW(plo, phi, olo, ohi); fnwLo = _lo; fnwHi = _hi;
  m |= (((fnwLo & NA) >>> 9) | ((fnwHi & NA) << 23)) & elo; mh |= ((fnwHi & NA) >>> 9) & ehi;
  MLO = m; MHI = mh;
}

/** 落点位 mlo/mhi 的翻子掩码 → _lo/_hi。要求先对同一局面调过 genMoves。
 *  翻子_d = fill_d(落子点, O) ∩ fill_-d(全部 P, O):
 *  该格与落子点之间全是 O,且沿同一方向延伸出去是 P。 */
function moveFlips(mlo, mhi, olo, ohi) {
  let fl = 0, fh = 0;
  fillE(mlo, mhi, olo, ohi); fl |= _lo & fwLo; fh |= _hi & fwHi;
  fillW(mlo, mhi, olo, ohi); fl |= _lo & feLo; fh |= _hi & feHi;
  fillS(mlo, mhi, olo, ohi); fl |= _lo & fnLo; fh |= _hi & fnHi;
  fillN(mlo, mhi, olo, ohi); fl |= _lo & fsLo; fh |= _hi & fsHi;
  fillSW(mlo, mhi, olo, ohi); fl |= _lo & fneLo; fh |= _hi & fneHi;
  fillNE(mlo, mhi, olo, ohi); fl |= _lo & fswLo; fh |= _hi & fswHi;
  fillSE(mlo, mhi, olo, ohi); fl |= _lo & fnwLo; fh |= _hi & fnwHi;
  fillNW(mlo, mhi, olo, ohi); fl |= _lo & fseLo; fh |= _hi & fseHi;
  _lo = fl; _hi = fh;
}

/** 终局点差 ×100(行棋方视角) */
function terminalDiff() {
  return (popcnt(PLO) + popcnt(PHI) - popcnt(OLO) - popcnt(OHI)) * 100;
}

/** 启发式评估(行棋方视角):位置权重差 + 行动力差 ×8 */
function evaluate() {
  let s = 0, x, b;
  x = PLO; while (x) { b = x & -x; x ^= b; s += W64[31 - Math.clz32(b)]; }
  x = PHI; while (x) { b = x & -x; x ^= b; s += W64[63 - Math.clz32(b)]; }
  x = OLO; while (x) { b = x & -x; x ^= b; s -= W64[31 - Math.clz32(b)]; }
  x = OHI; while (x) { b = x & -x; x ^= b; s -= W64[63 - Math.clz32(b)]; }
  genMoves(PLO, PHI, OLO, OHI);
  const mobP = popcnt(MLO) + popcnt(MHI);
  genMoves(OLO, OHI, PLO, PHI);
  const mobO = popcnt(MLO) + popcnt(MHI);
  return s + (mobP - mobO) * 8;
}

/* 每层搜索的暂存:着法/排序分/翻子掩码/进位前的 4 字局面 */
const MAX_PLY = 72;
const plyMoves = [], plyScores = [], plyFlipLo = [], plyFlipHi = [];
for (let i = 0; i < MAX_PLY; i++) {
  plyMoves.push(new Int8Array(32));
  plyScores.push(new Int32Array(32));
  plyFlipLo.push(new Int32Array(32));
  plyFlipHi.push(new Int32Array(32));
}
const plySave = new Int32Array(MAX_PLY * 4);

/** 应用 ply 层第 i 个着法(make;unmakeMove 恢复)。
 *  落子后换手:P' = O & ~翻子,O' = P | 落点 | 翻子 */
function makeMove(i, ply) {
  const o = ply << 2;
  plySave[o] = PLO; plySave[o + 1] = PHI; plySave[o + 2] = OLO; plySave[o + 3] = OHI;
  const fl = plyFlipLo[ply][i], fh = plyFlipHi[ply][i];
  const sq = plyMoves[ply][i];
  const mlo = sq < 32 ? 1 << sq : 0, mhi = sq < 32 ? 0 : 1 << (sq - 32);
  const plo = PLO, phi = PHI;
  PLO = OLO & ~fl; PHI = OHI & ~fh;
  OLO = plo | mlo | fl; OHI = phi | mhi | fh;
}

function unmakeMove(ply) {
  const o = ply << 2;
  PLO = plySave[o]; PHI = plySave[o + 1]; OLO = plySave[o + 2]; OHI = plySave[o + 3];
}

/** 交换行棋方(虚着用) */
function swapSides() {
  let w = PLO; PLO = OLO; OLO = w;
  w = PHI; PHI = OHI; OHI = w;
}

/**
 * PVS 负极大搜索:返回对行棋方的分值。
 * 首着全窗口,其余零窗口试探、超界时重搜;置换表提供截断与最优着法排序。
 * exact=true 为残局完全求解:只接受终局精确点差,不调用启发式评估。
 */
function search(depth, alpha, beta, player, ply, exact) {
  nodes++;
  const T = exact ? TT_END : TT_MID;
  const ttMask = exact ? TT_MASK_END : TT_MASK_MID;
  hashPos(player);
  const key = _k1, key2 = _k2;
  const slot = key & ttMask;
  let ttMove = -1;
  if (T.key[slot] === key && T.key2[slot] === key2) {
    ttMove = T.move[slot];
    if (T.depth[slot] >= depth) {
      const v = T.score[slot], f = T.flag[slot];
      if (f === F_EXACT || (f === F_LOWER && v >= beta) || (f === F_UPPER && v <= alpha)) return v;
    }
  }
  if (ply >= MAX_PLY - 2 || depth <= 0) {
    return exact ? terminalDiff() : evaluate();
  }

  genMoves(PLO, PHI, OLO, OHI);
  let mlo = MLO, mhi = MHI;
  if (!(mlo | mhi)) {
    // 无棋可走:对方也无 → 终局;否则虚着换手(不消耗深度)
    genMoves(OLO, OHI, PLO, PHI);
    if (!(MLO | MHI)) return terminalDiff();
    swapSides();
    const v = -search(depth, -beta, -alpha, 3 - player, ply + 1, exact);
    swapSides();
    return v;
  }

  /* 遍历合法着,计算翻子;静态排序分 = 位置权重 + 翻子数 ×2 */
  const moves = plyMoves[ply], scores = plyScores[ply];
  const fll = plyFlipLo[ply], flh = plyFlipHi[ply];
  let n = 0;
  while (mlo | mhi) {
    let b, sq;
    if (mlo) { b = mlo & -mlo; mlo ^= b; sq = 31 - Math.clz32(b); }
    else { b = mhi & -mhi; mhi ^= b; sq = 63 - Math.clz32(b); }
    moveFlips(b, sq < 32 ? 0 : b, OLO, OHI);
    const fc = popcnt(_lo) + popcnt(_hi);
    moves[n] = sq; scores[n] = W64[sq] + fc * 2; fll[n] = _lo; flh[n] = _hi;
    n++;
  }
  /* 插入排序(降序),置换表最优着法提到队首(四个平行数组同步移动) */
  for (let i = 1; i < n; i++) {
    const m = moves[i], s = scores[i], fl = fll[i], fh = flh[i];
    let j = i - 1;
    while (j >= 0 && scores[j] < s) {
      moves[j + 1] = moves[j]; scores[j + 1] = scores[j];
      fll[j + 1] = fll[j]; flh[j + 1] = flh[j];
      j--;
    }
    moves[j + 1] = m; scores[j + 1] = s; fll[j + 1] = fl; flh[j + 1] = fh;
  }
  if (ttMove >= 0 && moves[0] !== ttMove) {
    for (let i = 1; i < n; i++) {
      if (moves[i] !== ttMove) continue;
      for (let j = i; j > 0; j--) {
        moves[j] = moves[j - 1]; scores[j] = scores[j - 1];
        fll[j] = fll[j - 1]; flh[j] = flh[j - 1];
      }
      moves[0] = ttMove;
      break;
    }
  }

  let best = -INF, bestMove = moves[0];
  const a0 = alpha;
  for (let i = 0; i < n; i++) {
    makeMove(i, ply);
    let v;
    if (i === 0) {
      v = -search(depth - 1, -beta, -alpha, 3 - player, ply + 1, exact);
    } else {
      v = -search(depth - 1, -alpha - 1, -alpha, 3 - player, ply + 1, exact);
      if (alpha < v && v < beta) v = -search(depth - 1, -beta, -v, 3 - player, ply + 1, exact);
    }
    unmakeMove(ply);
    if (v > best) { best = v; bestMove = moves[i]; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  T.key[slot] = key;
  T.key2[slot] = key2;
  T.depth[slot] = depth;
  T.flag[slot] = best >= beta ? F_LOWER : best > a0 ? F_EXACT : F_UPPER;
  T.score[slot] = best;
  T.move[slot] = bestMove;
  return best;
}

/** UI 棋盘('b'/'w'/null)→ 位棋盘;P = aiColor 一方 */
function toBitboard(board, aiColor) {
  let blo = 0, bhi = 0, wlo = 0, whi = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const v = board[r][c];
    if (!v) continue;
    const p = r * 8 + c;
    if (v === 'b') { if (p < 32) blo |= 1 << p; else bhi |= 1 << (p - 32); }
    else { if (p < 32) wlo |= 1 << p; else whi |= 1 << (p - 32); }
  }
  const black = aiColor === 'b';
  PLO = black ? blo : wlo; PHI = black ? bhi : whi;
  OLO = black ? wlo : blo; OHI = black ? whi : bhi;
}

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * AI 思考入口:初级直接贪心;中/高级迭代加深 PVS,残局完全求解
 * (求解前先跑中层迭代加深确定根排序)。
 * onProgress(info, done) 把每轮结果写给界面;shouldAbort() 为真则放弃本次结果。
 */
async function think(board, aiColor, level, onProgress, shouldAbort) {
  const ai = aiColor === 'b' || aiColor === BLACK ? BLACK : WHITE; // UI 传 'b'/'w',引擎内部用 1/2
  const aiOpp = 3 - ai;
  toBitboard(board, aiColor);
  nodes = 0;
  const t0 = performance.now();
  const empties = 64 - (popcnt(PLO) + popcnt(PHI) + popcnt(OLO) + popcnt(OHI));
  const exact = empties <= level.end;

  /* 根着法:生成掩码、逐个求翻子,静态分 = 位置权重 + 翻子数 ×2(存入 ply 0 暂存区) */
  genMoves(PLO, PHI, OLO, OHI);
  const moves = plyMoves[0], scores = plyScores[0];
  const fll = plyFlipLo[0], flh = plyFlipHi[0];
  let n0 = 0;
  let mlo = MLO, mhi = MHI;
  while (mlo | mhi) {
    let b, sq;
    if (mlo) { b = mlo & -mlo; mlo ^= b; sq = 31 - Math.clz32(b); }
    else { b = mhi & -mhi; mhi ^= b; sq = 63 - Math.clz32(b); }
    moveFlips(b, sq < 32 ? 0 : b, OLO, OHI);
    moves[n0] = sq;
    scores[n0] = W64[sq] + (popcnt(_lo) + popcnt(_hi)) * 2;
    fll[n0] = _lo; flh[n0] = _hi;
    n0++;
  }
  if (!n0) return null;

  /* 按静态分排好根着法顺序(后续迭代按搜索分重排) */
  const order = [];
  for (let i = 0; i < n0; i++) order.push(i);
  order.sort((a, b) => scores[b] - scores[a]);
  const rootV = new Array(n0).fill(0);

  /** 一轮根搜索(PVS):并按本轮得分重排 order 供下一轮迭代排序 */
  const runRoot = (depth, exactMode) => {
    let alpha = -INF;
    const beta = INF;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      makeMove(i, 0);
      if (k === 0) {
        rootV[i] = -search(depth - 1, -beta, -alpha, aiOpp, 1, exactMode);
      } else {
        rootV[i] = -search(depth - 1, -alpha - 1, -alpha, aiOpp, 1, exactMode);
        if (alpha < rootV[i] && rootV[i] < beta) {
          rootV[i] = -search(depth - 1, -beta, -rootV[i], aiOpp, 1, exactMode);
        }
      }
      unmakeMove(0);
      if (rootV[i] > alpha) alpha = rootV[i];
    }
    order.sort((a, b) => rootV[b] - rootV[a]);
    return { move: moves[order[0]], score: rootV[order[0]] };
  };

  /* 初级:纯贪心,取静态分最高者 */
  if (level.depth === 0) {
    const res = { greedy: true, move: moves[order[0]], score: scores[order[0]], nodes: n0, ms: performance.now() - t0 };
    onProgress(res, true);
    if (shouldAbort()) return null;
    return res;
  }

  if (exact) {
    /* 前置中层迭代加深(启发式):结果只用于完全求解的根着法排序 */
    const preMax = Math.min(PRE_ENDGAME_DEPTH, level.depth, empties);
    for (let d = 2; d <= preMax; d += 2) {
      if (n0 === 1) break;
      const w = runRoot(d, false);
      onProgress({ warm: true, move: w.move, score: w.score, depth: d, depthMax: preMax, nodes, ms: performance.now() - t0 }, false);
      if (shouldAbort()) return null;
      await yieldUI();
    }
    onProgress({ endgame: true, empties, move: moves[order[0]], nodes: 0, ms: 0, pending: true }, false);
    await yieldUI();
    if (shouldAbort()) return null;
    const r = runRoot(empties + 4, true); // 余量 4:虚着不消耗深度,保证必搜到终局
    const ms = performance.now() - t0;
    onProgress({ endgame: true, empties, move: r.move, score: r.score, nodes, ms }, true);
    if (shouldAbort()) return null;
    return { move: r.move, score: r.score, endgame: true, empties, nodes, ms };
  }

  if (n0 === 1) {
    const res = { move: moves[0], score: 0, only: true, nodes: 0, ms: 0 };
    onProgress(res, true);
    return res;
  }

  let res = null;
  for (let d = 2; d <= level.depth; d += 2) {
    const r = runRoot(d, false);
    res = { move: r.move, score: r.score, depth: d, depthMax: level.depth, nodes, ms: performance.now() - t0 };
    onProgress(res, d === level.depth);
    if (shouldAbort()) return null;
    if (Math.abs(r.score) >= INF / 2) break; // 已搜到终局,无需继续加深
    await yieldUI();
  }
  return res;
}

/* 仅供测试脚本/调试使用:直接操作位棋盘状态 */
function __setPosition(blo, bhi, wlo, whi, side) {
  const black = side === 'b';
  PLO = black ? blo : wlo; PHI = black ? bhi : whi;
  OLO = black ? wlo : blo; OHI = black ? whi : bhi;
}
function __legal() { genMoves(PLO, PHI, OLO, OHI); return [MLO, MHI]; }
function __flips(sq) {
  genMoves(PLO, PHI, OLO, OHI); // 先生成 P 侧方向填充,供 moveFlips 求交
  moveFlips(sq < 32 ? 1 << sq : 0, sq < 32 ? 0 : 1 << (sq - 32), OLO, OHI);
  return [_lo, _hi];
}
function __pos() { return [PLO, PHI, OLO, OHI]; }
function __make(i, ply) { makeMove(i, ply); }
function __unmake(ply) { unmakeMove(ply); }
function __setMoveSlot(i, sq, flo, fhi) { // 测试用:把着法写入 ply 暂存区供 __make
  plyMoves[0][i] = sq; plyFlipLo[0][i] = flo; plyFlipHi[0][i] = fhi;
}
/* ==================== 应用 UI ==================== */

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (p) => (p === 'b' ? 'w' : 'b');

function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  b[3][3] = 'w'; b[3][4] = 'b'; b[4][3] = 'b'; b[4][4] = 'w';
  return b;
}

/** 某格落子能翻转的所有对方子(返回坐标数组;无翻转则 []) */
function flipsFor(b, r, c, color) {
  if (b[r][c]) return [];
  const flips = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let rr = r + dr, cc = c + dc;
    while (inB(rr, cc) && b[rr][cc] && b[rr][cc] !== color) { line.push([rr, cc]); rr += dr; cc += dc; }
    if (line.length && inB(rr, cc) && b[rr][cc] === color) flips.push(...line);
  }
  return flips;
}

function legalMoves(b, color) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (!b[r][c] && flipsFor(b, r, c, color).length) out.push([r, c]);
  }
  return out;
}

function applyMove(b, r, c, color) {
  const flips = flipsFor(b, r, c, color);
  const nb = b.map(row => [...row]);
  nb[r][c] = color;
  for (const [fr, fc] of flips) nb[fr][fc] = color;
  return { board: nb, flipped: flips };
}

function counts(b) {
  let black = 0, white = 0;
  for (const row of b) for (const cell of row) { if (cell === 'b') black++; else if (cell === 'w') white++; }
  return { black, white };
}

const moveName = (p) => 'abcdefgh'[p & 7] + ((p >> 3) + 1);
const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));
const fmtT = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms');
const fmtNps = (res) => (res.ms > 0 ? ` · ${fmtN(Math.round(res.nodes / res.ms * 1000))}节点/s` : '');

register({
  id: 'reversi',
  name: '黑白棋',
  icon: 'circle',
  color: 'linear-gradient(135deg,#059669,#065f46)',
  neon: { a: '#10b981', b: '#a3e635' },
  width: 640, height: 660,
  min: { w: 460, h: 480 },
  singleton: true,
  order: 9.8,
  mount({ root, setTitle, bus }) {
    let board = initBoard();
    let turn = 'b';          // 玩家执黑,先手
    let gameOver = false;
    let vsAI = true;
    let lastMove = null;
    let searchGen = 0;       // 搜索代数:新对局/模式切换时 +1,打断进行中的搜索
    let thinking = false;
    let levelIdx = 2;        // 默认高级

    const statusL = el('span', {}, '');
    const boardEl = el('div', { class: 'rv-board' });
    const blackCount = el('span', { class: 'rv-count black' }, '2');
    const whiteCount = el('span', { class: 'rv-count white' }, '2');
    const searchLine = el('div', { class: 'rv-search' }, levelHint());

    function levelHint() {
      const lv = LEVELS[levelIdx];
      return `AI 待命(难度:${lv.name}) · ${lv.desc}`;
    }

    /** 把搜索过程写入信息行 */
    function showSearch(res, done) {
      if (res.greedy) {
        const sc = res.score >= 0 ? `白 +${res.score}` : `黑 +${-res.score}`;
        searchLine.textContent = `初级 贪心选点 ${moveName(res.move)} · 评估 ${sc} · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}`;
        return;
      }
      if (res.only) { searchLine.textContent = `唯一合法步 ${moveName(res.move)},无需搜索`; return; }
      const tail = ` · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}${fmtNps(res)}`;
      if (res.warm) { // 残局前置中层搜索:只为完全求解排序
        const sc = res.score >= 0 ? `白 +${res.score}` : `黑 +${-res.score}`;
        searchLine.textContent = `残局预热 深度 ${res.depth}/${res.depthMax} · 最佳 ${moveName(res.move)} · 评估 ${sc}${tail}`;
        return;
      }
      if (res.endgame) {
        if (res.pending) { searchLine.textContent = `残局完全求解中…(${res.empties} 空) · 先行着法 ${moveName(res.move)}`; return; }
        const d = Math.round((res.score || 0) / 100);
        const verdict = d > 0 ? `白胜 ${d} 子` : d < 0 ? `黑胜 ${-d} 子` : '和棋';
        searchLine.textContent = `残局完全求解(${res.empties}空):${verdict} · 最佳 ${moveName(res.move)}${tail}`;
      } else {
        const sc = res.score >= 0 ? `白 +${res.score}` : `黑 +${-res.score}`;
        searchLine.textContent = `${done ? '' : '搜索中… '}深度 ${res.depth}/${res.depthMax} · 最佳 ${moveName(res.move)} · 评估 ${sc}${tail}`;
      }
    }

    function renderBoard() {
      boardEl.innerHTML = '';
      const hints = legalMoves(board, turn);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const piece = board[r][c];
          const isHint = !gameOver && piece === null && flipsFor(board, r, c, turn).length > 0;
          const cell = el('button', {
            class: 'rv-cell' + (isHint ? ' hint' : '') + (lastMove && lastMove[0] === r && lastMove[1] === c ? ' last' : ''),
            dataset: { r: String(r), c: String(c) },
            onClick: () => humanMove(r, c),
          });
          if (piece) cell.append(el('div', { class: `rv-piece ${piece}${lastMove && lastMove[0] === r && lastMove[1] === c ? ' just' : ''}` }));
          else if (isHint && turn === 'b') cell.append(el('div', { class: 'rv-hint-dot' }));
          boardEl.append(cell);
        }
      }
      const n = counts(board);
      blackCount.textContent = String(n.black);
      whiteCount.textContent = String(n.white);
    }

    function updateStatus(msg) {
      const n = counts(board);
      if (msg) statusL.textContent = msg;
      else statusL.textContent = gameOver ? '终局' : `${turn === 'b' ? '黑方(你)' : '白方(AI)'}行棋 · 合法步 ${legalMoves(board, turn).length}`;
      setTitle(`黑白棋 ${n.black}:${n.white} — ${gameOver ? '终局' : turn === 'b' ? '你的回合' : 'AI 回合'}`);
    }

    function finish() {
      const { black, white } = counts(board);
      gameOver = true;
      let title, msg;
      if (black > white) { title = '🎉 你赢了!'; msg = `黑 ${black} : 白 ${white}`; }
      else if (white > black) { title = 'AI 获胜'; msg = `黑 ${black} : 白 ${white}`; }
      else { title = '平局'; msg = `${black} : ${white}`; }
      dialogs.info({ title, message: msg });
      updateStatus(`${title}(${msg})`);
    }

    /** 回合推进:处理跳过与终局;vsAI 时驱动 AI */
    function advance() {
      const n = counts(board);
      const full = n.black + n.white === 64;
      if (full || (legalMoves(board, 'b').length === 0 && legalMoves(board, 'w').length === 0)) {
        finish(); renderBoard(); return;
      }
      if (legalMoves(board, turn).length === 0) {
        // 当前方无棋:跳过(双方均无棋的情况已在上面终局处理)
        bus.notify('黑白棋', `${turn === 'b' ? '黑方' : '白方'}无合法棋,跳过回合`);
        turn = other(turn);
      }
      renderBoard();
      updateStatus();
      if (vsAI && turn === 'w' && !gameOver) setTimeout(aiMove, 260);
    }

    function humanMove(r, c) {
      if (gameOver || turn !== 'b') return;
      const flips = flipsFor(board, r, c, 'b');
      if (!flips.length) return;
      const { board: nb, flipped } = applyMove(board, r, c, 'b');
      board = nb;
      lastMove = [r, c];
      turn = 'w';
      renderBoard();
      updateStatus(`${flipped.length} 子被翻`);
      advance();
    }

    async function aiMove() {
      if (gameOver || !vsAI || turn !== 'w') return;
      if (!root.isConnected) { searchGen++; return; }
      if (thinking) { setTimeout(aiMove, 260); return; } // 上一轮搜索尚未结束,稍后重试
      thinking = true;
      const gen = searchGen;
      try {
        const res = await think(board, 'w', LEVELS[levelIdx], showSearch, () => gen !== searchGen);
        if (!res || gen !== searchGen || gameOver || !root.isConnected) return;
        const r = res.move >> 3, c = res.move & 7;
        const { board: nb, flipped } = applyMove(board, r, c, 'w');
        board = nb;
        lastMove = [r, c];
        turn = 'b';
        renderBoard();
        updateStatus(`AI 落子 ${moveName(res.move)}(翻 ${flipped.length} 子)`);
        advance();
      } finally {
        thinking = false;
      }
    }

    const newBtn = el('button', { class: 'btn primary', onClick: () => {
      searchGen++; // 打断进行中的搜索
      board = initBoard(); turn = 'b'; gameOver = false; lastMove = null;
      searchLine.textContent = levelHint();
      renderBoard(); updateStatus();
    } }, '新对局');
    const aiBtn = el('button', {
      class: 'btn', onClick: (e) => {
        searchGen++;
        vsAI = !vsAI;
        e.currentTarget.textContent = vsAI ? '人机:开' : '双人';
        if (!vsAI) { searchLine.textContent = '双人模式 · 无 AI 搜索'; updateStatus(); }
        else advance();
      },
    }, '人机:开');
    const levelBtn = el('button', {
      class: 'btn', onClick: (e) => {
        searchGen++;
        levelIdx = (levelIdx + 1) % LEVELS.length;
        e.currentTarget.textContent = `难度:${LEVELS[levelIdx].name}`;
        searchLine.textContent = levelHint();
        // 若切换发生在 AI 思考中,重新调度被打断的 AI
        if (vsAI && turn === 'w' && !gameOver) setTimeout(aiMove, 260);
      },
    }, `难度:${LEVELS[levelIdx].name}`);

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn, aiBtn, levelBtn,
        el('span', { class: 'grow' }),
        el('span', { class: 'row' }, blackCount, el('span', { class: 'dim' }, ':'), whiteCount)),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, boardEl),
      searchLine,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '你执黑先行 · 点亮圈为可落子位'))));

    renderBoard();
    updateStatus();
  },
});
