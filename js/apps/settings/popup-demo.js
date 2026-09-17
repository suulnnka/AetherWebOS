/* ============ 弹窗演示:弹窗 ≠ 消息框 ============
 * 配置页(二级)与画布游戏(三级),展示 wm.popup() 承载任意内容:
 *   - 复杂配置页:表单控件 + 可缩放窗口 + Promise 带回结果
 *   - 游戏弹窗:canvas 渲染 + 键鼠输入 + RAF 循环 + onClose 清理
 * ================================================================ */
import { el } from '../../core/utils.js';
import { popup } from '../../core/wm.js';
import { beep } from '../../core/audio.js';

const OWNER = 'settings';   // 二级弹框:锁定的目标应用

/** 复杂配置页弹窗(二级 · 应用模态 · 可缩放)。
 *  Promise 以「保存 → 配置对象 / 取消 → null」兑现。 */
export function openConfigPopup() {
  const state = { quality: 'high', shadow: true, fov: 75, budget: 40 };

  const h = popup({
    title: '渲染高级设置', icon: 'sliders',
    width: 620, height: 460, resizable: true,
    level: 2, owner: OWNER,
    mount({ root, close }) {
      const sel = el('select', { class: 'select' },
        ...['low', 'medium', 'high', 'ultra'].map(v =>
          el('option', { value: v, selected: state.quality === v ? '' : null },
            { low: '低', medium: '中', high: '高', ultra: '极致' }[v])));
      sel.value = state.quality;
      sel.addEventListener('change', () => { state.quality = sel.value; });

      const shadow = el('input', { type: 'checkbox' });
      shadow.checked = state.shadow;
      shadow.addEventListener('change', () => { state.shadow = shadow.checked; });

      const fov = el('input', { type: 'range', min: 60, max: 100, value: state.fov, style: { flex: '1' } });
      const fovVal = el('span', { class: 'mono', style: { width: '34px', textAlign: 'right' } }, state.fov + '°');
      fov.addEventListener('input', () => { state.fov = +fov.value; fovVal.textContent = fov.value + '°'; });

      const budget = el('input', { type: 'range', min: 10, max: 100, value: state.budget, style: { flex: '1' } });
      const budgetVal = el('span', { class: 'mono', style: { width: '34px', textAlign: 'right' } }, state.budget + '%');
      budget.addEventListener('input', () => { state.budget = +budget.value; budgetVal.textContent = budget.value + '%'; });

      const formRow = (label, control) => el('div', { class: 'set-row' },
        el('div', { class: 's-label' }, label), el('div', { class: 'row' }, control));

      root.append(el('div', { class: 'app', style: { padding: '14px 16px', gap: '4px' } },
        el('div', { class: 'dim', style: { fontSize: '12px', marginBottom: '8px' } },
          '这是一个普通的二级弹窗:内容随意复杂,窗口可缩放;锁定期间系统设置的所有窗口均不可操作。'),
        formRow('渲染画质', sel),
        formRow('动态阴影', shadow),
        formRow('视场角', el('div', { class: 'row', style: { flex: '1' } }, fov, fovVal)),
        formRow('性能预算', el('div', { class: 'row', style: { flex: '1' } }, budget, budgetVal)),
        el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: 'auto', paddingTop: '12px' } },
          el('button', { class: 'btn', onClick: () => close(null) }, '取消'),
          el('button', { class: 'btn primary', onClick: () => close({ ...state }) }, '保存配置'))));
    },
  });
  return h.promise;
}

/** 游戏弹窗(三级 · 系统模态 · canvas 渲染)。
 *  「弹球接环」:方向键/鼠标移动挡板,接满 5 颗通关,漏 3 颗失败。
 *  Promise 兑现:true 通关 / false 失败退出 / undefined 直接关闭。 */
