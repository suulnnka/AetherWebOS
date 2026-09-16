/* ============================================================
 * Weather —— 模拟气象数据引擎(零后端)
 *
 * 数据特点:
 *  - 确定性:同一城市同一天气永远相同(种子 = 城市ID + 日期),
 *    因此"历史查询"结果稳定可回溯,也可预言"未来";
 *  - 季节规律:基于纬度的基准温度曲线(北半球夏热冬冷)+
 *    日内正弦变化;降水概率/风速/湿度/气压由同一随机源派生;
 *  - 天气类型由湿度与温度联合判定(晴/多云/阴/雨/雪/雷暴/雾)。
 *
 * API:
 *   cities()                       城市列表
 *   current(cityId)                当前实况
 *   hourly(cityId, n)              从现在起 n 小时逐时
 *   forecast(cityId, n)            未来 n 天(含今天)
 *   history(cityId, dateStr)       某日历史(YYYY-MM-DD,可回溯任意天数)
 *   daily(cityId, dateStr)         单日数据(历史与未来同构)
 * ============================================================ */

export const CITY_LIST = [
  { id: 'shanghai', name: '上海', lat: 31.2, base: 17, range: 12, humid: 0.62 },
  { id: 'beijing', name: '北京', lat: 39.9, base: 13, range: 13, humid: 0.45 },
  { id: 'guangzhou', name: '广州', lat: 23.1, base: 22, range: 8, humid: 0.74 },
  { id: 'chengdu', name: '成都', lat: 30.6, base: 17, range: 9, humid: 0.7 },
  { id: 'harbin', name: '哈尔滨', lat: 45.8, base: 5, range: 16, humid: 0.55 },
  { id: 'lhasa', name: '拉萨', lat: 29.6, base: 9, range: 12, humid: 0.35 },
  { id: 'urumqi', name: '乌鲁木齐', lat: 43.8, base: 8, range: 14, humid: 0.4 },
  { id: 'sanya', name: '三亚', lat: 18.2, base: 26, range: 5, humid: 0.78 },
];

/** 确定性伪随机:字符串种子 → [0,1) */
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return ((h >>> 0) % 100000) / 100000;
  };
}

export const cities = () => CITY_LIST;
export const getCity = (id) => CITY_LIST.find(c => c.id === id) || CITY_LIST[0];

const pad2 = (n) => String(n).padStart(2, '0');
export const dateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 天气代码 → 名称与图标(icons.js 中可用的名称) */
const WX = [
  { code: 'sunny', name: '晴', icon: 'sun' },
  { code: 'partly', name: '多云', icon: 'sun' },
  { code: 'cloudy', name: '阴', icon: 'moon' },
  { code: 'rain', name: '雨', icon: 'download' },
  { code: 'storm', name: '雷暴', icon: 'alertTriangle' },
  { code: 'snow', name: '雪', icon: 'moon' },
  { code: 'fog', name: '雾', icon: 'info' },
];
const wxBy = (code) => WX.find(w => w.code === code);

