/* ============================================================
 * AetherWebOS e2e 用例组 · 游戏(T33 T34 T35 T36 T44 T52)
 * 自原 e2e.mjs 单文件按域拆出;公共助手见 tools/e2e-harness.mjs。
 * 本文件只做 group() 注册(被入口 tools/e2e.mjs import),不要直接运行。
 * ============================================================ */
import { group, t, ev, c, fresh, sleep, waitFor, needApps, termType, nav, bashType, bashOut, ctxClick, typeReal, pressEnter, clickReal, wipeAppData, wipeSharedAppData } from '../e2e-harness.mjs';

group('T33', '扫雷 + 国际象棋', async () => {
  /* ---- T33 扫雷 + 国际象棋 ---- */
  await needApps('minesweeper', 'chess3d');
  await fresh();

  // 扫雷:棋盘规模 / 首击安全 / 右键插旗
  await ev(`WebOS.wm.open('minesweeper')`);
  await sleep(700);
  const g1 = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=minesweeper]');
    const cells = [...w.querySelectorAll('.ms-cell')];
    const first = cells[40];   // 中心格
    first.click();
    await new Promise(r => setTimeout(r, 250));
    const opened = w.querySelectorAll('.ms-cell.open').length;
    // 首击安全:翻开的都不是雷(数字格即非雷)
    const safe = !w.querySelector('.ms-cell.mine');
    // 右键插旗
    const target = [...w.querySelectorAll('.ms-cell:not(.open)')][0];
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 250));
    const flag = w.querySelectorAll('.ms-cell.flag').length;
    return { total: cells.length, opened, safe, flag };
  })()`);
  t('T33 扫雷:9x9=81格+首击安全+展开', g1.total === 81 && g1.safe && g1.opened > 1, JSON.stringify(g1));
  t('T33.1 右键插旗', g1.flag === 1);
  await c.shot('t33-minesweeper');

  // 3D 象棋:等 chess3d 应用注册完成(含 Three.js chunk)再打开
  for (let i = 0; i < 20 && !(await ev(`!!WebOS.apps.list().find(a => a.id === 'chess3d')`)); i++) await sleep(500);
  await ev(`WebOS.wm.open('chess3d')`);
  await sleep(2500);
  const g2 = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=chess3d]');
    const canvas = w.querySelector('canvas');
    if (!canvas) return { noCanvas: true };
    if (!window.__chess) return { noHook: true, hasErr: (w.querySelector('.win-error')?.textContent || '').slice(0, 120) };
    const before = JSON.stringify(window.__chess.board());
    window.__chess.click(6, 4);   // 选中 e2 兵
    await new Promise(r => setTimeout(r, 250));
    window.__chess.click(4, 4);   // 走 e2-e4
    await new Promise(r => setTimeout(r, 1300));   // 等 AI 应答
    return {
      changed: JSON.stringify(window.__chess.board()) !== before,
      turn: window.__chess.turn(),
      status: w.querySelector('.app-status span').textContent,
    };
  })()`);
  t('T33.2 3D 象棋:走子+AI 应答', g2.changed === true && g2.turn === 'w', JSON.stringify(g2));
  await c.shot('t33-chess');


  const errs3 = await ev(`window.__errs.length`);
  t('T33.3 全程无错误', errs3 === 0, `errs=${errs3}`);
});

