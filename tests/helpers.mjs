import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../dist/store.js';
export const auth = { version: 1, token: 'fixture-token', botId: 'fixture-bot', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' };
export const apiOptions = { requestTimeoutMs: 1000, pollTimeoutMs: 1000, allowedApiHosts: ['ilinkai.weixin.qq.com'], loginBaseUrl: 'https://ilinkai.weixin.qq.com' };
export const engineOptions = { allowedUsers: [], reconnectDelayMs: 10, queueIntervalMs: 10, maxPromptChars: 1000, maxReplyChars: 100, maxPendingMessages: 100, historyRetentionDays: 30 };
export const message = (id = '1', text = 'hello', user = 'owner') => ({ message_id: id, from_user_id: user, message_type: 1, context_token: `context-${id}`, item_list: [{ type: 1, text_item: { text } }] });
export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-test-'));
  const store = new Store(directory, auth.botId);
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  return { directory, store, onCleanup: cleanup => cleanups.push(cleanup) };
}
export function blocked(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
export async function eventually(condition) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Expected observable state did not arrive.');
    await setImmediate();
  }
}
