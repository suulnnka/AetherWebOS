/* ============================================================
 * AEXE —— AetherJS 可执行文件(.exe)的打包 / 识别 / 解包
 * ------------------------------------------------------------
 * 文件格式(纯文本,兼容虚拟文件系统,cat 可见但不可读):
 *   AEXE1:<base64(掩码混淆的密钥)>:WEOS1:<salt>:<iv>:<密文>
 *
 * 定位是**混淆级**封装,不是保密:密钥随机生成、随文件携带(XOR
 * 掩码 + base64),防的是「cat / 记事本直接读懂源码」;对能读代码
 * 的逆向者不设防 —— 密钥就在文件里,知道格式就能取出源码。真保密
 * 用 crypt encrypt 的口令加密文件(那把密钥不随文件走)。
 *
 * 与 WEOS1 加密文件刻意区分前缀:exe 在文件管家/终端 cat 眼里就是
 * 普通文本文件(无锁图标、不弹密码框),内容是密文 —— 「可以看,
 * 看不懂」。执行侧(终端直击、未来其他宿主)按 AEXE1 魔数识别,
 * 自动解包后走 core/ascript.js 的沙盒 Worker 运行。
 * ============================================================ */
import { encryptText, decryptText } from './crypto.js';

const MAGIC = 'AEXE1';
const MASK = 'AetherEXE::obfuscation-mask::v1';

/** 是否 AEXE 可执行文件(按内容魔数,不看扩展名) */
export function isExe(content) {
  return typeof content === 'string' && content.startsWith(MAGIC + ':');
}

/* 密钥混淆:hex 密钥 XOR 掩码后 base64(密钥仅 [0-9a-f],btoa 安全) */
const scramble = (key) => btoa([...key].map((c, i) =>
  String.fromCharCode(c.charCodeAt(0) ^ MASK.charCodeAt(i % MASK.length))).join(''));

function unscramble(part) {
  return [...atob(part)].map((c, i) =>
    String.fromCharCode(c.charCodeAt(0) ^ MASK.charCodeAt(i % MASK.length))).join('');
}

/** 打包:源码 → exe 文件内容(随机 128 位密钥自动加密,密钥混淆后随文件携带) */
export async function packExe(source) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const enc = await encryptText(String(source), key);
  return `${MAGIC}:${scramble(key)}:${enc}`;
}

/** 解包:exe 文件内容 → 源码(自动解密;伪造/损坏抛错,消息面向用户) */
export async function unpackExe(content) {
  if (!isExe(content)) throw new Error('不是有效的 AEXE 可执行文件');
  const rest = content.slice(MAGIC.length + 1);
  const sep = rest.indexOf(':');          // 密钥段是 base64,不含冒号
  if (sep < 0) throw new Error('exe 文件已损坏(缺少密钥段)');
  try {
    return await decryptText(rest.slice(sep + 1), unscramble(rest.slice(0, sep)));
  } catch (e) {
    throw new Error(`解密失败:${e.message}(文件已损坏,或不是本系统打包的 exe)`);
  }
}
