/* ============================================================
 * 2D 棋子:classic 赛用造型(参照 Wikimedia 的经典 Cburnett 一套,
 * Wikipedia / lichess 默认棋子同源)。
 * - 白子:象牙底 + 深色描边,浅格深格上都有清晰轮廓;
 * - 黑子:近黑剪影 + 浅色细节线(城垛刻线 / 主教十字 / 马眼鼻孔 / 王冠十字),
 *   深色格上靠剪影、细节线保辨识。
 * 之前用 Unicode 字形:观感随系统字体漂移,实心字形在浅格上糊、空心字形太细,已弃用。
 * ============================================================ */

const W = { fill: '#f9f6ee', line: '#2b241c', detail: '#2b241c' };
const B = { fill: '#26231f', line: '#26231f', detail: '#e9e2d0' };

const PIECES = {
  p: (c) => `<g fill="${c.fill}" stroke="${c.line}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z"/>
    <path d="M12.5 37h20v3h-20z"/><path d="M11 40h23v2.5H11z"/>
  </g>`,
  r: (c) => `<g fill="${c.fill}" stroke="${c.line}" stroke-width="1.5" stroke-linejoin="round">
    <path d="M9 39h27v-3H9zM12 36v-4h21v4zM11 14V9h4v2h5V9h5v2h5V9h4v5" stroke-linecap="butt"/>
    <path d="M34 14l-3 3H14l-3-3"/>
    <path d="M31 17v12.5H14V17" stroke-linecap="butt" stroke-linejoin="miter"/>
    <path d="M31 29.5l1.5 2.5h-20l1.5-2.5"/>
    <path d="M11 14h23" fill="none" stroke="${c.detail}" stroke-linejoin="miter"/>
  </g>`,
  n: (c) => `<g fill="${c.fill}" stroke="${c.line}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21z"/>
    <path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3z"/>
    <path d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0z" fill="${c.detail}" stroke="${c.detail}"/>
    <path d="M14.933 15.75a.5 1.5 30 1 1-.866-.5.5 1.5 30 1 1 .866.5z" fill="${c.detail}" stroke="${c.detail}"/>
  </g>`,
  b: (c) => `<g fill="${c.fill}" stroke="${c.line}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.94 3-2 3-2z"/>
    <path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/>
    <path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/>
    <path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" fill="none" stroke="${c.detail}"/>
  </g>`,
  q: (c) => `<g fill="${c.fill}" stroke="${c.line}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zm16.5-4.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM41 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM16 8.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM33 9a2 2 0 1 1-4 0 2 2 0 1 1 4 0z"/>
    <path d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5 9 26z" stroke-linecap="butt"/>
    <path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z"/>
  </g>`,
  k: (c) => `<g fill="none" stroke="${c.line}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22.5 11.63V6M20 8h5" stroke-linejoin="miter"/>
    <path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5z" fill="${c.fill}"/>
    <path d="M12.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-2.5-7.5-12-10.5-16-4-3 6 6 10.5 6 10.5v7" fill="${c.fill}"/>
    ${c.detail !== c.line ? `<path d="M22.5 11.63V6M20 8h5M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5z" fill="none" stroke="${c.detail}"/>` : ''}
  </g>`,
};

/** 某棋子的 2D SVG 标记(t ∈ 'pnbrqk',color 为 'w'/'b') */
export function piece2d(t, color) {
  const mk = PIECES[t] || PIECES.p;
  return `<svg viewBox="0 0 45 45" aria-hidden="true">${mk(color === 'b' ? B : W)}</svg>`;
}
