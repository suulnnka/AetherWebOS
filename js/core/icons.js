/* ============ 内联 SVG 图标库(线性风格) ============ */

import { settings } from './store.js';

const I = {
  // 系统与通用
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  minus: '<path d="M5 12h14"/>',
  max: '<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/>',
  restore: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  chevronL: '<path d="m15 18-6-6 6-6"/>',
  chevronR: '<path d="m9 18 6-6-6-6"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',

  // 音量
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  volume1: '<path d="M11 5 6 9H2v6h4l5 4z"/>',
  volume2: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  volumeX: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',

  // 应用
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 11h.01"/><path d="M12 11h.01"/><path d="M16 11h.01"/><path d="M8 15h.01"/><path d="M12 15h.01"/><path d="M16 15h.01"/><path d="M8 19h.01"/><path d="M12 19h.01"/><path d="M16 19h.01"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  hardDrive: '<line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
  pause: '<rect x="5" y="4" width="5" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="5" height="16" rx="1" fill="currentColor" stroke="none"/>',
  skipBack: '<polygon points="19 20 9 12 19 4 19 20" fill="currentColor" stroke="none"/><path d="M5 19V5" stroke-width="2.4"/>',
  skipFwd: '<polygon points="5 4 15 12 5 20 5 4" fill="currentColor" stroke="none"/><path d="M19 5v14" stroke-width="2.4"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  arrowUp: '<path d="m12 19V5"/><path d="m5 12 7-7 7 7"/>',
  folderPlus: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  filePlus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6"/><path d="M9 15h6"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  map: '<path d="m9 3-6 2v16l6-2 6 2 6-2V3l-6 2-6-2z"/><path d="M9 3v16"/><path d="M15 5v16"/>',
  mapPin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  film: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3z"/>',
  alertTriangle: '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  helpCircle: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  textCursor: '<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 0-4-4H7"/><path d="M7 22h1a4 4 0 0 0 4-4v-1"/>',
};

/* ============ 像素图标(Win31/98 复古皮肤专用) ============ */
/* 手绘 16×16 像素画:黑描边 + 经典配色,shape-rendering 保证硬边。
 * 字符画一行一个 16 像素,'.' 为透明,其他字母查 PAL 调色板。 */

const PAL = {
  K: '#000000', W: '#ffffff', S: '#c0c0c0', G: '#808080', D: '#404040',
  Y: '#ffdf6e', y: '#c69a2e', B: '#2f6fe0', b: '#8fbaff', n: '#123c8c',
  E: '#3fae5a', e: '#9ce8af', R: '#e04848', r: '#ff9a9a', O: '#f09a38',
  o: '#c26a18', T: '#00a894', P: '#9a5cd8', p: '#d0a8f0', N: '#102a4e', C: '#58c8e8',
};

/** 字符画 → 合并横排 run 后的 <rect> 串 */
function pix(rows) {
  const out = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < Math.min(row.length, 16)) {
      const ch = row[x];
      if (ch === '.' || !PAL[ch]) { x++; continue; }
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      out.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${PAL[ch]}"/>`);
      x += run;
    }
  });
  return out.join('');
}

