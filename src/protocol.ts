import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { WeixinError } from './errors.js';

/** Version advertised to iLink; package validation checks it against package.json. */
export const PLUGIN_VERSION = '0.2.0';

export const userIdSchema = z.string().min(1).brand<'WeixinUserId'>();
export type WeixinUserId = z.infer<typeof userIdSchema>;
export const credentialsSchema = z.object({
  version: z.literal(1), token: z.string().min(1), botId: z.string().min(1),
  userId: userIdSchema, baseUrl: z.string().url(),
}).strict();
export type Credentials = z.infer<typeof credentialsSchema>;

const itemSchema = z.object({ type: z.number().int(), text_item: z.object({ text: z.string() }).optional(), ref_msg: z.unknown().optional() });
export const messageSchema = z.object({
  message_id: z.string().min(1), from_user_id: userIdSchema,
  to_user_id: z.string().optional(), group_id: z.string().optional(),
  message_type: z.number().int(), context_token: z.string().optional(),
  item_list: z.array(itemSchema).default([]),
});
export type WeixinMessage = z.infer<typeof messageSchema>;
const updatesSchema = z.object({
  ret: z.number().optional(), errcode: z.number().optional(),
  msgs: z.array(z.unknown()).default([]), get_updates_buf: z.string(),
});
export type Updates = z.infer<typeof updatesSchema>;
const qrSchema = z.object({ qrcode: z.string().min(1), qrcode_img_content: z.string().url() });
const loginSchema = z.object({
  status: z.enum(['wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect', 'need_verifycode', 'verify_code_blocked', 'binded_redirect']),
  bot_token: z.string().optional(), ilink_bot_id: z.string().optional(),
  ilink_user_id: z.string().optional(), baseurl: z.string().optional(), redirect_host: z.string().optional(),
});
export type LoginStatus = z.infer<typeof loginSchema>;

/** Reject credential-bearing redirects and unexpected hosts before transmitting credentials.
 * @param input - API URL supplied by configuration or a QR response.
 * @param allowedHosts - Exact hostnames trusted by the operator.
 * @returns Validated HTTPS origin ending in a slash.
 */
export function apiOrigin(input: string, allowedHosts: readonly string[]): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || !allowedHosts.includes(url.hostname)) {
    throw new WeixinError('PROTOCOL', 'API host', 'Expected an HTTPS origin on the configured host allowlist.');
  }
  return url.href;
}

/** Read integer message identities from their JSON source without IEEE-754 rounding.
 * @param text - Raw JSON from the remote API.
 * @returns Parsed response; unrecognized fields are validated by the receiving schema.
 */
export function parseWireJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key === 'message_id' && typeof value === 'number') {
      if (context?.source && /^\d+$/u.test(context.source)) return context.source;
      if (Number.isSafeInteger(value)) return String(value);
      throw new WeixinError('PROTOCOL', 'message identity', 'An exact integer message ID is required.');
    }
    return value;
  });
}

/** Request timing and trusted hosts for one iLink account. */
export interface ApiOptions {
  requestTimeoutMs: number;
  pollTimeoutMs: number;
  allowedApiHosts: readonly string[];
  loginBaseUrl: string;
}

/** Text-only iLink transport. Sends are never retried because their outcome can be unknown. */
export class ILinkClient {
  constructor(private readonly options: ApiOptions, private readonly transport: typeof fetch = fetch) {}