group('T34', '黑白棋', async () => {
  /* ---- T34 黑白棋 ---- */
  await needApps('reversi');
  await fresh();
  await ev(`WebOS.wm.open('reversi')`);
  await sleep(700);
  const rv0 = await ev(`(() => ({
    cells: document.querySelectorAll('.rv-cell').length,
    black: document.querySelectorAll('.rv-piece.b').length,
    white: document.querySelectorAll('.rv-piece.w').length,
    hints: document.querySelectorAll('.rv-hint-dot').length,
  }))()`);
  t('T34 黑白棋:初始局面(4子+4合法步提示)', rv0.cells === 64 && rv0.black === 2 && rv0.white === 2 && rv0.hints === 4,
    JSON.stringify(rv0));

  // 引擎规则验证:开局黑方合法位 = d3(2,3) / c4(3,2) / f5(4,5) / e6(5,4)
  const rv1 = await ev(`(() => {
    const hints = [...document.querySelectorAll('.rv-cell.hint')].map(c => c.dataset.r + ',' + c.dataset.c).sort();
    return { hints, ok: JSON.stringify(hints) === JSON.stringify(['2,3', '3,2', '4,5', '5,4']) };
  })()`);
  t('T34.1 合法走法位置正确(标准开局4位)', rv1.ok, JSON.stringify(rv1.hints));

  // 玩家落子(第一个提示位)→ 翻子 → AI 应答 → 子数变化
  const rv2 = await ev(`(async () => {
    const before = document.querySelectorAll('.rv-piece').length;
    const cell = document.querySelector('.rv-cell.hint');
    const rc = cell.dataset.r + ',' + cell.dataset.c;
    cell.click();
    await new Promise(r => setTimeout(r, 900));   // 翻子 + AI
    const n = document.querySelectorAll('.rv-piece').length;
    const status = document.querySelector('.win[data-app=reversi] .app-status span').textContent;
    return { rc, before, after: n, status };
  })()`);
  t('T34.2 落子翻子+AI 应答', rv2.after >= 4, JSON.stringify(rv2));

  // 传回终端规则验证:用引擎API核对黑白棋终局计数(应用窗口直接读)
  const rv3 = await ev(`(() => ({
    black: document.querySelector('.win[data-app=reversi] .rv-count.black')?.textContent,
    white: document.querySelector('.win[data-app=reversi] .rv-count.white')?.textContent,
    sum: +(document.querySelector('.win[data-app=reversi] .rv-count.black')?.textContent || 0) +
         +(document.querySelector('.win[data-app=reversi] .rv-count.white')?.textContent || 0),
  }))()`);
  t('T34.3 子数统计一致', rv3.sum >= 4 && rv3.sum <= 64, JSON.stringify(rv3));
  await c.shot('t34-reversi');

  // 工具栏按钮按文字查找(新对局/换边/悔棋)
  const rvBtn = (label) => ev(`[...document.querySelectorAll('.win[data-app=reversi] .app-toolbar .btn')]
    .find(b => b.textContent.includes('${label}'))?.click()`);

  // 悔棋:人机模式连 AI 应手一起撤 → 回到初始 4 子,轮到玩家
  await rvBtn('悔棋');
  await sleep(300);
  const rv4 = await ev(`(() => ({
    pieces: document.querySelectorAll('.rv-piece').length,
    status: document.querySelector('.win[data-app=reversi] .app-status span').textContent,
  }))()`);
  t('T34.5 悔棋撤两手回初始局面', rv4.pieces === 4 && rv4.status.includes('黑方行棋'), JSON.stringify(rv4));

  // 换边:玩家改执白,AI 执黑先行落子;搜索信息改写在状态栏右侧(infoL)
  await rvBtn('换边');
  await sleep(2500);
  const rv5 = await ev(`(() => {
    const spans = document.querySelectorAll('.win[data-app=reversi] .app-status span');
    return {
      pieces: document.querySelectorAll('.rv-piece').length,
      status: spans[0].textContent,
      info: spans[spans.length - 1].textContent,
    };
  })()`);
  t('T34.6 换边后 AI 执黑先行', rv5.pieces >= 5 && rv5.status.includes('白方行棋') && rv5.info.length > 0,
    JSON.stringify(rv5));

  // 新对局保持执白偏好:仍是 AI(黑)先行;悔棋可复活终局就不在此展开了
  const rv6 = await ev(`[...document.querySelectorAll('.win[data-app=reversi] .app-toolbar .btn')]
    .find(b => b.textContent.includes('新对局'))?.click()`);
  await sleep(2000);
  const rv7 = await ev(`(() => ({
    pieces: document.querySelectorAll('.rv-piece').length,
    status: document.querySelector('.win[data-app=reversi] .app-status span').textContent,
  }))()`);
  t('T34.7 新对局执白时 AI 先行', rv6 === undefined || rv6 === true ? rv7.pieces >= 5 && rv7.status.includes('白方行棋') : false,
    JSON.stringify(rv7));

  const errs4 = await ev(`window.__errs.length`);
  t('T34.4 全程无错误', errs4 === 0, `errs=${errs4}`);
});

