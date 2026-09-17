/* ⚠️ 本文件是 js/apps/reversi/index.js 引擎段的【快照】,不会自动跟随上游改动。
 *    当前快照 = 已落地「提前收尾 + 跳过空方向」的生产版(index.js 747 行)。
 *    若 index.js 的引擎段有变更,需要重建本文件。
 *    背景、实测数据与验收方法见 docs/reversi-ai-optimization.md。
 *    用法:node tools/<本文件> <micro|bench|stats|idstats|nps|endgame|selfplay|moves|endmoves>
 */
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

/** 经典 Zobrist:每格 × 每色一对独立随机数(mulberry32 生成),异或组合。
 *  索引 = 颜色×64 + 格号(白 0-63 / 黑 64-127),保证"白@s 与 黑@s'"
 *  这类跨色跨字的组合不可能整对抵消——线性混合或错位索引都会造成
 *  精确碰撞,污染置换表精确分。双 32 位联合校验,伪命中概率约 2^-64。 */
const ZOB1 = new Int32Array(128), ZOB2 = new Int32Array(128);
{
  let s = 0x1a2b3c4d;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  };
  for (let i = 0; i < 128; i++) { ZOB1[i] = rnd(); ZOB2[i] = rnd(); }
}
let _k1 = 0, _k2 = 0;
function hashPos(player) {
  let k1 = 0, k2 = 0, x, b;
  x = PLO; while (x) { b = x & -x; x ^= b; const i = 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  x = PHI; while (x) { b = x & -x; x ^= b; const i = 32 + 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  x = OLO; while (x) { b = x & -x; x ^= b; const i = 64 + 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  x = OHI; while (x) { b = x & -x; x ^= b; const i = 96 + 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  k1 = (k1 ^ player) | 0;
  k2 = (k2 ^ Math.imul(player, 0x9e3779b9)) | 0;
  _k1 = k1; _k2 = k2;
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

/* ---- 8 方向"穿越填充":从源格集出发穿过连续 O,结果 → _lo/_hi。
 *      每步先按方向掩掉边列再移位;±1 按字内移位,±7/±8/±9 做字间进位。
 *      "走到不是 O 就停":方向线最多 6 个中间格,原实现无条件展开 6 层,
 *      但绝大多数出发点邻格不是 O,一层都不必展开。语义与 6 层展开完全等价。 */

/** 东(+1):源不得在 H 列 */
function fillE(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = ((lo & NH) << 1) & olo, xh = ((hi & NH) << 1) & ohi;
  while (x | xh) { t |= x; th |= xh; x = ((x & NH) << 1) & olo; xh = ((xh & NH) << 1) & ohi; }
  _lo = t; _hi = th;
}

/** 西(-1):源不得在 A 列 */
function fillW(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = ((lo & NA) >>> 1) & olo, xh = ((hi & NA) >>> 1) & ohi;
  while (x | xh) { t |= x; th |= xh; x = ((x & NA) >>> 1) & olo; xh = ((xh & NA) >>> 1) & ohi; }
  _lo = t; _hi = th;
}

/** 南(+8,下一行):字间进位取自低字高 8 位 */
function fillS(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = (lo << 8) & olo, xh = ((hi << 8) | (lo >>> 24)) & ohi;
  while (x | xh) { t |= x; th |= xh; xh = ((xh << 8) | (x >>> 24)) & ohi; x = (x << 8) & olo; }
  _lo = t; _hi = th;
}

/** 北(-8,上一行):字间进位取自高字低 8 位 */
function fillN(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = ((lo >>> 8) | (hi << 24)) & olo, xh = (hi >>> 8) & ohi;
  while (x | xh) { t |= x; th |= xh; x = ((x >>> 8) | (xh << 24)) & olo; xh = (xh >>> 8) & ohi; }
  _lo = t; _hi = th;
}

/** 西南(+7:下一行左一列):源不得在 A 列 */
function fillSW(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NA, h = hi & NA;
  let x = (l << 7) & olo, xh = ((h << 7) | (l >>> 25)) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NA; h = xh & NA; xh = ((h << 7) | (l >>> 25)) & ohi; x = (l << 7) & olo; }
  _lo = t; _hi = th;
}

/** 东北(-7:上一行右一列):源不得在 H 列 */
function fillNE(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NH, h = hi & NH;
  let x = ((l >>> 7) | (h << 25)) & olo, xh = (h >>> 7) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NH; h = xh & NH; x = ((l >>> 7) | (h << 25)) & olo; xh = (h >>> 7) & ohi; }
  _lo = t; _hi = th;
}

/** 东南(+9:下一行右一列):源不得在 H 列 */
function fillSE(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NH, h = hi & NH;
  let x = (l << 9) & olo, xh = ((h << 9) | (l >>> 23)) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NH; h = xh & NH; xh = ((h << 9) | (l >>> 23)) & ohi; x = (l << 9) & olo; }
  _lo = t; _hi = th;
}

/** 西北(-9:上一行左一列):源不得在 A 列 */
function fillNW(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NA, h = hi & NA;
  let x = ((l >>> 9) | (h << 23)) & olo, xh = (h >>> 9) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NA; h = xh & NA; x = ((l >>> 9) | (h << 23)) & olo; xh = (h >>> 9) & ohi; }
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
  /* 每方向先就地判一次"邻格是否为 O"(即 fill 的第一步),
     落空则连函数调用都不发生 —— 绝大多数方向在此直接跳过。 */
  if ((((mlo & NH) << 1) | ((mhi & NH) << 1)) & olo | (((mhi & NH) << 1) & ohi)) { fillE(mlo, mhi, olo, ohi); fl |= _lo & fwLo; fh |= _hi & fwHi; }
  if ((((mlo & NA) >>> 1) | ((mhi & NA) >>> 1)) & olo | (((mhi & NA) >>> 1) & ohi)) { fillW(mlo, mhi, olo, ohi); fl |= _lo & feLo; fh |= _hi & feHi; }
  if (((mlo << 8) & olo) | (((mhi << 8) | (mlo >>> 24)) & ohi)) { fillS(mlo, mhi, olo, ohi); fl |= _lo & fnLo; fh |= _hi & fnHi; }
  if ((((mlo >>> 8) | (mhi << 24)) & olo) | ((mhi >>> 8) & ohi)) { fillN(mlo, mhi, olo, ohi); fl |= _lo & fsLo; fh |= _hi & fsHi; }
  if ((((mlo & NA) << 7) & olo) | ((((mhi & NA) << 7) | ((mlo & NA) >>> 25)) & ohi)) { fillSW(mlo, mhi, olo, ohi); fl |= _lo & fneLo; fh |= _hi & fneHi; }
  if (((((mlo & NH) >>> 7) | ((mhi & NH) << 25)) & olo) | (((mhi & NH) >>> 7) & ohi)) { fillNE(mlo, mhi, olo, ohi); fl |= _lo & fswLo; fh |= _hi & fswHi; }
  if ((((mlo & NH) << 9) & olo) | ((((mhi & NH) << 9) | ((mlo & NH) >>> 23)) & ohi)) { fillSE(mlo, mhi, olo, ohi); fl |= _lo & fnwLo; fh |= _hi & fnwHi; }
  if (((((mlo & NA) >>> 9) | ((mhi & NA) << 23)) & olo) | (((mhi & NA) >>> 9) & ohi)) { fillNW(mlo, mhi, olo, ohi); fl |= _lo & fseLo; fh |= _hi & fseHi; }
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
    moveFlips(sq < 32 ? b : 0, sq < 32 ? 0 : b, OLO, OHI);
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
      // 先存走 ttMove 自己的翻子:右移会覆盖 fll[i]/flh[i],漏存会让
      // moves[0] 配到别人的翻子掩码,make 出非法局面(值全错)
      const fl = fll[i], fh = flh[i];
      for (let j = i; j > 0; j--) {
        moves[j] = moves[j - 1]; scores[j] = scores[j - 1];
        fll[j] = fll[j - 1]; flh[j] = flh[j - 1];
      }
      moves[0] = ttMove; fll[0] = fl; flh[0] = fh;
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
    moveFlips(sq < 32 ? b : 0, sq < 32 ? 0 : b, OLO, OHI);
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
/* ==================== 基准测试驱动(不属于应用代码) ==================== */

/* UI 侧的同名工具函数(引擎部分未抽取,这里补上) */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (p) => (p === 'b' ? 'w' : 'b');
const moveName = (p) => 'abcdefgh'[p & 7] + ((p >> 3) + 1);

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
  const nb = b.map((row) => [...row]);
  nb[r][c] = color;
  for (const [fr, fc] of flips) nb[fr][fc] = color;
  return { board: nb, flipped: flips };
}

function clearTT() {
  for (const T of [TT_MID, TT_END]) {
    T.key.fill(0); T.key2.fill(0); T.depth.fill(0);
    T.flag.fill(0); T.score.fill(0); T.move.fill(-1);
  }
}

function parseBoard(s) {
  const lines = s.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const b = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let c = 0; c < 8; c++) {
      const ch = lines[r][c];
      row.push(ch === 'b' ? 'b' : ch === 'w' ? 'w' : null);
    }
    b.push(row);
  }
  return b;
}

