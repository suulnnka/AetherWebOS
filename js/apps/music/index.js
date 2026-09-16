/* ============ 应用:音乐播放(WebAudio 合成,音量跟随系统) ============ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import { ensureCtx, masterGain } from '../../core/audio.js';
import { settings } from '../../core/store.js';

/* 音符频率表(Hz) */
const N = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.26, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, G3: 196.0, A3: 220.0, B3: 246.94, F3: 174.61, E3: 164.81, D3: 146.83, C3: 130.81,
};

/* 内置旋律:[音符, 拍数],null 为休止 */
const TRACKS = [
  {
    name: '小星星', bpm: 96, wave: 'triangle',
    notes: [
      ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2],
      ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2],
      ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2],
      ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2],
      ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2],
      ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2],
    ],
  },
  {
    name: '欢乐颂', bpm: 120, wave: 'sine',
    notes: [
      ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1], ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
      ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1], ['E4', 1.5], ['D4', 0.5], ['D4', 2],
      ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1], ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
      ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1], ['D4', 1.5], ['C4', 0.5], ['C4', 2],
    ],
  },
  {
    name: '天空练习曲', bpm: 84, wave: 'sine',
    notes: [
      ['A4', 1], ['C5', 1], ['E5', 1], ['D5', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1], ['C5', 1],
      ['A4', 1], ['G4', 1], ['A4', 1], ['C5', 1], ['C5', 0.5], ['B4', 0.5], ['A4', 1], ['G4', 1],
      ['E4', 1], ['G4', 1], ['A4', 1], ['B4', 1], ['C5', 1.5], ['B4', 0.5], ['A4', 1], ['G4', 2],
      ['A4', 1], ['C5', 1], ['E5', 1], ['G5', 1], ['E5', 1], ['D5', 1], ['C5', 2],
    ],
  },
];

const trackDuration = (t) => t.notes.reduce((s, [, b]) => s + b, 0) * 60 / t.bpm;

