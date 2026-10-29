import test from 'node:test';
import assert from 'node:assert/strict';
import { DshDriver } from '../dist/driver.js';
import { fixture } from './helpers.mjs';

async function driverHarness(t, { resumeCwd, outcomes = [] } = {}) {
  const { store, directory, onCleanup } = await fixture(t);
  const live = new Map();
  const events = new Map();
  const created = [], resumed = [], disposed = [], attached = [], submitted = [];
  function owned(id, cwd = directory) {
    const session = { header: { id, cwd }, seq: 0, append() { this.seq++; } };
    let outcome;
    const agent = {
      session, status: 'idle',
      followup(message) { submitted.push({ id, message }); outcome = outcomes.shift() ?? 'completed'; },
      async whenIdle() {
        events.get('session/event')?.(session, { type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '继续回复' }] } } });
        events.get('session/event')?.(session, { type: 'turn/end', data: { reason: { kind: outcome } } });
      },
      cancel() {},
    };
    live.set(id, agent);
    return { agent, async dispose() { disposed.push(id); if (live.get(id) === agent) live.delete(id); } };
  }
  const ctx = {
    agents: {
      get(id) { return live.get(id); },
      async create({ sessionId }) { created.push(sessionId); return owned(sessionId); },
      async resume({ resumeSessionId }) { resumed.push(resumeSessionId); return owned(resumeSessionId, resumeCwd); },
    },
    agentPresets: { async resolve() { return { id: 'standard' }; } },
    agentDefaultModel: { currentSelection() { return { provider: 'fixture', model: 'fixture' }; } },
    workspaceRegistry: { async create() { return { path: directory, async attachSession(id) { attached.push(id); } }; } },
    permissionPresets: { set(session, preset) { assert.equal(preset, 'danger-full-access'); } },
    sessions: { async flush() {} },
    on(name, fn) { events.set(name, fn); return () => events.delete(name); },
    subagents: { async waitForChildren() { return false; }, async drainDescendants() {} },
  };
  const driver = new DshDriver(ctx, store, { workspaceRoot: directory, agentPreset: 'standard', permissionPreset: 'danger-full-access', taskTimeoutMs: 10000 });
  onCleanup(() => driver.close());
  return { store, live, ctx, driver, created, resumed, disposed, attached, submitted, signal: new AbortController().signal };
}

test('another owner holding the bound Session triggers a fresh channel Session and continues the task', async t => {
  const h = await driverHarness(t);
  const browserAgent = { followup() { assert.fail('must not borrow the browser Agent'); }, dispose() { assert.fail('must not dispose the browser Agent'); } };
  h.store.bind('owner', 'browser-session');
  h.live.set('browser-session', browserAgent);
  assert.equal(await h.driver.respond('owner', 'first', h.signal), '继续回复');
  const id = h.store.session('owner');
  assert.match(id, /^weixin-/u);
  assert.notEqual(id, 'browser-session');
  assert.deepEqual(h.created, [id]);
  assert.deepEqual(h.attached, [id]);
  assert.deepEqual(h.resumed, []);
  assert.deepEqual(h.disposed, []);
  assert.equal(h.live.get('browser-session'), browserAgent);
  assert.equal(await h.driver.respond('owner', 'second', h.signal), '继续回复');
  assert.deepEqual(h.submitted.map(item => item.id), [id, id]);
  assert.equal(h.created.length, 1);
});

test('a browser claiming the Session during resume triggers one fresh Session without replaying input', async t => {
  const h = await driverHarness(t);
  h.store.bind('owner', 'saved-session');
  const browserAgent = {};
  let attempts = 0;
  h.ctx.agents.resume = async () => { attempts++; h.live.set('saved-session', browserAgent); throw new Error('Registry publication raced.'); };
  assert.equal(await h.driver.respond('owner', 'continue', h.signal), '继续回复');
  assert.equal(attempts, 1);
  assert.equal(h.created.length, 1);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.store.session('owner'), h.created[0]);
  assert.equal(h.live.get('saved-session'), browserAgent);
});

for (const message of ['This Session is active under another owner; send /new.', 'agent "saved-session" is already registered', 'Saved Session belongs to another workspace']) {
  test(`resume conflict auto-rebinds: ${message}`, async t => {
    const h = await driverHarness(t);
    h.store.bind('owner', 'saved-session');
    let attempts = 0;
    h.ctx.agents.resume = async () => { attempts++; throw new Error(message); };
    assert.equal(await h.driver.respond('owner', 'continue', h.signal), '继续回复');
    assert.equal(attempts, 1);
    assert.equal(h.created.length, 1);
    assert.equal(h.store.session('owner'), h.created[0]);
    assert.equal(h.submitted.length, 1);
  });
}

test('a resumed Session from another workspace is disposed and replaced before submitting input', async t => {
  const h = await driverHarness(t, { resumeCwd: '/other-workspace' });
  h.store.bind('owner', 'wrong-workspace');
  assert.equal(await h.driver.respond('owner', 'continue', h.signal), '继续回复');
  const id = h.store.session('owner');
  assert.deepEqual(h.resumed, ['wrong-workspace']);
  assert.deepEqual(h.disposed, ['wrong-workspace']);
  assert.deepEqual(h.created, [id]);
  assert.deepEqual(h.submitted.map(item => item.id), [id]);
});

