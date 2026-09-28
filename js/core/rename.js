/* ============================================================
 * 就地重命名(Mac Finder 式)
 *
 * 在原标签位置盖一个临时输入框:回车或点击别处提交,Esc 取消,
 * 初始预选主名(不含扩展名),输入即像 Finder 一样只替换主名。
 * 输入框挂在 document.body(position: fixed)而非标签内部 ——
 * 桌面图标与文件管家条目都是 <button>,嵌套输入框属于非法的
 * 交互内容嵌套,覆盖式放置可完全绕开。
 * ============================================================ */
import { el, clamp } from './utils.js';

/**
 * @param anchor          被编辑的标签(取视口矩形与字体)
 * @param value           初始值(调用方决定给真实名还是显示名)
 * @param onCommit(next)  回车/失焦提交时回调;Esc 取消不回调
 */
export function inplaceRename(anchor, value, onCommit) {
  const r = anchor.getBoundingClientRect();
  const cs = getComputedStyle(anchor);
  const input = el('input', { class: 'rename-input', spellcheck: 'false' });
  input.value = value;
  Object.assign(input.style, {
    fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
    textAlign: cs.textAlign,
  });
  document.body.append(input);

  // 水平以标签为中心放宽,竖直与标签居中对齐,均不出视口
  const w = clamp(Math.max(r.width + 24, 110), 110, innerWidth - 16);
  const h = input.offsetHeight;
  input.style.width = w + 'px';
  input.style.left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8) + 'px';
  input.style.top = clamp(r.top + r.height / 2 - h / 2, 8, innerHeight - h - 8) + 'px';

  input.focus();
  const dot = value.lastIndexOf('.');   // 预选主名,保留扩展名(Finder 式)
  input.setSelectionRange(0, dot > 0 ? dot : value.length);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    input.remove();
    if (commit && next) onCommit(next);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;   // IME 组字中的回车是确认候选,不是提交
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));   // 点击别处 = 提交(macOS 行为)
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
}
