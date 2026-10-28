/** One account supervisor: peer-ordered tasks, independent commands and durable delivery. */
import { setTimeout as delay } from 'node:timers/promises';
import { WeixinError, describeError } from './errors.js';
import type { Credentials, ILinkClient, WeixinUserId } from './protocol.js';
import type { Store, InboxRow } from './store.js';
import { Wakeup } from './wakeup.js';
import { withTyping } from './activity.js';
import { channelHelp } from './commands.js';
import type { PreparedInbound } from './media/types.js';
import type { MediaPipeline } from './media/pipeline.js';

/** Per-sender DSH conversations owned exclusively by this channel. */
export interface AgentDriver {
  respond(userId: WeixinUserId, input: string | PreparedInbound, signal: AbortSignal): Promise<string>;
  reset(userId: WeixinUserId): Promise<void>;
  cancel(userId: WeixinUserId): void;
}
export interface EngineOptions {
  allowedUsers: readonly string[];
  maxMediaItems?: number;
  maxImageBytes?: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  sessionRecoveryAttempts: number;
  queueIntervalMs: number;
  maxPromptChars: number;
  maxReplyChars: number;
  maxPendingMessages: number;
  maxConcurrentUsers: number;
  typingIntervalMs: number;
  shutdownTimeoutMs: number;
  outboundIntervalMs: number;
  historyRetentionDays: number;
}
interface RunningTask { readonly controller: AbortController; readonly task: Promise<void> }
class ControlCancellation extends WeixinError {
  constructor(readonly command: 'stop' | 'new') { super('AGENT', 'DSH task', 'Stopped by a WeChat control command.'); }
}

/** Owns all channel work; its returned promise is the sole drain operation. */
export class Engine {
  private readonly wakeup = new Wakeup();
  private readonly running = new Map<WeixinUserId, RunningTask>();
  private readonly barriers = new Map<WeixinUserId, Promise<void>>();
  private readonly children = new Set<Promise<void>>();
  constructor(
    private readonly api: Pick<ILinkClient, 'updates' | 'send' | 'notify' | 'typingTicket' | 'typing'>,
    private readonly auth: Credentials, private readonly store: Store,
    private readonly driver: AgentDriver, private readonly options: EngineOptions,
    private readonly report: (message: string) => void,
    private readonly media?: MediaPipeline,
  ) {}

