/** Plugin-private originals. Remote identities never become local path components. */
import { constants, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { Artifact } from './types.js';
import { MediaError } from './types.js';

/** Reject symlinks in every existing ancestor; repair permissions only on the owned directory. */
export function privateDirectory(path: string): void {
  const absolute = resolve(path);
  let current: string = sep;
  for (const component of absolute.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new MediaError('UNSAFE_DIRECTORY');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const info = lstatSync(absolute);
  if (process.getuid && info.uid !== process.getuid()) throw new MediaError('DIRECTORY_OWNER');
  chmodSync(absolute, 0o700);
}
export function privateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new MediaError('UNSAFE_FILE');
  chmodSync(path, 0o600);
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Fast format and decoded-size gate before the host performs authoritative full decoding. */
export function inspectImage(data: Buffer, maxPixels: number, maxDimension: number): { mime: ImageMediaType; extension: string } {
  let width = 0; let height = 0; let mime: ImageMediaType | undefined; let extension = '';
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && data.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; extension = 'png'; width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data.length >= 10 && /^GIF8[79]a$/u.test(data.toString('ascii', 0, 6))) {
    mime = 'image/gif'; extension = 'gif'; width = data.readUInt16LE(6); height = data.readUInt16LE(8);
  } else if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp'; extension = 'webp';
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = data.readUIntLE(24, 3) + 1; height = data.readUIntLE(27, 3) + 1; }
    else if (kind === 'VP8L' && data[20] === 0x2f) { const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    else if (kind === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff; }
  } else if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    mime = 'image/jpeg'; extension = 'jpg';
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!mime || !width || !height) throw new MediaError('INVALID_IMAGE');
  if (width * height > maxPixels || Math.max(width, height) > maxDimension) throw new MediaError('IMAGE_PIXELS', '图片像素或尺寸超过上限，未交给模型。请缩小后重发。');
  return { mime, extension };
}
export class InboundStorage {
  readonly root: string;
  private reserved = 0;
  constructor(directory: string, private readonly quota: number) { privateDirectory(directory); this.root = join(directory, 'inbound'); privateDirectory(this.root); }
  private path(relative: string): string {
    if (!/^[a-f\d-]{36}\/(?:original\.(?:png|jpg|gif|webp)|[a-f\d-]{36}\.tmp)$/u.test(relative)) throw new MediaError('UNSAFE_PATH');
    privateDirectory(join(this.root, relative.split('/')[0]!));
    return join(this.root, relative);
  }
  usage(): number {
    let bytes = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const directory = join(this.root, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MediaError('UNSAFE_DIRECTORY');
      privateDirectory(directory);
      for (const name of readdirSync(directory)) { const path = join(directory, name); privateFile(path); bytes += lstatSync(path).size; }
    }
    return bytes;
  }
  /** Reserve worst-case plaintext storage before network I/O; reservations are synchronous and account-wide. */
  reserve(bytes: number): () => void {
    if (this.usage() + this.reserved + bytes > this.quota) throw new MediaError('MEDIA_QUOTA', '媒体存储已满，图片未交给模型。请在电脑端清理后重发。');
    this.reserved += bytes;
    return () => { this.reserved -= bytes; };
  }
  async temporary(mediaId: string): Promise<{ relative: string; write: (chunk: Uint8Array) => Promise<void>; finish: () => Promise<void>; discard: () => Promise<void> }> {
    const relative = `${mediaId}/${randomUUID()}.tmp`;
    const path = this.path(relative);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let closed = false;
    const close = async (): Promise<void> => { if (!closed) { closed = true; await file.close(); } };
    return { relative, write: async chunk => {
      let offset = 0;
      while (offset < chunk.length) { const result = await file.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw new MediaError('DISK_WRITE'); offset += result.bytesWritten; }
    }, finish: async () => { await file.sync(); await close(); }, discard: async () => { await close(); await rm(path, { force: true }); } };
  }
  async read(relative: string, max: number, digest?: string): Promise<Buffer> {
    const path = this.path(relative); privateFile(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > max) throw new MediaError('ARTIFACT_SIZE');
      // Read at most max+1 even if another local process modifies the file after stat.
      const data = Buffer.alloc(Math.min(stat.size + 1, max + 1));
      let offset = 0;
      while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset); if (!bytesRead) break; offset += bytesRead; }
      const result = data.subarray(0, offset);
      if (result.length > max || (digest && createHash('sha256').update(result).digest('hex') !== digest)) throw new MediaError('ARTIFACT_INTEGRITY');
      return result;
    } finally { await handle.close(); }
  }
  async publish(temp: string, mediaId: string, data: Buffer, mime: string, extension: string): Promise<Artifact> {
    const relative = `${mediaId}/original.${extension}`;
    const target = this.path(relative);
    if (existsSync(target)) privateFile(target);
    await rename(this.path(temp), target);
    await syncDirectory(dirname(target));
    await syncDirectory(this.root);
    return { media_id: mediaId, relative_path: relative, bytes: data.length, mime, sha256: createHash('sha256').update(data).digest('hex'), attachment_json: null };
  }
  async remove(relative: string): Promise<void> { const path = this.path(relative); if (existsSync(path)) privateFile(path); await rm(path, { force: true }); await syncDirectory(dirname(path)); }
  /** Reclaim orphan files at startup/maintenance, excluding active downloads and committed artifacts. */
  async reconcile(known: { has(path: string): boolean }, active: ReadonlySet<string> = new Set()): Promise<void> {
    this.usage();
    for (const directory of readdirSync(this.root)) {
      if (active.has(directory)) continue;
      const path = join(this.root, directory);
      for (const name of readdirSync(path)) { const relative = `${directory}/${name}`; if (!active.has(directory) && !known.has(relative)) await this.remove(relative); }
      if (!active.has(directory) && readdirSync(path).length === 0) rmdirSync(path);
    }
    await syncDirectory(this.root);
  }
}
