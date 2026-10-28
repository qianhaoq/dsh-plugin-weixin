import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/engine.js';
import { WeixinError } from '../dist/errors.js';
import { fixture, auth, message, engineOptions, blocked, eventually } from './helpers.mjs';

async function harness(t, { sendFailure = false, messages = [message()], respond } = {}) {
  const { store, onCleanup } = await fixture(t);
  const controller = new AbortController();
  const sent = [];
  const prompts = [];
  const logs = [];
  let polled = false;
  let closed = false;
  const driver = {
    respond: async (user, text, signal) => { prompts.push(text); return respond ? respond(user, text, signal) : '模型回复'; },
    reset: async user => store.forget(user), cancel() {}, close: async () => { closed = true; },
  };
  const api = {
    updates: async (auth, cursor, signal) => {
      if (!polled) { polled = true; return { msgs: messages, get_updates_buf: 'next-cursor' }; }
      return blocked(signal);
    },
    send: async (auth, value) => { sent.push(value); if (sendFailure) throw new WeixinError('NETWORK', 'send', 'Unknown transport outcome.', true); },
  };
  const task = new Engine(api, auth, store, driver, engineOptions, text => logs.push(text)).run(controller.signal);
  task.catch(() => {});
  onCleanup(async () => { controller.abort(); await task.catch(() => {}); });
  return { store, controller, task, sent, prompts, logs, closed: () => closed };
}

test('inbound text reaches DSH once and returns through the matching context token', async t => {
  const h = await harness(t, { messages: [message(), message()] });
  await eventually(() => h.store.counts().pending === 0 && h.sent.length === 1);
  assert.deepEqual(h.prompts, ['hello']);
  assert.equal(h.sent[0].text, '模型回复');
  assert.equal(h.sent[0].contextToken, 'context-1');
  assert.equal(h.store.cursor(), 'next-cursor');
  h.controller.abort(); await h.task.catch(() => {});
  assert.equal(h.closed(), false, 'the account runtime owns driver disposal');
});

test('unknown reply delivery is logged, persisted, and never retried', async t => {
  const h = await harness(t, { sendFailure: true });
  await eventually(() => h.store.counts().unknown === 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.prompts.length, 1);
  assert.ok(h.logs.some(line => line.includes('unknown')));
  h.controller.abort(); await h.task.catch(() => {});
  h.store.recover();
  assert.equal(h.store.next(), undefined);
});

test('unauthorized senders cannot run prompts or receive a reply', async t => {
  const h = await harness(t, { messages: [message('1', 'hello', 'stranger')] });
  await eventually(() => h.store.cursor() === 'next-cursor');
  assert.deepEqual(h.prompts, []); assert.deepEqual(h.sent, []);
});

test('task failure returns actionable guidance and starts the next message in a new session', async t => {
  const h = await harness(t, { respond: async () => { throw new WeixinError('AGENT', 'task', 'Fixture failure.'); } });
  await eventually(() => h.sent.length === 1 && h.store.counts().pending === 0);
  assert.match(h.sent[0].text, /未成功完成/u);
  assert.equal(h.store.session('owner'), undefined);
});

test('/stop is admitted by polling while DSH is still processing a previous message', async t => {
  const { store, onCleanup } = await fixture(t);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const replies = [];
  let poll = 0;
  let running = false;
  let cancelledWhileRunning = false;
  const driver = {
    async respond() { running = true; started.resolve(); await cancelled.promise; running = false; throw new WeixinError('AGENT', 'task', 'Cancelled.'); },
    async reset() {}, cancel() { if (running) { cancelledWhileRunning = true; cancelled.resolve(); } }, async close() {},
  };
  const api = {
    async updates(auth, cursor, signal) {
      if (poll++ === 0) return { msgs: [message()], get_updates_buf: 'a' };
      if (poll === 2) { await started.promise; return { msgs: [message('2', '/stop')], get_updates_buf: 'b' }; }
      return blocked(signal);
    },
    async send(auth, reply) { replies.push(reply.text); },
  };
  const task = new Engine(api, auth, store, driver, engineOptions, () => {}).run(controller.signal);
  task.catch(() => {});
  onCleanup(async () => { cancelled.resolve(); controller.abort(); await task.catch(() => {}); });
  await eventually(() => replies.length === 2);
  assert.equal(cancelledWhileRunning, true);
  assert.ok(replies.some(reply => /请求停止/u.test(reply)));
});
