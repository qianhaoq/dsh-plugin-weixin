import test from 'node:test';
import assert from 'node:assert/strict';
import { splitReply } from '../dist/delivery.js';
import { fixture, message } from './helpers.mjs';

test('multipart replies preserve every Unicode code point and include labels within the limit', () => {
  for (const repetitions of [1, 30, 300, 2000]) {
    const text = '文字🌕\n'.repeat(repetitions);
    const parts = splitReply(text, 100);
    assert.ok(parts.every(part => Array.from(part).length <= 100));
    assert.equal(parts.map(part => part.replace(/^\[\d+\/\d+\]\n/u, '')).join(''), text);
  }
});

test('manual retry resumes the unknown part without resending an acknowledged prefix', async t => {
  const { store } = await fixture(t);
  store.accept([message()], 'cursor', new Set(['owner']), 1000);
  store.ready('1', '文字'.repeat(180));
  const first = store.nextDelivery(100);
  store.startDelivery(first); store.acknowledge(first);
  const second = store.nextDelivery(100);
  store.startDelivery(second); store.unknown(second);
  assert.equal(store.nextDelivery(100), undefined);
  assert.equal(store.retryLatest('stranger', 'wrong-context', 100), false);
  assert.equal(store.retryLatest('owner', 'fresh-context', 100), true);
  const retry = store.nextDelivery(100);
  assert.equal(retry.ordinal, second.ordinal);
  assert.equal(retry.client_id, second.client_id);
  assert.equal(retry.text, second.text);
  assert.equal(retry.context_token, 'fresh-context');
  assert.notEqual(retry.ordinal, first.ordinal);
});

test('restart preserves acknowledged parts and parks an in-flight part as unknown', async t => {
  const { store } = await fixture(t);
  store.accept([message()], 'cursor', new Set(['owner']), 1000);
  store.ready('1', '回复'.repeat(180));
  const first = store.nextDelivery(100); store.startDelivery(first); store.acknowledge(first);
  const second = store.nextDelivery(100); store.startDelivery(second);
  store.recover();
  assert.equal(store.counts().unknown, 1);
  assert.equal(store.nextDelivery(100), undefined);
  store.retryLatest('owner', 'new-context', 100);
  assert.equal(store.nextDelivery(100).ordinal, second.ordinal);
});
