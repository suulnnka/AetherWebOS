/* ============================================================
 * 应用:扫雷(Minesweeper)
 * 三种难度、右键插旗、双击快开(chord)、计时器、
 * 首次点击保证安全(自动避开雷区)、胜利/失败判定。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { register } from '../../core/registry.js';
import { dialogs } from '../../core/dialogs.js';

const LEVELS = {
  easy: { cols: 9, rows: 9, mines: 10, name: '初级' },
  medium: { cols: 16, rows: 16, mines: 40, name: '中级' },
  hard: { cols: 30, rows: 16, mines: 99, name: '高级' },
};
const NUM_COLORS = ['', '#2563eb', '#15803d', '#dc2626', '#6d28d9', '#b45309', '#0e7490', '#334155', '#7f1d1d'];

register({
  id: 'minesweeper',
  name: '扫雷',
  icon: 'alertTriangle',
  color: 'linear-gradient(135deg,#334155,#0f172a)',
  neon: { a: '#94a3b8', b: '#f43f5e' },
  width: 560, height: 620,
  min: { w: 420, h: 420 },
  singleton: true,
  order: 9,
  mount({ root, setTitle }) {
    let level = 'easy';
    let grid, mines, revealed, flagged, started, dead, won;
    let flags = 0, time = 0, timer = null;

    const faceBtn = el('button', { class: 'ms-face', title: '重新开始' }, '🙂');
    const mineCount = el('span', { class: 'ms-led' }, '010');
    const timeLed = el('span', { class: 'ms-led' }, '000');
    const board = el('div', { class: 'ms-board' });

    const leds = (n) => {
      const v = Math.max(0, Math.min(999, n));
      return String(v).padStart(3, '0');
    };
    const stopTimer = () => { clearInterval(timer); timer = null; };
    const startTimer = () => {
      if (timer) return;
      timer = setInterval(() => {
        time++;
        timeLed.textContent = leds(time);
      }, 1000);
    };

    function reset() {
      const L = LEVELS[level];
      grid = Array.from({ length: L.rows }, () => Array(L.cols).fill(0));   // -1 雷,0-8 数字
      revealed = Array.from({ length: L.rows }, () => Array(L.cols).fill(false));
      flagged = Array.from({ length: L.rows }, () => Array(L.cols).fill(false));
      started = false; dead = false; won = false;
      flags = 0; time = 0;
      stopTimer();
      mineCount.textContent = leds(L.mines);
      timeLed.textContent = '000';
      faceBtn.textContent = '🙂';
      renderBoard();
      setTitle('扫雷');
    }

    function placeMines(safeR, safeC) {
      const L = LEVELS[level];
      let placed = 0;
      while (placed < L.mines) {
        const r = Math.floor(Math.random() * L.rows);
        const c = Math.floor(Math.random() * L.cols);
        if (grid[r][c] === -1) continue;
        if (Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1) continue;   // 首击安全
        grid[r][c] = -1;
        placed++;
      }
      for (let r = 0; r < L.rows; r++) {
        for (let c = 0; c < L.cols; c++) {
          if (grid[r][c] === -1) continue;
          grid[r][c] = neighbors(r, c).filter(([nr, nc]) => grid[nr][nc] === -1).length;
        }
      }
    }

    function neighbors(r, c) {
      const out = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < grid.length && nc >= 0 && nc < grid[0].length) out.push([nr, nc]);
      }
      return out;
    }

    function reveal(r, c) {
      if (revealed[r][c] || flagged[r][c]) return;
      revealed[r][c] = true;
      if (grid[r][c] !== 0) return;
      for (const [nr, nc] of neighbors(r, c)) reveal(nr, nc);
    }

    function checkWin() {
      const L = LEVELS[level];
      let revealedCount = 0;
      for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) if (revealed[r][c]) revealedCount++;
      return revealedCount === L.rows * L.cols - L.mines;
    }

    function clickCell(r, c) {
      if (dead || won || flagged[r][c] || revealed[r][c]) return;
      if (!started) { started = true; placeMines(r, c); startTimer(); }
      if (grid[r][c] === -1) {
        dead = true;
        stopTimer();
        for (let rr = 0; rr < grid.length; rr++) for (let cc = 0; cc < grid[0].length; cc++) if (grid[rr][cc] === -1) revealed[rr][cc] = true;
        faceBtn.textContent = '😵';
        renderBoard();
        dialogs.error({ title: '游戏结束', message: `你踩到雷了!用时 ${time} 秒。`, detail: '点击表情重新开始' });
        return;
      }
      reveal(r, c);
      if (checkWin()) {
        won = true;
        stopTimer();
        faceBtn.textContent = '😎';
        renderBoard();
        dialogs.success({ title: '扫雷胜利 🎉', message: `${LEVELS[level].name}难度通关!用时 ${time} 秒。` });
        return;
      }
      renderBoard();
    }

    function chordCell(r, c) {
      if (dead || won || !revealed[r][c] || grid[r][c] === 0) return;
      const nb = neighbors(r, c);
      const flagCount = nb.filter(([nr, nc]) => flagged[nr][nc]).length;
      if (flagCount !== grid[r][c]) return;
      let boom = false;
      for (const [nr, nc] of nb) {
        if (!flagged[nr][nc] && !revealed[nr][nc]) {
          if (grid[nr][nc] === -1) { boom = true; revealed[nr][nc] = true; }
          else reveal(nr, nc);
        }
      }
      if (boom) {
        dead = true; stopTimer(); faceBtn.textContent = '😵';
        for (let rr = 0; rr < grid.length; rr++) for (let cc = 0; cc < grid[0].length; cc++) if (grid[rr][cc] === -1) revealed[rr][cc] = true;
      } else if (checkWin()) {
        won = true; stopTimer(); faceBtn.textContent = '😎';
        dialogs.success({ title: '扫雷胜利 🎉', message: `${LEVELS[level].name}难度通关!用时 ${time} 秒。` });
      }
      renderBoard();
    }

    function toggleFlag(r, c) {
      if (dead || won || revealed[r][c]) return;
      if (!started) return;   // 首击前不允许插旗(与首击安全配合)
      flagged[r][c] = !flagged[r][c];
      flags += flagged[r][c] ? 1 : -1;
      mineCount.textContent = leds(LEVELS[level].mines - flags);
      renderBoard();
    }

    function renderBoard() {
      board.innerHTML = '';
      board.style.gridTemplateColumns = `repeat(${grid[0].length}, var(--ms-cell, 26px))`;
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[0].length; c++) {
          const cell = el('button', { class: 'ms-cell' + (revealed[r][c] ? ' open' : '') + (flagged[r][c] ? ' flag' : '') });
          if (revealed[r][c]) {
            if (grid[r][c] === -1) { cell.textContent = '💥'; cell.classList.add('mine'); }
            else if (grid[r][c] > 0) {
              cell.textContent = String(grid[r][c]);
              cell.style.color = NUM_COLORS[grid[r][c]];
              cell.style.fontWeight = '700';
            }
          } else if (flagged[r][c]) cell.textContent = '🚩';
          cell.addEventListener('click', () => clickCell(r, c));
          cell.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleFlag(r, c); });
          cell.addEventListener('dblclick', () => chordCell(r, c));
          board.append(cell);
        }
      }
    }

    faceBtn.addEventListener('click', reset);

    const levelSeg = el('div', { class: 'seg' },
      ...Object.entries(LEVELS).map(([id, L]) => el('button', {
        class: 'seg-btn' + (level === id ? ' active' : ''),
        onClick: (e) => {
          level = id;
          e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
          reset();
        },
      }, L.name)));

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' }, levelSeg, el('span', { class: 'grow' })),
      el('div', { class: 'ms-hud' }, mineCount, faceBtn, timeLed),
      el('div', { class: 'app-body ms-body' }, board),
      el('div', { class: 'app-status' },
        el('span', {}, '左键翻开 · 右键插旗 · 双击快开'),
        el('span', { class: 'grow' }),
        el('span', { class: 'mono' }, '首击安全'))));

    reset();
  },
});