const emptiesOf = (b) => {
  let n = 0;
  for (const row of b) for (const v of row) if (!v) n++;
  return n;
};

/** 根搜索:与 think() 内的 runRoot 等价,但无 setTimeout,便于计秒 */
function rootSearch(board, aiColor, depth, exactMode) {
  toBitboard(board, aiColor);
  const aiNum = aiColor === 'b' ? BLACK : WHITE;
  nodes = 0;
  const t0 = performance.now();
  genMoves(PLO, PHI, OLO, OHI);
  const moves = plyMoves[0], scores = plyScores[0];
  const fll = plyFlipLo[0], flh = plyFlipHi[0];
  let n0 = 0, mlo = MLO, mhi = MHI;
  while (mlo | mhi) {
    let b, sq;
    if (mlo) { b = mlo & -mlo; mlo ^= b; sq = 31 - Math.clz32(b); }
    else { b = mhi & -mhi; mhi ^= b; sq = 63 - Math.clz32(b); }
    moveFlips(sq < 32 ? b : 0, sq < 32 ? 0 : b, OLO, OHI);
    moves[n0] = sq;
    scores[n0] = W64[sq] + (popcnt(_lo) + popcnt(_hi)) * 2;
    fll[n0] = _lo; flh[n0] = _hi;
    n0++;
  }
  if (!n0) return { move: -1, score: 0, nodes: 0, ms: 0, n0: 0 };
  const order = [];
  for (let i = 0; i < n0; i++) order.push(i);
  order.sort((a, b) => scores[b] - scores[a]);
  const rootV = new Array(n0).fill(0);
  let alpha = -INF;
  const beta = INF;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    makeMove(i, 0);
    if (k === 0) {
      rootV[i] = -search(depth - 1, -beta, -alpha, 3 - aiNum, 1, exactMode);
    } else {
      rootV[i] = -search(depth - 1, -alpha - 1, -alpha, 3 - aiNum, 1, exactMode);
      if (alpha < rootV[i] && rootV[i] < beta) {
        rootV[i] = -search(depth - 1, -beta, -rootV[i], 3 - aiNum, 1, exactMode);
      }
    }
    unmakeMove(0);
    if (rootV[i] > alpha) alpha = rootV[i];
  }
  order.sort((a, b) => rootV[b] - rootV[a]);
  return { move: moves[order[0]], score: rootV[order[0]], nodes, ms: performance.now() - t0, n0 };
}

