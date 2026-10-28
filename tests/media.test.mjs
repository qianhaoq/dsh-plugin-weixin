import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, symlink, mkdir, writeFile, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { messageSchema } from '../dist/protocol.js';
import { resolveConfig } from '../dist/config.js';
import { parseAesKey, decryptAesEcb } from '../dist/vendor/tencent-weixin/aes.js';
import { buildCdnDownloadUrl } from '../dist/vendor/tencent-weixin/cdn-url.js';
import { CdnClient, cdnUrl } from '../dist/media/cdn-client.js';
import { MediaPipeline } from '../dist/media/pipeline.js';
import { InboundStorage, inspectImage } from '../dist/media/storage.js';
import { Engine } from '../dist/engine.js';
import { DshDriver } from '../dist/driver.js';
import { Store } from '../dist/store.js';
import { fixture, message, auth, engineOptions, incomingApi, eventually, blocked } from './helpers.mjs';

const wire = JSON.parse(await readFile(new URL('./fixtures/image-wire.json', import.meta.url), 'utf8'));
import { png, key, encrypted } from './fixtures/image-bytes.mjs';
const cdnOptions = { allowedCdnHosts: ['novac2c.cdn.weixin.qq.com'], cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', mediaDownloadTimeoutMs: 1000 };
const descriptor = { encrypt_query_param: 'fixture', aes_key: key.toString('base64'), encrypt_type: 1 };
const imageMessage = (id = '1', user = 'owner') => ({ ...message(id, '', user), item_list: [wire.item_list[1]] });
const limits = { maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 32000000, maxImageDimension: 20000, maxImagesPerMessage: 4, maxMessageImageBytes: 12 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] };
function attachments() {
  return { imageLimits: limits, calls: [], async readImage(ref) { return { ref, data: png }; }, async validateImage(input) { assert.deepEqual(input.data, png); }, async saveImages(inputs) {
    this.calls.push(inputs);
    return inputs.map(input => ({ attachmentId: 'fixture-attachment', mediaType: input.mediaType, bytes: input.data.length, width: 2, height: 2 }));
  } };
}
function setupPipeline(store, directory, options = {}, host = attachments(), fetcher = async () => new Response(encrypted), capable = async () => true) {
  const config = resolveConfig({ stateDirectory: directory, ...options });
  const pipeline = new MediaPipeline(store, config, host, capable, new CdnClient(config, fetcher));
  return { pipeline, config, host };
}
function running(store) { const row = store.nextTask([]); assert.ok(row); store.status(row.id, 'running'); store.preparingPhase(row.id); return row; }
async function download(client, d = descriptor, max = png.length) { const chunks = []; await client.download(d, max, new AbortController().signal, async chunk => { chunks.push(chunk); }); return Buffer.concat(chunks); }

test('image wire fixture preserves full identity, ordered captions and all image descriptors', async t => {
  const { store } = await fixture(t);
  const parsed = messageSchema.parse(wire);
  assert.equal(parsed.message_id, '18446744073709551611');
  assert.equal(parsed.item_list[1].image_item.aeskey, key.toString('hex'));
  store.accept([wire, wire], 'committed-before-download', new Set(['owner']), 1000);
  assert.equal(store.cursor(), 'committed-before-download');
  const row = store.next();
  assert.deepEqual(JSON.parse(row.input_json).parts.map(p => p.type), ['text', 'media', 'text', 'media']);
  assert.equal(store.counts().queued, 1);
});