register({
  id: 'music',
  neon: { a: '#a855f7', b: '#22d3ee' },  // 霓虹灯条双色(霓虹未来皮肤)
  name: '音乐',
  icon: 'music',
  color: 'linear-gradient(135deg,#8b5cf6,#d946ef)',
  width: 420, height: 480,
  min: { w: 340, h: 420 },
  singleton: true,
  order: 7,
  mount({ root, bus, setTitle }) {
    let idx = 0;
    let playing = false;
    let timer = null;       // 音符调度器
    let stopTimer = null;   // 结束检测
    let startedAt = 0;      // 音频时钟基准
    let startedWall = 0;    // 墙钟基准(无音频设备时 UI 进度仍可走)
    let elapsed = 0;        // 暂停时保存进度
    let liveOsc = [];

    const listBox = el('div', { class: 'music-list' });
    const prog = el('i', { style: { width: '0%' } });
    const timeEl = el('span', { class: 'm-time' }, '0:00');
    const durEl = el('span', { class: 'm-time' }, '0:00');
    const playBtn = el('button', { class: 'play-btn', title: '播放 / 暂停' }, icon('play', 18));
    playBtn.addEventListener('click', () => toggle());
    const trackName = el('span', { style: { fontWeight: 600, fontSize: '13.5px' } }, TRACKS[0].name);

    const track = () => TRACKS[idx];
    const dur = () => trackDuration(track());

    function fmtT(s) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

    function playNote(freq, when, dur) {
      const c = ensureCtx();
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = track().wave;
      osc.frequency.value = freq;
      const vol = 0.32;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vol, when + 0.02);
      g.gain.setValueAtTime(vol, when + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, when + dur * 0.98);
      osc.connect(g);
      g.connect(masterGain());
      osc.start(when);
      osc.stop(when + dur);
      liveOsc.push(osc);
      osc.onended = () => { liveOsc = liveOsc.filter(o => o !== osc); };
    }

    function stopPlayback() {
      playing = false;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      timer = stopTimer = null;
      liveOsc.forEach(o => { try { o.stop(); } catch {} });
      liveOsc = [];
      // 记录已播进度(墙钟,避免无音频设备时 AudioContext 时钟冻结)
      if (startedWall) elapsed = Math.min(dur(), (performance.now() - startedWall) / 1000);
      startedAt = 0;
      startedWall = 0;
      playBtn.innerHTML = '';
      playBtn.append(icon('play', 18));
      renderList();
      tickUI();
    }

    function startPlayback() {
      const c = ensureCtx();
      const t = track();
      if (elapsed >= dur() - 0.05) elapsed = 0;
      const targetBeat = elapsed * t.bpm / 60; // 从哪一拍继续
      let when = c.currentTime + 0.06;
      let i = 0, pos = 0;
      for (; i < t.notes.length; i++) {       // 跳过已过去的音符
        const b = t.notes[i][1];
        if (pos + b > targetBeat) break;
        pos += b;
      }
      startedAt = when - (pos * 60 / t.bpm);
      startedWall = performance.now() - elapsed * 1000;

      playing = true;
      playBtn.innerHTML = '';
      playBtn.append(icon('pause', 18));

      const schedule = () => {
        if (!playing || i >= t.notes.length) return;
        const [note, b] = t.notes[i++];
        const d = b * 60 / t.bpm;
        if (note) playNote(N[note], when, d * 0.95);
        when += d;
        timer = setTimeout(schedule, Math.max(30, (when - c.currentTime - 0.12) * 1000));
      };
      schedule();
      stopTimer = setTimeout(() => { elapsed = 0; switchTrack(1, true); }, (dur() - elapsed) * 1000 + 300);
      renderList();
    }

    /** 切换曲目;auto=true 时无论是否在播放都接着播 */
    function switchTrack(delta, auto = false) {
      const keep = auto || playing;
      stopPlayback();
      elapsed = 0;
      idx = (idx + delta + TRACKS.length) % TRACKS.length;
      renderList();
      updateMeta();
      if (keep) startPlayback();
    }

    const toggle = () => (playing ? stopPlayback() : startPlayback());

    function renderList() {
      listBox.innerHTML = '';
      TRACKS.forEach((t, i) => {
        listBox.append(el('button', {
          class: 'music-item' + (i === idx ? ' playing' : ''),
          onClick: () => { if (i === idx) { toggle(); return; } stopPlayback(); idx = i; elapsed = 0; renderList(); updateMeta(); startPlayback(); },
        },
          icon(i === idx && playing ? 'pause' : 'play', 14),
          t.name,
          el('span', { class: 'mi-dur' }, fmtT(trackDuration(t)))));
      });
    }

    function updateMeta() {
      trackName.textContent = track().name;
      durEl.textContent = fmtT(dur());
      setTitle(`${track().name} — 音乐`);
    }

    function tickUI() {
      const p = (playing && startedWall) ? Math.min(dur(), (performance.now() - startedWall) / 1000) : elapsed;
      prog.style.width = Math.max(0, Math.min(100, p / dur() * 100)) + '%';
      timeEl.textContent = fmtT(Math.max(0, p));
    }
    const uiTimer = setInterval(tickUI, 200);

    // 点击进度条跳转
    const progBar = el('div', { class: 'music-progress', onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const wasPlaying = playing;
      stopPlayback();
      elapsed = ratio * dur();
      if (wasPlaying) startPlayback(); else tickUI();
    } }, prog);

    renderList();
    updateMeta();

    root.append(el('div', { class: 'app' },
      el('div', { class: 'music' },
        el('div', { class: 'app-toolbar' }, trackName, el('span', { class: 'grow' }),
          el('span', { class: 'dim', style: { fontSize: '11.5px' } }, 'WebAudio 合成 · 音量跟随系统')),
        listBox,
        el('div', { class: 'music-ctl' },
          progBar,
          el('div', { class: 'music-row' },
            timeEl,
            el('span', { class: 'grow', style: { display: 'flex', justifyContent: 'center', gap: '10px', alignItems: 'center' } },
              el('button', { class: 'icon-btn', onClick: () => switchTrack(-1), title: '上一首' }, icon('skipBack', 17)),
              playBtn,
              el('button', { class: 'icon-btn', onClick: () => switchTrack(1), title: '下一首' }, icon('skipFwd', 17))),
            durEl)))));

    return {
      onClose() { clearInterval(uiTimer); stopPlayback(); return true; },
    };
  },
});
