import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { brandString } from '@deepseek-ai/dsh-brand';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { AgentDriver } from './engine.js';
import type {} from '@deepseek-ai/dsh-attachment';
import type { PreparedInbound } from './media/types.js';
import type { Store } from './store.js';
import type { WeixinUserId } from './protocol.js';
import { WeixinError } from './errors.js';
import { channelGuide } from './commands.js';

/** Resume can race with another owner after the registry check. */
function isSessionConflict(error: unknown): boolean {
  return error instanceof Error && /active under another owner|(?:agent|session) .+ (?:already registered|already live)|Saved Session belongs to another workspace/iu.test(error.message);
}

export interface DriverOptions {
  workspaceRoot: string;
  agentPreset: string;
  permissionPreset: string;
  taskTimeoutMs: number;
  provider?: string | undefined;
  model?: string | undefined;
}

/** Creates only channel-owned Sessions; it never borrows a browser-owned live Agent. */
export class DshDriver implements AgentDriver {
  private readonly handles = new Map<WeixinUserId, AgentHandle>();
  private readonly active = new Map<WeixinUserId, AbortController>();
  private closing = false;
  constructor(private readonly ctx: Context, private readonly store: Store, private readonly options: DriverOptions) {}

  async initialize(): Promise<void> {
    if (!this.ctx.attachments || !this.ctx.llm) throw new WeixinError('STATE', 'run dependencies', 'Run mode requires attachments and llm services.');
    this.ctx.permissionPresets.resolve(this.options.permissionPreset);
    await this.ctx.agentPresets.resolve(this.options.agentPreset);
  }