  /** Stop admission and abort all I/O before draining peer work and releasing the driver. */
  async run(signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const loops: Promise<void>[] = [];
    try {
      this.store.recover();
      if (this.store.counts().unknown > 0) this.report('Earlier replies have unknown delivery status. Check the chat before using /retry; tasks will not be replayed.');
      loops.push(this.poll(combined), this.schedule(combined, controller), this.deliver(combined));
      if (this.media) loops.push(this.maintainMedia(combined));
      await Promise.all(loops);
    }
    finally {
      controller.abort();
      this.wakeup.notify();
      await Promise.allSettled(loops);
      await Promise.allSettled([...this.children]);
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const allowed = new Set(this.options.allowedUsers.length ? this.options.allowedUsers : [this.auth.userId]);
    let failures = 0;
    let recoveries = 0;
    while (!signal.aborted) {
      try {
        const result = await this.api.updates(this.auth, this.store.cursor(), signal);
        signal.throwIfAborted();
        this.store.accept(result.msgs, result.get_updates_buf, allowed, this.options.maxPromptChars, this.options.maxPendingMessages, this.options.maxMediaItems);
        this.wakeup.notify();
        if (failures > 0) this.report('WeChat connection recovered.');
        failures = 0;
        recoveries = 0;
        if (result.msgs.length === 0) await delay(this.options.queueIntervalMs, undefined, { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof WeixinError && error.code === 'AUTH_EXPIRED' && recoveries < this.options.sessionRecoveryAttempts) {
          recoveries++;
          this.report('WeChat session unavailable; attempting a bounded backend reconnect without changing credentials or replaying tasks.');
          await this.api.notify(this.auth, 'start', signal);
          await delay(this.options.reconnectDelayMs, undefined, { signal });
          continue;
        }
        if (!(error instanceof WeixinError) || !error.retryable) throw error;
        failures++;
        if (failures === 1) this.report(`${describeError(error)} Retrying polling; queued tasks remain durable.`);
        await delay(Math.min(this.options.reconnectMaxDelayMs, this.options.reconnectDelayMs * 2 ** Math.min(failures - 1, 30)), undefined, { signal });
      }
    }
  }

  private track(task: Promise<void>, controller: AbortController): void {
    const observed = task.catch((error: unknown) => { controller.abort(error); }).finally(() => {
      this.children.delete(observed);
      this.wakeup.notify();
    });
    this.children.add(observed);
  }

  private interrupt(user: WeixinUserId, command: 'stop' | 'new'): RunningTask | undefined {
    const running = this.running.get(user);
    if (running) {
      running.controller.abort(new ControlCancellation(command));
      this.driver.cancel(user);
    }
    return running;
  }

  private control(row: InboxRow, signal: AbortSignal, controller: AbortController): void {
    this.store.status(row.id, 'running');
    let text: string;
    switch (row.prompt.trim()) {
      case '/help': text = channelHelp(this.options); break;
      case '/status': {
        const count = this.store.counts(row.user_id);
        text = `微信已连接到本机 DSH。运行中：${this.running.has(row.user_id) ? 1 : 0}；排队：${count.queued}；待处理消息：${count.pending - 1}；投递结果未知：${count.unknown}；准备媒体：${count.preparing}。${this.media?.summary() ?? '语音识别与视频解析尚未启用。'}`;
        break;
      }
      case '/stop':
        this.interrupt(row.user_id, 'stop');
        text = '已请求停止当前任务，并取消该命令之前的排队任务。已完成的操作不会撤销。';
        break;
      case '/retry':
        if (this.store.retryLatest(row.user_id, row.context_token, this.options.maxReplyChars)) {
          this.store.ready(row.id, '已请求重发投递结果不明的回复；可能重复，不会重新运行任务。');
          this.store.status(row.id, 'done');
          return;
        }
        text = '没有投递结果不明的回复。';
        break;
      case '/new': {
        const active = this.interrupt(row.user_id, 'new');
        const previous = this.barriers.get(row.user_id);
        const barrier = Promise.resolve().then(async () => {
          await previous;
          await active?.task;
          signal.throwIfAborted();
          await this.driver.reset(row.user_id);
          signal.throwIfAborted();
          this.store.ready(row.id, '已开始新会话，历史会话仍保存在 DSH。');
        }).finally(() => {
          if (this.barriers.get(row.user_id) === barrier) this.barriers.delete(row.user_id);
          this.wakeup.notify();
        });
        this.barriers.set(row.user_id, barrier);
        this.track(barrier, controller);
        return;
      }
      default: throw new WeixinError('STATE', 'command', 'Unsupported persisted control command.');
    }
    this.store.ready(row.id, text);
  }

  private async schedule(signal: AbortSignal, supervisor: AbortController): Promise<void> {
    while (!signal.aborted) {
      for (const row of this.store.controls()) this.control(row, signal, supervisor);
      while (this.running.size < this.options.maxConcurrentUsers) {
        const row = this.store.nextTask([...this.running.keys(), ...this.barriers.keys()]);
        if (!row) break;
        this.store.status(row.id, 'running');
        this.store.preparingPhase(row.id);
        const controller = new AbortController();
        const taskSignal = AbortSignal.any([signal, controller.signal]);
        const task = Promise.resolve().then(() => this.execute(row, taskSignal, signal)).finally(() => {
          this.running.delete(row.user_id);
          this.wakeup.notify();
        });
        this.running.set(row.user_id, { controller, task });
        this.track(task, supervisor);
      }
      this.wakeup.notify();
      await this.wakeup.wait(this.wakeup.version(), signal);
    }
    signal.throwIfAborted();
  }

  private async execute(row: InboxRow, taskSignal: AbortSignal, channelSignal: AbortSignal): Promise<void> {
    let agentStarted = false;
    try {
      taskSignal.throwIfAborted();
      const text = await withTyping(this.api, this.auth, row.user_id, row.context_token, this.options, taskSignal, this.report, async () => {
        const prepared = this.media ? await this.media.prepare(row, taskSignal) : undefined;
        taskSignal.throwIfAborted();
        if (prepared && !prepared.usable) return prepared.notices.join('\n') || '没有可供处理的文字或图片，请重新发送。';
        if (!prepared && JSON.parse(row.input_json).parts.some((part: { type: string }) => part.type !== 'text')) return '图片准备服务尚未启用，请发送文字。';
        this.store.agentPhase(row.id);
        agentStarted = true;
        const reply = await this.driver.respond(row.user_id, prepared ?? row.prompt, taskSignal);
        return (prepared?.notices.length ? `${prepared.notices.join('\n')}\n以下仅依据已提供的文字和图片回答：\n` : '') + (reply || 'DSH 已完成任务，但没有返回文字。');
      });
      taskSignal.throwIfAborted();
      this.store.ready(row.id, text);
    } catch (error) {
      if (channelSignal.aborted) throw error;
      this.report(describeError(error));
      if (agentStarted && !(taskSignal.reason instanceof ControlCancellation && taskSignal.reason.command === 'new')) await this.driver.reset(row.user_id);
      channelSignal.throwIfAborted();
      this.store.ready(row.id, !agentStarted ? (taskSignal.aborted ? '媒体准备已停止，没有交给模型。' : '媒体准备未完成，没有交给模型。请重发文字或图片。') : taskSignal.aborted ? '任务已停止，已完成的操作不会撤销。后续消息会使用新会话。' :
        '本次 DSH 任务未成功完成，工作区可能已有部分改动。请在电脑上查看 DSH 日志；后续消息会使用新会话。');
    }
  }

  private async maintainMedia(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await delay(60 * 60 * 1000, undefined, { signal });
      signal.throwIfAborted();
      await this.media!.prune();
    }
  }

  private async deliver(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const version = this.wakeup.version();
      const part = this.store.nextDelivery(this.options.maxReplyChars);
      if (!part) { await this.wakeup.wait(version, signal); continue; }
      this.store.startDelivery(part);
      try {
        await this.api.send(this.auth, { userId: part.user_id, contextToken: part.context_token, clientId: part.client_id, text: part.text }, signal);
        this.store.acknowledge(part);
      } catch (error) {
        this.store.unknown(part);
        if (signal.aborted) throw error;
        this.report(`${describeError(error)} Reply delivery is unknown. Check the chat before using /retry; no automatic resend or task replay will occur.`);
        if (error instanceof WeixinError && error.code === 'AUTH_EXPIRED') throw error;
      }
      if (this.media) await this.media.prune();
      else this.store.prune(this.options.historyRetentionDays);
      if (this.options.outboundIntervalMs > 0) await delay(this.options.outboundIntervalMs, undefined, { signal });
    }
  }
}
