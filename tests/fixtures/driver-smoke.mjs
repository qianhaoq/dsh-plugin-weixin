/** Actual DSH Agent fixture; the parent process owns the mocked model and teardown. */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../../dist/store.js';
import { DshDriver } from '../../dist/driver.js';
import { runAccount } from '../../dist/runtime.js';
import { resolveConfig } from '../../dist/config.js';

async function pipeline(ctx, options, root, parentSignal) {
  const state = join(root, 'pipeline'); await mkdir(state);
  await writeFile(join(state, 'credentials.json'), JSON.stringify({ version: 1, token: 'fixture-token', botId: 'fixture-bot', userId: 'fixture-owner', baseUrl: 'https://ilinkai.weixin.qq.com' }), { mode: 0o600 });
  const replies = []; const sessions = []; const cursors = [];
  for (const round of [1, 2]) {
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const parts = [];
    let polled = false;
    const api = {
      async notify() {},
      async updates(auth, cursor, signal) {
        if (!polled) {
          polled = true; cursors.push(cursor);
          return { msgs: [{ message_id: `pipeline-${round}`, from_user_id: 'fixture-owner', message_type: 1, context_token: 'fixture-context', item_list: [{ type: 1, text_item: { text: `流水线第${round}条测试消息` } }] }], get_updates_buf: `pipeline-cursor-${round}` };
        }
        signal.throwIfAborted();
        return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      },
      async send(auth, part) { parts.push(part.text); },
    };
    const config = resolveConfig({ ...options, mode: 'run', stateDirectory: state, typingIntervalMs: 0, outboundIntervalMs: 0, maxReplyChars: 100 });
    let failure;
    const running = runAccount(config, signal, { api, loginIo: {}, driver: (store, workspaceRoot) => new DshDriver(ctx, store, { ...config, workspaceRoot }), report() {}, output() {} });
    running.catch(error => { failure = error; });
    const deadline = Date.now() + 30000;
    try {
      while (true) {
        signal.throwIfAborted(); if (failure) throw failure;
        if (!existsSync(join(state, 'messages.sqlite'))) { await setImmediate(); continue; }
        const db = new DatabaseSync(join(state, 'messages.sqlite'), { readOnly: true });
        let done;
        try { done = db.prepare("SELECT count(*) AS n FROM inbox WHERE status='done'").get().n; }
        finally { db.close(); }
        if (done === round) break;
        if (Date.now() > deadline) throw Error('Native pipeline did not acknowledge its reply.');
        await setImmediate();
      }
    } finally { controller.abort(); await running.catch(error => { if (error !== signal.reason) throw error; }); }
    const db = new DatabaseSync(join(state, 'messages.sqlite'), { readOnly: true });
    try { sessions.push(db.prepare('SELECT session_id FROM conversations').get().session_id); }
    finally { db.close(); }
    replies.push(parts.map(text => text.replace(/^\[\d+\/\d+\]\n/u, '')).join(''));
  }
  return { pipelineReplies: replies, runtimeSessionReused: sessions[0] === sessions[1], cursorResumed: cursors[0] === '' && cursors[1] === 'pipeline-cursor-1' };
}

export const name = 'weixin-driver-smoke';
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessions', 'workspaceRegistry', 'subagents'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController();
    const task = (async () => {
      await ctx.get('loader')?.await();
      const store = new Store(config.stateDirectory, 'fixture-bot');
      let driver;
      let channelContextLogged = false;
      const stop = ctx.on('session/event', (_session, event) => {
        if (event.type === 'system/message' && JSON.stringify(event.data).includes('WeChat ClawBot')) channelContextLogged = true;
      });
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
        const result = await pipeline(ctx, options, config.stateDirectory, controller.signal);
        await writeFile(config.outputPath, JSON.stringify({ replies: [first, second], sessionReused: store.session('fixture-owner') === firstId, channelContextLogged, ...result }));
        console.log('weixin-driver-smoke: complete');
      } finally { stop(); await driver?.close(); store.close(); }
    })().catch(async error => {
      await writeFile(config.outputPath, JSON.stringify({ error: error.message }));
      console.log('weixin-driver-smoke: complete');
    });
    return async () => { controller.abort(); await task; };
  });
}