  private async handle(user: WeixinUserId, signal: AbortSignal): Promise<AgentHandle> {
    if (this.closing) throw new WeixinError('AGENT', 'conversation', 'Channel is closing.');
    signal.throwIfAborted();
    const current = this.handles.get(user);
    if (current) {
      if (this.ctx.agents.get(current.agent.session.header.id) === current.agent) return current;
      // A disposed/unregistered channel handle cannot accept another task.
      await this.reset(user);
    }
    const existing = this.store.session(user);
    const workspace = await this.ctx.workspaceRegistry.create(this.options.workspaceRoot);
    const preset = (await this.ctx.agentPresets.resolve(this.options.agentPreset)).id;
    const options = this.options.provider && this.options.model ? { provider: this.options.provider, model: this.options.model } : this.ctx.agentDefaultModel.currentSelection();
    const selection = { current: options.provider && options.model ? { provider: options.provider, model: options.model } : undefined, assembled: undefined };
    const setup = async (ctx: Context): Promise<void> => {
      installModelSelection(ctx, selection);
      await this.ctx.agentPresets.mount(ctx, preset);
      ctx.systemPrompt.section({
        name: 'weixin:channel', order: ctx.systemPrompt.getSectionOrder('WEB_SURFACE'),
        text: channelGuide,
      });
    };
    const id = brandString<SessionId>(existing ?? `weixin-${randomUUID()}`);
    signal.throwIfAborted();
    if (existing && this.ctx.agents.get(id)) {
      // Never borrow or dispose another owner's live Agent: replace only our binding.
      this.store.forget(user);
      return this.handle(user, signal);
    }
    let handle: AgentHandle;
    try {
      handle = existing ? await this.ctx.agents.resume({ resumeSessionId: id, agentOptions: options, signal, setup }) :
        await this.ctx.agents.create({ sessionId: id, agentOptions: options, signal, meta: { cwd: workspace.path, agentPreset: preset }, setup });
    } catch (error) {
      signal.throwIfAborted();
      if (!existing || (!this.ctx.agents.get(id) && !isSessionConflict(error))) throw error;
      this.store.forget(user);
      return this.handle(user, signal);
    }
    this.handles.set(user, handle);
    let workspaceMismatch = false;
    try {
      signal.throwIfAborted();
      workspaceMismatch = handle.agent.session.header.cwd !== workspace.path;
      if (workspaceMismatch) throw new WeixinError('AGENT', 'conversation', 'Saved Session belongs to another workspace.');
      this.ctx.permissionPresets.set(handle.agent.session, this.options.permissionPreset);
      setApprovalPolicy(handle.agent.session, 'never');
      if (!existing) await workspace.attachSession(id);
      await this.ctx.sessions.flush(handle.agent.session);
      this.store.bind(user, id);
      return handle;
    } catch (error) {
      try { await handle.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Agent setup and rollback failed.'); }
      finally { this.handles.delete(user); }
      if (existing && workspaceMismatch && !signal.aborted) {
        this.store.forget(user);
        return this.handle(user, signal);
      }
      throw error;
    }
  }

  /** Resolve the actual Session route; unknown image capability is unavailable. */
  async imageCapable(user: WeixinUserId, signal: AbortSignal): Promise<boolean> {
    const { agent } = await this.handle(user, signal);
    const routed = agent.session.requestHeader()?.config;
    const provider = routed?.provider ?? agent.options.provider;
    const model = routed?.model ?? agent.options.model;
    if (!provider || !model || !this.ctx.llm) return false;
    try { return (await this.ctx.llm.resolveModelInfo(provider, model, signal)).inputModalities?.includes('image') === true; }
    catch { signal.throwIfAborted(); return false; }
  }

  /** Submit logged user input, await root and child quiescence, then flush before delivery. */
  async respond(user: WeixinUserId, input: string | PreparedInbound, signal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    this.active.set(user, controller);
    try { return await this.run(user, input, AbortSignal.any([signal, controller.signal, AbortSignal.timeout(this.options.taskTimeoutMs)])); }
    catch (error) {
      if (signal.aborted || error instanceof WeixinError) throw error;
      throw new WeixinError('AGENT', 'DSH task', 'Task failed or reached taskTimeoutMs; inspect the local DSH Session.', false, { cause: error });
    }
    finally { this.active.delete(user); }
  }

  private async run(user: WeixinUserId, input: string | PreparedInbound, combined: AbortSignal): Promise<string> {
    const { agent } = await this.handle(user, combined);
    let reply = '';
    let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined;
    let failure = false;
    const offEvent = this.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return;
      if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
        const text = event.data.message.content.filter(item => item.type === 'text').map(item => item.text).join('');
        if (text) reply = text;
      }
      if (event.type === 'turn/end') { reason = event.data.reason; failure = reason.kind === 'error'; }
    });
    const offError = this.ctx.on('agent/error', ({ agent: subject }) => { if (subject === agent) failure = true; });
    let drain: Promise<void> = Promise.resolve();
    const cancel = (): void => {
      agent.cancel({ kind: 'user' });
      drain = this.ctx.subagents.drainDescendants([agent]);
      // The run finalizer retains and propagates the drain rejection after the idle wait.
      void drain.catch((_error: unknown) => undefined);
    };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      combined.throwIfAborted();
      if (typeof input !== 'string' && input.content.some(part => part.type === 'image') && !await this.imageCapable(user, combined)) throw new WeixinError('AGENT', 'image route', 'Current model route no longer declares image input.');
      combined.throwIfAborted();
      agent.followup(createUserMessage({ content: typeof input === 'string' ? [{ type: 'text', text: input }] : input.content, source: { kind: 'user' } }));
      while (true) {
        await agent.whenIdle();
        const seq = agent.session.seq;
        if (!await this.ctx.subagents.waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === seq) break;
      }
      await this.ctx.sessions.flush(agent.session);
      await drain;
      combined.throwIfAborted();
      if (failure || reason?.kind !== 'completed') throw new WeixinError('AGENT', 'DSH task', 'Task did not complete; inspect the local Session.');
      return reply;
    } finally {
      combined.removeEventListener('abort', cancel);
      offEvent(); offError();
      await drain;
    }
  }

  cancel(user: WeixinUserId): void {
    this.active.get(user)?.abort(new WeixinError('AGENT', 'DSH task', 'Task was stopped; completed effects are retained.'));
  }
  async reset(user: WeixinUserId): Promise<void> {
    const handle = this.handles.get(user);
    if (handle) await handle.dispose();
    this.store.forget(user);
    this.handles.delete(user);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.values()) controller.abort();
    const handles = [...this.handles.values()];
    this.handles.clear();
    const errors: unknown[] = [];
    try { await this.ctx.subagents.drainDescendants(handles.map(handle => handle.agent)); }
    catch (error) { errors.push(error); }
    const results = await Promise.allSettled(handles.map(handle => handle.dispose()));
    errors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
    if (errors.length) throw new AggregateError(errors, 'Weixin Agent cleanup failed.');
  }
}
