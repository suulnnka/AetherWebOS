/* ============================================================
 * Zip —— ZIP 压缩包读写支持
 *
 * 读取:unzip(Uint8Array) → 条目列表[{ name, dir, size, data? }]
 *   - 支持 STORE(0)与 DEFLATE(8)压缩方法
 *   - 基于 Central Directory 解析(兼容标准 zip 打包器)
 *   - UTF-8 文件名;带 data 参数时才解压内容(惰性)
 * 写入:zip([{ name, data }], { level }) → Uint8Array
 *   - data 为 string 时按 UTF-8 编码;压缩用 deflate-raw
 *   - 超大内容或不支持 CompressionStream 时自动回退 STORE
 * ============================================================ */

const te = new TextEncoder();
const td = new TextDecoder();

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const p16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const p32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------- 压缩 / 解压(Compression Streams) ---------- */
async function pipe(streamOf, transform) {
  const buf = await new Response(streamOf.pipeThrough(new transform())).arrayBuffer();
  return new Uint8Array(buf);
}

async function deflateRaw(data) {
  return pipe(new Blob([data]).stream(), CompressionStream);
  function CompressionStream() { return new globalThis.CompressionStream('deflate-raw'); }
}
async function inflateRaw(data) {
  return pipe(new Blob([data]).stream(), DecompressionStream);
  function DecompressionStream() { return new globalThis.DecompressionStream('deflate-raw'); }
}

/* ---------- 解析 ---------- */
/**
 * 解析 ZIP。返回条目数组:
 *   { name, dir, method, compressedSize, size, crc, offset }
 * 调用方可用 extract(u8, entry) 取内容(惰性)。
 */
export function listEntries(u8) {
  // 从尾部找 End of Central Directory(0x06054b50),容忍最多 64KB 注释
  let eocd = -1;
  const min = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= min; i--) {
    if (u32(u8, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件(找不到目录结尾)');
  const count = u16(u8, eocd + 10);
  let offset = u32(u8, eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (u32(u8, offset) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const method = u16(u8, offset + 10);
    const crc = u32(u8, offset + 16);
    const compressedSize = u32(u8, offset + 20);
    const size = u32(u8, offset + 24);
    const nameLen = u16(u8, offset + 28);
    const extraLen = u16(u8, offset + 30);
    const commentLen = u16(u8, offset + 32);
    const lfhOffset = u32(u8, offset + 42);
    const name = td.decode(u8.subarray(offset + 46, offset + 46 + nameLen));
    const dir = name.endsWith('/');
    // 定位 Local File Header 中的数据起点
    const lfhNameLen = u16(u8, lfhOffset + 26);
    const lfhExtraLen = u16(u8, lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    entries.push({ name, dir, method, crc, compressedSize, size, dataStart });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压单个条目 → Uint8Array(文本用 td.decode) */
export async function extract(u8, entry) {
  const raw = u8.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`不支持的压缩方法:${entry.method}`);
}

/** 解析 + 全部解压(文本内容自动解码为 string) */
export async function unzip(u8, { asText = false } = {}) {
  const entries = listEntries(u8);
  const out = [];
  for (const e of entries) {
    const item = { name: e.name, dir: e.dir, size: e.size, method: e.method };
    if (!e.dir) {
      const data = await extract(u8, e);
      item.data = data;
      if (asText) item.text = td.decode(data);
    }
    out.push(item);
  }
  return out;
}

/* ---------- 构建 ---------- */
/**
 * 打包 ZIP。items: [{ name, data }] — data 为 string 或 Uint8Array;
 * 目录条目用 name 以 / 结尾、data 省略。
 */
export async function zip(items) {
  const useDeflate = typeof globalThis.CompressionStream === 'function';
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const item of items) {
    const isDir = item.name.endsWith('/');
    const nameBytes = te.encode(item.name);
    let method = 0;
    let data = new Uint8Array(0);
    if (!isDir) {
      data = typeof item.data === 'string' ? te.encode(item.data) : item.data;
      if (useDeflate && data.length > 0) {
        try {
          const deflated = await deflateRaw(data);
          if (deflated.length < data.length) { method = 8; data = deflated; }
        } catch { /* 回退 STORE */ }
      }
    }
    const crc = crc32(data);
    const size = data.length;

    const lfh = new Uint8Array(30 + nameBytes.length);
    p32(lfh, 0, 0x04034b50);
    p16(lfh, 4, 20);            // version
    p16(lfh, 6, 0x0800);        // UTF-8 flag
    p16(lfh, 8, method);
    p16(lfh, 10, 0); p16(lfh, 12, 0);   // time/date(DOS,此处不填)
    p32(lfh, 14, crc);
    p32(lfh, 18, size);
    p32(lfh, 22, size);         // 压缩前后一致(写入实际大小)
    p16(lfh, 26, nameBytes.length);
    p16(lfh, 28, 0);
    lfh.set(nameBytes, 30);
    locals.push(lfh, data);

    const cdh = new Uint8Array(46 + nameBytes.length);
    p32(cdh, 0, 0x02014b50);
    p16(cdh, 4, 20); p16(cdh, 6, 20);
    p16(cdh, 8, 0x0800);
    p16(cdh, 10, method);
    p32(cdh, 16, crc);
    p32(cdh, 20, size);
    p32(cdh, 24, size);
    p16(cdh, 28, nameBytes.length);
    p32(cdh, 42, offset);
    cdh.set(nameBytes, 46);
    centrals.push(cdh);

    offset += lfh.length + data.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  p32(end, 0, 0x06054b50);
  p16(end, 8, items.length);
  p16(end, 10, items.length);
  p32(end, 12, centralSize);
  p32(end, 16, offset);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of [...locals, ...centrals, end]) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}

/** 便捷:文本条目解码 */
export const decodeText = (data) => td.decode(data);

export const zipfmt = { listEntries, extract, unzip, zip, decodeText };
export default zipfmt;
