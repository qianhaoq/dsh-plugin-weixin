/** Account resources are acquired and released by one owner, including failed startup. */
import { realpath, stat } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import type { ResolvedConfig } from './config.js';
import type { Credentials, ILinkClient, WeixinUserId } from './protocol.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import type { AgentDriver } from './engine.js';
import { login, readCredentials, saveCredentials } from './login.js';
import type { MediaPipeline } from './media/pipeline.js';
import { privateDirectory } from './media/storage.js';
import type { LoginIo } from './login.js';
import { WeixinError, describeError } from './errors.js';

export interface RuntimeDriver extends AgentDriver {
  initialize(): Promise<void>;
  imageCapable?(user: WeixinUserId, signal: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
/** Dependencies are explicit so lifecycle tests use real storage without external messaging. */
export interface RuntimeDependencies {
  readonly api: Pick<ILinkClient, 'qr' | 'loginStatus' | 'updates' | 'send' | 'notify' | 'typingTicket' | 'typing'>;
  readonly loginIo: LoginIo;
  readonly driver: (store: Store, workspaceRoot: string) => RuntimeDriver;
  readonly media?: (store: Store, driver: RuntimeDriver) => MediaPipeline;
  readonly report: (message: string) => void;
  readonly output: (message: string) => void;
}

/** Run one locked account. Driver work drains before SQLite and the lock are released.
 * @param config - Fully validated deployment options.
 * @param signal - Plugin lifetime.
 * @param dependencies - Account transport, DSH adapter and report sinks.
 * @returns A terminal command mode, or `run` when the channel stops.
 */
export async function runAccount(config: ResolvedConfig, signal: AbortSignal, dependencies: RuntimeDependencies): Promise<ResolvedConfig['mode']> {
  signal.throwIfAborted();
  privateDirectory(config.stateDirectory);
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const release = await lockfile.lock(await realpath(config.stateDirectory), { retries: 0, onCompromised: () => {
    dependencies.report('Account lock ownership was lost; the channel is stopping.');
    controller.abort(new WeixinError('STATE', 'account lock', 'Account ownership was lost; channel stopped.'));
  } });
  let store: Store | undefined;
  let driver: RuntimeDriver | undefined;
  let auth: Credentials | undefined;
  let notificationAttempted = false;
  const failures: unknown[] = [];
  try {
    lifetime.throwIfAborted();
    if (config.mode === 'login') {
      auth = await login(dependencies.api, config, lifetime, dependencies.loginIo);
      lifetime.throwIfAborted();
      store = new Store(config.stateDirectory, auth.botId);
      await saveCredentials(config.stateDirectory, auth);
      dependencies.output('登录成功，凭据已保存在插件数据目录。启动配置好的 Web profile 以接收消息。');
    } else {
      auth = await readCredentials(config.stateDirectory, config.allowedApiHosts);
      lifetime.throwIfAborted();
      store = new Store(config.stateDirectory, auth.botId);
      if (config.mode === 'status') {
        const count = store.counts();
        dependencies.output(`authenticated; pending=${count.pending}; unknown=${count.unknown}`);
      } else if (config.mode === 'run') {
        const workspace = await realpath(config.workspaceRoot!);
        if (!(await stat(workspace)).isDirectory()) throw new WeixinError('STATE', 'workspace', 'workspaceRoot must be an existing directory.');
        lifetime.throwIfAborted();
        driver = dependencies.driver(store, workspace);
        await driver.initialize();
        const media = dependencies.media?.(store, driver);
        await media?.initialize();
        lifetime.throwIfAborted();
        notificationAttempted = true;
        await dependencies.api.notify(auth, 'start', lifetime);
        dependencies.output('channel started; only explicitly allowed senders can run DSH tasks.');
        await new Engine(dependencies.api, auth, store, driver, config, dependencies.report, media).run(lifetime);
      }
    }
  } catch (error) { failures.push(error); }
  finally {
    // Each cleanup is attempted even if another resource cannot be released.
    if (driver) { try { await driver.close(); } catch (error) { failures.push(error); } }
    if (store) { try { store.close(); } catch (error) { failures.push(error); } }
    if (notificationAttempted && auth) {
      try { await dependencies.api.notify(auth, 'stop', AbortSignal.timeout(config.shutdownTimeoutMs)); }
      catch (error) { dependencies.report(`Stop notification was not confirmed. ${describeError(error)}`); }
    }
    try { await release(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Account runtime or cleanup failed.');
  return config.mode;
}