/** 从起始局面确定性地走出 plies 手,得到测试局面(用固定种子伪随机) */
function randomPosition(plies) {
  let b = parseBoard(`
    ........
    ........
    ........
    ...wb...
    ...bw...
    ........
    ........
    ........`);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let turn = 'b';
  for (let k = 0; k < plies; k++) {
    const ms = legalMoves(b, turn);
    if (!ms.length) {
      if (!legalMoves(b, other(turn)).length) break;
      turn = other(turn); continue;
    }
    const [r, c] = ms[Math.floor(rnd() * ms.length)];
    b = applyMove(b, r, c, turn).board;
    turn = other(turn);
  }
  return b;
}

/** 与 think() 内部一致的完整流程(含残局完全求解),用于端到端计时 */
async function fullThink(board, aiColor, level) {
  const pre = PRE_ENDGAME_DEPTH;
  clearTT();
  const ai = aiColor === 'b' ? BLACK : WHITE;
  toBitboard(board, aiColor);
  nodes = 0;
  const t0 = performance.now();
  const empties = 64 - (popcnt(PLO) + popcnt(PHI) + popcnt(OLO) + popcnt(OHI));
  if (empties <= level.end) {
    // 残局:前置中层 + 完全求解(rootSearch 无 UI 让步,需自行算预搜深度)
    const preMax = Math.min(pre, level.depth, empties);
    for (let d = 2; d <= preMax; d += 2) rootSearch(board, aiColor, d, false);
    const r = rootSearch(board, aiColor, empties + 4, true);
    return { move: r.move, score: r.score, nodes, ms: performance.now() - t0, endgame: true, empties };
  }
  let res = null;
  for (let d = 2; d <= level.depth; d += 2) {
    // 与 think() 一致:迭代之间不清表,浅层结果供深层复用
    res = rootSearch(board, aiColor, d, false);
  }
  return { move: res.move, score: res.score, nodes, ms: performance.now() - t0, endgame: false, empties };
}

