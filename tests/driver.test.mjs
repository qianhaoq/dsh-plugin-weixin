import test from 'node:test';
import assert from 'node:assert/strict';
import { DshDriver } from '../dist/driver.js';
import { fixture } from './helpers.mjs';

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