const PIX = {
  folder: pix([
    '..KKKKK.........',
    '.KyyyyyK........',
    '.KyYYYyKKKKKKK..',
    '.KYWWYYYYYYYYK..',
    '.KYWYYYYYYYYYK..',
    '.KYWYYYYYYYYYK..',
    '.KYWYYYYYYYYYK..',
    '.KYWYYYYYYYYYK..',
    '.KYWYYYYYYYYYK..',
    '.KYWYYYYYYYYYK..',
    '.KyyYYYYYYYYYK..',
    '.KyyyYYYYYYYYK..',
    '.KKKKKKKKKKKKK..',
  ]),
  folderOpen: pix([
    '..KKKKK.........',
    '.KyyyyyK........',
    '.KyYYYyKKKKKK...',
    '.KyYYYYYYYYYK...',
    '.KyKWWWWWWWWK...',
    '.KyKWWWWWWWWKK..',
    '.KyKWWWWWWWWWK..',
    '.KyKWWWWWWWWKK..',
    '.KyKWWWWWWWWK...',
    '.KyKKKKKKKKKK...',
    '.KyYYYYYYYYYK...',
    '.KKKKKKKKKKK....',
  ]),
  file: pix([
    '.KKKKKKKKK......',
    '.KWWWWWWWKK.....',
    '.KWWWWWWWKWK....',
    '.KWWWWWWWKKKK...',
    '.KWWWWWWWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KKKKKKKKKKKK...',
  ]),
  fileText: pix([
    '.KKKKKKKKK......',
    '.KWWWWWWWKK.....',
    '.KWWWWWWWKWK....',
    '.KWWWWWWWKKKK...',
    '.KWWWWWWWWWWK...',
    '.KWGGGGGGWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWGGGGGWWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWGGGGGGWWWK...',
    '.KWWWWWWWWWWK...',
    '.KWGGGWWWWWWK...',
    '.KKKKKKKKKKKK...',
  ]),
  globe: pix([
    '...KKKKKKKKKK...',
    '..KbbBBBBBBBBK..',
    '.KbBBBbbbBBBBBK.',
    '.KBBBBBBBBBbBBK.',
    'KBBBbBBBBBBBBBBK',
    'KBBBBBBBbbbBBBBK',
    'KBbbbBBBBBBBBBBK',
    'KBBBBBBBbBBBBBBK',
    'KBBBbbbBBBBBbBBK',
    '.KBBBBBBBBBBBBK.',
    '.KBbBBBBBbbbBBK.',
    '..KBBBBBBBBBBK..',
    '...KKKKKKKKKK...',
  ]),
  image: pix([
    '.KKKKKKKKKKKKK.',
    '.KWWWWWWWWWWWK.',
    '.KWBBBBBBBBBWK.',
    '.KWBBBYYYBBBWK.',
    '.KWBBBBBBBBBWK.',
    '.KWEEEEEBBBBWK.',
    '.KWEEEEEeBBBWK.',
    '.KWEEEEEEEBBWK.',
    '.KWEEEEEEEEEWK.',
    '.KWEEEEEEEEEWK.',
    '.KKKKKKKKKKKKK.',
  ]),
  mail: pix([
    '.KKKKKKKKKKKKK.',
    '.KSSSSSSSSSSSK.',
    '.KSKSSSSSSSKSK.',
    '.KSSKSSSSSKSSK.',
    '.KSSSKSSSKSSSK.',
    '.KSSSSKSKSSSSK.',
    '.KSSSSSSSSSSSK.',
    '.KSSSSSSSSSSSK.',
    '.KKKKKKKKKKKKK.',
  ]),
  message: pix([
    '..KKKKKKKKKK...',
    '.KWWWWWWWWWWK..',
    '.KWWWWWWWWWWK..',
    '.KWWWWWWWWWWK..',
    '.KWWWWWWWWWWK..',
    '.KWWWWWWWWWWK..',
    '.KKKKKKKKKKKK..',
    '.KKK...........',
    '..K............',
  ]),
  music: pix([
    '.........KKKK...',
    '.........KBK....',
    '.........KBK....',
    '.........KBK....',
    '.........KBK....',
    '.........KBK....',
    '.........KBK....',
    '.....KKKKBK.....',
    '....KBBBKK......',
    '...KBBBBK.......',
    '...KKKKK........',
  ]),
  sun: pix([
    '.......KK.......',
    '.......KK.......',
    '.KK...KKKK...KK.',
    '..KK.KYYYYK.KK..',
    '...KKYYYYYYKK...',
    '.KKKYYWYYYYKKK..',
    'KKKYYYYYYYYYKKK.',
    '.KKYYYYYYYYYKK..',
    '...KKYYYYYYKK...',
    '..KK.KYYYYK.KK..',
    '.KK...KKKK...KK.',
    '.......KK.......',
    '.......KK.......',
  ]),
  settings: pix([
    '...KK....KK.....',
    '..KSSKKKKSSK....',
    '.KSSSSSSSSSSK...',
    '.KSSWSSSSSSSK...',
    'KSSSKKKKSSSSSK..',
    'KSSKKKKKKKSSSK..',
    'KSSKKKKKKKSSSK..',
    'KSSSKKKKSSSSSK..',
    '.KSSSSSSSSSSK...',
    '.KSSSSSSSSSSK...',
    '..KSSKKKKSSK....',
    '...KK....KK.....',
  ]),
  terminal: pix([
    '.KKKKKKKKKKKKK..',
    '.KNNNNNNNNNNNK..',
    '.KNNWNNNNNNNNK..',
    '.KNNNWNNNNNNNK..',
    '.KNNWWWWWWWNNK..',
    '.KNNNWNNNNNNNK..',
    '.KNNWNNNWNNNNK..',
    '.KNNNNWWWWNNNK..',
    '.KNNNNNNNNNNNK..',
    '.KKKKKKKKKKKKK..',
  ]),
  calc: pix([
    '.KKKKKKKKKKKK...',
    '.KSSSSSSSSSSK...',
    '.KSWWWWWWWWSK...',
    '.KSWWWWWWWWSK...',
    '.KSSSSSSSSSSK...',
    '.KSKSKSKSKSSK...',
    '.KSSSSSSSSSSK...',
    '.KSKSKSKSKSSK...',
    '.KSSSSSSSSSSK...',
    '.KSKSKSKSKSSK...',
    '.KSSSSSSSSSSK...',
    '.KKKKKKKKKKKK...',
  ]),
  alertTriangle: pix([
    '.......KK.......',
    '.......KK.......',
    '......KYYK......',
    '......KYYK......',
    '.....KYYYYK.....',
    '.....KYKKYK.....',
    '....KYYKKYYK....',
    '....KYYKKYYK....',
    '...KYYYYYYYYK...',
    '...KYYKKKKYYK...',
    '..KYYYKKKKYYYK..',
    '.KYYYYYYYYYYYYK.',
    '.KKKKKKKKKKKKKK.',
  ]),
  star: pix([
    '.......KK.......',
    '......KYYK......',
    '......KYYK......',
    '.....KYYYYK.....',
    '....KYYYYYYK....',
    'KKKKYYYYYYYYKKK.',
    '.KYYYYYYYYYYYYK.',
    '..KYYYYYYYYYYK..',
    '...KYYYYYYYYK...',
    '...KYYYYYYYYK...',
    '..KYYYY..KYYYK..',
    '.KYYYYK...KYYK..',
    '.KKKK.......KK..',
  ]),
  grid: pix([
    '.KKKKK.KKKKK....',
    '.KRRRK.KEEEK....',
    '.KRRRK.KEEEK....',
    '.KRRRK.KEEEK....',
    '.KKKKK.KKKKK....',
    '................',
    '.KKKKK.KKKKK....',
    '.KBBBK.KYYYK....',
    '.KBBBK.KYYYK....',
    '.KBBBK.KYYYK....',
    '.KKKKK.KKKKK....',
  ]),
  circle: pix([
    '...KKKKKKKKKK...',
    '..KWWWWWWWWDDK..',
    '.KWWWWWWWWWWDDK.',
    '.KWWWWWWWWWWDDK.',
    'KWWWWWWWWWWWWDDK',
    'KWWWWWWWWWWWWDDK',
    'KWWWWWWWWWWWWDDK',
    'KWWWWWWWWWWWWDDK',
    '.KWWWWWWWWWWDDK.',
    '.KWWWWWWWWWWDDK.',
    '..KWWWWWWWWDDK..',
    '...KKKKKKKKKK...',
  ]),
  check: pix([
    '...........KKK..',
    '..........KEEEK.',
    '.........KEEEK..',
    '........KEEEK...',
    '.......KEEEK....',
    'K.....KEEEK.....',
    'KK...KEEEK......',
    '.KKKEEEK........',
    '..KKEEEK........',
    '....KKKK........',
  ]),
  activity: pix([
    '..........KK....',
    '.........KRRK...',
    '........KRRK....',
    '.......KRRK.....',
    '......KRRK......',
    '.....KRRK.......',
    '....KRRK........',
    '...KRRK...KK....',
    '.KKRRRRKKKRRKKK.',
    '.KKKKKKKKKKKKK..',
  ]),
  hardDrive: pix([
    '.KKKKKKKKKKKKK.',
    '.KSSSSSSSSSSSK.',
    '.KSSWWWWWWSSSK.',
    '.KSSSSSSSSSSSK.',
    '.KKKKKKKKKKKKK.',
    '.KSSSSSSSSSSSK.',
    '.KSGGGGGGGEBSK.',
    '.KKKKKKKKKKKKK.',
  ]),
  film: pix([
    '.KKKKKKKKKKKKK..',
    '.KDKDKDKDKDKDK..',
    '.KKKKKKKKKKKKK..',
    '.KWWWWWWWWWWWK..',
    '.KWWWWWWWWWWWK..',
    '.KKKKKKKKKKKKK..',
    '.KDKDKDKDKDKDK..',
    '.KKKKKKKKKKKKK..',
  ]),
  download: pix([
    '.......KK.......',
    '.......KBK......',
    '.......KBK......',
    '.......KBK......',
    '......KBBBK.....',
    '.....KBBBBBK....',
    '....KBBBBBBBK...',
    '.......KBK......',
    '.KKKKKKKKKKKKK..',
    '.KSSSSSSSSSSSK..',
    '.KKKKKKKKKKKKK..',
  ]),
  lock: pix([
    '.....KKKKK......',
    '....KSSSSSK.....',
    '....KSKKSSK.....',
    '....KSSSSSK.....',
    '.KKKKKKKKKKKK...',
    '.KGGGGGGGGGGK...',
    '.KGGGGYYGGGGK...',
    '.KGGGGYYGGGGK...',
    '.KGGGGGGGGGGK...',
    '.KKKKKKKKKKKK...',
  ]),
  bell: pix([
    '.......KK.......',
    '......KYYK......',
    '......KYYK......',
    '.....KYYYYK.....',
    '....KYYYYYYK....',
    '....KYYYYYYK....',
    '...KYYYYYYYYK...',
    '...KYYYYYYYYK...',
    '..KYYYYYYYYYYK..',
    '..KKKKKKKKKKKK..',
    '.....KYYYYK.....',
    '......KKKK......',
  ]),
  volume: pix([
    '.........CC.....',
    '....KK.CCCC.....',
    '...KWK.CC.CC....',
    '...KWK.C..CC....',
    '.KKWK.C...CC....',
    'KWWK.C....CC....',
    'KWWSK.....CC....',
    '.KWSK....CC.....',
    '..KKK...CC......',
  ]),
  volume1: null, volume2: null,   // 复用 volume(在下方统一指向)
  volumeX: pix([
    '....KK..........',
    '...KWK.KK.......',
    '.KKWK.KKKK......',
    'KWWK.KK.KK......',
    'KWWSK..KKKK.....',
    'KWWSK.KK.KK.....',
    '.KWSK.KKKKKK....',
    '..KKK...KK......',
  ]),
  search: pix([
    '...KKKK.........',
    '..KSSSSK........',
    '.KSWWSSSK.......',
    '.KSWWSSSK.......',
    '.KSSSSSSK...KK..',
    '..KSSSSK...KK...',
    '...KKKK...KK....',
    '..........KK....',
  ]),
  user: pix([
    '.....KKKKK......',
    '....KSSSSSK.....',
    '....KSSSSSK.....',
    '....KSSSSSK.....',
    '.....KKKKK......',
    '..KKKSSSSSKKK...',
    '.KSSSSSSSSSSSK..',
    '.KSSSSSSSSSSSK..',
    '.KKKKKKKKKKKKK..',
  ]),
  trash: pix([
    '.....KKKKKK.....',
    '..KKKKKKKKKKK...',
    '..KSSSSSSSSSK...',
    '..KSKSKSKSKSK...',
    '..KSKSKSKSKSK...',
    '...KSKSKSKSK....',
    '...KSKSKSKSK....',
    '...KKKKKKKKK....',
  ]),
  home: pix([
    '.......KK.......',
    '......KRRK......',
    '.....KRRRRK.....',
    '....KRRRRRRK....',
    '...KRRRRRRRRK...',
    '..KKKKKKKKKKKK..',
    '..KSSSSSSSSSK...',
    '..KSSKKKKSSSK...',
    '..KSSKKKKSSSK...',
    '..KSSSKKSSSSK...',
    '..KKKKKKKKKKK...',
  ]),
};
PIX.volume1 = PIX.volume;
PIX.volume2 = PIX.volume;