test('Tencent key encodings, image hex precedence, URL encoding and AES padding are strict', async () => {
  for (const encoded of [key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64')]) assert.deepEqual(parseAesKey(encoded), key);
  for (const bad of ['', key.toString('base64').slice(0, -1), key.toString('base64') + '!', Buffer.alloc(32, 0xff).toString('base64')]) assert.throws(() => parseAesKey(bad));
  assert.deepEqual(decryptAesEcb(encrypted, key), png);
  assert.throws(() => decryptAesEcb(encrypted.subarray(0, -1), key), { code: 'INVALID_CIPHERTEXT' });
  assert.equal(buildCdnDownloadUrl('+/=%', cdnOptions.cdnBaseUrl), `${cdnOptions.cdnBaseUrl}/download?encrypted_query_param=%2B%2F%3D%25`);
  assert.deepEqual(await download(new CdnClient(cdnOptions, async () => new Response(encrypted)), { ...descriptor, aeskey: key.toString('hex'), aes_key: 'invalid' }), png);
  await assert.rejects(download(new CdnClient(cdnOptions), { ...descriptor, aeskey: 'invalid' }), { code: 'INVALID_KEY' });
});

test('CDN allowlist rejects hostile URLs before fetch and keeps API trust separate', async () => {
  const config = resolveConfig({});
  assert.equal(config.allowedApiHosts.includes('novac2c.cdn.weixin.qq.com'), false);
  let calls = 0;
  const client = new CdnClient(cdnOptions, async () => { calls++; throw Error('must not run'); });
  for (const url of [
    'http://novac2c.cdn.weixin.qq.com/c2c/download', 'https://novac2c.cdn.weixin.qq.com.evil.test/c2c/download',
    'https://evil.test/c2c/download', 'https://u:p@novac2c.cdn.weixin.qq.com/c2c/download',
    'https://novac2c.cdn.weixin.qq.com:443/c2c/download', 'https://novac2c.cdn.weixin.qq.com:8443/c2c/download',
    'https://novac2c.cdn.weixin.qq.com/c2c/download#fragment', 'https://novac2c.cdn.weixin.qq.com/c2c/download#', 'https://novac2c.cdn.weixin.qq.com/c2c/upload',
    'https://novac2c.cdn.weixin.qq.com/a/../c2c/download', 'https://novac2c.cdn.weixin.qq.com/c2c/%64ownload',
    'https://127.0.0.1/c2c/download', 'https://localhost/c2c/download',
  ]) await assert.rejects(download(client, { ...descriptor, full_url: url }), { code: 'CDN_URL' });
  assert.equal(calls, 0);
  assert.throws(() => cdnUrl('https://127.0.0.1/c2c/download', ['127.0.0.1']));
  assert.throws(() => resolveConfig({ cdnBaseUrl: 'https://ilinkai.weixin.qq.com/c2c' }));
});

test('CDN full_url wins, downloads carry no credentials, redirects are errors, plaintext must be explicit', async () => {
  let seen;
  const client = new CdnClient(cdnOptions, async (url, init) => { seen = { url: url.href, init }; return new Response(encrypted); });
  assert.deepEqual(await download(client, { ...descriptor, full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?a=1' }), png);
  assert.equal(seen.url, 'https://novac2c.cdn.weixin.qq.com/c2c/download?a=1');
  assert.equal(seen.init.redirect, 'error');
  assert.deepEqual(seen.init.headers, { Accept: 'application/octet-stream' });
  const plain = new CdnClient(cdnOptions, async () => new Response(png));
  assert.deepEqual(await download(plain, { encrypt_query_param: 'x', encrypt_type: 0 }), png);
  await assert.rejects(download(plain, { encrypt_query_param: 'x' }), { code: 'MISSING_KEY' });
  await assert.rejects(download(plain, { ...descriptor, encrypt_type: 2 }), { code: 'ENCRYPTION_UNSUPPORTED' });
  await assert.rejects(download(new CdnClient(cdnOptions, async () => { throw TypeError('redirect with secret url'); })), { code: 'CDN_NETWORK', retryable: true });
});

test('streaming caps cover missing/forged Content-Length, padding, plaintext and exact boundaries', async () => {
  assert.deepEqual(await download(new CdnClient(cdnOptions, async () => new Response(encrypted))), png);
  let cancelled = false;
  const oversized = new CdnClient(cdnOptions, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(30)); controller.enqueue(Buffer.alloc(30)); controller.enqueue(Buffer.alloc(30)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-length': '1' } }));
  await assert.rejects(download(oversized, { encrypt_query_param: 'x', encrypt_type: 0 }, 50), { code: 'IMAGE_TOO_LARGE' });
  assert.equal(cancelled, true);
  await assert.rejects(download(new CdnClient(cdnOptions, async () => new Response(encrypted, { headers: { 'content-length': '999999' } }))), { code: 'IMAGE_TOO_LARGE' });
  await assert.rejects(download(new CdnClient(cdnOptions, async () => new Response(encrypted.subarray(0, -1)))), { code: 'INVALID_CIPHERTEXT', retryable: false });
  await assert.rejects(download(new CdnClient(cdnOptions, async () => new Response(null, { status: 403 }))), { code: 'CDN_HTTP_403', retryable: false });
  await assert.rejects(download(new CdnClient(cdnOptions, async () => new Response(null, { status: 503 }))), { code: 'CDN_HTTP_503', retryable: true });
  assert.throws(() => inspectImage(Buffer.from('not an image'), 32e6, 20000), { code: 'INVALID_IMAGE' });
  const bomb = Buffer.from(png); bomb.writeUInt32BE(32000001, 16);
  assert.throws(() => inspectImage(bomb, 32e6, 40000000), { code: 'IMAGE_PIXELS' });
});

test('accept → prepare → DSH followup injects ordered native image parts and persists refs without secrets', async t => {
  const { store, directory } = await fixture(t);
  const host = attachments();
  store.accept([wire], 'after-image', new Set(['owner']), 1000);
  const { pipeline } = setupPipeline(store, directory, {}, host);
  await pipeline.initialize();
  const prepared = await pipeline.prepare(running(store), new AbortController().signal);
  assert.deepEqual(prepared.content.map(p => p.type), ['text', 'text', 'image', 'text', 'text', 'image']);
  assert.equal(host.calls.length, 2);
  assert.ok(!JSON.stringify(prepared).includes('aes_key'));
  assert.ok(!JSON.stringify(prepared).includes('cdn.weixin'));
  let submitted;
  const events = new Map();
  const session = { header: { cwd: directory }, seq: 0, append() {}, requestHeader() { return undefined; } };
  const agent = { session, options: { provider: 'fixture', model: 'vision' }, status: 'idle', followup(msg) { submitted = msg; }, async whenIdle() {
    events.get('session/event')(session, { type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '看到了图片' }] } } });
    events.get('session/event')(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  } };
  const ctx = {
    attachments: host, llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] }; } },
    agents: { get() {}, async create() { return { agent, async dispose() {} }; } },
    agentPresets: { async resolve() { return { id: 'standard' }; } }, agentDefaultModel: { currentSelection() { return agent.options; } },
    workspaceRegistry: { async create() { return { path: directory, async attachSession() {} }; } },
    permissionPresets: { set(session, preset) { assert.equal(preset, 'read-only'); } }, sessions: { async flush() {} },
    on(name, fn) { events.set(name, fn); return () => events.delete(name); },
    subagents: { async waitForChildren() { return false; }, async drainDescendants() {} },
  };
  const driver = new DshDriver(ctx, store, { workspaceRoot: directory, agentPreset: 'standard', permissionPreset: 'read-only', taskTimeoutMs: 1000 });
  try { assert.equal(await driver.respond('owner', prepared, new AbortController().signal), '看到了图片'); }
  finally { await driver.close(); }
  assert.deepEqual(submitted.content.map(p => p.type), prepared.content.map(p => p.type));
  assert.equal(submitted.content[2].attachment.attachmentId, 'fixture-attachment');
  const db = new DatabaseSync(join(directory, 'messages.sqlite'));
  try {
    const artifacts = db.prepare('SELECT * FROM media_artifacts').all(); assert.equal(artifacts.length, 2);
    assert.ok(artifacts.every(a => a.bytes === png.length && a.attachment_json && a.sha256.length === 64));
    assert.ok(db.prepare('SELECT descriptor_json FROM inbound_media').all().every(m => m.descriptor_json === null));
    for (const a of artifacts) { assert.deepEqual(await readFile(join(directory, 'inbound', a.relative_path)), png); assert.equal((await stat(join(directory, 'inbound', a.relative_path))).mode & 0o777, 0o600); }
  } finally { db.close(); }
  assert.equal((await stat(join(directory, 'inbound'))).mode & 0o777, 0o700);
});

