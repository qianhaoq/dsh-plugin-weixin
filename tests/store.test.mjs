import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message } from './helpers.mjs';
import { Store, SCHEMA_VERSION } from '../dist/store.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

test('messages and cursor commit together, with durable duplicate suppression', async t => {
  const { store } = await fixture(t);
  store.accept([message()], 'cursor-1', new Set(['owner']), 1000);
  assert.equal(store.cursor(), 'cursor-1');
  assert.equal(store.accept([message()], 'cursor-2', new Set(['owner']), 1000).length, 0);
  assert.equal(store.counts().pending, 1);
  assert.throws(() => store.accept([message('2'), { malformed: true }], 'cursor-lost', new Set(['owner']), 1000));
  assert.equal(store.cursor(), 'cursor-2');
  assert.equal(store.counts().pending, 1);
});

test('only allowed direct-message senders enter the durable work queue', async t => {
  const { store } = await fixture(t);
  store.accept([message('1', 'x', 'stranger'), { ...message('2'), group_id: 'group' }, { ...message('3'), message_type: 2 }], 'cursor', new Set(['owner']), 1000);
  assert.equal(store.counts().pending, 0);
  assert.equal(store.cursor(), 'cursor');
});

test('interrupted tasks lose their resumable mapping and produce a recovery notice', async t => {
  const { store } = await fixture(t);
  store.accept([message()], 'cursor', new Set(['owner']), 1000);
  store.bind('owner', 'session-old');
  store.status('1', 'running');
  store.recover();
  assert.equal(store.session('owner'), undefined);
  assert.equal(store.next().status, 'ready');
  assert.match(store.next().reply, /中断/u);
});

test('a send interrupted after dispatch is not resent on restart', async t => {
  const { store } = await fixture(t);
  store.accept([message()], 'cursor', new Set(['owner']), 1000);
  store.ready('1', 'answer'); store.status('1', 'sending'); store.recover();
  assert.equal(store.next(), undefined);
  assert.equal(store.counts().unknown, 1);
});

test('attachments and oversized text return local guidance without model execution', async t => {
  const { store } = await fixture(t);
  store.accept([{ ...message(), item_list: [{ type: 2 }] }, message('2', 'very long')], 'cursor', new Set(['owner']), 3);
  assert.equal(store.next().status, 'ready');
  assert.match(store.next().reply, /只支持文字/u);
  store.status('1', 'done');
  assert.match(store.next().reply, /过长/u);
});

test('bot events without user-message fields are ignored without blocking the cursor', async t => {
  const { store } = await fixture(t);
  store.accept([{ message_type: 2 }], 'cursor', new Set(['owner']), 1000);
  assert.equal(store.cursor(), 'cursor');
  assert.equal(store.counts().pending, 0);
});

test('quoted content is not silently included in a model request', async t => {
  const { store } = await fixture(t);
  const input = message(); input.item_list[0].ref_msg = { title: 'quoted message' };
  store.accept([input], 'cursor', new Set(['owner']), 1000);
  assert.equal(store.next().status, 'ready');
});

test('future database versions are rejected without rewriting their metadata', async t => {
  const { directory } = await fixture(t);
  const db = new DatabaseSync(join(directory, 'messages.sqlite'));
  try {
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(SCHEMA_VERSION + 1), 'schema_version');
    assert.throws(() => new Store(directory, 'fixture-bot'), { code: 'STATE' });
    assert.equal(db.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version').value, String(SCHEMA_VERSION + 1));
  } finally { db.close(); }
});
