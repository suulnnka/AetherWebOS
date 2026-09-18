/* ============================================================
 * 图寻照片池
 *
 * 扩充方式(两步):
 *   1. 把照片(jpg/png/svg)放进 ./img/ 目录;
 *   2. 在下方 import 并登记一条 { src, lat, lng }。
 *
 * 坐标使用 WGS-84(GPS / OSM 体系,可在 OSM 地图右键复制),
 * 与百度 BD-09 无关 —— 本应用不依赖任何百度服务。
 * title 仅用于结算画面显示,不会在答题时剧透。
 * ============================================================ */
import beijing from './img/beijing.svg';
import shanghai from './img/shanghai.svg';
import guangzhou from './img/guangzhou.svg';
import hangzhou from './img/hangzhou.svg';

export const PHOTOS = [
  { src: beijing, lat: 39.9054, lng: 116.3976, title: '示例 · 天安门广场' },
  { src: shanghai, lat: 31.2397, lng: 121.4997, title: '示例 · 东方明珠' },
  { src: guangzhou, lat: 23.1065, lng: 113.3244, title: '示例 · 广州塔' },
  { src: hangzhou, lat: 30.2430, lng: 120.1443, title: '示例 · 杭州西湖' },
];