test('voice/video are explicit stage notices and never initiate CDN or Agent work', async t => {
  const { store, directory } = await fixture(t);
  for (const [index, kind] of [3, 5].entries()) {
    const m = { ...message(String(index)), item_list: [{ type: kind, voice_item: { text: '/stop', media: descriptor }, video_item: { media: descriptor } }] };
    store.accept([m], `cursor-${index}`, new Set(['owner']), 1000);
    const row = store.next(); assert.equal(row.kind, 'notice'); assert.equal(row.status, 'ready');
    assert.match(row.reply, kind === 3 ? /尚未识别语音/ : /尚未解析视频/); store.status(row.id, 'done');
    const db = new DatabaseSync(join(directory, 'messages.sqlite'));
    try { const media = db.prepare('SELECT * FROM inbound_media WHERE inbox_id=?').get(row.id); assert.equal(media.kind, kind === 3 ? 'voice' : 'video'); assert.equal(media.error_code, 'STAGE_NOT_ENABLED'); assert.equal(media.descriptor_json, null); }
    finally { db.close(); }
  }
});

test('mixed image/voice/video produces one Agent task, ordered notices and a mandatory failure prefix', async t => {
  const { store, directory, onCleanup } = await fixture(t);
  const { pipeline } = setupPipeline(store, directory);
  await pipeline.initialize();
  const api = incomingApi(); const controller = new AbortController(); let calls = 0;
  const driver = { cancel() {}, async reset() {}, async respond(user, prepared) { calls++; assert.deepEqual(prepared.content.map(p => p.type), ['text', 'image', 'text', 'text']); return 'model reply'; } };
  const task = new Engine(api, auth, store, driver, { ...engineOptions, maxReplyChars: 1800 }, () => {}, pipeline).run(controller.signal);
  task.catch(() => {}); onCleanup(async () => { controller.abort(); await task.catch(() => {}); });
  api.push([{ ...imageMessage(), item_list: [wire.item_list[1], { type: 3 }, { type: 5 }] }]);
  await eventually(() => api.sent.length === 1 && store.counts().pending === 0);
  assert.equal(calls, 1); assert.match(api.sent[0].text, /尚未识别语音/); assert.match(api.sent[0].text, /尚未解析视频/); assert.match(api.sent[0].text, /model reply/);
});

