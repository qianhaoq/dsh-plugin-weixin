import test from 'node:test';
import assert from 'node:assert/strict';
import { ILinkClient, apiOrigin, parseWireJson, PLUGIN_VERSION } from '../dist/protocol.js';
import { readFile } from 'node:fs/promises';
import { describeError } from '../dist/errors.js';
import { apiOptions, auth } from './helpers.mjs';

test('64-bit message IDs retain their exact decimal identity', () => {
  assert.equal(parseWireJson('{"message_id":9007199254740993123,"text":"9007199254740993123"}').message_id, '9007199254740993123');
});

test('credential destinations reject untrusted hosts and URL credentials', () => {
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://evil.test', 'https://ilinkai.weixin.qq.com.evil.test', 'https://user:password@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com:443/?secret=1']) assert.throws(() => apiOrigin(url, apiOptions.allowedApiHosts));
  assert.equal(apiOrigin('https://ilinkai.weixin.qq.com', apiOptions.allowedApiHosts), 'https://ilinkai.weixin.qq.com/');
});

test('outbound messages carry the original context, stable client ID and bot authentication', async () => {
  let captured;
  const api = new ILinkClient(apiOptions, async (url, init) => {
    captured = { url: url.href, ...init, payload: JSON.parse(init.body) };
    return Response.json({ ret: 0 });
  });
  await api.send(auth, { userId: 'owner', text: 'reply', contextToken: 'original-context', clientId: 'stable-id' }, new AbortController().signal);
  assert.equal(captured.url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  assert.equal(captured.headers.Authorization, 'Bearer fixture-token');
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.payload.msg.context_token, 'original-context');
  assert.equal(captured.payload.msg.client_id, 'stable-id');
  assert.equal(captured.payload.msg.item_list[0].text_item.text, 'reply');
});

test('expired sessions stop polling and do not expose server response secrets', async () => {
  const api = new ILinkClient(apiOptions, async () => Response.json({ ret: -14, errmsg: 'secret-value' }));
  await assert.rejects(api.updates(auth, '', new AbortController().signal), error => {
    assert.equal(error.code, 'AUTH_EXPIRED');
    assert.equal(error.retryable, false);
    assert.ok(!describeError(error).includes('secret-value'));
    return true;
  });
});

test('HTTP and network failures do not trigger duplicate send attempts', async () => {
  let calls = 0;
  const api = new ILinkClient(apiOptions, async () => { calls++; throw new Error('fixture-token'); });
  await assert.rejects(api.send(auth, { userId: 'owner', text: 'x', contextToken: 'ctx', clientId: 'id' }, new AbortController().signal), error => !describeError(error).includes('fixture-token'));
  assert.equal(calls, 1);
});

test('empty malformed API responses fail instead of becoming successful sends', async () => {
  const api = new ILinkClient(apiOptions, async () => Response.json(null));
  await assert.rejects(api.send(auth, { userId: 'owner', text: 'x', contextToken: 'ctx', clientId: 'id' }, new AbortController().signal), { code: 'PROTOCOL' });
});

test('an empty success-shaped object does not acknowledge delivery', async () => {
  const api = new ILinkClient(apiOptions, async () => Response.json({}));
  await assert.rejects(api.send(auth, { userId: 'owner', text: 'x', contextToken: 'ctx', clientId: 'id' }, new AbortController().signal), { code: 'PROTOCOL' });
});

test('backend lifecycle notifications use authenticated account endpoints', async () => {
  const paths = [];
  const api = new ILinkClient(apiOptions, async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer fixture-token');
    paths.push(url.pathname);
    return Response.json({ ret: 0 });
  });
  await api.notify(auth, 'start', new AbortController().signal);
  await api.notify(auth, 'stop', new AbortController().signal);
  assert.deepEqual(paths, ['/ilink/bot/msg/notifystart', '/ilink/bot/msg/notifystop']);
});

test('wire metadata matches the package version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PLUGIN_VERSION, pkg.version);
  const api = new ILinkClient(apiOptions, async (url, init) => {
    const [major, minor, patch] = pkg.version.split('.').map(Number);
    assert.equal(init.headers['iLink-App-ClientVersion'], String((major << 16) | (minor << 8) | patch));
    assert.equal(JSON.parse(init.body).base_info.channel_version, pkg.version);
    return Response.json({ ret: 0 });
  });
  await api.notify(auth, 'start', new AbortController().signal);
});

test('typing uses separate configuration and status endpoints with the original user context', async () => {
  const calls = [];
  const api = new ILinkClient(apiOptions, async (url, init) => {
    calls.push({ path: url.pathname, body: JSON.parse(init.body) });
    return Response.json({ ret: 0, ...(url.pathname.endsWith('getconfig') ? { typing_ticket: 'ticket' } : {}) });
  });
  const signal = new AbortController().signal;
  const ticket = await api.typingTicket(auth, 'owner', 'original-context', signal);
  await api.typing(auth, 'owner', ticket, true, signal);
  await api.typing(auth, 'owner', ticket, false, signal);
  assert.equal(calls[0].body.context_token, 'original-context');
  assert.equal(calls[1].body.status, 1);
  assert.equal(calls[2].body.status, 2);
});
