import { createDecipheriv } from 'node:crypto';
import { isIP } from 'node:net';
import { buildCdnDownloadUrl } from '../vendor/tencent-weixin/cdn-url.js';
import { parseAesKey } from '../vendor/tencent-weixin/aes.js';
import { MediaError } from './types.js';
import type { DownloadDescriptor } from './types.js';

export const DEFAULT_CDN_HOST = 'novac2c.cdn.weixin.qq.com';
export const DEFAULT_CDN_BASE = `https://${DEFAULT_CDN_HOST}/c2c`;
/** CDN trust is deliberately separate from the credential-bearing iLink API. */
export function cdnUrl(input: string, allowed: readonly string[], base = false): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new MediaError('CDN_URL'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || input.includes('#') ||
    !allowed.includes(host) || isIP(host) || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    url.pathname !== (base ? '/c2c' : '/c2c/download') || (base && url.search)) throw new MediaError('CDN_URL');
  // Reject explicitly written ports (including :443), backslashes and normalized path escapes.
  if (!/^https:\/\/[^/?#@:]+\//u.test(input) || /\\/u.test(input) || /(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c/iu.test(input.split('?')[0]!)) throw new MediaError('CDN_URL');
  return url;
}
export interface CdnOptions { allowedCdnHosts: readonly string[]; cdnBaseUrl: string; mediaDownloadTimeoutMs: number }
export class CdnClient {
  constructor(private readonly options: CdnOptions, private readonly transport: typeof fetch = fetch) {
    cdnUrl(options.cdnBaseUrl, options.allowedCdnHosts, true);
  }
  /** Stream decrypted chunks to a private unpublished file, bounding both wire and plaintext bytes. */
  async download(descriptor: DownloadDescriptor, maxBytes: number, signal: AbortSignal, write: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    const url = cdnUrl(descriptor.full_url ?? buildCdnDownloadUrl(descriptor.encrypt_query_param ?? '', this.options.cdnBaseUrl), this.options.allowedCdnHosts);
    if (!descriptor.full_url && !descriptor.encrypt_query_param) throw new MediaError('MISSING_LOCATION');
    if (descriptor.encrypt_type !== undefined && descriptor.encrypt_type !== 0 && descriptor.encrypt_type !== 1) throw new MediaError('ENCRYPTION_UNSUPPORTED');
    let key: Buffer | undefined;
    if (descriptor.aeskey !== undefined) {
      if (!/^[a-f\d]{32}$/iu.test(descriptor.aeskey)) throw new MediaError('INVALID_KEY');
      key = Buffer.from(descriptor.aeskey, 'hex');
    } else if (descriptor.aes_key !== undefined) key = parseAesKey(descriptor.aes_key);
    if (!key && descriptor.encrypt_type !== 0) throw new MediaError('MISSING_KEY');
    const decipher = key ? createDecipheriv('aes-128-ecb', key, null) : undefined;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.options.mediaDownloadTimeoutMs)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let wire = 0; let plain = 0;
    const emit = async (chunk: Uint8Array): Promise<void> => {
      plain += chunk.byteLength;
      if (plain > maxBytes) throw new MediaError('IMAGE_TOO_LARGE', '图片超过单张大小上限，未交给模型。请压缩后重发。');
      combined.throwIfAborted();
      try { await write(chunk); } catch { throw new MediaError('DISK_WRITE', '媒体写入失败，图片未交给模型。请检查本机存储后重发。'); }
    };
    try {
      const response = await this.transport(url, { signal: combined, redirect: 'error', headers: { Accept: 'application/octet-stream' } });
      reader = response.body?.getReader();
      if (!response.ok) throw new MediaError(`CDN_HTTP_${response.status}`, response.status === 403 || response.status === 404 ? '图片链接已失效，未交给模型。请重发图片。' : undefined, response.status === 429 || response.status >= 500);
      const length = response.headers.get('content-length');
      const wireLimit = maxBytes + (key ? 16 : 0);
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > wireLimit)) throw new MediaError('IMAGE_TOO_LARGE');
      if (!reader) throw new MediaError('EMPTY_BODY');
      while (true) {
        combined.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        wire += next.value.byteLength;
        if (wire > wireLimit) throw new MediaError('IMAGE_TOO_LARGE');
        await emit(decipher ? decipher.update(next.value) : next.value);
      }
      if (decipher) {
        let final: Buffer;
        try { final = decipher.final(); } catch { throw new MediaError('INVALID_CIPHERTEXT'); }
        await emit(final);
      }
      if (!plain) throw new MediaError('EMPTY_BODY');
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof MediaError) throw error;
      throw new MediaError('CDN_NETWORK', undefined, true);
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  }
}
