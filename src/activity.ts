/** Native typing is task-owned, best effort and independent of model success or delivery. */
import { setTimeout as delay } from 'node:timers/promises';
import type { Credentials, ILinkClient, WeixinUserId } from './protocol.js';
import { describeError } from './errors.js';

export interface ActivityOptions { typingIntervalMs: number; shutdownTimeoutMs: number }

/** Keep one peer's indicator active until the operation and its cleanup settle. */
export async function withTyping<T>(
  api: Pick<ILinkClient, 'typingTicket' | 'typing'>, auth: Credentials,
  user: WeixinUserId, context: string, options: ActivityOptions,
  signal: AbortSignal, report: (message: string) => void, operation: () => Promise<T>,
): Promise<T> {
  if (options.typingIntervalMs === 0) return operation();
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  let ticket: string | undefined;
  const activity = (async () => {
    ticket = await api.typingTicket(auth, user, context, AbortSignal.any([lifetime, AbortSignal.timeout(options.shutdownTimeoutMs)]));
    if (!ticket) return;
    while (!lifetime.aborted) {
      await api.typing(auth, user, ticket, true, AbortSignal.any([lifetime, AbortSignal.timeout(options.shutdownTimeoutMs)]));
      await delay(options.typingIntervalMs, undefined, { signal: lifetime });
    }
  })().catch((error: unknown) => {
    if (!lifetime.aborted) report(`Typing indicator unavailable; the task continues. ${describeError(error)}`);
  });
  try { return await operation(); }
  finally {
    controller.abort();
    await activity;
    if (ticket) {
      try { await api.typing(auth, user, ticket, false, AbortSignal.timeout(options.shutdownTimeoutMs)); }
      catch (error) { report(`Typing indicator clear was not confirmed. ${describeError(error)}`); }
    }
  }
}
