import test from 'node:test';
import assert from 'node:assert/strict';
import { withTyping } from '../dist/activity.js';
import { auth } from './helpers.mjs';

test('typing remains task-owned and is cleared before the task wrapper returns', async () => {
  const typed = Promise.withResolvers();
  const events = [];
  const api = { async typingTicket() { return 'ticket'; }, async typing(auth, user, ticket, active) { events.push(active); if (active) typed.resolve(); } };
  const result = await withTyping(api, auth, 'owner', 'context', { typingIntervalMs: 10000, shutdownTimeoutMs: 100 }, new AbortController().signal, () => {}, async () => { await typed.promise; return 'answer'; });
  assert.equal(result, 'answer');
  assert.deepEqual(events, [true, false]);
});

test('a failed typing API does not cancel the model operation', async () => {
  const failed = Promise.withResolvers();
  const reported = Promise.withResolvers();
  const reports = [];
  const api = { async typingTicket() { failed.resolve(); throw Error('not supported'); }, async typing() { assert.fail('no ticket'); } };
  const result = await withTyping(api, auth, 'owner', 'context', { typingIntervalMs: 10000, shutdownTimeoutMs: 100 }, new AbortController().signal, message => { reports.push(message); reported.resolve(); }, async () => { await failed.promise; await reported.promise; return 'answer'; });
  assert.equal(result, 'answer');
  assert.ok(reports.some(message => message.includes('task continues')));
});

test('disabled typing performs no auxiliary API requests', async () => {
  const api = { async typingTicket() { assert.fail('disabled'); }, async typing() { assert.fail('disabled'); } };
  assert.equal(await withTyping(api, auth, 'owner', 'context', { typingIntervalMs: 0, shutdownTimeoutMs: 100 }, new AbortController().signal, () => {}, async () => 'answer'), 'answer');
});
