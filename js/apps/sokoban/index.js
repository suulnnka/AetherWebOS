/* ============================================================
 * 应用:推箱子(Sokoban)
 * 经典规则:把所有箱子推上目标点;箱子只能推、不能拉;
 * 方向键 / WASD 移动;撤销(U)、重开(R)。
 * 关卡字符含义:# 墙 · @ 玩家 · $ 箱子 · . 目标 · * 箱在目标上 ·
 *              + 玩家在目标上 · 空格 地板
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { dialogs } from '../../core/dialogs.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './sokoban.css';

/* 关卡(经典微型关卡集,由易到难) */
const LEVELS = [
  {
    name: '入门',
    map: [
      '######',
      '#    #',
      '# $. #',
      '# @  #',
      '######',
    ],
  },
  {
    name: '转角',
    map: [
      '#######',
      '#     #',
      '# .$@ #',
      '#  $  #',
      '#  .  #',
      '#######',
    ],
  },
  {
    name: '双箱',
    map: [
      '########',
      '#      #',
      '# .$ . #',
      '#  @$  #',
      '#      #',
      '########',
    ],
  },
  {
    name: '走廊',
    map: [
      '########',
      '#.  #  #',
      '# $ @ $#',
      '#   # .#',
      '########',
    ],
  },
  {
    name: '四箱',
    map: [
      '#########',
      '#   #   #',
      '# $ . $ #',
      '#  ...  #',
      '# $ @   #',
      '#   #   #',
      '#########',
    ],
  },
  {
    name: '经典 Microban #1',
    map: [
      '######',
      '#    #',
      '# #@ #',
      '# $* #',
      '# .* #',
      '#    #',
      '######',
    ],
  },
];

function parseLevel(lv) {
  const rows = lv.map((r) => r.split(''));
  const walls = new Set();
  const goals = new Set();
  const boxes = new Set();
  let player = null;
  rows.forEach((row, r) => row.forEach((ch, c) => {
    const k = `${r},${c}`;
    if (ch === '#') walls.add(k);
    if (ch === '.' || ch === '*' || ch === '+') goals.add(k);
    if (ch === '$' || ch === '*') boxes.add(k);
    if (ch === '@' || ch === '+') player = { r, c };
  }));
  return { walls, goals, boxes, player, rows: rows.length, cols: Math.max(...rows.map(r => r.length)) };
}

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let levelIdx = 0;
    let level = null;
    let undoStack = [];
    let steps = 0, pushes = 0;

    const levelSel = el('select', { class: 'select', title: '选择关卡' });
    const statusL = el('span', {}, '');
    const statusR = el('span', { class: 'mono' }, '');
    const board = el('div', { class: 'soko-board' });

    const key = (r, c) => `${r},${c}`;

    function loadLevel(idx) {
      levelIdx = idx;
      levelSel.value = String(idx);
      level = parseLevel(LEVELS[idx].map);
      undoStack = [];
      steps = 0; pushes = 0;
      render();
      updateStatus('方向键 / WASD 移动');
    }

    function updateStatus(msg) {
      const total = level.goals.size;
      const done = [...level.goals].filter(k => level.boxes.has(k)).length;
      statusL.textContent = msg || `第 ${levelIdx + 1} 关 · ${LEVELS[levelIdx].name}`;
      statusR.textContent = `箱子 ${done}/${total} · 步 ${steps} · 推 ${pushes}`;
      setTitle(`推箱子 ${done}/${total}`);
      if (done === total && !board.dataset.won) {
        board.dataset.won = '1';
        dialogs.success({ title: '过关 🎉', message: `${LEVELS[levelIdx].name}完成!步数 ${steps},推动 ${pushes} 次。` });
        if (levelIdx < LEVELS.length - 1) setTimeout(() => loadLevel(levelIdx + 1), 1400);
      }
      if (done !== total) delete board.dataset.won;
    }

    function tryMove(dr, dc) {
      const { r, c } = level.player;
      const nr = r + dr, nc = c + dc;
      const nk = key(nr, nc);
      if (level.walls.has(nk)) return;
      if (level.boxes.has(nk)) {
        // 推箱子:箱子目标格必须空且非墙
        const br = nr + dr, bc = nc + dc;
        const bk = key(br, bc);
        if (level.walls.has(bk) || level.boxes.has(bk)) return;
        undoStack.push({ player: { ...level.player }, box: { from: nk, to: bk }, steps, pushes });
        level.boxes.delete(nk);
        level.boxes.add(bk);
        level.player = { r: nr, c: nc };
        pushes++;
      } else {
        undoStack.push({ player: { ...level.player } });
        level.player = { r: nr, c: nc };
      }
      steps++;
      render();
      updateStatus();
    }

    function undo() {
      const s = undoStack.pop();
      if (!s) return;
      level.player = s.player;
      if (s.box) {
        level.boxes.delete(s.box.to);
        level.boxes.add(s.box.from);
        pushes--;
      }
      steps--;
      render();
      updateStatus('已撤销');
    }

    function render() {
      board.innerHTML = '';
      const { rows, cols } = level;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const k = key(r, c);
          const isWall = level.walls.has(k);
          const isGoal = level.goals.has(k);
          const hasBox = level.boxes.has(k);
          const isPlayer = level.player.r === r && level.player.c === c;
          const cls = ['soko-cell'];
          if (isWall) cls.push('wall');
          if (isGoal) cls.push('goal');
          let content = '';
          if (isPlayer) { cls.push('player'); content = '🙂'; }
          else if (hasBox) {
            cls.push('box');
            if (isGoal) { cls.push('on-goal'); content = '📦'; }
            else content = '📦';
          } else if (isGoal) content = '✅';
          else if (!isWall) content = ' ';
          const cell = el('div', { class: cls.join(' ') }, content);
          board.append(cell);
        }
      }
    }

    /* 键盘 */
    const KEYS = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1],
      W: [-1, 0], S: [1, 0], A: [0, -1], D: [0, 1],
    };
    const keyHandler = (e) => {
      // 仅当推箱子窗口是活动窗口时响应
      const w = document.querySelector('.win[data-app=sokoban]');
      if (!w || !w.classList.contains('focused')) return;
      if (KEYS[e.key]) { e.preventDefault(); tryMove(...KEYS[e.key]); }
      else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undo(); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); loadLevel(levelIdx); }
    };
    document.addEventListener('keydown', keyHandler);

    /* 工具栏 */
    levelSel.append(...LEVELS.map((lv, i) => el('option', { value: String(i) }, `${i + 1}. ${lv.name}`)));
    levelSel.addEventListener('change', () => loadLevel(+levelSel.value));

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        levelSel,
        el('button', { class: 'btn', onClick: () => undo(), title: '撤销(U)' }, '↩ 撤销'),
        el('button', { class: 'btn', onClick: () => loadLevel(levelIdx), title: '重开(R)' }, icon('refresh', 13), '重开'),
        el('span', { class: 'grow' }),
        el('span', { class: 'dim', style: { fontSize: '12px' } }, '方向键/WASD · U 撤销 · R 重开')),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, board),
      el('div', { class: 'app-status' }, statusL, el('span', { class: 'grow' }), statusR)));

    loadLevel(0);
    return {
      onClose() { document.removeEventListener('keydown', keyHandler); return true; },
    };
  },
});