test('unknown vision capability saves originals and returns a local notice without image injection', async t => {
  const { store, directory } = await fixture(t);
  const host = attachments();
  const { pipeline } = setupPipeline(store, directory, {}, host, undefined, async () => false);
  store.accept([imageMessage()], 'c', new Set(['owner']), 1000);
  const prepared = await pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(prepared.usable, false); assert.equal(host.calls.length, 0); assert.match(prepared.notices[0], /当前模型未启用图片理解/);
  assert.equal(store.artifactPaths().length, 1);
});

test('slow media keeps cursor/poll/status responsive; stop/new cancels downloads without a late Agent submit', async t => {
  for (const command of ['/stop', '/new']) {
    const { store, directory, onCleanup } = await fixture(t);
    const started = Promise.withResolvers(); let aborted = false; let reset = 0; let calls = 0;
    const { pipeline } = setupPipeline(store, directory, {}, attachments(), async (url, init) => { started.resolve(); try { await blocked(init.signal); } finally { aborted = true; } });
    const api = incomingApi(); const controller = new AbortController();
    const driver = { cancel() {}, async reset() { assert.equal(aborted, true); reset++; }, async respond() { calls++; return 'unexpected'; } };
    const task = new Engine(api, auth, store, driver, { ...engineOptions, maxReplyChars: 1800 }, () => {}, pipeline).run(controller.signal);
    task.catch(() => {}); onCleanup(async () => { controller.abort(); await task.catch(() => {}); });
    api.push([imageMessage(), imageMessage('queued')]); await started.promise;
    assert.equal(store.cursor(), '1');
    api.push([message('status', '/status')]); await eventually(() => api.sent.some(x => x.contextToken === 'context-status'));
    assert.match(api.sent.find(x => x.contextToken === 'context-status').text, /准备媒体：1/);
    api.push([message('control', command)]);
    await eventually(() => store.counts().pending === 0);
    assert.equal(aborted, true); assert.equal(calls, 0); assert.equal(reset, command === '/new' ? 1 : 0);
    assert.ok(api.sent.some(x => /媒体准备已停止/.test(x.text)));
    controller.abort(); await task.catch(() => {});
  }
});

