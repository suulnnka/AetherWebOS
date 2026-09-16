/* ============ 应用:计算器(手写表达式解析,无 eval) ============ */
import { el } from '../core/utils.js';
import { register } from '../core/registry.js';

/** 词法分析 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j;
    } else if ('+-*/%()'.includes(c)) {
      tokens.push({ t: c });
      i++;
    } else {
      throw new Error(`无法识别的字符 "${c}"`);
    }
  }
  return tokens;
}

/** 中缀 → 逆波兰(调度场算法) */
function toRPN(tokens) {
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, u: 3 };
  const out = [], ops = [];
  let prev = null;
  for (const tk of tokens) {
    if (tk.t === 'num') { out.push(tk); }
    else if (tk.t === '(') { ops.push(tk); }
    else if (tk.t === ')') {
      while (ops.length && ops.at(-1).t !== '(') out.push(ops.pop());
      if (!ops.length) throw new Error('括号不匹配');
      ops.pop();
    } else {
      // 一元负号:出现在表达式开头或左括号/运算符之后
      const unary = tk.t === '-' && (prev === null || prev.t === '(' || prec[prev.t]);
      if (unary) { ops.push({ t: 'u' }); }
      else {
        while (ops.length && ops.at(-1).t !== '(' && prec[ops.at(-1).t] >= prec[tk.t]) out.push(ops.pop());
        ops.push(tk);
      }
    }
    prev = tk;
  }
  while (ops.length) {
    const op = ops.pop();
    if (op.t === '(') throw new Error('括号不匹配');
    out.push(op);
  }
  return out;
}

/** 求值逆波兰 */
function evalRPN(rpn) {
  const st = [];
  for (const tk of rpn) {
    if (tk.t === 'num') { st.push(tk.v); continue; }
    if (tk.t === 'u') {
      const a = st.pop();
      if (a === undefined) throw new Error('表达式不完整');
      st.push(-a);
      continue;
    }
    const b = st.pop(), a = st.pop();
    if (a === undefined || b === undefined) throw new Error('表达式不完整');
    st.push(tk.t === '+' ? a + b : tk.t === '-' ? a - b : tk.t === '*' ? a * b : tk.t === '%' ? a % b : a / b);
  }
  if (st.length !== 1) throw new Error('表达式不完整');
  return st[0];
}

const evaluate = (src) => evalRPN(toRPN(tokenize(src)));

register({
  id: 'calc',
  neon: { a: '#38bdf8', b: '#818cf8' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '计算器',
  icon: 'calc',
  color: 'linear-gradient(135deg,#0ea5e9,#2563eb)',
  width: 320, height: 460,
  min: { w: 260, h: 380 },
  singleton: true,
  order: 4,
  mount({ root }) {
    let expr = '';      // 当前表达式
    let result = '0';   // 当前结果

    const exprEl = el('div', { class: 'calc-expr' }, '');
    const mainEl = el('div', { class: 'calc-main' }, '0');

    function fmt(n) {
      if (!isFinite(n)) return '错误';
      const s = Math.abs(n) >= 1e12 || (Math.abs(n) < 1e-9 && n !== 0) ? n.toExponential(6) : String(Math.round(n * 1e10) / 1e10);
      return s;
    }

    function refresh() {
      exprEl.textContent = expr || '';
      mainEl.textContent = result;
    }

    function press(k) {
      if (k === 'C') { expr = ''; result = '0'; }
      else if (k === '⌫') { expr = expr.slice(0, -1); }
      else if (k === '=') {
        if (!expr) return;
        try { result = fmt(evaluate(expr)); expr = ''; }
        catch (e) { result = e.message; expr = ''; }
      } else {
        expr += k;
        // 实时预览
        try {
          const v = evaluate(expr);
          if (isFinite(v)) result = fmt(v);
        } catch { /* 输入未完成时忽略 */ }
      }
      refresh();
    }

    const KEYS = [
      ['C', 'fn'], ['⌫', 'fn'], ['(', 'fn'], [')', 'fn'],
      ['7', ''], ['8', ''], ['9', ''], ['÷', 'op'],
      ['4', ''], ['5', ''], ['6', ''], ['×', 'op'],
      ['1', ''], ['2', ''], ['3', ''], ['−', 'op'],
      ['%', 'op'], ['0', ''], ['.', ''], ['+', 'op'],
    ];
    // 显示符号 → 表达式符号
    const MAP = { '÷': '/', '×': '*', '−': '-' };

    const keys = el('div', { class: 'calc-keys' },
      ...KEYS.map(([k, cls]) => el('button', {
        class: 'ckey ' + cls,
        onClick: () => press(MAP[k] || k),
      }, k)),
      el('button', { class: 'ckey eq', style: { gridColumn: '1 / -1', minHeight: '44px' }, onClick: () => press('=') }, '='));

    // 键盘支持(窗口内按键)
    root.tabIndex = 0;
    root.style.outline = 'none';
    root.addEventListener('keydown', (e) => {
      const k = e.key;
      if (/^[0-9.+\-*/%()]$/.test(k)) { press(k); e.preventDefault(); }
      else if (k === 'Enter' || k === '=') { press('='); e.preventDefault(); }
      else if (k === 'Backspace') { press('⌫'); e.preventDefault(); }
      else if (k === 'Escape') { press('C'); e.preventDefault(); }
    });
    root.addEventListener('pointerdown', () => root.focus());

    root.append(el('div', { class: 'app' },
      el('div', { class: 'calc' },
        el('div', { class: 'calc-screen' }, exprEl, mainEl),
        keys)));

    setTimeout(() => root.focus(), 60);
    refresh();
  },
});
