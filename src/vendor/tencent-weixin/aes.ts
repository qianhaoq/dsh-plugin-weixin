/** Adapted from @tencent-weixin/openclaw-weixin 2.4.10; see SOURCES.md and LICENSE. */
import { createDecipheriv } from 'node:crypto';
import { MediaError } from '../../media/types.js';

/** Tencent CDN keys are base64(raw 16 bytes) or base64(32 ASCII hex digits). */
export function parseAesKey(encoded: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new MediaError('INVALID_KEY');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) throw new MediaError('INVALID_KEY');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(decoded.toString('latin1'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw new MediaError('INVALID_KEY');
}
/** AES-128-ECB with PKCS#7. A bad final block must never fall back to plaintext. */
export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  try { return Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
  catch { throw new MediaError('INVALID_CIPHERTEXT'); }
}
