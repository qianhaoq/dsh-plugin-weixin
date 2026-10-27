/** Actual DSH Agent fixture; the parent process owns the mocked model and teardown. */
import { writeFile } from 'node:fs/promises';
import { Store } from '../../dist/store.js';
import { DshDriver } from '../../dist/driver.js';

export const name = 'weixin-driver-smoke';
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessions', 'workspaceRegistry', 'subagents'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController();
    const task = (async () => {
      await ctx.get('loader')?.await();
      const store = new Store(config.stateDirectory, 'fixture-bot');
      let driver;
      try {
        const options = { workspaceRoot: config.workspaceRoot, agentPreset: 'standard', permissionPreset: 'read-only', taskTimeoutMs: 60000, provider: 'deepseek-official', model: 'deepseek-flash' };
        driver = new DshDriver(ctx, store, options);
        await driver.initialize();
        const first = await driver.respond('fixture-owner', '微信第一条测试消息，请回复测试文字。', controller.signal);
        const firstId = store.session('fixture-owner');
        await driver.close();
        driver = new DshDriver(ctx, store, options);
        await driver.initialize();
        const second = await driver.respond('fixture-owner', '微信第二条测试消息，请继续回复测试文字。', controller.signal);
        await writeFile(config.outputPath, JSON.stringify({ replies: [first, second], sessionReused: store.session('fixture-owner') === firstId }));
        console.log('weixin-driver-smoke: complete');
      } finally { await driver?.close(); store.close(); }
    })().catch(async error => {
      await writeFile(config.outputPath, JSON.stringify({ error: error.message }));
      console.log('weixin-driver-smoke: complete');
    });
    return async () => { controller.abort(); await task; };
  });
}
