/* ============================================================
 * 应用:记忆翻牌(Pairs)
 * 翻两张配对(花色+点数相同),全部配对即胜利;
 * 计步与计时,4x4 / 6x6 两种规模。
 * ============================================================ */
import { el, E2E } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './pairs.css';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const RED = new Set(['♥', '♦']);

register({
  ...manifest,
  /* dialogs 来自 ctx:应用绑定弹框,默认二级(应用模态,只锁本应用) */
  mount({ root, setTitle, bus, dialogs }) {
    let size = 4;            // 4 = 4x4(8 对), 6 = 6x6(18 对)
    let deck = [];           // { suit, rank, matched, id }
    let open = [];           // 当前翻开未配对的索引
    let lock = false;        // 翻错后的等待锁
    let moves = 0, matched = 0, pairs = 8;
    let seconds = 0, timer = null;
    let started = false;

    const board = el('div', { class: 'pairs-board' });
    const timeEl = el('span', { class: 'mono' }, '00:00');
    const movesEl = el('span', { class: 'mono' }, '0');

    function fmt(sec) { return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }

    function startTimer() {
      if (timer) return;
      timer = setInterval(() => { seconds++; timeEl.textContent = fmt(seconds); }, 1000);
    }
    function stopTimer() { clearInterval(timer); timer = null; }

    function deal() {
      pairs = size * size / 2;
      const pool = [];
      for (const s of SUITS) for (const r of RANKS) pool.push({ suit: s, rank: r });
      // 洗牌取 pairs 对
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const chosen = pool.slice(0, pairs);
      deck = [...chosen, ...chosen.map(c => ({ ...c }))];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      deck = deck.map((c, i) => ({ ...c, matched: false, i }));
      open = []; lock = false; moves = 0; matched = 0; seconds = 0; started = false;
      stopTimer();
      timeEl.textContent = '00:00';
      movesEl.textContent = '0';
      render();
    }

    function flip(i) {
      if (lock || deck[i].matched || open.includes(i)) return;
      if (!started) { started = true; startTimer(); }
      open.push(i);
      render();
      if (open.length === 2) {
        moves++;
        movesEl.textContent = String(moves);
        const [a, b] = open;
        if (deck[a].suit === deck[b].suit && deck[a].rank === deck[b].rank) {
          // 配对成功
          deck[a].matched = deck[b].matched = true;
          open = [];
          matched++;
          render();
          if (matched === pairs) {
            stopTimer();
            setTimeout(() => dialogs.success({
              title: '全部配对 🎉',
              message: `${size}×${size} 完成!步数 ${moves},用时 ${fmt(seconds)}。`,
            }), 350);
          }
        } else {
          // 翻错:展示后盖回(测试模式缩短锁定,T35 翻牌遍历因此提速)
          lock = true;
          setTimeout(() => { open = []; lock = false; render(); }, E2E ? 150 : 750);
        }
      }
    }

    function render() {
      board.innerHTML = '';
      board.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
      deck.forEach((card, i) => {
        const faceUp = open.includes(i) || card.matched;
        const cell = el('button', {
          class: 'pairs-card' + (faceUp ? ' up' : '') + (card.matched ? ' matched' : ''),
          onClick: () => flip(i),
        },
          el('span', { class: 'pairs-inner' },
            el('span', { class: 'pairs-back' }, '✦'),
            el('span', { class: 'pairs-face' + (RED.has(card.suit) ? ' red' : '') },
              el('b', {}, card.rank), el('i', {}, card.suit))));
        board.append(cell);
      });
    }

    const sizeSeg = el('div', { class: 'seg' },
      ...[[4, '4×4'], [6, '6×6']].map(([v, name]) => el('button', {
        class: 'seg-btn' + (size === v ? ' active' : ''),
        onClick: (e) => {
          size = v;
          e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
          deal();
        },
      }, name)));

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        sizeSeg,
        el('button', { class: 'btn primary', onClick: () => deal() }, icon('refresh', 13), '重开'),
        el('span', { class: 'grow' }),
        el('span', { class: 'row mono', style: { gap: '10px' } },
          icon('clock', 13), timeEl, icon('check', 13), movesEl)),
      el('div', { class: 'app-body', style: { display: 'grid', placeItems: 'center' } }, board),
      el('div', { class: 'app-status' },
        el('span', {}, `配对 ${matched}/${pairs}`),
        el('span', { class: 'grow' }),
        el('span', {}, '翻开两张相同花色点数的牌'))));

    deal();
  },
});