/** 当前风格是否使用像素图标 */
export function pixelMode() {
  return ['win31', 'win98'].includes(settings.get('style'));
}

function pixelSvg(name, size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">${PIX[name]}</svg>`;
}

/** 生成内联 SVG 字符串(复古皮肤下有像素版图标则优先使用) */
export function svg(name, size = 18, sw = 2) {
  if (pixelMode() && PIX[name]) return pixelSvg(name, size);
  const body = I[name] || I.file;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** 生成 DOM 节点形式的图标 */
export function icon(name, size = 18, sw = 2) {
  const t = document.createElement('template');
  t.innerHTML = svg(name, size, sw);
  return t.content.firstChild;
}

/** 应用彩色磁贴图标(桌面 / 开始菜单 / 任务栏通用) */
export function appTile(manifest, size = 48, iconSize) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  paintTile(tile, manifest, 'linear-gradient(135deg,#64748b,#475569)');
  tile.style.width = tile.style.height = size + 'px';
  tile.style.borderRadius = Math.round(size * 0.24) + 'px';
  tile.append(icon(manifest.icon || 'file', iconSize || Math.round(size * 0.52), 2));
  return tile;
}

/** 给磁贴上色:写成 CSS 变量而不是直接设 background,
 *  让各风格皮肤可以重绘图标(如 Win31/98 用 --tile-flat 单色扁平方块) */
export function paintTile(el, manifest, fallback = 'var(--accent)') {
  const bg = manifest?.color || fallback;
  el.style.setProperty('--tile-bg', bg);
  const first = /#[0-9a-f]{3,8}/i.exec(bg);
  const flat = first ? first[0] : bg;
  el.style.setProperty('--tile-flat', flat);
  // 浅色块配深色图形(复古扁平方块时的可读性),深色块维持白色
  el.style.setProperty('--tile-fg', luminance(flat) > 0.5 ? '#10131a' : '#fff');
}

/** 相对亮度(仅处理 6 位 hex;其余返回 0 走白图形) */
function luminance(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
