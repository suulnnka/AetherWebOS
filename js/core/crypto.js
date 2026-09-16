/* ============================================================
 * Crypto —— 虚拟文件加密(AES-GCM + PBKDF2)
 *
 * 文件格式(全部存为文本,兼容虚拟文件系统):
 *   WEOS1:<base64(salt)>:<base64(iv)>:<base64(ciphertext)>
 *   - salt(16B) 与 iv(12B) 每次加密随机生成
 *   - 密钥由密码经 PBKDF2(SHA-256, 150000 次迭代)派生
 * 加密后的文件:内容不可读;删除/重命名等元操作不受影响。
 * ============================================================ */

const MAGIC = 'WEOS1';
const ITER = 150000;
const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function isEncrypted(content) {
  return typeof content === 'string' && content.startsWith(MAGIC + ':');
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 加密明文 → WEOS1 文件内容 */
export async function encryptText(plain, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plain));
  return `${MAGIC}:${b64(salt)}:${b64(iv)}:${b64(cipher)}`;
}

/** 解密 WEOS1 内容;密码错误/数据损坏时抛错 */
export async function decryptText(content, password) {
  const parts = content.split(':');
  if (parts[0] !== MAGIC || parts.length !== 4) throw new Error('不是有效的加密文件');
  const [, saltB, ivB, dataB] = parts;
  const key = await deriveKey(password, unb64(saltB));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, key, unb64(dataB));
  } catch {
    throw new Error('密码错误或文件已损坏');
  }
  return td.decode(plain);
}

export const cryptoFile = { isEncrypted, encryptText, decryptText, MAGIC };
export default cryptoFile;