export function openGamePopup() {
  const h = popup({
    title: '弹球接环 · 系统锁定中', icon: 'activity',
    width: 460, height: 420, resizable: false,
    level: 3,
    mount({ root, close }) {
      const W = 400, H = 240;
      const cv = el('canvas', { width: W, height: H, style: { width: '100%', borderRadius: '8px', background: '#0b1020', display: 'block' } });
      const hud = el('div', { class: 'mono', style: { fontSize: '12px', display: 'flex', justifyContent: 'space-between', padding: '2px 2px 8px' } });
      const ctx2d = cv.getContext('2d');

      const S = {
        paddle: W / 2, keys: {}, orbs: [], score: 0, lives: 3,
        raf: 0, over: false, t: 0,
      };
      const drawHud = () => {
        hud.textContent = '';
        hud.append(el('span', {}, `得分 ${S.score} / 5`), el('span', {}, '❤'.repeat(S.lives) || '—'));
      };

      const onKey = (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { S.keys[e.key] = e.type === 'keydown'; e.preventDefault(); }
      };
      const onMove = (e) => {
        const r = cv.getBoundingClientRect();
        S.paddle = (e.clientX - r.left) / r.width * W;
      };
      document.addEventListener('keydown', onKey);
      document.addEventListener('keyup', onKey);
      cv.addEventListener('pointermove', onMove);

      const finish = (result) => { S.over = true; cancelAnimationFrame(S.raf); close(result); };

      const loop = () => {
        if (S.over) return;
        S.t++;
        if (S.keys.ArrowLeft) S.paddle -= 6;
        if (S.keys.ArrowRight) S.paddle += 6;
        S.paddle = Math.max(30, Math.min(W - 30, S.paddle));
        if (S.t % 70 === 0) S.orbs.push({ x: 30 + Math.random() * (W - 60), y: -10, v: 1.6 + Math.random() * 1.4, r: 8 });
        for (const o of S.orbs) o.y += o.v;
        for (const o of S.orbs) {
          if (o.y > H - 18 && o.y < H - 2 && Math.abs(o.x - S.paddle) < 34) { o.dead = true; S.score++; beep(660, 0.08); }
          if (o.y > H + 10 && !o.dead) { o.dead = true; S.lives--; beep(180, 0.15); }
        }
        S.orbs = S.orbs.filter(o => !o.dead);
        drawHud();

        ctx2d.clearRect(0, 0, W, H);
        ctx2d.fillStyle = '#0b1020';
        ctx2d.fillRect(0, 0, W, H);
        ctx2d.fillStyle = 'rgba(91,108,255,0.12)';
        for (let y = 0; y < H; y += 24) ctx2d.fillRect(0, y, W, 1);
        for (const o of S.orbs) {
          const g = ctx2d.createRadialGradient(o.x, o.y, 1, o.x, o.y, o.r + 4);
          g.addColorStop(0, '#7dd3fc'); g.addColorStop(1, 'rgba(125,211,252,0)');
          ctx2d.fillStyle = g;
          ctx2d.beginPath(); ctx2d.arc(o.x, o.y, o.r + 4, 0, 7); ctx2d.fill();
        }
        ctx2d.fillStyle = '#5b6cff';
        ctx2d.beginPath(); ctx2d.roundRect(S.paddle - 34, H - 14, 68, 9, 5); ctx2d.fill();

        if (S.score >= 5) return finish(true);
        if (S.lives <= 0) {
          S.over = true;
          ctx2d.fillStyle = '#f87171';
          ctx2d.font = 'bold 22px sans-serif';
          ctx2d.fillText('游戏结束', W / 2 - 54, H / 2);
          return;
        }
        S.raf = requestAnimationFrame(loop);
      };

      const retry = el('button', { class: 'btn', onClick: () => {
        // 原地重开:不关闭弹窗,只重置状态并重启渲染循环
        Object.assign(S, { paddle: W / 2, orbs: [], score: 0, lives: 3, over: false, t: 0 });
        cancelAnimationFrame(S.raf);
        drawHud();
        S.raf = requestAnimationFrame(loop);
      } }, '再来一局');
      const giveup = el('button', { class: 'btn', onClick: () => close(false) }, '放弃并退出');
      root.append(el('div', { class: 'app', style: { padding: '12px 14px', gap: '8px' } },
        hud, cv,
        el('div', { class: 'dim', style: { fontSize: '11.5px' } }, '←/→ 方向键或鼠标移动挡板;这是三级弹窗:关闭它之前,整个系统都被锁定。'),
        el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, retry, giveup)));

      drawHud();
      S.raf = requestAnimationFrame(loop);
      return {
        onClose() {           // 弹窗因任何原因关闭:停掉渲染循环、摘掉全局监听
          S.over = true;
          cancelAnimationFrame(S.raf);
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('keyup', onKey);
        },
      };
    },
  });
  return h.promise;
}
