/** Preparation runs inside the existing sender-ordered Engine task, never inside poll/accept. */
import { setTimeout as delay } from 'node:timers/promises';
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ResolvedConfig } from '../config.js';
import type { Store, InboxRow } from '../store.js';
import type { WeixinUserId } from '../protocol.js';
import { InboundStorage, inspectImage } from './storage.js';
import { CdnClient } from './cdn-client.js';
import { descriptorSchema, MediaError, IMAGE_NOTICE } from './types.js';
import type { InboundInput, PreparedInbound, Artifact } from './types.js';

/** A bounded, abortable account-wide download queue. Waiting consumes the persisted preparation budget. */
class Semaphore {
  private active = 0;
  private readonly waiting = new Set<() => void>();
  constructor(private readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const finish = (): void => { this.waiting.delete(finish); signal.removeEventListener('abort', abort); resolve(); };
      const abort = (): void => { this.waiting.delete(finish); reject(signal.reason); };
      signal.throwIfAborted(); this.waiting.add(finish); signal.addEventListener('abort', abort, { once: true });
    });
    signal.throwIfAborted(); this.active++;
    return () => { this.active--; for (const wake of [...this.waiting]) wake(); };
  }
}
export class MediaPipeline {
  readonly storage: InboundStorage;
  private maintenance: Promise<void> = Promise.resolve();
  private readonly activeMedia = new Set<string>();
  private readonly downloads: Semaphore;
  private readonly decoding = new Semaphore(1);
  constructor(private readonly store: Store, private readonly config: ResolvedConfig,
    private readonly attachments: Pick<AttachmentStore, 'imageLimits' | 'validateImage' | 'saveImages' | 'readImage'>,
    private readonly imageCapable: (user: WeixinUserId, signal: AbortSignal) => Promise<boolean>,
    private readonly cdn = new CdnClient(config)) {
    this.storage = new InboundStorage(config.stateDirectory, config.inboundQuotaBytes);
    this.downloads = new Semaphore(config.mediaDownloadConcurrency);
  }
  async initialize(): Promise<void> {
    await this.prune();
  }
  prune(): Promise<void> {
    const task = this.maintenance.then(() => this.collect());
    this.maintenance = task.catch(() => {});
    return task;
  }
  private async collect(): Promise<void> {
    const pending = this.store.markMediaGc(this.config.historyRetentionDays);
    for (const item of pending) await this.storage.remove(item.relative_path);
    for (const id of new Set(pending.map(item => item.inbox_id))) this.store.finishMediaGc(id);
    this.store.prune(this.config.historyRetentionDays);
    await this.storage.reconcile({ has: path => this.store.hasArtifactPath(path) }, this.activeMedia);
  }
  summary(): string { return `语音识别：尚未启用；视频解析：尚未启用；媒体存储：${this.storage.usage()}/${this.config.inboundQuotaBytes} bytes（不含宿主附件）。`; }
  private async image(id: string, signal: AbortSignal, maxBytes: number): Promise<{ artifact: Artifact; data: Buffer }> {
    const media = this.store.media(id);
    if (media.status === 'failed') throw new MediaError(media.error_code ?? 'MEDIA_FAILED', media.notice ?? IMAGE_NOTICE);
    const existing = this.store.artifact(id);
    if (existing) return { artifact: existing, data: await this.storage.read(existing.relative_path, maxBytes, existing.sha256) };
    if (media.attempts >= 3) throw new MediaError('DOWNLOAD_ATTEMPTS');
    const descriptor = descriptorSchema.safeParse(media.descriptor_json ? JSON.parse(media.descriptor_json) : undefined);
    if (!descriptor.success) throw new MediaError('INVALID_DESCRIPTOR');
    const unlock = await this.downloads.acquire(signal);
    this.activeMedia.add(id);
    let release: (() => void) | undefined;
    try {
      await this.prune();
      signal.throwIfAborted();
      release = this.storage.reserve(maxBytes);
      for (let attempt = media.attempts; attempt < 3; attempt++) {
        if (attempt > 0) await delay(attempt === 1 ? 1000 : 3000, undefined, { signal });
        signal.throwIfAborted();
        const temp = await this.storage.temporary(id);
        try {
          this.store.attempt(id);
          await this.cdn.download(descriptor.data, maxBytes, signal, temp.write);
          await temp.finish();
          const data = await this.storage.read(temp.relative, maxBytes);
          const limits = this.attachments.imageLimits;
          const detected = inspectImage(data, Math.min(this.config.maxImagePixels, limits.maxImagePixels), limits.maxImageDimension);
          if (!limits.mediaTypes.includes(detected.mime)) throw new MediaError('IMAGE_TYPE');
          const releaseDecode = await this.decoding.acquire(signal);
          try { await this.attachments.validateImage({ data, mediaType: detected.mime }); } finally { releaseDecode(); }
          signal.throwIfAborted();
          const artifact = await this.storage.publish(temp.relative, id, data, detected.mime, detected.extension);
          signal.throwIfAborted();
          this.store.saveArtifact(artifact);
          return { artifact, data };
        } catch (error) {
          await temp.discard();
          signal.throwIfAborted();
          if (!(error instanceof MediaError) || !error.retryable || attempt === 2) throw error;
        }
      }
      throw new MediaError('DOWNLOAD_ATTEMPTS');
    } finally { this.activeMedia.delete(id); release?.(); unlock(); }
  }
  async prepare(row: InboxRow, parentSignal: AbortSignal): Promise<PreparedInbound> {
    const deadline = this.store.beginPreparation(row.id, this.config.mediaPrepareTimeoutMs);
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
    const input = JSON.parse(row.input_json) as InboundInput;
    const prepared: PreparedInbound = { version: 1, content: [], notices: [], usable: false };
    let bytes = 0; let imageBytes = 0; let sourceImageBytes = 0; let images = 0; let capable: boolean | undefined;
    const notice = (text: string): void => { prepared.notices.push(text); prepared.content.push({ type: 'text', text: `[微信媒体说明：${text}]` }); };
    for (const part of input.parts) {
      parentSignal.throwIfAborted();
      if (part.type === 'text') { prepared.content.push({ type: 'text', text: part.text }); if (part.text.trim()) prepared.usable = true; continue; }
      if (part.type === 'notice') { notice(part.text); continue; }
      try {
        if (Date.now() >= deadline) throw new MediaError('PREPARE_TIMEOUT', '图片准备超时，未交给模型。请重发图片。');
        signal.throwIfAborted();
        const limits = this.attachments.imageLimits;
        const maxBytes = Math.min(this.config.maxImageBytes, limits.maxImageBytes, this.config.maxMessageMediaBytes - bytes);
        if (maxBytes <= 0) throw new MediaError('MESSAGE_BYTES');
        const { artifact, data } = await this.image(part.mediaId, signal, maxBytes);
        inspectImage(data, Math.min(this.config.maxImagePixels, limits.maxImagePixels), limits.maxImageDimension);
        if (!limits.mediaTypes.includes(artifact.mime as ImageMediaType)) throw new MediaError('IMAGE_TYPE');
        bytes += data.length;
        if (images >= Math.min(this.config.maxMediaItems, limits.maxImagesPerMessage) || sourceImageBytes + data.length > Math.min(this.config.maxMessageImageBytes, limits.maxMessageImageBytes)) throw new MediaError('IMAGE_BATCH_LIMIT', '本条图片总数或总大小超过上限；部分图片未交给模型，请拆分后重发。');
        capable ??= await this.imageCapable(row.user_id, signal);
        if (!capable) { notice('图片已保存；当前模型未启用图片理解，请在电脑端配置支持看图的模型。'); continue; }
        let ref: ImageAttachmentRef;
        let cached: ImageAttachmentRef | undefined;
        if (artifact.attachment_json) {
          const candidate = JSON.parse(artifact.attachment_json) as ImageAttachmentRef;
          try { await this.attachments.readImage(candidate, signal); cached = candidate; }
          catch { signal.throwIfAborted(); } // Re-admit from verified originals if host retention removed a shared object.
        }
        if (cached) ref = cached;
        else {
          const releaseDecode = await this.decoding.acquire(signal);
          let refs: readonly ImageAttachmentRef[];
          try { refs = await this.attachments.saveImages([{ data, mediaType: artifact.mime as ImageMediaType, name: `weixin-image-${part.ordinal + 1}` }]); } finally { releaseDecode(); }
          if (!refs[0]) throw new MediaError('ATTACHMENT_MISSING');
          ref = refs[0];
          signal.throwIfAborted();
          this.store.saveArtifact({ ...artifact, attachment_json: JSON.stringify(ref) });
        }
        signal.throwIfAborted();
        if (imageBytes + ref.bytes > Math.min(this.config.maxMessageImageBytes, limits.maxMessageImageBytes)) throw new MediaError('IMAGE_BATCH_LIMIT', '本条图片总大小超过上限；部分图片未交给模型，请拆分后重发。');
        imageBytes += ref.bytes; sourceImageBytes += data.length; images++;
        prepared.content.push({ type: 'text', text: `微信图片 ${part.ordinal + 1}：` }, { type: 'image', attachment: ref });
        prepared.usable = true;
      } catch (error) {
        parentSignal.throwIfAborted();
        const failure = signal.aborted ? new MediaError('PREPARE_TIMEOUT', '图片准备超时，未交给模型。请重发图片。') : error instanceof MediaError ? error : new MediaError('IMAGE_PREPARATION');
        // Ready originals stay reusable even when model routing/attachment admission fails.
        if (!this.store.artifact(part.mediaId)) this.store.mediaFailure(part.mediaId, failure.code, failure.notice);
        notice(failure.notice);
      }
    }
    parentSignal.throwIfAborted();
    this.store.prepared(row.id, prepared);
    return prepared;
  }
}
