/* ============================================================
 * Audio —— 共享 WebAudio 引擎
 * 主增益与「系统音量」绑定:任何应用播放的声音
 * 都会自动跟随系统设置(这是 IPC 的一个实际受益者)。
 * ============================================================ */

import { settings } from './store.js';
import { subscribe } from './bus.js';

let ctx = null;
let master = null;

export function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.connect(ctx.destination);
    updateGain();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function masterGain() { ensureCtx(); return master; }

function updateGain() {
  if (!master) return;
  const s = settings.get();
  master.gain.setTargetAtTime(s.muted ? 0 : s.volume / 100, ctx.currentTime, 0.02);
}
subscribe('sys:volume-changed', updateGain);

/** 短提示音 */
export function beep(freq = 880, dur = 0.15) {
  const c = ensureCtx();
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.5, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  osc.connect(g);
  g.connect(master);
  osc.start();
  osc.stop(c.currentTime + dur);
  return osc;
}
