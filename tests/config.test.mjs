import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply, resolveConfig, Config } from '../dist/index.js';

test('installation is disabled until login and a workspace are explicitly configured', async () => {
  const context = new Context();
  try { assert.equal(resolveConfig({}).mode, 'disabled'); apply(context, {}); }
  finally { await context.fiber.dispose(); }
});

test('invalid run configuration fails before starting side effects', () => {
  for (const value of [{ mode: 'run' }, { mode: 'run', workspaceRoot: 'relative' }, { provider: 'route' }, { maxPendingMessages: 0 }, { loginBaseUrl: 'https://untrusted.test' }]) assert.throws(() => resolveConfig(value));
});

test('Cordis schema defaults preserve the trusted-host allowlist before runtime validation', () => {
  const resolved = resolveConfig(Config({ mode: 'status' }));
  assert.deepEqual(resolved.allowedApiHosts, ['ilinkai.weixin.qq.com', 'ilinkai.wxqcloud.qq.com']);
  assert.equal(resolved.requestTimeoutMs, 15000);
  assert.equal(resolved.permissionPreset, 'danger-full-access');
});

test('Cordis forwards scheduling and activity options including explicit zero values', () => {
  const input = { maxConcurrentUsers: 2, maxPendingMessages: 8, reconnectMaxDelayMs: 9000, sessionRecoveryAttempts: 0, typingIntervalMs: 0, outboundIntervalMs: 0, shutdownTimeoutMs: 500 };
  const config = resolveConfig(Config(input));
  for (const [key, value] of Object.entries(input)) assert.equal(config[key], value);
  assert.throws(() => resolveConfig({ reconnectDelayMs: 1000, reconnectMaxDelayMs: 10 }));
});
