/** Cordis owns the account lifetime; runtime.ts owns its resources and shutdown order. */
import type { Context } from '@deepseek-ai/cordis';
import { ILinkClient } from './protocol.js';
import { DshDriver } from './driver.js';
import { terminalLoginIo } from './login.js';
import { describeError } from './errors.js';
import { resolveConfig } from './config.js';
import type { Config } from './config.js';
import { runAccount } from './runtime.js';
export { Config, resolveConfig } from './config.js';

/** Cordis plugin identity. */
export const name = 'weixin';

/** Background failures remain visible in profiles without a Cordis log exporter. */
function report(ctx: Context, message: string): void {
  console.error(`weixin: ${message}`);
  try { ctx.logger.warn(`weixin: ${message}`); }
  catch (_error: unknown) { console.error('weixin: Cordis log export failed; the report above remains available on stderr.'); }
}

/** Register one awaitable account lifetime under its actual DSH service dependencies.
 * @param ctx - Plugin-owned context.
 * @param input - Deployment fields validated before any effect is registered.
 */
export function apply(ctx: Context, input: Config): void {
  const config = resolveConfig(input);
  if (config.mode === 'disabled') return;
  const mount = (ctx: Context): void => {
    ctx.effect(() => {
      const controller = new AbortController();
      const task = runAccount(config, controller.signal, {
        api: new ILinkClient(config), loginIo: terminalLoginIo,
        driver: (store, workspaceRoot) => new DshDriver(ctx, store, { ...config, workspaceRoot }),
        report: message => report(ctx, message),
        output: message => console.log(`weixin: ${message}`),
      }).then(() => {
        if (config.mode !== 'run') ctx.get('appExit')?.(0);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted || error !== controller.signal.reason) {
          report(ctx, `Channel stopped. ${describeError(error)}`);
          if (config.mode !== 'run') ctx.get('appExit')?.(1);
        }
      });
      return async () => { controller.abort(); await task; };
    }, 'weixin.account');
  };
  if (config.mode === 'run') ctx.inject(['agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessions', 'workspaceRegistry', 'subagents', 'systemPrompt'], mount);
  else mount(ctx);
}
