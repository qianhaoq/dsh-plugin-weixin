/** Cordis bundle entry for direct WeChat ClawBot text messaging in DSH. */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { ILinkClient, apiOrigin } from './protocol.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { DshDriver } from './driver.js';
import { login, readCredentials, saveCredentials, terminalLoginIo } from './login.js';
import { describeError, WeixinError } from './errors.js';

/** Cordis plugin identity. */
export const name = 'weixin';

/** Background failures remain visible even in profiles with no Cordis log exporter. */
function report(ctx: Context, level: 'warn' | 'error', message: string): void {
  ctx.logger[level](message);
  console.error(message);
}

const optionsSchema = z.object({
  mode: z.enum(['disabled', 'login', 'run', 'status']).default('disabled'),
  stateDirectory: z.string().default(join(resolveDshHome(), 'weixin')),
  workspaceRoot: z.string().optional(),
  allowedUsers: z.array(z.string().min(1)).default([]),
  allowedApiHosts: z.array(z.string().min(1)).min(1).default(['ilinkai.weixin.qq.com', 'ilinkai.wxqcloud.qq.com']),
  loginBaseUrl: z.string().default('https://ilinkai.weixin.qq.com'),
  agentPreset: z.string().default('standard'), permissionPreset: z.string().default('read-only'),
  provider: z.string().min(1).optional(), model: z.string().min(1).optional(),
  requestTimeoutMs: z.number().int().min(100).default(15000),
  pollTimeoutMs: z.number().int().min(100).default(40000),
  loginTimeoutMs: z.number().int().min(100).default(300000),
  loginPollIntervalMs: z.number().int().min(10).default(1000),
  reconnectDelayMs: z.number().int().min(10).default(3000),
  queueIntervalMs: z.number().int().min(10).default(250),
  taskTimeoutMs: z.number().int().min(100).default(180000),
  maxPromptChars: z.number().int().positive().default(16000),
  maxReplyChars: z.number().int().min(100).default(1800),
  maxPendingMessages: z.number().int().positive().default(100),
  historyRetentionDays: z.number().int().positive().default(30),
}).strict();

/** Deployment configuration. State and workspace paths must be absolute. */
export type Config = z.input<typeof optionsSchema>;
export const Config = Schema.object({
  mode: Schema.union(['disabled', 'login', 'run', 'status']).default('disabled'),
  stateDirectory: Schema.string(), workspaceRoot: Schema.string(),
  allowedUsers: Schema.array(Schema.string()), allowedApiHosts: Schema.array(Schema.string()).default(['ilinkai.weixin.qq.com', 'ilinkai.wxqcloud.qq.com']),
  loginBaseUrl: Schema.string(), agentPreset: Schema.string(), permissionPreset: Schema.string(),
  provider: Schema.string(), model: Schema.string(),
  requestTimeoutMs: Schema.number(), pollTimeoutMs: Schema.number(), loginTimeoutMs: Schema.number(),
  loginPollIntervalMs: Schema.number(), reconnectDelayMs: Schema.number(), queueIntervalMs: Schema.number(),
  taskTimeoutMs: Schema.number(), maxPromptChars: Schema.number(), maxReplyChars: Schema.number(),
  maxPendingMessages: Schema.number(), historyRetentionDays: Schema.number(),
});

/** Validate all deployment fields before registering effects. */
export function resolveConfig(input: Config): z.output<typeof optionsSchema> {
  const result = optionsSchema.safeParse(input);
  if (!result.success) throw new WeixinError('STATE', 'configuration', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const config = result.data;
  if (!isAbsolute(config.stateDirectory) || (config.workspaceRoot !== undefined && !isAbsolute(config.workspaceRoot))) throw new WeixinError('STATE', 'configuration', 'stateDirectory and workspaceRoot must be absolute paths.');
  if (config.mode === 'run' && !config.workspaceRoot) throw new WeixinError('STATE', 'configuration', 'Run mode requires an explicit workspaceRoot.');
  if (Boolean(config.provider) !== Boolean(config.model)) throw new WeixinError('STATE', 'configuration', 'provider and model must be specified together.');
  apiOrigin(config.loginBaseUrl, config.allowedApiHosts);
  return config;
}

/** Register login or a service-dependent runtime. Every background operation drains on unload.
 * @param ctx - Plugin-owned Cordis context.
 * @param input - Deployment options validated before network or filesystem effects.
 */
export function apply(ctx: Context, input: Config): void {
  const config = resolveConfig(input);
  if (config.mode === 'disabled') return;
  const mount = (ctx: Context): void => {
    ctx.effect(() => {
      const controller = new AbortController();
      const task = (async () => {
        await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
        const release = await lockfile.lock(await realpath(config.stateDirectory), { retries: 0, onCompromised: () => {
          report(ctx, 'error', 'weixin: account lock ownership was lost; channel is stopping.');
          controller.abort(new WeixinError('STATE', 'account lock', 'Account ownership was lost; channel stopped.'));
        } });
        let store: Store | undefined;
        try {
          const api = new ILinkClient(config);
          if (config.mode === 'login') {
            const auth = await login(api, config, controller.signal, terminalLoginIo);
            store = new Store(config.stateDirectory, auth.botId);
            await saveCredentials(config.stateDirectory, auth);
            console.log('weixin: 登录成功，凭据已保存在插件数据目录。启动配置好的 Web profile 以接收消息。');
            queueMicrotask(() => { ctx.get('appExit')?.(0); });
            return;
          }
          const auth = await readCredentials(config.stateDirectory, config.allowedApiHosts);
          store = new Store(config.stateDirectory, auth.botId);
          if (config.mode === 'status') {
            console.log(`weixin: authenticated; pending=${store.counts().pending}; unknown=${store.counts().unknown}`);
            queueMicrotask(() => { ctx.get('appExit')?.(0); });
            return;
          }
          const workspaceRoot = await realpath(config.workspaceRoot!);
          if (!(await stat(workspaceRoot)).isDirectory()) throw new WeixinError('STATE', 'workspace', 'workspaceRoot must be an existing directory.');
          const driver = new DshDriver(ctx, store, { ...config, workspaceRoot });
          await driver.initialize();
          console.error('weixin: channel started; only explicitly allowed senders can run DSH tasks.');
          try {
            await api.notify(auth, 'start', controller.signal);
            await new Engine(api, auth, store, driver, config, message => report(ctx, 'warn', `weixin: ${message}`)).run(controller.signal);
          } finally {
            await driver.close();
            try { await api.notify(auth, 'stop', AbortSignal.timeout(config.requestTimeoutMs)); }
            catch (error) { report(ctx, 'warn', `weixin: stop notification was not confirmed. ${describeError(error)}`); }
          }
        } finally { store?.close(); await release(); }
      })().catch((error: unknown) => {
        if (!controller.signal.aborted || error !== controller.signal.reason) {
          report(ctx, 'error', `weixin: channel stopped. ${describeError(error)}`);
          if (config.mode !== 'run') queueMicrotask(() => { ctx.get('appExit')?.(1); });
        }
      });
      return async () => { controller.abort(); await task; };
    }, 'weixin.account');
  };
  if (config.mode === 'run') ctx.inject(['agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessions', 'workspaceRegistry', 'subagents'], mount);
  else mount(ctx);
}