test('an unrelated resume failure retains the saved binding without creating a new Session', async t => {
  const h = await driverHarness(t);
  h.store.bind('owner', 'saved-session');
  h.ctx.agents.resume = async () => { throw new Error('Temporary persistence failure.'); };
  await assert.rejects(h.driver.respond('owner', 'continue', h.signal));
  assert.equal(h.store.session('owner'), 'saved-session');
  assert.deepEqual(h.created, []);
});

test('cancellation during resume does not treat a conflict as permission to forget the binding', async t => {
  const h = await driverHarness(t);
  const controller = new AbortController();
  h.store.bind('owner', 'saved-session');
  h.ctx.agents.resume = async () => { controller.abort(); throw new Error('This Session is active under another owner.'); };
  await assert.rejects(h.driver.respond('owner', 'continue', controller.signal));
  assert.equal(h.store.session('owner'), 'saved-session');
  assert.deepEqual(h.created, []);
});

test('cancellation during workspace resolution preserves an occupied binding', async t => {
  const h = await driverHarness(t);
  const controller = new AbortController();
  const createWorkspace = h.ctx.workspaceRegistry.create;
  h.store.bind('owner', 'browser-session');
  h.live.set('browser-session', {});
  h.ctx.workspaceRegistry.create = async () => { controller.abort(); return createWorkspace(); };
  await assert.rejects(h.driver.respond('owner', 'continue', controller.signal));
  assert.equal(h.store.session('owner'), 'browser-session');
  assert.deepEqual(h.created, []);
});

test('automatic rebind does not retry a failing fresh Session creation', async t => {
  const h = await driverHarness(t);
  h.store.bind('owner', 'browser-session');
  h.live.set('browser-session', {});
  let attempts = 0;
  h.ctx.agents.create = async () => { attempts++; throw new Error('This Session is active under another owner.'); };
  await assert.rejects(h.driver.respond('owner', 'continue', h.signal));
  assert.equal(attempts, 1);
  assert.deepEqual(h.submitted, []);
});

test('a failed turn retains its owned Agent and Session for the next task', async t => {
  const h = await driverHarness(t, { outcomes: ['error', 'completed'] });
  await assert.rejects(h.driver.respond('owner', 'first', h.signal), /Task did not complete/u);
  const id = h.store.session('owner');
  const agent = h.live.get(id);
  assert.equal(await h.driver.respond('owner', 'continue', h.signal), '继续回复');
  assert.equal(h.store.session('owner'), id);
  assert.equal(h.live.get(id), agent);
  assert.deepEqual(h.submitted.map(item => item.id), [id, id]);
  assert.deepEqual(h.disposed, []);
});

test('a disposed channel handle is replaced before the next task', async t => {
  const h = await driverHarness(t);
  await h.driver.respond('owner', 'first', h.signal);
  const oldId = h.store.session('owner');
  h.live.delete(oldId);
  assert.equal(await h.driver.respond('owner', 'continue', h.signal), '继续回复');
  assert.notEqual(h.store.session('owner'), oldId);
  assert.deepEqual(h.disposed, [oldId]);
  assert.equal(h.created.length, 2);
});

test('explicit reset disposes the owned Agent and forgets its binding', async t => {
  const h = await driverHarness(t);
  await h.driver.respond('owner', 'first', h.signal);
  const oldId = h.store.session('owner');
  await h.driver.reset('owner');
  assert.equal(h.store.session('owner'), undefined);
  assert.deepEqual(h.disposed, [oldId]);
  await h.driver.respond('owner', 'new task', h.signal);
  assert.notEqual(h.store.session('owner'), oldId);
});

for (const propagateSignal of [false, true]) {
  test(`native cancellation occurs once with upstream abort=${propagateSignal}`, async t => {
    const { store, directory } = await fixture(t);
    const started = Promise.withResolvers();
    const idle = Promise.withResolvers();
    let cancellations = 0;
    const session = { header: { cwd: directory }, seq: 0, append() { this.seq++; } };
    const agent = {
      session, status: 'busy', followup() { started.resolve(); }, whenIdle() { return idle.promise; },
      cancel() { cancellations++; this.status = 'idle'; idle.resolve(); },
    };
    const ctx = {
      agents: { get() {}, async create() { return { agent, async dispose() {} }; } },
      agentPresets: { async resolve() { return { id: 'standard' }; } },
      agentDefaultModel: { currentSelection() { return { provider: 'fixture', model: 'fixture' }; } },
      workspaceRegistry: { async create() { return { path: directory, async attachSession() {} }; } },
      permissionPresets: { set() {} }, sessions: { async flush() {} }, on() { return () => {}; },
      subagents: { async waitForChildren() { return false; }, async drainDescendants() {} },
    };
    const driver = new DshDriver(ctx, store, { workspaceRoot: directory, agentPreset: 'standard', permissionPreset: 'read-only', taskTimeoutMs: 10000 });
    const controller = new AbortController();
    const task = driver.respond('owner', 'work', controller.signal);
    task.catch(() => {});
    try {
      await started.promise;
      if (propagateSignal) controller.abort();
      driver.cancel('owner');
      await assert.rejects(task);
      assert.equal(cancellations, 1);
    } finally { controller.abort(); idle.resolve(); await task.catch(() => {}); await driver.close(); }
  });
}
