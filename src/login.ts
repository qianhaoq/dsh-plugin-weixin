import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import qrcode from 'qrcode-terminal';
import { credentialsSchema, apiOrigin } from './protocol.js';
import type { Credentials, ILinkClient, ApiOptions } from './protocol.js';
import { WeixinError } from './errors.js';

/** Read only this plugin's private credentials; parser failures never include credential values. */
export async function readCredentials(directory: string, hosts: readonly string[]): Promise<Credentials> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')); }
  catch (error) { throw new WeixinError('STATE', 'credentials', 'Cannot read credentials.json; run the login profile first.', false, { cause: error }); }
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success) throw new WeixinError('STATE', 'credentials', 'Invalid credentials.json; run a fresh QR login.');
  apiOrigin(parsed.data.baseUrl, hosts);
  return parsed.data;
}

/** Atomically replace this account's credential document, retaining owner-only file access. */
export async function saveCredentials(directory: string, auth: Credentials): Promise<void> {
  const path = join(directory, 'credentials.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(auth) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
}

export interface LoginIo {
  showQr(url: string): void;
  inform(message: string): void;
  verification(signal: AbortSignal): Promise<string>;
}

/** Terminal QR and verification input, owned only by the dedicated login profile. */
export const terminalLoginIo: LoginIo = {
  showQr(url) { console.log('用微信扫一扫下方二维码，确认连接 DSH：'); qrcode.generate(url, { small: true }); console.log(`二维码链接：${url}`); },
  inform(message) { console.log(message); },
  async verification(signal) {
    if (!process.stdin.isTTY) throw new WeixinError('STATE', 'login verification', 'Run the login profile in an interactive terminal to enter the code shown by WeChat.');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await input.question('输入手机微信显示的数字：', { signal })).trim(); }
    finally { input.close(); }
  },
};

/** Complete one bounded QR exchange, including IDC redirect and phone verification.
 * @param api - iLink client.
 * @param options - Trusted hosts and login timing.
 * @param signal - Plugin lifetime.
 * @param io - QR display and verification input.
 * @returns Validated credentials; the caller owns persistence.
 */
export async function login(api: Pick<ILinkClient, 'qr' | 'loginStatus'>, options: ApiOptions & { loginTimeoutMs: number; loginPollIntervalMs: number }, signal: AbortSignal, io: LoginIo): Promise<Credentials> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(options.loginTimeoutMs)]);
  const qr = await api.qr(combined);
  io.showQr(qr.qrcode_img_content);
  let base = apiOrigin(options.loginBaseUrl, options.allowedApiHosts);
  let code: string | undefined;
  while (true) {
    combined.throwIfAborted();
    let state;
    try { state = await api.loginStatus(base, qr.qrcode, combined, code); }
    catch (error) {
      if (combined.aborted || !(error instanceof WeixinError) || !error.retryable) throw error;
      io.inform('微信登录连接暂时中断，正在重试；无需重复扫码。');
      await delay(options.loginPollIntervalMs, undefined, { signal: combined });
      continue;
    }
    switch (state.status) {
      case 'wait': break;
      case 'scaned': code = undefined; break;
      case 'need_verifycode': code = await io.verification(combined); continue;
      case 'scaned_but_redirect':
        if (!state.redirect_host) throw new WeixinError('PROTOCOL', 'QR login', 'Missing redirect host.');
        base = apiOrigin(`https://${state.redirect_host}`, options.allowedApiHosts); break;
      case 'confirmed': {
        const parsed = credentialsSchema.safeParse({ version: 1, token: state.bot_token, botId: state.ilink_bot_id, userId: state.ilink_user_id, baseUrl: state.baseurl });
        if (!parsed.success) throw new WeixinError('PROTOCOL', 'QR login', 'Confirmed login is missing account credentials.');
        apiOrigin(parsed.data.baseUrl, options.allowedApiHosts);
        return parsed.data;
      }
      case 'expired': throw new WeixinError('AUTH_EXPIRED', 'QR login', 'QR code expired; run the login profile again.');
      case 'verify_code_blocked': throw new WeixinError('AUTH_EXPIRED', 'QR login', 'Verification was blocked; wait and start another login.');
      case 'binded_redirect': throw new WeixinError('STATE', 'QR login', 'This bot is already bound. Use its existing DSH credential directory or create a separate bot binding.');
      default: state.status satisfies never;
    }
    await delay(options.loginPollIntervalMs, undefined, { signal: combined });
  }
}
