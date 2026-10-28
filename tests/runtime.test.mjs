import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { runAccount } from '../dist/runtime.js';
import { resolveConfig } from '../dist/config.js';
import { WeixinError } from '../dist/errors.js';
import { auth, blocked, eventually } from './helpers.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'credentials.json'), JSON.stringify(auth), { mode: 0o600 });
  return { root, config: resolveConfig({ mode: 'run', stateDirectory: root, workspaceRoot: root, typingIntervalMs: 0, reconnectDelayMs: 10, shutdownTimeoutMs: 100 }) };
}

test('shutdown drains task cleanup while storage and the account lock remain usable', async t => {
  const { root, config } = await setup(t);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const releaseTask = Promise.withResolvers();
  let store;
  let closed = 0;
  let polled = false;
  const api = {
    async notify() {},
    async updates(auth, cursor, signal) { if (!polled) { polled = true; return { msgs: [{ message_id: '1', from_user_id: 'owner', message_type: 1, context_token: 'context', item_list: [{ type: 1, text_item: { text: 'task' } }] }], get_updates_buf: 'next' }; } return blocked(signal); },
    async send() { assert.fail('shutdown must not deliver the cancelled task'); },
  };
  const driver = {
    async initialize() {}, async reset() {}, cancel() {},
    async respond(user, text, signal) {
      started.resolve();
      try { await blocked(signal); }
      finally { cancelled.resolve(); await releaseTask.promise; assert.equal(store.cursor(), 'next'); }
    },
    async close() { closed++; assert.equal(store.cursor(), 'next'); },
  };
  let settled = false;
  const task = runAccount(config, controller.signal, { api, loginIo: {}, driver: value => { store = value; return driver; }, output() {}, report() {} });
  task.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started.promise;
    controller.abort(); await cancelled.promise;
    assert.equal(settled, false);
    assert.equal(closed, 0);
    await assert.rejects(lockfile.lock(root, { retries: 0 }), { code: 'ELOCKED' });
  } finally { releaseTask.resolve(); controller.abort(); await task.catch(() => {}); }
  assert.equal(closed, 1);
  assert.throws(() => store.cursor());
  const unlock = await lockfile.lock(root, { retries: 0 }); await unlock();
});

test('failed driver cleanup still releases SQLite and the account lock', async t => {
  const { root, config } = await setup(t);
  let store;
  let closes = 0;
  const driver = { async initialize() { throw new WeixinError('STATE', 'fixture startup', 'failed'); }, async close() { closes++; throw Error('fixture cleanup'); } };
  await assert.rejects(runAccount(config, new AbortController().signal, { api: {}, loginIo: {}, driver: value => { store = value; return driver; }, output() {}, report() {} }), AggregateError);
  assert.equal(closes, 1);
  assert.throws(() => store.cursor());
  const unlock = await lockfile.lock(root, { retries: 0 }); await unlock();
});

test('transient polling rejections are observed and retried without killing the host', async t => {
  const { config } = await setup(t);
  const controller = new AbortController();
  let polls = 0;
  let closed = 0;
  const reports = [];
  const api = {
    async notify() {}, async send() {},
    async updates(auth, cursor, signal) { polls++; if (polls < 3) throw new WeixinError('NETWORK', 'getupdates', 'fixture network fault', true); return blocked(signal); },
  };
  const driver = { async initialize() {}, async respond() {}, async reset() {}, cancel() {}, async close() { closed++; } };
  const task = runAccount(config, controller.signal, { api, loginIo: {}, driver: () => driver, output() {}, report: message => reports.push(message) });
  task.catch(() => {});
  try { await eventually(() => polls >= 3); }
  finally { controller.abort(); await task.catch(() => {}); }
  assert.equal(closed, 1);
  assert.ok(reports.some(message => message.includes('Retrying polling')));
});

test('a stalled stop notification is aborted within its configured cleanup budget', { timeout: 10000 }, async t => {
  const { config } = await setup(t);
  const controller = new AbortController();
  const polling = Promise.withResolvers();
  let stopAborted = false;
  const reports = [];
  const api = {
    async notify(auth, phase, signal) {
      if (phase === 'stop') {
        try { await blocked(signal); }
        finally { stopAborted = signal.aborted; }
      }
    },
    async updates(auth, cursor, signal) { polling.resolve(); return blocked(signal); }, async send() {},
  };
  const driver = { async initialize() {}, async reset() {}, cancel() {}, async respond() {}, async close() {} };
  const task = runAccount(config, controller.signal, { api, loginIo: {}, driver: () => driver, output() {}, report: message => reports.push(message) });
  task.catch(() => {});
  await polling.promise; controller.abort();
  await assert.rejects(task);
  assert.equal(stopAborted, true);
  assert.ok(reports.some(message => message.includes('Stop notification')));
});
