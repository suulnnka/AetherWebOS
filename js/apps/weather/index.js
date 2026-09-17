/* ============================================================
 * 应用:天气
 * 当前实况 + 24 小时逐时 + 7 日预报 + 历史天气查询
 * (历史查询基于确定性模拟气象引擎,可回溯任意日期)
 * ============================================================ */
import { el } from '../../core/utils.js';
import { icon } from '../../core/icons.js';
import { register } from '../../core/registry.js';
import manifest from './manifest.js';
import './weather.css';
import weather from '../../core/weather.js';

const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

/** 温度迷你条形图(纯 div,无 canvas) */
function tempChart(rows, key = 'temp') {
  const temps = rows.map(r => r[key]);
  const min = Math.min(...temps), max = Math.max(...temps);
  const span = Math.max(1, max - min);
  const box = el('div', { class: 'wx-chart' });
  for (const r of rows) {
    const h = 12 + (r[key] - min) / span * 48;
    box.append(el('div', { class: 'wx-bar', title: `${r.label || r.date}: ${r[key]}°` },
      el('i', { style: { height: h + 'px' } }),
      el('span', { class: 'wx-bar-t' }, String(Math.round(r[key])) + '°')));
  }
  return box;
}

register({
  ...manifest,
  mount({ root, setTitle, bus }) {
    let cityId = 'shanghai';
    let tab = 'now';        // now | days | history

    const side = el('div', { class: 'app-side' });
    const body = el('div', { class: 'app-body wx-body' });
    const statusL = el('span', {}, '');

    function renderSide() {
      side.innerHTML = '';
      side.append(el('div', { class: 'dim', style: { fontSize: '11.5px', padding: '4px 10px 8px' } }, '城市'));
      for (const c of weather.cities()) {
        const cur = weather.current(c.id);
        side.append(el('button', {
          class: 'nav-item' + (c.id === cityId ? ' active' : ''),
          onClick: () => { cityId = c.id; render(); },
        },
          el('span', { class: 'ni' }, icon(cur.icon, 14)),
          c.name,
          el('span', { style: { marginLeft: 'auto', fontSize: '12px', fontWeight: 700 } }, `${Math.round(cur.temp)}°`)));
      }
      const c = weather.getCity(cityId);
      side.append(el('div', { class: 'card', style: { marginTop: '12px', fontSize: '11.5px' } },
        el('div', { class: 'dim' }, '数据来源'),
        el('div', {}, 'NEXUS 气象引擎'),
        el('div', { class: 'dim', style: { marginTop: '4px' } }, '本地模拟 · 历史可回溯')));
    }

    function renderNow() {
      const w = weather.current(cityId);
      setTitle(`${w.city} ${Math.round(w.temp)}° ${w.name} — 天气`);
      statusL.textContent = `实况更新于 ${new Date().toLocaleTimeString('zh-CN')}`;

      const hero = el('div', { class: 'wx-hero' },
        el('div', { class: 'wx-hero-main' },
          el('div', { class: 'wx-icon', style: { color: '#f59e0b' } }, icon(w.icon, 64)),
          el('div', { class: 'wx-temp' }, `${Math.round(w.temp)}°`),
          el('div', { class: 'wx-desc' }, `${w.name} · 体感 ${w.feels}°`)),
        el('div', { class: 'wx-hero-grid' },
          wxStat('风速', `${w.wind} km/h`), wxStat('湿度', `${w.humidity}%`),
          wxStat('气压', `${w.pressure} hPa`), wxStat('降水', `${w.precip} mm`),
          wxStat('日出', w.sunrise), wxStat('日落', w.sunset)));

      const hours = weather.hourly(cityId, 24);
      const hourlyBox = el('div', { class: 'card' },
        el('div', { class: 'card-title' }, icon('clock', 14), '未来 24 小时'),
        (() => {
          const strip = el('div', { class: 'wx-hours' });
          for (const h of hours.slice(0, 12)) {
            strip.append(el('div', { class: 'wx-hour' },
              el('span', { class: 'dim' }, h.label),
              icon(h.icon, 16),
              el('b', {}, `${Math.round(h.temp)}°`)));
          }
          return strip;
        })(),
        tempChart(hours, 'temp'));

      const days = weather.forecast(cityId, 7);
      const fbox = el('div', { class: 'card' },
        el('div', { class: 'card-title' }, icon('calendar', 14), '7 日预报'),
        ...days.map(d => el('div', { class: 'wx-day-row' },
          el('span', { class: 'wx-day-label' }, d.label),
          icon(d.icon, 16),
          el('span', { class: 'dim' }, d.name),
          el('span', { class: 'wx-day-t' }, `${Math.round(d.tmin)}° / ${Math.round(d.tmax)}°`))));

      body.innerHTML = '';
      body.append(hero, hourlyBox, fbox);
    }

    function wxStat(label, value) {
      return el('div', { class: 'wx-stat' },
        el('span', { class: 'dim' }, label),
        el('b', {}, value));
    }

    function renderHistory(dateStr) {
      const city = weather.getCity(cityId);
      const h = weather.history(cityId, dateStr);
      statusL.textContent = h ? `历史 · ${city.name} ${dateStr}` : '日期无效';
      if (!h) { body.innerHTML = ''; body.append(el('div', { class: 'empty' }, icon('calendar', 40), '请选择有效日期')); return; }
      setTitle(`${city.name} ${dateStr} 历史 — 天气`);

      const hero = el('div', { class: 'wx-hero' },
        el('div', { class: 'wx-hero-main' },
          el('div', { class: 'wx-icon' }, icon(h.icon, 56)),
          el('div', { class: 'wx-temp' }, `${Math.round((h.tmin + h.tmax) / 2)}°`),
          el('div', { class: 'wx-desc' }, `${h.name} · ${dateStr}`)),
        el('div', { class: 'wx-hero-grid' },
          wxStat('最低', `${Math.round(h.tmin)}°`), wxStat('最高', `${Math.round(h.tmax)}°`),
          wxStat('降水', `${h.precip} mm`), wxStat('湿度', `${h.humidity}%`),
          wxStat('风速', `${h.wind} km/h`), wxStat('气压', `${h.pressure} hPa`)));

      // 前后各 3 天区间对比
      const range = weather.historyRange(cityId, dateStr, 1)
        .concat([h]);
      const prev = (() => {
        const [y, m, d] = dateStr.split('-').map(Number);
        const out = [];
        for (let i = 6; i >= 1; i--) {
          const ds = weather.dateStr(new Date(Date.UTC(y, m - 1, d) - i * 86400e3));
          out.push({ ...weather.history(cityId, ds), label: ds.slice(5) });
        }
        out.push({ ...h, label: dateStr.slice(5) + '(查询日)' });
        return out;
      })();

      body.innerHTML = '';
      body.append(hero,
        el('div', { class: 'card' },
          el('div', { class: 'card-title' }, icon('activity', 14), `此前 6 天平均温度趋势(${city.name})`),
          tempChart(prev, 'temp')),
        el('div', { class: 'card' },
          el('div', { class: 'card-title' }, icon('info', 14), '关于历史数据'),
          el('div', { class: 'dim', style: { fontSize: '12.5px', lineHeight: 1.7 } },
            '历史数据由 NEXUS 气象引擎确定性生成:同一城市、同一日期的天气永远一致,可回溯至任意过去日期,也可精确"预言"未来。')));
    }

    function render() {
      renderSide();
      if (tab === 'now') renderNow();
      else if (tab === 'days') {
        statusL.textContent = '7 日预报';
        renderNow();   // 现在同屏含 7 日预报
      } else renderHistory(histDate.value);
    }

    /* 历史页签 */
    const histDate = el('input', { class: 'input', type: 'date', value: todayStr(), max: todayStr(), min: '2000-01-01' });
    histDate.addEventListener('change', () => { if (tab === 'history') renderHistory(histDate.value); });
    const quickBtn = (days, label) => el('button', {
      class: 'btn',
      onClick: () => {
        histDate.value = weather.dateStr(new Date(Date.now() - days * 86400e3));
        renderHistory(histDate.value);
      },
    }, label);

    const tabs = el('div', { class: 'app-toolbar' },
      el('div', { class: 'seg' },
        el('button', { class: 'seg-btn active', onClick: (e) => { tab = 'now'; setTab(e); render(); } }, '实况'),
        el('button', { class: 'seg-btn', onClick: (e) => { tab = 'history'; setTab(e); renderHistory(histDate.value); } }, '历史查询')),
      el('span', { class: 'grow' }),
      histDate,
      quickBtn(1, '昨天'), quickBtn(7, '一周前'), quickBtn(30, '30 天前'), quickBtn(365, '去年今日'));

    function setTab(e) {
      tabs.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
    }

    root.append(el('div', { class: 'app' }, tabs,
      el('div', { class: 'app-mid' }, side, body),
      el('div', { class: 'app-status' }, statusL,
        el('span', { class: 'grow' }),
        el('span', { class: 'mono' }, 'NEXUS METEO v2'))));

    render();
  },
});
