import type { ImageBlock, TextBlock } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';

export const descriptorSchema = z.object({
  encrypt_query_param: z.string().max(16384).optional(), full_url: z.string().max(16384).optional(),
  aes_key: z.string().max(128).optional(), encrypt_type: z.number().int().optional(),
  aeskey: z.string().max(128).optional(),
});
export type DownloadDescriptor = z.infer<typeof descriptorSchema>;
export interface InboundInput {
  version: 1;
  parts: ({ type: 'text'; text: string } | { type: 'media'; mediaId: string; ordinal: number } | { type: 'notice'; text: string })[];
}
export interface PreparedInbound {
  version: 1;
  content: (TextBlock | ImageBlock)[];
  notices: string[];
  usable: boolean;
}
export interface MediaRow {
  id: string; inbox_id: string; item_ordinal: number; kind: string;
  descriptor_json: string | null; status: string; attempts: number; error_code: string | null;
}
export interface Artifact {
  media_id: string; relative_path: string; bytes: number; mime: string; sha256: string;
  attachment_json: string | null;
}
export const VOICE_NOTICE = '当前阶段尚未识别语音内容，请发送文字。';
export const VIDEO_NOTICE = '当前阶段尚未解析视频，请发送关键画面截图或文字说明。';
export const UNSUPPORTED_NOTICE = '本条包含当前未支持的文件/消息类型；该部分未交给模型。';
export const IMAGE_NOTICE = '图片下载或校验失败，未交给模型。请重发图片。';
/** Stable, sanitized media failures; never include remote URLs or keys in a message. */
export class MediaError extends Error {
  constructor(readonly code: string, readonly notice = IMAGE_NOTICE, readonly retryable = false) { super(code); }
}