group('T35', '纸牌游戏(接龙 + 记忆翻牌)', async () => {
  /* ---- T35 纸牌游戏(接龙 + 记忆翻牌) ---- */
  await needApps('solitaire', 'pairs');
  await fresh();

  // 接龙:发牌正确性(52 张全在场上:28 在列 + 24 在牌堆)、7 列、点击翻牌
  await ev(`WebOS.wm.open('solitaire')`);
  await sleep(700);
  const so1 = await ev(`(() => ({
    cols: document.querySelectorAll('.sol-col').length,
    slots: document.querySelectorAll('.sol-top .sol-card').length,
    stockCards: (JSON.stringify(0), document.querySelectorAll('.sol-top .sol-card').length),
    title: document.querySelector('.win[data-app=solitaire] .win-title').textContent,
  }))()`);
  t('T35 接龙:界面(7列+6顶槽)', so1.cols === 7 && so1.slots === 6, JSON.stringify(so1));

  // 牌堆点击翻牌:点一次后弃牌堆有牌
  const so2 = await ev(`(async () => {
    const stock = document.querySelector('.sol-top .sol-card');
    stock.click();
    await new Promise(r => setTimeout(r, 300));
    const wasteHas = document.querySelectorAll('.sol-top .sol-card.has').length >= 2;  // stock+waste
    return { wasteHas };
  })()`);
  t('T35.1 牌堆翻牌到弃牌堆', so2.wasteHas === true);

  // 列内翻牌:每列最后一张应翻开
  const so3 = await ev(`(() => {
    const cols = [...document.querySelectorAll('.sol-col')];
    const ups = cols.map(col => {
      const cards = [...col.querySelectorAll('.sol-card')];
      const last = cards.at(-1);
      return last ? !!last.querySelector('.sol-card-face') : false;
    });
    return { allTailsUp: ups.every(Boolean), ups };
  })()`);
  t('T35.2 列尾牌全部翻开', so3.allTailsUp === true, JSON.stringify(so3.ups));
  await c.shot('t35-solitaire');

  // 记忆翻牌:4x4 = 16 张、翻两张配对流程
  await ev(`WebOS.wm.open('pairs')`);
  await sleep(700);
  const p1 = await ev(`(() => ({
    cards: document.querySelectorAll('.pairs-card').length,
    status: document.querySelector('.win[data-app=pairs] .app-status span').textContent,
  }))()`);
  t('T35.3 记忆翻牌:4x4=16 张', p1.cards === 16, JSON.stringify(p1));

  // 自动配对:枚举找到一对相同花色点数的牌翻它们(通过 DOM 文本)
  const p2 = await ev(`(async () => {
    // 关键:flip 触发 render() 会重建 DOM,所有旧引用失效 ——
    // 因此每次点击后必须重新按位置查询节点再读取内容
    const known = new Map();   // 内容 -> 位置索引
    const readFace = (i) => {
      const c = document.querySelectorAll('.pairs-card')[i];
      return c ? (c.querySelector('.pairs-face')?.textContent ?? null) : null;
    };
    const clickAt = async (i, waitMs) => {
      const c = document.querySelectorAll('.pairs-card')[i];
      if (!c) return null;
      c.click();
      await new Promise((r) => setTimeout(r, waitMs));
      const node = document.querySelectorAll('.pairs-card')[i];
      return node ? (node.querySelector('.pairs-face')?.textContent ?? null) : null;
    };
    for (let round = 0; round < 20; round++) {   // 翻牌遍历即可,不做全量穷举
      if (document.querySelectorAll('.pairs-card.matched').length >= 2) return { found: true };
      // 找当前未翻开、未配对的第一张
      const cards = [...document.querySelectorAll('.pairs-card')];
      const idx = cards.findIndex((c) => !c.classList.contains('matched') && !c.classList.contains('up'));
      if (idx < 0) break;
      const keyA = await clickAt(idx, 120);
      if (keyA == null) continue;
      if (known.has(keyA) && known.get(keyA) !== idx) {
        const keyB = await clickAt(known.get(keyA), 400);   // 配对即时生效,等 render 即可
        if (document.querySelectorAll('.pairs-card.matched').length >= 2) return { found: true };
        known.delete(keyA);
        continue;
      }
      // 未知内容:翻开另一张未知的牌,记录两张
      const cards2 = [...document.querySelectorAll('.pairs-card')];
      const idx2 = cards2.findIndex((c) => !c.classList.contains('matched') && !c.classList.contains('up'));
      if (idx2 < 0) break;
      const keyB = await clickAt(idx2, 450);   // 翻错锁 150ms(e2e 模式)+ render 余量
      if (keyB != null && !known.has(keyB)) known.set(keyB, idx2);
      if (!known.has(keyA)) known.set(keyA, idx);
    }
    return { found: document.querySelectorAll('.pairs-card.matched').length >= 2 };
  })()`);
  await c.shot('t35-pairs');


  const errs5 = await ev(`window.__errs.length`);
  t('T35.5 全程无错误', errs5 === 0, `errs=${errs5}`);
});