/* ---- 自对弈:N 手固定深度,统计总节点/总耗时 ---- */

function selfPlay(plies, depth) {
  let plo = 0, phi = 0, olo = 0, ohi = 0;
  // 起始局面
  for (const [p, color] of [[27, 'w'], [28, 'b'], [35, 'b'], [36, 'w']]) {
    if (color === 'b') { if (p < 32) plo |= 1 << p; else phi |= 1 << (p - 32); }
    else { if (p < 32) olo |= 1 << p; else ohi |= 1 << (p - 32); }
  }
  let player = BLACK;
  let totalNodes = 0, totalMs = 0, moves = 0;
  for (let k = 0; k < plies; k++) {
    __setPosition(plo, phi, olo, ohi, player === BLACK ? 'b' : 'w');
    const [mlo, mhi] = __legal();
    if (!(mlo | mhi)) {
      const [nlo, nhi] = (genMoves(olo, ohi, plo, phi), [MLO, MHI]);
      if (!(nlo | nhi)) break;
      const w = plo; plo = olo; olo = w;
      const w2 = phi; phi = ohi; ohi = w2;
      player = 3 - player;
      continue;
    }
    const boardArr = bitToBoard(plo, phi, olo, ohi, player);
    const res = rootSearch(boardArr, player === BLACK ? 'b' : 'w', depth, false);
    totalNodes += nodes; totalMs += res.ms; moves++;
    __setPosition(plo, phi, olo, ohi, player === BLACK ? 'b' : 'w');
    plyMoves[0][0] = res.move;
    genMoves(plo, phi, olo, ohi);
    moveFlips(res.move < 32 ? 1 << res.move : 0, res.move < 32 ? 0 : 1 << (res.move - 32), olo, ohi);
    plyFlipLo[0][0] = _lo; plyFlipHi[0][0] = _hi;
    makeMove(0, 0);
    plo = PLO; phi = PHI; olo = OLO; ohi = OHI;
    player = 3 - player;
  }
  return { moves, totalNodes, totalMs };
}

function bitToBoard(plo, phi, olo, ohi, player) {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const put = (lo, hi, ch) => {
    for (let p = 0; p < 64; p++) {
      const bit = p < 32 ? (lo >>> p) & 1 : (hi >>> (p - 32)) & 1;
      if (bit) b[p >> 3][p & 7] = ch;
    }
  };
  if (player === BLACK) { put(plo, phi, 'b'); put(olo, ohi, 'w'); }
  else { put(plo, phi, 'w'); put(olo, ohi, 'b'); }
  return b;
}

/* ---- 主流程 ---- */

