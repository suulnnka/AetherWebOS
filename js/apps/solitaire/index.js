/* ============================================================
 * 应用:纸牌接龙(Klondike)
 * 标准 KL 规则:7 列 tableau(交替色降序)、4 组 foundation(同花色升序)、
 * 牌堆翻牌到弃牌堆;点击选中 → 点击目标移动;空列只收 K;
 * 双击自动上 foundation;牌堆耗尽可重置翻牌。
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './solitaire.css';
import { dialogs } from '../../core/dialogs.js';

const SUITS = ['♠', '♥', '♦', '♣'];
const RED = new Set(['♥', '♦']);
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const isRed = (s) => RED.has(s);

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 0; r < 13; r++) deck.push({ suit: s, rank: r, up: false });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
   [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let stock = [], waste = [], foundations = [[], [], [], []], tableau = [];
    let sel = null;           // { zone, index, cardIndex }
    let moves = 0, score = 0, won = false;

    const statusL = el('span', {}, '');
    const top = el('div', { class: 'sol-top' });
    const columns = el('div', { class: 'sol-cols' });
    const scoreEl = el('span', { class: 'sol-score mono' }, '分数 0');

    function deal() {
      const deck = newDeck();
      stock = []; waste = []; foundations = [[], [], [], []]; tableau = [];
      for (let i = 0; i < 7; i++) {
        const col = [];
        for (let j = 0; j <= i; j++) {
          const card = deck.pop();
          card.up = j === i;
          col.push(card);
        }
        tableau.push(col);
      }
      stock = deck;
      sel = null; moves = 0; score = 0; won = false;
      render();
    }

    /** 从 cardIndex 起的序列能否整体移到目标列 */
    function canMoveSeq(seq, destCol) {
      if (!seq.length || !seq[0].up) return false;
      if (!destCol.length) return seq[0].rank === 12;   // 空列只收 K
      const top = destCol.at(-1);
      return top.up && isRed(top.suit) !== isRed(seq[0].suit) && seq[0].rank === top.rank - 1;
    }

    function canFound(card, f) {
      if (!f.length) return card.rank === 0;
      const top = f.at(-1);
      return top.suit === card.suit && card.rank === top.rank + 1;
    }

    /** 自动翻 tableau 列尾暗牌 */
    function flipTails() {
      for (const col of tableau) {
        if (col.length && !col.at(-1).up) col.at(-1).up = true;
      }
    }

    function checkWin() {
      const total = foundations.reduce((s, f) => s + f.length, 0);
      if (total === 52) {
        won = true;
        dialogs.success({ title: '接龙胜利 🎉', message: `恭喜通关!步数 ${moves},分数 ${score}。` });
        bus.notify('接龙', '通关!');
      }
      return won;
    }

    /** 双击/点击 foundation 按钮自动上牌 */
    function tryAutoFound(zone, index, cardIndex) {
      const card = peek(zone, index, cardIndex);
      if (!card) return false;
      // 只允许列尾/弃牌堆顶
      if (zone === 'tableau' && cardIndex !== tableau[index].length - 1) return false;
      if (zone === 'stock') return false;
      for (let fi = 0; fi < 4; fi++) {
        if (canFound(card, foundations[fi])) {
          removeCard(zone, index, cardIndex);
          foundations[fi].push(card);
          flipTails();
          moves++; score += 10;
          checkWin();
          render();
          return true;
        }
      }
      return false;
    }

    function peek(zone, index, cardIndex) {
      if (zone === 'waste') return waste.at(-1) ?? null;
      if (zone === 'tableau') return tableau[index][cardIndex] ?? null;
      return null;
    }

    function removeCard(zone, index, cardIndex) {
      if (zone === 'waste') waste.pop();
      else if (zone === 'tableau') tableau[index].splice(cardIndex);
    }

    /** 点击处理:选择 → 移动;或自动上 foundation */
    function onCardClick(zone, index, cardIndex) {
      if (won) return;
      // 已有选中:尝试移动到此处(仅 tableau / foundation 目标)
      if (sel) {
        if (zone === 'tableau') {
          const seq = getSelSeq();
          if (seq && canMoveSeq(seq, tableau[index])) {
            const moving = takeSel();
            tableau[index].push(...moving);
            flipTails();
            moves++; score += 3;
            sel = null;
            checkWin(); render();
            return;
          }
        } else if (zone === 'foundation') {
          // 点 foundation 自动尝试收牌
          if (tryAutoFound(sel.zone, sel.index, sel.cardIndex)) { sel = null; return; }
          sel = null; render(); return;
        }
        // 无效:换选中或取消
        if (sel.zone === zone && sel.index === index && sel.cardIndex === cardIndex) { sel = null; render(); return; }
      }
      if (zone === 'stock') {
        drawStock();
        return;
      }
      if (zone === 'waste' && waste.length) { sel = { zone, index, cardIndex: waste.length - 1 }; render(); return; }
      if (zone === 'tableau') {
        const col = tableau[index];
        const card = col[cardIndex];
        if (card?.up) {
          if (tryAutoFound(zone, index, cardIndex)) { sel = null; return; }
          sel = { zone, index, cardIndex };
        }
      }
      render();
    }

    function getSelSeq() {
      if (!sel) return null;
      if (sel.zone === 'waste') return waste.length ? [waste.at(-1)] : null;
      if (sel.zone === 'tableau') return tableau[sel.index].slice(sel.cardIndex);
      return null;
    }

    function takeSel() {
      if (sel.zone === 'waste') return waste.splice(waste.length - 1);
      return tableau[sel.index].splice(sel.cardIndex);
    }

    function drawStock() {
      if (stock.length) {
        const card = stock.pop();
        card.up = true;
        waste.push(card);
      } else if (waste.length) {
        // 重置:弃牌堆翻回牌堆
        stock = waste.reverse().map(c => ({ ...c, up: false }));
        waste = [];
        score = Math.max(0, score - 20);
      }
      moves++;
      render();
    }

    /* ---------- 渲染 ---------- */
    function cardEl(card, onClick, selected) {
      const cls = 'card' + (card.up ? '' : ' down') + (selected ? ' sel' : '');
      return el('button', { class: cls, onClick },
        card.up ? el('span', { class: 'card-face' + (isRed(card.suit) ? ' red' : '') },
          el('b', {}, RANKS[card.rank]),
          el('i', {}, card.suit)) : el('span', { class: 'card-back' }, '✦'));
    }

    function render() {
      top.innerHTML = '';
      // 牌堆
      top.append(el('button', {
        class: 'card slot' + (stock.length ? ' has' : ''),
        onClick: () => onCardClick('stock'),
        title: '翻牌',
      }, stock.length ? el('span', { class: 'card-back' }, '✦') : el('span', { class: 'slot-mark' }, '↻')));
      // 弃牌堆
      top.append(el('button', { class: 'card slot' + (waste.length ? ' has' : ''), onClick: () => onCardClick('waste', 0, waste.length - 1) },
        waste.length ? cardFace(waste.at(-1)) : el('span', { class: 'slot-mark' }, ' ')));
      top.append(el('div', { style: { flex: 1 } }));
      // 4 个 foundation
      for (let i = 0; i < 4; i++) {
        const f = foundations[i];
        top.append(el('button', {
          class: 'card slot' + (f.length ? ' has' : ''),
          onClick: () => onCardClick('foundation', i),
        }, f.length ? cardFace(f.at(-1)) : el('span', { class: 'slot-mark' }, SUITS[i])));
      }

      // 7 列
      columns.innerHTML = '';
      tableau.forEach((col, ci) => {
        const colEl = el('div', { class: 'sol-col' });
        if (!col.length) {
          colEl.append(el('button', { class: 'card slot', onClick: () => onCardClick('tableau', ci) }, el('span', { class: 'slot-mark' }, 'K')));
        } else {
          col.forEach((card, ri) => {
            const isLast = ri === col.length - 1;
            const inSeq = sel?.zone === 'tableau' && sel.index === ci && ri >= sel.cardIndex;
            colEl.append(el('button', {
              class: 'card tab' + (card.up ? '' : ' down') + (inSeq ? ' sel' : ''),
              style: { top: `${ri * 24}px` },
              onClick: () => onCardClick('tableau', ci, ri),
            }, card.up ? cardFace(card) : el('span', { class: 'card-back' }, '✦')));
          });
        }
        columns.append(colEl);
      });

      scoreEl.textContent = `分数 ${score} · 步数 ${moves}`;
      const total = foundations.reduce((s, f) => s + f.length, 0);
      setTitle(`接龙 — 收齐 ${total}/52`);
      checkWinOnce();
    }

    let winNotified = false;
    function checkWinOnce() {
      const total = foundations.reduce((s, f) => s + f.length, 0);
      if (total === 52 && !winNotified) {
        winNotified = true;
        stopWinWatch = true;
        dialogs.success({ title: '接龙胜利 🎉', message: `恭喜通关!步数 ${moves},分数 ${score}。` });
      }
    }
    let stopWinWatch = false;

    function cardFace(card) {
      return el('span', { class: 'card-face' + (isRed(card.suit) ? ' red' : '') },
        el('b', {}, RANKS[card.rank]),
        el('i', {}, card.suit));
    }

    const newBtn = el('button', { class: 'btn primary', onClick: () => { winNotified = false; deal(); } }, icon('refresh', 13), '新对局');

    root.append(el('div', { class: 'app' },
      el('div', { class: 'app-toolbar' },
        newBtn, scoreEl,
        el('span', { class: 'grow' }),
        el('span', { class: 'dim', style: { fontSize: '12px' } }, '点击选中→点击目标 · 双击自动收牌')),
      top,
      columns,
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', {}, '空列只收 K · 同花色 A 起收牌'))));

    deal();
  },
});