  private async request(base: string, endpoint: string, body: object | undefined, signal: AbortSignal, token?: string, poll = false): Promise<unknown> {
    const origin = apiOrigin(base, this.options.allowedApiHosts);
    const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '512' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['AuthorizationType'] = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let response: Response;
    try {
      response = await this.transport(new URL(endpoint, origin), {
        method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(poll ? this.options.pollTimeoutMs : this.options.requestTimeoutMs)]),
      });
      if (!response.ok) throw new WeixinError('HTTP', endpoint.split('?')[0]!, `HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
      const data = parseWireJson(await response.text());
      const result = z.object({ ret: z.number().optional(), errcode: z.number().optional() }).parse(data);
      const code = result.errcode && result.errcode !== 0 ? result.errcode : result.ret;
      if (code !== undefined && code !== 0) {
        throw new WeixinError(code === -14 ? 'AUTH_EXPIRED' : 'API', endpoint.split('?')[0]!, `Server returned code ${code}; ${code === -14 ? 'reconnect the session or scan a new QR code.' : 'check the channel status.'}`);
      }
      return data;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof WeixinError) throw error;
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw new WeixinError('PROTOCOL', 'iLink response', 'Invalid JSON response.');
      throw new WeixinError('NETWORK', endpoint.split('?')[0]!, 'Request failed or timed out.', true, { cause: error });
    }
  }

  /** Start a fresh login without reading another application's credentials. */
  async qr(signal: AbortSignal): Promise<z.infer<typeof qrSchema>> {
    return qrSchema.parse(await this.request(this.options.loginBaseUrl, 'ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, signal));
  }

  /** Poll a QR login on a validated host; verification codes are never logged. */
  async loginStatus(base: string, qr: string, signal: AbortSignal, code?: string): Promise<LoginStatus> {
    const query = new URLSearchParams({ qrcode: qr });
    if (code) query.set('verify_code', code);
    return loginSchema.parse(await this.request(base, `ilink/bot/get_qrcode_status?${query}`, undefined, signal, undefined, true));
  }

  /** Long-poll messages using the last durably committed cursor. */
  async updates(auth: Credentials, cursor: string, signal: AbortSignal): Promise<Updates> {
    return updatesSchema.parse(await this.request(auth.baseUrl, 'ilink/bot/getupdates', {
      get_updates_buf: cursor, base_info: this.baseInfo(),
    }, signal, auth.token, true));
  }

  /** Inform the account backend of this channel's lifecycle without retrying the notification. */
  async notify(auth: Credentials, phase: 'start' | 'stop', signal: AbortSignal): Promise<void> {
    await this.request(auth.baseUrl, `ilink/bot/msg/notify${phase}`, { base_info: this.baseInfo() }, signal, auth.token);
  }

  /** Obtain an account-supported typing ticket without consuming a text-message reply. */
  async typingTicket(auth: Credentials, user: WeixinUserId, context: string, signal: AbortSignal): Promise<string | undefined> {
    const response = await this.request(auth.baseUrl, 'ilink/bot/getconfig', {
      ilink_user_id: user, context_token: context, base_info: this.baseInfo(),
    }, signal, auth.token);
    return z.object({ typing_ticket: z.string().optional() }).parse(response).typing_ticket;
  }

  /** Publish or clear a task-owned native typing indicator. */
  async typing(auth: Credentials, user: WeixinUserId, ticket: string, active: boolean, signal: AbortSignal): Promise<void> {
    await this.request(auth.baseUrl, 'ilink/bot/sendtyping', {
      ilink_user_id: user, typing_ticket: ticket, status: active ? 1 : 2, base_info: this.baseInfo(),
    }, signal, auth.token);
  }

  /** Send one final text message once, with its original reply context and stable client ID. */
  async send(auth: Credentials, message: { userId: string; contextToken: string; clientId: string; text: string }, signal: AbortSignal): Promise<void> {
    const response = await this.request(auth.baseUrl, 'ilink/bot/sendmessage', {
      base_info: this.baseInfo(), msg: {
        from_user_id: '', to_user_id: message.userId, client_id: message.clientId,
        message_type: 2, message_state: 2, context_token: message.contextToken,
        item_list: [{ type: 1, text_item: { text: message.text } }],
      },
    }, signal, auth.token);
    const acknowledgement = z.object({ ret: z.number().optional(), message_id: z.string().optional() }).safeParse(response);
    if (!acknowledgement.success || (acknowledgement.data.ret === undefined && !acknowledgement.data.message_id)) {
      throw new WeixinError('PROTOCOL', 'sendmessage', 'Missing delivery acknowledgement; delivery outcome is unknown.');
    }
  }

  private baseInfo(): object { return { channel_version: PLUGIN_VERSION, bot_agent: `DeepSeekHarness/0.2.1 DshWeixin/${PLUGIN_VERSION}` }; }
}