const MODE = process.argv[2] || 'nps';
const LEVELS_FOR_BENCH = [
  { name: '中级(4层)', depth: 4, end: 8 },
  { name: '高级(8层)', depth: 8, end: 14 },
];
function fmt(n) { return n.toLocaleString('en-US'); }

/** 64 字符串(row-major,'b'/'w'/'.')→ UI 棋盘 */
function parseBoard64(s) {
  const b = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let c = 0; c < 8; c++) {
      const ch = s[r * 8 + c];
      row.push(ch === 'b' ? 'b' : ch === 'w' ? 'w' : null);
    }
    b.push(row);
  }
  return b;
}


/* ---- 引擎服务模式:从 stdin 逐行读「局面 深度 行棋方」,向 stdout 吐着法 ---- */
if (process.argv[2] === 'serve') {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const [pos, depthS, color] = line.split(' ');
      const b = parseBoard64(pos);
      // 不清表:与真实对局一致(think() 全程复用同一张表)
      const r = rootSearch(b, color, +depthS, false);
      process.stdout.write(moveName(r.move) + '\n');
    }
  });
}


if (MODE === 'micro') {
  const b = randomPosition(24);
  toBitboard(b, 'w');
  const N = 3000000;
  const bench = (label, fn) => {
    fn(); // 预热/JIT
    const t = performance.now();
    fn();
    const ms = performance.now() - t;
    console.log(`${label.padEnd(24)} ${(ms * 1e6 / N).toFixed(1).padStart(8)} ns/次   (${ms.toFixed(0)}ms / ${fmt(N)} 次)`);
  };
  let acc = 0;
  const plo = PLO, phi = PHI, olo = OLO, ohi = OHI;
  bench('hashPos(全盘扫描)', () => { for (let i = 0; i < N; i++) { hashPos(1); acc ^= _k1; } });
  bench('genMoves(8 次 fill)', () => { for (let i = 0; i < N; i++) { genMoves(plo, phi, olo, ohi); acc ^= MLO; } });
  bench('fillE ×1', () => { for (let i = 0; i < N; i++) { fillE(plo, phi, olo, ohi); acc ^= _lo; } });
  bench('popcnt ×4', () => { for (let i = 0; i < N; i++) { acc ^= popcnt(plo) + popcnt(phi) + popcnt(olo) + popcnt(ohi); } });
  bench('evaluate()', () => { for (let i = 0; i < N; i++) { acc ^= evaluate(); } });
  genMoves(plo, phi, olo, ohi);
  const sq0 = 31 - Math.clz32((MLO || MHI) & -(MLO || MHI));
  bench('moveFlips ×1', () => {
    for (let i = 0; i < N; i++) {
      moveFlips(sq0 < 32 ? 1 << sq0 : 0, sq0 < 32 ? 0 : 1 << (sq0 - 32), olo, ohi);
      acc ^= _lo;
    }
  });
  console.log('(校验位 ' + acc + ')');
  const r = (clearTT(), rootSearch(b, 'w', 8, false));
  console.log(`参考:该局面 8 层搜索 ${fmt(r.nodes)} 节点 / ${r.ms.toFixed(0)}ms → ${(r.ms * 1e6 / r.nodes).toFixed(0)} ns/节点`);
}


