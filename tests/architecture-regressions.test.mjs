import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/engine.js';
import { fixture, auth, message, engineOptions, blocked, eventually } from './helpers.mjs';

test('/status replies while another message is still running', async t => {
  const { store, onCleanup } = await fixture(t);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const sent = [];
  let poll = 0;
  const driver = { async respond() { started.resolve(); await finish.promise; return 'done'; }, async reset() {}, cancel() {}, async close() {} };
  const api = {
    async updates(auth, cursor, signal) {
      if (poll++ === 0) return { msgs: [message()], get_updates_buf: 'a' };
      if (poll === 2) { await started.promise; return { msgs: [message('2', '/status')], get_updates_buf: 'b' }; }
      return blocked(signal);
    },
    async send(auth, value) { sent.push(value); },
  };
  const task = new Engine(api, auth, store, driver, engineOptions, () => {}).run(controller.signal);
  task.catch(() => {});
  onCleanup(async () => { finish.resolve(); controller.abort(); await task.catch(() => {}); });
  await eventually(() => store.cursor() === 'b');
  await eventually(() => sent.some(item => item.contextToken === 'context-2'));
});

test('a long response is delivered in full rather than truncated', async t => {
  const { store, onCleanup } = await fixture(t);
  const controller = new AbortController();
  const sent = [];
  const answer = '完整回复。'.repeat(70);
  let polled = false;
  const api = {
    async updates(auth, cursor, signal) { if (!polled) { polled = true; return { msgs: [message()], get_updates_buf: 'a' }; } return blocked(signal); },
    async send(auth, value) { sent.push(value); },
  };
  const driver = { async respond() { return answer; }, async reset() {}, cancel() {}, async close() {} };
  const task = new Engine(api, auth, store, driver, engineOptions, () => {}).run(controller.signal);
  task.catch(() => {});
  onCleanup(async () => { controller.abort(); await task.catch(() => {}); });
  await eventually(() => sent.length > 0 && store.counts().pending === 0);
  assert.equal(sent.map(item => item.text.replace(/^\[\d+\/\d+\]\n/u, '')).join(''), answer);
});
