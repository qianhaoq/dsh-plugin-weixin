import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { login, saveCredentials, readCredentials } from '../dist/login.js';
import { fixture, apiOptions, auth } from './helpers.mjs';

test('QR login handles phone verification and saves owner-only credentials', async t => {
  const { directory } = await fixture(t);
  const states = [{ status: 'need_verifycode' }, { status: 'confirmed', bot_token: auth.token, ilink_bot_id: auth.botId, ilink_user_id: auth.userId, baseurl: auth.baseUrl }];
  const codes = [];
  const api = { qr: async () => ({ qrcode: 'opaque', qrcode_img_content: 'https://weixin.qq.com/qr-fixture' }), loginStatus: async (base, qr, signal, code) => { codes.push(code); return states.shift(); } };
  const result = await login(api, { ...apiOptions, loginTimeoutMs: 10000, loginPollIntervalMs: 10 }, new AbortController().signal, { showQr() {}, inform() {}, verification: async () => '123456' });
  assert.deepEqual(codes, [undefined, '123456']);
  await saveCredentials(directory, result);
  assert.deepEqual(await readCredentials(directory, apiOptions.allowedApiHosts), auth);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
});

test('QR redirects cannot send the login challenge to an untrusted host', async () => {
  const api = { qr: async () => ({ qrcode: 'opaque', qrcode_img_content: 'https://weixin.qq.com/qr-fixture' }), loginStatus: async () => ({ status: 'scaned_but_redirect', redirect_host: 'evil.test' }) };
  await assert.rejects(login(api, { ...apiOptions, loginTimeoutMs: 10000, loginPollIntervalMs: 10 }, new AbortController().signal, { showQr() {}, inform() {}, verification: async () => '' }), { code: 'PROTOCOL' });
});

test('confirmed logins missing account identity do not produce credentials', async () => {
  const api = { qr: async () => ({ qrcode: 'opaque', qrcode_img_content: 'https://weixin.qq.com/qr-fixture' }), loginStatus: async () => ({ status: 'confirmed', bot_token: 'secret' }) };
  await assert.rejects(login(api, { ...apiOptions, loginTimeoutMs: 10000, loginPollIntervalMs: 10 }, new AbortController().signal, { showQr() {}, inform() {}, verification: async () => '' }), { code: 'PROTOCOL' });
});