if (MODE === 'micro') {
  const b = randomPosition(24);
  toBitboard(b, 'w');
  const N = 3000000;
  const bench = (label, fn) => {
    fn(); // 预热/JIT
    const t = performance.now();
    fn();
    const ms = performance.now() - t;
    console.log(`${label.padEnd(24)} ${(ms * 1e6 / N).toFixed(1).padStart(8)} ns/次   (${ms.toFixed(0)}ms / ${fmt(N)} 次)`);
  };
  let acc = 0;
  const plo = PLO, phi = PHI, olo = OLO, ohi = OHI;
  bench('hashPos(全盘扫描)', () => { for (let i = 0; i < N; i++) { hashPos(1); acc ^= _k1; } });
  bench('genMoves(8 次 fill)', () => { for (let i = 0; i < N; i++) { genMoves(plo, phi, olo, ohi); acc ^= MLO; } });
  bench('fillE ×1', () => { for (let i = 0; i < N; i++) { fillE(plo, phi, olo, ohi); acc ^= _lo; } });
  bench('popcnt ×4', () => { for (let i = 0; i < N; i++) { acc ^= popcnt(plo) + popcnt(phi) + popcnt(olo) + popcnt(ohi); } });
  bench('evaluate()', () => { for (let i = 0; i < N; i++) { acc ^= evaluate(); } });
  genMoves(plo, phi, olo, ohi);
  const sq0 = 31 - Math.clz32((MLO || MHI) & -(MLO || MHI));
  bench('moveFlips ×1', () => {
    for (let i = 0; i < N; i++) {
      moveFlips(sq0 < 32 ? 1 << sq0 : 0, sq0 < 32 ? 0 : 1 << (sq0 - 32), olo, ohi);
      acc ^= _lo;
    }
  });
  console.log('(校验位 ' + acc + ')');
  const r = (clearTT(), rootSearch(b, 'w', 8, false));
  console.log(`参考:该局面 8 层搜索 ${fmt(r.nodes)} 节点 / ${r.ms.toFixed(0)}ms → ${(r.ms * 1e6 / r.nodes).toFixed(0)} ns/节点`);
}

if (MODE === 'stats') {
  for (const plies of [12, 24, 40]) {
    const b = randomPosition(plies);
    for (const d of [6, 8]) {
      clearTT();
      statNodes = statLeaves = statTTHit = statTTMove = 0;
      rootSearch(b, 'w', d, false);
      const pct = (x) => (x / statNodes * 100).toFixed(1) + '%';
      console.log(
        `空 ${emptiesOf(b)} 深度 ${d} | 节点 ${fmt(statNodes)} | 叶子 ${pct(statLeaves)} | ` +
        `TT 截断 ${pct(statTTHit)} | TT 有最优着 ${pct(statTTMove)}`
      );
    }
  }
}

if (MODE === 'idstats') {
  for (const plies of [12, 24, 40]) {
    const b = randomPosition(plies);
    for (const d of [8]) {
      clearTT();
      statNodes = statLeaves = statTTHit = statTTMove = 0;
      await fullThink(b, 'w', { depth: d, end: 0 });
      const pct = (x) => (x / statNodes * 100).toFixed(1) + '%';
      console.log(
        `[迭代加深] 空 ${emptiesOf(b)} 深度 ${d} | 节点 ${fmt(statNodes)} | 叶子 ${pct(statLeaves)} | ` +
        `TT 截断 ${pct(statTTHit)} | TT 有最优着 ${pct(statTTMove)}`
      );
    }
  }
}

if (MODE === 'bench') {
  const positions = [12, 20, 28, 36, 44, 52].map(randomPosition);
  const usable = positions.filter((b) => emptiesOf(b) > 14);
  for (const depth of [5, 6, 7, 8]) {
    let totNodes = 0, best = Infinity;
    for (let rep = 0; rep < 4; rep++) {
      let ms = 0, nd = 0;
      for (const b of usable) {
        clearTT();
        const r = rootSearch(b, 'w', depth, false);
        ms += r.ms; nd += r.nodes;
      }
      if (rep > 0 && ms < best) best = ms;
      if (rep === 0) totNodes = nd;
    }
    console.log(`${fmt(usable.length)} 局面 深度 ${depth} | 合计 ${fmt(totNodes)} 节点 | 最快一轮 ${best.toFixed(0)}ms | ${fmt(Math.round(totNodes / best * 1000))} NPS`);
  }
}