test('preparing recovery retains Session and deadlines; agent-phase recovery never replays', async t => {
  const { store } = await fixture(t);
  store.bind('owner', 'existing'); store.accept([imageMessage()], 'c', new Set(['owner']), 1000);
  running(store); const deadline = store.beginPreparation('1', 1000);
  store.recover(); assert.equal(store.session('owner'), 'existing'); assert.equal(store.nextTask([]).prepare_deadline, deadline);
  running(store); assert.equal(store.beginPreparation('1', 99999), deadline);
  store.agentPhase('1'); store.recover(); assert.equal(store.session('owner'), undefined); assert.equal(store.nextTask([]), undefined); assert.match(store.next().reply, /中断/);
});

test('malformed items do not poison admission and references/over-limit/queue-full create no downloads', async t => {
  const { store } = await fixture(t);
  const bad = { ...imageMessage(), item_list: [{ type: 2, image_item: { media: { aes_key: 42 } } }, { type: 3, voice_item: null }, { broken: true }] };
  store.accept([bad], 'c', new Set(['owner']), 1000);
  assert.equal(store.cursor(), 'c'); assert.equal(store.next().kind, 'notice');
  store.status('1', 'done');
  const mixedCommand = { ...imageMessage('2'), item_list: [{ type: 1, text_item: { text: '/stop' } }, wire.item_list[1]] };
  store.accept([mixedCommand], 'd', new Set(['owner']), 1000);
  assert.equal(store.nextTask([]).kind, 'task');
  store.accept([imageMessage('3')], 'e', new Set(['owner']), 1000, 1);
  store.status('2', 'done'); assert.match(store.next().reply, /队列已满/);
});

test('quota, private permissions, symlink refusal, orphan cleanup and expired GC are enforced', async t => {
  const { store, directory } = await fixture(t);
  const { pipeline } = setupPipeline(store, directory, { inboundQuotaBytes: 1 });
  store.accept([imageMessage()], 'c', new Set(['owner']), 1000);
  let prepared = await pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(prepared.usable, false); assert.match(prepared.notices[0], /存储已满/);
  const unsafe = join(directory, 'unsafe'); await symlink(directory, unsafe);
  assert.throws(() => new InboundStorage(unsafe, 1e9), { code: 'UNSAFE_DIRECTORY' });
  await chmod(directory, 0o755); new InboundStorage(directory, 1e9); assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const storage = new InboundStorage(directory, 1e9); const temp = await storage.temporary('00000000-0000-0000-0000-000000000000'); await temp.write(png); await temp.finish();
  await storage.reconcile(new Set()); assert.deepEqual(await readdir(storage.root), []);
  const second = setupPipeline(store, directory);
  store.status('1', 'done'); store.accept([imageMessage('2')], 'd', new Set(['owner']), 1000);
  prepared = await second.pipeline.prepare(running(store), new AbortController().signal); assert.equal(prepared.usable, true); store.status('2', 'done');
  const db = new DatabaseSync(join(directory, 'messages.sqlite')); db.exec("UPDATE inbox SET received_at=1"); db.close();
  await second.pipeline.prune(); assert.equal(store.next(), undefined); assert.equal(store.artifactPaths().length, 0);
});