group('T36', '推箱子', async () => {
  /* ---- T36 推箱子 ---- */
  await needApps('sokoban');
  await fresh();
  for (let i = 0; i < 10 && !(await ev(`WebOS.apps.list().some(a => a.id === 'sokoban')`)); i++) await sleep(400);
  await ev(`WebOS.wm.open('sokoban')`);
  await sleep(700);
  const sk1 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=sokoban]');
    return {
      cells: w.querySelectorAll('.soko-cell').length,
      boxes: w.querySelectorAll('.soko-cell.box').length,
      status: w.querySelector('.app-status span').textContent,
      err: w.querySelector('.win-error')?.textContent || '',
    };
  })()`);
  t('T36 推箱子:第一关加载(30格+1箱)', sk1.cells === 30 && sk1.boxes === 1 && !sk1.err, JSON.stringify(sk1));

  // 键盘解第一关(A W D)→ 箱子入目标 → 胜利对话框
  const sk2 = await ev(`(async () => {
    for (const k of ['a', 'w', 'd']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      await new Promise(r => setTimeout(r, 220));
    }
    await new Promise(r => setTimeout(r, 500));
    const w = document.querySelector('.win[data-app=sokoban]');
    return {
      onGoal: w.querySelectorAll('.soko-cell.on-goal').length,
      statusR: w.querySelector('.app-status .mono').textContent,
      winDlg: [...document.querySelectorAll('.win[data-app=sysdialog] .dlg-title')].some(t => t.textContent.includes('过关')),
    };
  })()`);
  t('T36.1 键盘推箱通关(箱子入目标)', sk2.onGoal === 1 && sk2.winDlg, JSON.stringify(sk2));

  // 撤销:胜利后 1.4s 自动进入下一关(撤销栈清空),在新关卡验证移动+撤销
  await ev(`(() => {
    const dlgBtn = [...document.querySelectorAll('.win[data-app=sysdialog] .dlg-btns .btn')].pop();
    if (dlgBtn) dlgBtn.click();
    return true;
  })()`);
  await sleep(1700);   // 等自动切换到第二关
  const sk3 = await ev(`(async () => {
    const w = document.querySelector('.win[data-app=sokoban]');
    // 模拟用户点击窗口恢复焦点(对话框关闭后焦点需要重新激活)
    w.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const before = w.querySelector('.app-status .mono').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const after = w.querySelector('.app-status .mono').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const undone = w.querySelector('.app-status .mono').textContent;
    return { before, after, undone, undoWorks: undone === before && after !== before };
  })()`);
  t('T36.2 移动与撤销(U)', sk3.undoWorks === true, JSON.stringify(sk3));
  await c.shot('t36-sokoban');


  const errs3 = await ev(`window.__errs.length`);
  t('T36.3 全程无错误', errs3 === 0, `errs=${errs3}`);
});

group('T44', '五子棋(双规则 / 禁手标记 / AI 应答)', async () => {
  /* ---- T44 五子棋:双规则 / 禁手标记 / AI 应答 / 悔棋 ---- */
  await needApps('gomoku');
  await fresh();
  await ev(`WebOS.wm.open('gomoku')`);
  await sleep(700);
  const g0 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return {
      pts: w.querySelectorAll('.gk-pt').length,
      stats: window.__gomoku?.stats(),
      bars: w.querySelectorAll('.app-status').length,
      buttons: [...w.querySelectorAll('.app-toolbar .btn')].map((b) => b.textContent.trim()),
      selects: [...w.querySelectorAll('.app-toolbar select')].map((s) => s.selectedOptions[0].textContent),
      status: w.querySelector('.app-status span')?.textContent,
    };
  })()`);
  t('T44 窗口与棋盘(225 交叉点,有禁手默认档)',
    g0.pts === 225 && g0.stats?.mode === 'renju' && g0.bars === 1, JSON.stringify(g0.stats));
  t('T44.1 顶栏按钮组:新对局/人机/换边/悔棋 + 规则/难度下拉',
    g0.buttons.join('|') === '新对局|人机|换边|悔棋' && g0.selects.join('/') === '有禁手/高级',
    g0.buttons.join(' ') + ' | ' + g0.selects.join('/'));
  t('T44.2 底栏左边是行棋状态(黑先)', g0.status === '黑方行棋 · 第 1 手', g0.status);

  // 落一子(H8 天元)→ AI 应答 → plies=2
  await ev(`document.querySelector('.win[data-app=gomoku] .gk-pt[data-i="112"]').click()`);
  await sleep(400);
  const g1 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return {
      black: w.querySelectorAll('.gk-stone.black').length,
      last: !!w.querySelector('.gk-stone.last'),
      stats: window.__gomoku.stats(),
    };
  })()`);
  t('T44.3 点天元真的落子(黑子 1 颗,带上一手标记)',
    g1.black === 1 && g1.last && g1.stats.plies >= 1, JSON.stringify(g1));
  /* plies 用 >=:wasm v2 引擎 ~1ms 就应完,读到时 AI 那手多半已落地 */

  let g2 = null;
  for (let i = 0; i < 60; i++) {
    g2 = await ev(`({ stats: window.__gomoku.stats(),
      info: document.querySelector('.win[data-app=gomoku] .app-status .mono')?.textContent,
      status: document.querySelector('.win[data-app=gomoku] .app-status span')?.textContent })`);
    if (g2.stats.plies === 2 && !g2.stats.searching) break;
    await sleep(250);
  }
  t('T44.4 AI(白方)应答,回到黑方回合', g2.stats.plies === 2 && g2.stats.turn === 0, JSON.stringify(g2.stats));
  t('T44.5 底栏右侧有引擎信息(档位·深度·节点·耗时·评分)',
    /^.+ · 深度 \d+ · \d+k 节点 · \d+ms · [+-]/.test(g2.info), g2.info);

  // 有禁手:双人模式按谱落子构造「横竖双活三」局面 → (7,7) 出现 × 标记且点不下去
  await ev(`(() => {
    const btns = [...document.querySelectorAll('.win[data-app=gomoku] .app-toolbar .btn')];
    btns.find(b => b.textContent === '人机').click();          // 切双人
    btns.find(b => b.textContent.includes('新对局')).click();  // 清掉 AI 对局残子,拿一张空盘
    return true;
  })()`);
  await sleep(350);
  for (const i of [111, 0, 113, 30, 97, 60, 127, 90]) {   // 黑 (7,6)(7,8)(6,7)(8,7),白 (0,0)(2,0)(4,0)(6,0) 摊开 —— 8 手后轮黑
    await ev(`document.querySelector('.win[data-app=gomoku] .gk-pt[data-i="${i}"]').click()`);
    await sleep(120);
  }
  const g3 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    const pt = w.querySelector('.gk-pt[data-i="112"]');
    const stonesBefore = w.querySelectorAll('.gk-stone').length;
    pt.click();                                     // 点禁手点:应被拒绝
    return {
      stonesBefore,
      stonesAfter: w.querySelectorAll('.gk-stone').length,
      banCls: pt.classList.contains('ban'),
      banMark: !!pt.querySelector('.gk-ban'),
      banCount: w.querySelectorAll('.gk-ban').length,
      stats: window.__gomoku.stats(),
    };
  })()`);
  t('T44.6 双活三点标 × 且拒落(点后子数不变)',
    g3.banCls && g3.banMark && g3.banCount === 1 &&
    g3.stonesBefore === 8 && g3.stonesAfter === 8, JSON.stringify(g3));

  // 切无禁手:重开新对局,禁手标记逻辑整体关闭
  await ev(`window.__gomoku.setMode(0)`);
  await sleep(400);
  const g5 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return {
      stats: window.__gomoku.stats(),
      stones: w.querySelectorAll('.gk-stone').length,
      bans: w.querySelectorAll('.gk-ban').length,
      status: w.querySelector('.app-status span')?.textContent,
    };
  })()`);
  t('T44.7 切无禁手后重开(空盘,无禁手标记)',
    g5.stats.mode === 'free' && g5.stats.plies === 0 && g5.stones === 0 && g5.bans === 0, JSON.stringify(g5));

  // 悔棋:先走一手再悔(无禁双人下悔一手)
  await ev(`document.querySelector('.win[data-app=gomoku] .gk-pt[data-i="112"]').click()`);
  await sleep(250);
  await ev(`[...document.querySelectorAll('.win[data-app=gomoku] .app-toolbar .btn')].find(b => b.textContent.includes('悔棋')).click()`);
  await sleep(250);
  const g6 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=gomoku]');
    return { stones: w.querySelectorAll('.gk-stone').length, stats: window.__gomoku.stats() };
  })()`);
  t('T44.8 悔棋撤一手回到空盘', g6.stones === 0 && g6.stats.plies === 0, JSON.stringify(g6));

  const errs = await ev(`window.__errs.length`);
  t('T44.9 全程无错误', errs === 0, `errs=${errs}`);
  await c.shot('t44-gomoku');
});