if (MODE === 'nps' || MODE === 'all') {
  const cases = [
    ['开局后 12 手', randomPosition(12)],
    ['中局 24 手', randomPosition(24)],
    ['中后期 40 手', randomPosition(40)],
    ['残局 52 手', randomPosition(52)],
  ];
  for (const [name, b] of cases) {
    for (const lv of LEVELS_FOR_BENCH) {
      if (emptiesOf(b) <= lv.end) continue;
      clearTT();
      const warm = rootSearch(b, 'w', lv.depth, false); // 预热
      clearTT();
      const r = rootSearch(b, 'w', lv.depth, false);
      const nps = r.ms > 0 ? Math.round(r.nodes / r.ms * 1000) : 0;
      console.log(`${name} | ${lv.name} | 空 ${emptiesOf(b)} | 节点 ${fmt(r.nodes)} | ${r.ms.toFixed(1)}ms | ${fmt(nps)} NPS | 最佳 ${moveName(r.move)} 分 ${r.score}`);
    }
  }
}

if (MODE === 'endgame' || MODE === 'all') {
  for (const plies of [46, 47, 48, 49]) {
    const b = randomPosition(plies);
    const e = emptiesOf(b);
    clearTT();
    const r0 = rootSearch(b, 'w', e + 4, true);
    clearTT();
    const t0 = performance.now();
    const r = rootSearch(b, 'w', e + 4, true);
    const ms = performance.now() - t0;
    const nps = ms > 0 ? Math.round(r.nodes / ms * 1000) : 0;
    console.log(`残局完全求解 | 空 ${e} | 节点 ${fmt(r.nodes)} | ${ms.toFixed(1)}ms | ${fmt(nps)} NPS | 最佳 ${moveName(r.move)} 分 ${r.score / 100} 子`);
  }
}

if (MODE === 'endnodes') {
  /* 残局完全求解的节点数。局面由固定种子生成 ⇒ 节点数完全可复现,
     是"纯加速/纯排序"类改动最干净的度量(不受机器噪声影响)。 */
  const bs = [];
  for (let plies = 40; plies <= 56; plies++) {
    const b = randomPosition(plies);
    const e = emptiesOf(b);
    if (e >= 8 && e <= 22) bs.push({ b, e, plies });
  }
  const byE = {};
  for (const x of bs) (byE[x.e] = byE[x.e] || []).push(x);
  for (const e of Object.keys(byE).map(Number).sort((a, c) => a - c)) {
    const group = byE[e];
    let tot = 0, ms = 0, ok = true, sig = [];
    for (const x of group) {
      clearTT();
      const r = rootSearch(x.b, 'w', x.e + 4, true);
      tot += r.nodes; ms += r.ms;
      sig.push(`${moveName(r.move)}:${r.score}`);
    }
    console.log(`空 ${String(e).padStart(2)} | 局面 ${group.length} | 合计节点 ${fmt(tot).padStart(14)} | ${ms.toFixed(0).padStart(6)}ms | ${sig.join(' ')}`);
  }
}

if (MODE === 'selfplay' || MODE === 'all') {
  for (const d of [4, 6, 8]) {
    clearTT();
    const r = selfPlay(56, d);
    const nps = r.totalMs > 0 ? Math.round(r.totalNodes / r.totalMs * 1000) : 0;
    console.log(`自对弈 深度 ${d} | ${r.moves} 手 | 总节点 ${fmt(r.totalNodes)} | 总耗时 ${(r.totalMs / 1000).toFixed(2)}s | 平均 ${fmt(nps)} NPS`);
  }
}

if (MODE === 'moves' || MODE === 'all') {
  // 语义回归:固定深度下的最佳着法与分数(优化前后必须一致)
  const cases = [12, 20, 28, 36].map((p) => randomPosition(p));
  const out = [];
  for (const b of cases) {
    for (const d of [4, 6, 8]) {
      clearTT();
      const r = rootSearch(b, 'w', d, false);
      out.push(`${d}:${moveName(r.move)}:${r.score}:${r.nodes}`);
    }
  }
  console.log('MOVES ' + out.join(' '));
}

if (MODE === 'endmoves' || MODE === 'all') {
  const out = [];
  for (const plies of [46, 47, 48, 49]) {
    const b = randomPosition(plies);
    const e = emptiesOf(b);
    clearTT();
    const r = rootSearch(b, 'w', e + 4, true);
    out.push(`${e}:${moveName(r.move)}:${r.score}`);
  }
  console.log('ENDMOVES ' + out.join(' '));
}