test('download retry budget and preparation deadline survive interruption; completed originals are reused', async t => {
  const { store, directory } = await fixture(t);
  let fetches = 0;
  const { pipeline } = setupPipeline(store, directory, {}, attachments(), async () => { fetches++; return new Response(encrypted); });
  store.accept([imageMessage()], 'c', new Set(['owner']), 1000);
  const row = running(store); const id = JSON.parse(row.input_json).parts[0].mediaId;
  store.attempt(id); store.attempt(id); store.recover();
  const result = await pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(result.usable, true); assert.equal(store.media(id).attempts, 3); assert.equal(fetches, 1);
  store.recover(); await pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(fetches, 1, 'saved original and attachment are reused without a fourth download');
  store.status('1', 'done'); store.accept([imageMessage('expired')], 'd', new Set(['owner']), 1000);
  const expired = running(store);
  const db = new DatabaseSync(join(directory, 'messages.sqlite')); db.exec("UPDATE inbox SET prepare_deadline=1 WHERE id='expired'"); db.close();
  const timedOut = await pipeline.prepare(expired, new AbortController().signal);
  assert.equal(timedOut.usable, false); assert.match(timedOut.notices[0], /准备超时/); assert.equal(fetches, 1);
});

test('only transient failures retry and failed pictures do not block subsequent messages', async t => {
  const { store, directory } = await fixture(t);
  let fetches = 0;
  const { pipeline } = setupPipeline(store, directory, {}, attachments(), async () => {
    fetches++; if (fetches === 1) return new Response(null, { status: 503 }); return new Response(encrypted);
  });
  store.accept([imageMessage()], 'c', new Set(['owner']), 1000);
  const row = running(store); const id = JSON.parse(row.input_json).parts[0].mediaId;
  assert.equal((await pipeline.prepare(row, new AbortController().signal)).usable, true);
  assert.equal(fetches, 2); assert.equal(store.media(id).attempts, 2);
  store.status('1', 'done');
  const broken = { ...imageMessage('bad'), item_list: [{ ...wire.item_list[1], image_item: { ...wire.item_list[1].image_item, aeskey: 'bad-key-secret' } }] };
  store.accept([broken, message('next')], 'd', new Set(['owner']), 1000);
  const failure = await pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(failure.usable, false); assert.equal(fetches, 2); assert.ok(!JSON.stringify(failure).includes('bad-key-secret'));
  store.status('bad', 'done'); assert.equal(store.nextTask([]).id, 'next');
});

test('bad decoded bytes stay unpublished; recovered artifacts verify hashes and orphan files are collected', async t => {
  const { store, directory } = await fixture(t);
  const host = attachments(); host.validateImage = async () => { throw Error('decoder failure with secret'); };
  const { pipeline } = setupPipeline(store, directory, {}, host);
  store.accept([imageMessage()], 'c', new Set(['owner']), 1000);
  const failure = await pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(failure.usable, false); assert.equal(store.artifactPaths().length, 0); assert.ok(!JSON.stringify(failure).includes('secret'));
  store.status('1', 'done'); store.accept([imageMessage('2')], 'd', new Set(['owner']), 1000);
  const good = setupPipeline(store, directory); const row = running(store);
  const prepared = await good.pipeline.prepare(row, new AbortController().signal); assert.equal(prepared.usable, true);
  await writeFile(join(directory, 'inbound', store.artifactPaths()[0]), Buffer.alloc(png.length));
  store.recover();
  const damaged = await good.pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(damaged.usable, false); assert.match(damaged.notices[0], /图片.*失败/);
  const temporary = await good.pipeline.storage.temporary('00000000-0000-0000-0000-000000000000'); await temporary.write(png); await temporary.finish();
  await good.pipeline.initialize(); assert.equal((await readdir(join(directory, 'inbound'))).length, 1);
});