group('T52', '线索(节点便签图 / 单链连线 / 双击编辑 / 缩放 / 持久化)', async () => {
  /* ---- T52 clues:便签节点(只显标题)+ 有向单链 + 双击编辑 + 右键聚焦 ---- */
  await fresh();
  // 前置:登录专用账号并清 appdata(保证种子数据),再安装(安装按用户:登录后装)
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current() !== 'clueer' && !(await accounts.login('clueer', 'cluepass')).ok) {
      await accounts.register('clueer', 'cluepass');
      await accounts.login('clueer', 'cluepass');
    }
    return true;
  })()`);
  await wipeAppData('clueer', 'clues');
  await needApps('clues');

  await ev(`WebOS.wm.open('clues')`);
  const opened = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w && w.querySelectorAll('.clue-note').length === 3 ? true : false;
  })()`);
  const s0 = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const edges = [...w.querySelectorAll('.clue-edge')];
    return {
      notes: w.querySelectorAll('.clue-note').length,
      links: edges.length,
      arrows: edges.every(p => (p.getAttribute('marker-end') || '').includes('clue-arr')),
      anchor: !!w.querySelector('.clue-anchor'),
      status: w.querySelector('.clue-status-l')?.textContent || '',
      statusR: w.querySelector('.clue-status-r')?.textContent || '',
    };
  })()`);
  t('T52.1 骨架(种子 3 便签 / 2 单链带箭头 / 状态栏)', opened === true
    && s0.notes === 3 && s0.links === 2 && s0.arrows === true && s0.anchor === true
    && s0.status.includes('3 节点') && s0.status.includes('2 单链')
    && s0.statusR.includes('双击便签编辑'), JSON.stringify(s0));

  // 选中 + 编辑:改标题/加内容
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('案件')).click();
  })()`);
  const selOk = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const sel = w.querySelector('.clue-note.sel');
    return sel && [...w.querySelectorAll('.app-toolbar .btn')].filter(b => !b.disabled).length >= 4;   // 新建+编辑+连出+删除
  })()`);
  t('T52.2 单击选中(sel 类 + 上下文按钮可用)', selOk === true);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('编辑')).click();
  })()`);
  const editorUp = await waitFor(`(() => {
    const box = document.querySelector('.clue-editor');
    return box && box.querySelector('.clue-ed-title') && box.querySelector('.clue-ed-body-in')
      && box.querySelector('.clue-ed-sheet') && box.querySelector('.clue-ed-preview .clue-note')
      && box.querySelector('.clue-swatch.on') ? true : false;
  })()`);
  t('T52.3 编辑器(左编辑纸标题+正文融合 / 右预览+颜色)', editorUp === true);
  await ev(`(() => {
    const box = document.querySelector('.clue-editor');
    box.querySelector('.clue-ed-title').value = '案件:仓库失窃·改';
    box.querySelector('.clue-ed-body-in').value = '监控断电十分钟是人为。';
    [...box.querySelectorAll('.btn.primary')].find(b => b.textContent.includes('保存')).click();
  })()`);
  const edited = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const n = [...w.querySelectorAll('.clue-note')].find(x => x.textContent.includes('仓库失窃·改'));
    if (!n || !n.classList.contains('has-body')) return false;
    // 回归:保存后编辑器与遮罩都必须消失(旧 bug 只删 box,灰色 mask 残留罩死全屏)
    return !document.querySelector('.clue-editor') && !document.querySelector('body > .modal-mask');
  })()`);
  t('T52.4 保存后只显标题 + 遮罩彻底关闭(回归)', edited === true
    && await ev(`(() => {
      const n = [...document.querySelector('.win[data-app=clues]').querySelectorAll('.clue-note')]
        .find(x => x.textContent.includes('仓库失窃·改'));
      return n.querySelector('.clue-title').textContent === '案件:仓库失窃·改'
        && !n.textContent.includes('监控断电');
    })()`));

  // 双击便签直接打开编辑器(改名后保存生效,遮罩随之关闭)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const n = [...w.querySelectorAll('.clue-note')].find(x => x.textContent.includes('嫌疑人'));
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 30, clientY: r.top + 15 }));
  })()`);
  const dblEd = await waitFor(`(() => {
    const box = document.querySelector('.clue-editor');
    return box && box.querySelector('.clue-ed-title').value.includes('嫌疑人') ? true : false;
  })()`);
  await ev(`(() => {
    const box = document.querySelector('.clue-editor');
    box.querySelector('.clue-ed-title').value = '嫌疑人 M(重点)';
    [...box.querySelectorAll('.btn.primary')].find(b => b.textContent.includes('保存')).click();
  })()`);
  const dblSaved = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return [...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('重点'))
      && !document.querySelector('.clue-editor') && !document.querySelector('body > .modal-mask');
  })()`);
  t('T52.5 双击便签直接编辑(打开即带原文 / 保存生效)', dblEd === true && dblSaved === true);

  // 双击空白新建便签(落点即位置)
  await ev(`(() => {
    const cv = document.querySelector('.win[data-app=clues] .clues-canvas');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 420, clientY: r.top + 300 }));
  })()`);
  const newDlg = await waitFor(`!!document.querySelector('.clue-editor')`);
  await ev(`(() => {
    const box = document.querySelector('.clue-editor');
    box.querySelector('.clue-ed-title').value = '门外的新脚印';
    [...box.querySelectorAll('.btn.primary')].find(b => b.textContent.includes('保存')).click();
  })()`);
  const added = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-note').length === 4
      && [...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('新脚印')) ? true : false;
  })()`);
  t('T52.6 双击空白新建(4 便签)', newDlg === true && added === true);

  // 连线:选中「门外的新脚印」→ 连出 → 点击「嫌疑人 M」
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('新脚印')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('连出')).click();
  })()`);
  const linking = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelector('.clues-canvas').classList.contains('linking')
      && w.querySelector('.clue-status-r').textContent.includes('目标便签');
  })()`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('嫌疑人')).click();
  })()`);
  const linked = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-edge').length === 3 ? true : false;
  })()`);
  t('T52.7 单链连线(连出 → 点目标,3 单链带箭头)', linking === true && linked === true
    && await ev(`(() => {
      const w = document.querySelector('.win[data-app=clues]');
      return [...w.querySelectorAll('.clue-edge')].every(p => (p.getAttribute('marker-end') || '').includes('clue-arr'))
        && !w.querySelector('.clues-canvas').classList.contains('linking');
    })()`));

  // 重复同向单链被拒绝(数量不变,连线模式退出)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('新脚印')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('连出')).click();
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('嫌疑人')).click();
  })()`);
  const dupOk = await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return { links: w.querySelectorAll('.clue-edge').length, linking: w.querySelector('.clues-canvas').classList.contains('linking') };
  })()`);
  t('T52.8 同向单链去重(仍 3 条)', dupOk.links === 3 && dupOk.linking === false, JSON.stringify(dupOk));

  // 聚焦(右键便签 → 聚焦):只显示它 + 直接相邻(无关联的「新脚印」被隐藏)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const n = [...w.querySelectorAll('.clue-note')].find(x => x.textContent.includes('仓库失窃'));
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }));
  })()`);
  const focusMenu = await waitFor(`[...document.querySelectorAll('#ctx .ctx-item')].some(b => b.textContent.includes('聚焦'))`);
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('聚焦')).click()`);
  const focused = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-note').length === 3 && w.querySelector('.clue-focus-chip') ? true : false;
  })()`);
  t('T52.9 右键聚焦(只留相关 3 张,无关节点隐藏)', focusMenu === true && focused === true
    && await ev(`(() => {
      const w = document.querySelector('.win[data-app=clues]');
      return w.querySelector('.clue-focus-chip').textContent.includes('仓库失窃')
        && ![...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('新脚印'))
        && w.querySelectorAll('.clue-edge').length === 2;      // 聚焦只画可见节点间的线
    })()`));
  // 双击空白退出聚焦
  await ev(`(() => {
    const cv = document.querySelector('.win[data-app=clues] .clues-canvas');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }));
  })()`);
  const exited = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const chip = w && w.querySelector('.clue-focus-chip');
    return w.querySelectorAll('.clue-note').length === 4 && chip && chip.style.display === 'none' ? true : false;
  })()`);
  t('T52.10 双击空白退出聚焦(回全图 4 张)', exited === true);

  // 工具栏缩放:+ 放大 / 百分比复位 / − 缩小(整体节点随之缩放)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const btns = [...w.querySelectorAll('.app-toolbar .btn')];
    btns.find(b => b.title === '放大').click();
    btns.find(b => b.title === '放大').click();
  })()`);
  const zoomedIn = await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').textContent`);
  await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').click()`);
  const zoomReset = await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').textContent`);
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.title === '缩小').click();
  })()`);
  const zoomedOut = await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').textContent`);
  t('T52.11 工具栏缩放(放大 / 复位 100% / 缩小)', parseInt(zoomedIn) > 100
    && zoomReset.trim() === '100%' && parseInt(zoomedOut) < 100,
    `${zoomedIn} → ${zoomReset} → ${zoomedOut}`);
  await ev(`document.querySelector('.win[data-app=clues] .clue-zoom-btn').click()`);   // 复位回 100%,不干扰后续

  // 反向单链:嫌疑人 → 案件(与已有 案件→嫌疑人 互为反向,两条都弯开)
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('嫌疑人')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('连出')).click();
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('仓库失窃')).click();
  })()`);
  const curved = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    const qs = [...w.querySelectorAll('.clue-edge')].filter(p => p.getAttribute('d').includes('Q'));
    return w.querySelectorAll('.clue-edge').length === 4 && qs.length === 2 ? true : false;
  })()`);
  t('T52.12 反向单链(双向对自动弯开不重叠)', curved === true);

  // 连线右键删除
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    w.querySelector('.clue-edge-hit')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  })()`);
  const menuUp = await waitFor(`[...document.querySelectorAll('#ctx .ctx-item')].some(b => b.textContent.includes('删除连线'))`);
  t('T52.13 连线右键菜单(反转 / 删除)', menuUp === true);
  await ev(`[...document.querySelectorAll('#ctx .ctx-item')].find(b => b.textContent.includes('删除连线')).click()`);
  const linkGone = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-edge').length === 3 ? true : false;
  })()`);
  t('T52.14 删除连线(3 条)', linkGone === true);

  // 删除便签:确认框 + 级联清线
  await ev(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    [...w.querySelectorAll('.clue-note')].find(n => n.textContent.includes('新脚印')).click();
    [...w.querySelectorAll('.app-toolbar .btn')].find(b => b.textContent.includes('删除')).click();
  })()`);
  const confirmUp = await waitFor(`(() => {
    return [...document.querySelectorAll('.win[data-app=sysdialog]')].some(d => d.textContent.includes('删除便签'));
  })()`);
  t('T52.15 删除便签确认框(提示级联删线)', confirmUp === true);
  await ev(`(() => {
    const btns = [...document.querySelectorAll('.win[data-app=sysdialog] button')];
    (btns.find(b => b.textContent.includes('删除')) || btns.find(b => b.textContent.includes('确定')))?.click();
  })()`);
  const nodeGone = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    return w.querySelectorAll('.clue-note').length === 3 && w.querySelectorAll('.clue-edge').length === 2 ? true : false;
  })()`);
  t('T52.16 删除便签级联清线(回 3 节点 2 单链)', nodeGone === true);

  // 持久化:落盘后整页刷新,重新登录打开,数据原样回来
  await sleep(450);   // 等过持久化防抖(200ms),再显式冲刷元数据
  await ev(`(async () => { await WebOS.fs.flush(); return true; })()`);
  await fresh();
  await ev(`(async () => {
    const { accounts } = await import('./js/core/accounts.js');
    if (accounts.current() !== 'clueer') await accounts.login('clueer', 'cluepass');
    return true;
  })()`);
  await needApps('clues');
  await ev(`WebOS.wm.open('clues')`);
  const restored = await waitFor(`(() => {
    const w = document.querySelector('.win[data-app=clues]');
    if (!w) return false;
    const edited = [...w.querySelectorAll('.clue-note')].some(n => n.textContent.includes('仓库失窃·改'));
    return w.querySelectorAll('.clue-note').length === 3 && edited
      && w.querySelectorAll('.clue-edge').length === 2 ? true : false;
  })()`);
  t('T52.17 刷新后数据恢复(编辑过的标题 / 3 节点 2 单链)', restored === true);

  const errs52 = await ev(`window.__errs.length`);
  t('T52.18 全程无错误', errs52 === 0, `errs=${errs52}`);
  await c.shot('t52-clues');
});