/** 计算某城市某日某小时的天气(核心确定性函数) */
function compute(city, ds, hour) {
  const [y, m, d] = ds.split('-').map(Number);
  const dayOfYear = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400e3);

  // 季节温度:余弦曲线,7 月最热(北半球)
  const seasonal = Math.cos((dayOfYear - 196) / 365 * 2 * Math.PI) * -city.range;
  // 日内变化:14 时最热、05 时最冷
  const diurnal = Math.sin((hour - 8) / 24 * 2 * Math.PI) * 5;
  const rnd = seededRandom(`${city.id}|${ds}|${hour}`);
  const jitter = (rnd() - 0.5) * 4;
  const temp = Math.round((city.base + seasonal + diurnal + jitter) * 10) / 10;

  // 湿度与降水:夏季+高温高湿城市更易降水
  const humR = seededRandom(`${city.id}|${ds}|h${Math.floor(hour / 3)}`)();
  const humidity = Math.round(clamp01(city.humid + seasonal / 80 + (humR - 0.5) * 0.35 + Math.sin(hour / 24 * 2 * Math.PI) * 0.08) * 100);
  const rainBase = rnd();
  const snowable = temp <= 0;

  let code;
  if (humidity > 88 && rainBase < 0.35 && temp > 18) code = 'storm';
  else if (humidity > 75 && rainBase < 0.45) code = snowable ? 'snow' : 'rain';
  else if (humidity > 60 && rainBase < 0.6) code = 'cloudy';
  else if (humidity < 45 && rainBase > 0.85) code = 'fog';
  else if (rainBase < 0.72) code = 'partly';
  else code = 'sunny';

  const wind = Math.round(2 + seededRandom(`${city.id}|${ds}|w${hour}`)() * 28);
  const pressure = Math.round(998 + seededRandom(`${city.id}|${ds}|p${hour}`)() * 28);
  const precip = (code === 'rain' || code === 'storm') ? Math.round(rnd() * 14 + 2) : code === 'snow' ? Math.round(rnd() * 6) : 0;

  return {
    date: ds, hour,
    temp, humidity, wind, pressure, precip,
    code, name: wxBy(code).name, icon: wxBy(code).icon,
  };
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 汇总某日(取 14 时为代表 + 日最低/最高扫描) */
export function daily(cityId, ds) {
  const city = getCity(cityId);
  let min = Infinity, max = -Infinity, pick = null;
  for (let h = 0; h < 24; h++) {
    const w = compute(city, ds, h);
    if (w.temp < min) min = w.temp;
    if (w.temp > max) max = w.temp;
    if (h === 14) pick = w;
  }
  // 降水日合计
  let precip = 0;
  for (let h = 0; h < 24; h += 3) precip += compute(city, ds, h).precip;
  return { ...pick, date: ds, tmin: min, tmax: max, precip };
}

/** 实况:今天当前小时 */
export function current(cityId) {
  const city = getCity(cityId);
  const now = new Date();
  const ds = dateStr(now);
  const w = compute(city, ds, now.getHours());
  // 体感温度:湿度高更闷热,风大更冷
  const feels = Math.round(w.temp + (w.humidity > 70 ? 1.5 : 0) - w.wind * 0.08);
  const tomorrow = dateStr(new Date(Date.now() + 86400e3));
  return { ...w, feels, city: city.name, cityId: city.id, sunrise: '06:' + pad2(20 + Math.floor(seededRandom(ds)() * 30)), sunset: '18:' + pad2(10 + Math.floor(seededRandom(ds + 'x')() * 40)), tomorrowCode: daily(cityId, tomorrow).code };
}

/** 逐时:从当前小时起 n 小时(跨天自动衔接) */
export function hourly(cityId, n = 24) {
  const city = getCity(cityId);
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const t = new Date(now.getTime() + i * 3600e3);
    const w = compute(city, dateStr(t), t.getHours());
    out.push({ ...w, label: i === 0 ? '现在' : pad2(t.getHours()) + ':00' });
  }
  return out;
}

/** 未来 n 天预报(含今天) */
export function forecast(cityId, n = 7) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = dateStr(new Date(today.getTime() + i * 86400e3));
    out.push({ ...daily(cityId, d), label: i === 0 ? '今天' : i === 1 ? '明天' : '周' + '日一二三四五六'[new Date(d).getDay()] });
  }
  return out;
}

/** 历史查询:某日(YYYY-MM-DD),与预报同构 */
export function history(cityId, ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return null;
  return daily(cityId, ds);
}

/** 历史区间:从 endStr 往前 n 天 */
export function historyRange(cityId, endStr, n = 7) {
  const [y, m, d] = endStr.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const ds = dateStr(new Date(end - i * 86400e3));
    out.push({ ...daily(cityId, ds), label: ds.slice(5) });
  }
  return out;
}

const weather = { cities, getCity, current, hourly, forecast, history, historyRange, daily, dateStr };
export default weather;
