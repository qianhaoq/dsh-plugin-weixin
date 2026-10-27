import { setTimeout as delay } from 'node:timers/promises';
import { WeixinError, describeError } from './errors.js';
import type { Credentials, ILinkClient, WeixinUserId } from './protocol.js';
import type { Store, InboxRow } from './store.js';

/** Per-sender DSH conversations owned exclusively by this channel. */
export interface AgentDriver {
  respond(userId: WeixinUserId, text: string, signal: AbortSignal): Promise<string>;
  reset(userId: WeixinUserId): Promise<void>;
  cancel(userId: WeixinUserId): void;
  close(): Promise<void>;
}
export interface EngineOptions {
  allowedUsers: readonly string[];
  reconnectDelayMs: number;
  queueIntervalMs: number;
  maxPromptChars: number;
  maxReplyChars: number;
  maxPendingMessages: number;
  historyRetentionDays: number;
}

/** Separate long polling from serial work so /stop can cancel a running turn. */
export class Engine {
  constructor(
    private readonly api: Pick<ILinkClient, 'updates' | 'send'>,
    private readonly auth: Credentials, private readonly store: Store,
    private readonly driver: AgentDriver, private readonly options: EngineOptions,
    private readonly report: (message: string) => void,
  ) {}

  /** Own and drain both loops. Shutdown aborts networking before disposing DSH Agents. */
  async run(signal: AbortSignal): Promise<void> {
    this.store.recover();
    if (this.store.counts().unknown > 0) this.report('Some earlier replies have unknown delivery status; they will not be resent. Inspect messages.sqlite before asking the user to repeat a task.');
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const loops = [this.poll(combined), this.work(combined)];
    try { await Promise.all(loops); }
    finally {
      controller.abort();
      await Promise.allSettled(loops);
      await this.driver.close();
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const allowed = new Set(this.options.allowedUsers.length ? this.options.allowedUsers : [this.auth.userId]);
    let degraded = false;
    while (!signal.aborted) {
      if (this.store.counts().pending >= this.options.maxPendingMessages) { await delay(this.options.queueIntervalMs, undefined, { signal }); continue; }
      try {
        const result = await this.api.updates(this.auth, this.store.cursor(), signal);
        signal.throwIfAborted();
        const messages = this.store.accept(result.msgs, result.get_updates_buf, allowed, this.options.maxPromptChars);
        for (const message of messages) {
          if (message.item_list.length === 1 && message.item_list[0]?.text_item?.text.trim() === '/stop') this.driver.cancel(message.from_user_id);
        }
        if (degraded) { this.report('WeChat connection recovered.'); degraded = false; }
        if (result.msgs.length === 0) await delay(this.options.queueIntervalMs, undefined, { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof WeixinError) || !error.retryable) throw error;
        if (!degraded) this.report(`${describeError(error)} Retrying message polling; queued tasks remain durable.`);
        degraded = true;
        await delay(this.options.reconnectDelayMs, undefined, { signal });
      }
    }
  }

  private async work(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const row = this.store.next();
      if (!row) { await delay(this.options.queueIntervalMs, undefined, { signal }); continue; }
      if (row.status === 'received') {
        this.store.status(row.id, 'running');
        try {
          const text = await this.reply(row, signal);
          signal.throwIfAborted();
          this.store.ready(row.id, this.boundReply(text));
        } catch (error) {
          if (signal.aborted) throw error;
          this.report(describeError(error));
          await this.driver.reset(row.user_id);
          this.store.ready(row.id, '本次 DSH 任务未成功完成，工作区可能已有部分改动。请在电脑上查看 DSH 日志；后续消息会使用新会话。');
        }
        continue;
      }
      this.store.status(row.id, 'sending');
      try {
        await this.api.send(this.auth, { userId: row.user_id, contextToken: row.context_token, clientId: row.client_id, text: row.reply ?? '' }, signal);
        this.store.status(row.id, 'done');
      } catch (error) {
        this.store.status(row.id, 'unknown');
        if (signal.aborted) throw error;
        this.report(`${describeError(error)} Reply delivery is unknown; no automatic resend or task replay will occur.`);
        if (error instanceof WeixinError && error.code === 'AUTH_EXPIRED') throw error;
      }
      this.store.prune(this.options.historyRetentionDays);
    }
  }

  private async reply(row: InboxRow, signal: AbortSignal): Promise<string> {
    switch (row.prompt.trim()) {
      case '/help': return '直接发送文字即可交给 DSH。\n/new：新建会话\n/stop：停止当前任务\n/status：查看连接状态\n当前只支持文字消息。';
      case '/new': await this.driver.reset(row.user_id); return '已开始新会话，历史会话仍保存在 DSH。';
      case '/stop': this.driver.cancel(row.user_id); return '已请求停止当前任务。已完成的文件或命令操作不会撤销。';
      case '/status': return `微信已连接到本机 DSH。待处理消息：${this.store.counts().pending - 1}；投递结果未知：${this.store.counts().unknown}。`;
      default: return this.driver.respond(row.user_id, row.prompt, signal);
    }
  }
  private boundReply(text: string): string {
    const points = Array.from(text || 'DSH 已完成任务，但没有返回文字。');
    return points.length <= this.options.maxReplyChars ? points.join('') : points.slice(0, this.options.maxReplyChars).join('') + '\n[回复已截断，完整结果请在电脑上查看 DSH 会话。]';
  }
}
