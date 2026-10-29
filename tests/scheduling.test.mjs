import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/engine.js';
import { WeixinError } from '../dist/errors.js';
import { fixture, auth, message, engineOptions, incomingApi, eventually, blocked } from './helpers.mjs';

async function start(t, driver, options = engineOptions, api = incomingApi()) {
  const { store, onCleanup } = await fixture(t);
  const controller = new AbortController();
  const task = new Engine(api, auth, store, driver, options, () => {}).run(controller.signal);
  task.catch(() => {});
  onCleanup(async () => { controller.abort(); await task.catch(() => {}); });
  return { api, store, controller, task, onCleanup };
}

test('different users progress concurrently while each user retains FIFO task order', async t => {
  const first = Promise.withResolvers();
  const started = [];
  const driver = { async reset() {}, cancel() {}, async respond(user, text, signal) {
    started.push(text);
    if (text === 'first') await first.promise;
    return text;
  } };
  const h = await start(t, driver, { ...engineOptions, allowedUsers: ['owner', 'other'], maxConcurrentUsers: 2 });
  h.onCleanup(async () => { first.resolve(); });
  h.api.push([message('1', 'first'), message('2', 'second'), message('3', 'other peer', 'other')]);
  await eventually(() => h.api.sent.some(value => value.contextToken === 'context-3'));
  assert.deepEqual(started, ['first', 'other peer']);
  first.resolve();
  await eventually(() => h.store.counts().pending === 0);
  assert.deepEqual(started, ['first', 'other peer', 'second']);
});

test('/stop cancels the active task exactly once and only removes work queued before the command', async t => {
  const active = Promise.withResolvers();
  const prompts = [];
  let cancels = 0;
  const driver = { async reset() {}, cancel() { cancels++; }, async respond(user, text, signal) {
    prompts.push(text);
    if (text === 'active') { active.resolve(); await blocked(signal); }
    return text;
  } };
  const h = await start(t, driver);
  h.api.push([message('1', 'active')]); await active.promise;
  h.api.push([message('2', 'old queued'), message('3', '/stop'), message('4', 'after stop')]);
  await eventually(() => h.store.counts().pending === 0);
  assert.equal(cancels, 1);
  assert.deepEqual(prompts, ['active', 'after stop']);
  assert.ok(h.api.sent.some(value => value.contextToken === 'context-3' && value.text.includes('请求停止')));
});

test('/new waits for the old task to drain while status remains responsive', async t => {
  const active = Promise.withResolvers();
  const stopping = Promise.withResolvers();
  const finishCleanup = Promise.withResolvers();
  const prompts = [];
  let resets = 0;
  const driver = { async reset(user) { resets++; h.store.forget(user); }, cancel() {}, async respond(user, text, signal) {
    prompts.push(text);
    if (text === 'old') {
      active.resolve();
      try { await blocked(signal); }
      finally { stopping.resolve(); await finishCleanup.promise; }
    }
    if (text === 'new task') assert.equal(h.store.session(user), undefined);
    return text;
  } };
  const h = await start(t, driver);
  h.store.bind('owner', 'old-session');
  h.onCleanup(async () => { finishCleanup.resolve(); });
  h.api.push([message('1', 'old')]); await active.promise;
  h.api.push([message('2', '/new'), message('3', 'new task'), message('4', '/status')]);
  await stopping.promise;
  await eventually(() => h.api.sent.some(value => value.contextToken === 'context-4'));
  assert.deepEqual(prompts, ['old']); assert.equal(resets, 0);
  assert.equal(h.store.session('owner'), 'old-session');
  finishCleanup.resolve();
  await eventually(() => h.store.counts().pending === 0);
  assert.deepEqual(prompts, ['old', 'new task']); assert.equal(resets, 1);
  assert.equal(h.store.session('owner'), undefined);
});

test('a full queue rejects new work visibly without blocking /stop or /status', async t => {
  const active = Promise.withResolvers();
  const driver = { async reset() {}, cancel() {}, async respond(user, text, signal) { active.resolve(); await blocked(signal); return text; } };
  const h = await start(t, driver, { ...engineOptions, maxPendingMessages: 1 });
  h.api.push([message('1', 'active')]); await active.promise;
  h.api.push([message('2', 'overflow'), message('3', '/status'), message('4', '/stop')]);
  await eventually(() => h.store.counts().pending === 0);
  assert.ok(h.api.sent.some(value => value.contextToken === 'context-2' && value.text.includes('队列已满')));
  assert.ok(h.api.sent.some(value => value.contextToken === 'context-3'));
});

test('manual /retry sends the saved remainder and never repeats the model task', async t => {
  let prompts = 0;
  let fail = true;
  const api = incomingApi();
  const baseSend = api.send;
  api.send = async (auth, value) => { if (value.clientId.endsWith(':2') && fail) { fail = false; throw new WeixinError('NETWORK', 'send', 'unknown', true); } await baseSend(auth, value); };
  const answer = '完整答案'.repeat(80);
  const driver = { async reset() {}, cancel() {}, async respond() { prompts++; return answer; } };
  const h = await start(t, driver, engineOptions, api);
  h.api.push([message('1', 'question')]);
  await eventually(() => h.store.counts().unknown === 1);
  const firstId = h.api.sent[0].clientId;
  h.api.push([message('2', '/retry')]);
  await eventually(() => h.store.counts().pending === 0 && h.store.counts().unknown === 0);
  assert.equal(prompts, 1);
  assert.equal(h.api.sent.filter(value => value.clientId === firstId).length, 1);
  assert.equal(h.api.sent.map(value => value.text.replace(/^\[\d+\/\d+\]\n/u, '')).join(''), answer);
  assert.ok(h.api.sent.slice(1).every(value => value.contextToken === 'context-2'));
});

test('the QR owner remains authorized across multiple polls without first-contact registration', async t => {
  const prompts = [];
  const driver = { async reset() {}, cancel() {}, async respond(user, text) { prompts.push(text); return text; } };
  const h = await start(t, driver);
  h.api.push([message('1', 'first')]);
  await eventually(() => h.api.sent.length === 1);
  h.api.push([message('2', 'second')]);
  await eventually(() => h.api.sent.length === 2);
  assert.deepEqual(prompts, ['first', 'second']);
});

test('a transient backend session rejection gets one bounded reconnect attempt', async t => {
  const api = incomingApi();
  const next = api.updates;
  let polls = 0; let recoveries = 0;
  api.updates = async (...args) => { if (++polls === 1) throw new WeixinError('AUTH_EXPIRED', 'poll', 'session lost'); return next(...args); };
  api.notify = async () => { recoveries++; };
  const driver = { async reset() {}, cancel() {}, async respond() { return 'answer'; } };
  const h = await start(t, driver, engineOptions, api);
  h.api.push([message()]);
  await eventually(() => h.api.sent.length === 1);
  assert.equal(recoveries, 1);
});