test('bounded media downloads preserve sender FIFO while another sender and controls progress', async t => {
  const { store, directory, onCleanup } = await fixture(t);
  const slowStarted = Promise.withResolvers(); const finish = Promise.withResolvers(); const calls = [];
  let fetches = 0;
  const { pipeline } = setupPipeline(store, directory, { mediaDownloadConcurrency: 1 }, attachments(), async () => {
    if (++fetches === 1) { slowStarted.resolve(); await finish.promise; }
    return new Response(encrypted);
  });
  const controller = new AbortController(); const api = incomingApi();
  const driver = { cancel() {}, async reset() {}, async respond(user, input) { calls.push(user); return 'ok'; } };
  const task = new Engine(api, auth, store, driver, { ...engineOptions, allowedUsers: ['owner', 'other'], maxReplyChars: 1800 }, () => {}, pipeline).run(controller.signal);
  task.catch(() => {}); onCleanup(async () => { finish.resolve(); controller.abort(); await task.catch(() => {}); });
  api.push([imageMessage('1'), message('2', 'after image'), message('3', 'other text', 'other')]);
  await slowStarted.promise; await eventually(() => calls.length === 1);
  assert.deepEqual(calls, ['other']); assert.equal(store.cursor(), '1');
  finish.resolve(); await eventually(() => store.counts().pending === 0);
  assert.deepEqual(calls, ['other', 'owner', 'owner']);
  assert.equal(store.artifactPaths().length, 1);
});

test('preparation timeout aborts fetch and original-only failures never start Agent work', async t => {
  const { store, directory } = await fixture(t);
  let aborted = false;
  const { pipeline } = setupPipeline(store, directory, { mediaPrepareTimeoutMs: 100 }, attachments(), async (url, init) => {
    try { await blocked(init.signal); } finally { aborted = true; }
  });
  store.accept([imageMessage()], 'c', new Set(['owner']), 1000);
  // A ref'ed sentinel keeps node:test alive while AbortSignal.timeout's own timer is unref'ed.
  const timer = setTimeout(() => {}, 1000);
  try {
    const result = await pipeline.prepare(running(store), new AbortController().signal);
    assert.equal(aborted, true); assert.equal(result.usable, false); assert.match(result.notices[0], /准备超时/);
    assert.equal(store.artifactPaths().length, 0);
  } finally { clearTimeout(timer); }
});

test('host batch count/pixel limits and normalized image byte budgets are enforced', async t => {
  const { store, directory } = await fixture(t);
  const host = attachments(); host.imageLimits = { ...limits, maxImagesPerMessage: 1 };
  const { pipeline } = setupPipeline(store, directory, {}, host);
  store.accept([wire], 'c', new Set(['owner']), 1000);
  const result = await pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(result.content.filter(p => p.type === 'image').length, 1); assert.match(result.notices[0], /总数或总大小/);
  store.status(wire.message_id, 'done');
  const smallHost = attachments(); smallHost.imageLimits = { ...limits, maxImagePixels: 1 };
  const smaller = setupPipeline(store, directory, {}, smallHost);
  store.accept([imageMessage('2')], 'd', new Set(['owner']), 1000);
  const rejected = await smaller.pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(rejected.usable, false); assert.match(rejected.notices[0], /像素/);
  store.status('2', 'done');
  const normalizedHost = attachments();
  normalizedHost.saveImages = async inputs => [{ attachmentId: 'normalized', bytes: png.length + 1, width: 2, height: 2, mediaType: 'image/png' }];
  const normalized = setupPipeline(store, directory, { maxMessageImageBytes: png.length }, normalizedHost);
  store.accept([imageMessage('3')], 'e', new Set(['owner']), 1000);
  const oversized = await normalized.pipeline.prepare(running(store), new AbortController().signal);
  assert.equal(oversized.usable, false); assert.match(oversized.notices[0], /总大小/);
});

test('dangling SQLite WAL and media leaf symlinks are refused before any external write/read', async t => {
  const { directory } = await fixture(t);
  const isolated = join(directory, 'wal-attack'); await mkdir(isolated, { mode: 0o700 });
  await symlink(join(directory, 'never-created'), join(isolated, 'messages.sqlite-wal'));
  assert.throws(() => new Store(isolated, 'bot'), { code: 'UNSAFE_FILE' });
  const storage = new InboundStorage(directory, 1e9);
  const id = '00000000-0000-0000-0000-000000000000'; await mkdir(join(storage.root, id), { mode: 0o700 });
  await symlink(join(directory, 'messages.sqlite'), join(storage.root, id, 'original.png'));
  await assert.rejects(storage.read(`${id}/original.png`, 1024), { code: 'UNSAFE_FILE' });
  await assert.rejects(storage.read('../messages.sqlite', 1024), { code: 'UNSAFE_PATH' });
});
