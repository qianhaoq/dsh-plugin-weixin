import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = process.env.DSH_SOURCE_DIR;
const bin = process.env.DSH_BIN ?? 'dsh';

test('source-built dsh loads the bundle and resumes a real Agent through the Messages mock', { skip: !source, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-integration-'));
  const cleanups = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const { startMockLlmServer } = await import(pathToFileURL(join(resolve(source), 'packages/test-support/llm-mock-server/lib/index.js')).href);
  const reply = '微信桥接测试回复。'.repeat(20);
  const model = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: reply });
  cleanups.push(() => model.close());
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-weixin-fixture', DEEPSEEK_BASE_URL: model.baseURL, NODE_NO_WARNINGS: '1' };
  for (const name of Object.keys(env)) if (/(?:OPENAI|ANTHROPIC|DEEPSEEK_SEARCH).*KEY/u.test(name)) delete env[name];
  const run = args => promisify(execFile)(bin, args, { env, cwd: workspace, timeout: 30000, maxBuffer: 2 ** 20 });
  await run(['web', '--dump-config']);
  await run(['plugin', '--profile', 'web', 'add', pluginRoot]);
  await run(['plugin', '--profile', 'weixin-login', 'add', pluginRoot]);
  const statusState = join(root, 'status-state'); await mkdir(statusState, { mode: 0o700 });
  await writeFile(join(statusState, 'credentials.json'), JSON.stringify({ version: 1, token: 'fixture-not-live', botId: 'fixture-bot', userId: 'fixture-user', baseUrl: 'https://ilinkai.weixin.qq.com' }), { mode: 0o600 });
  const statusPatch = join(root, 'status.patch.json');
  await writeFile(statusPatch, JSON.stringify([{ id: 'hmr', disabled: true }, { id: 'weixin', config: { mode: 'status', stateDirectory: statusState } }]));
  const statusResult = await run(['--profile', 'weixin-login', '--patch', statusPatch]);
  assert.match(statusResult.stdout, /authenticated; pending=0; unknown=0/u);
  const patch = join(root, 'smoke.patch.json');
  const output = join(root, 'result.json');
  await writeFile(patch, JSON.stringify([
    { id: 'hmr', disabled: true }, { id: 'session-log-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'driver-smoke', name: join(pluginRoot, 'tests/fixtures/driver-smoke.mjs'), config: { stateDirectory: join(root, 'state'), workspaceRoot: workspace, outputPath: output } }] },
  ]));
  const child = spawn(bin, ['web', '--patch', patch, '--port', '0', '--no-open'], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; let result;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { result = { code, signal }; resolve(result); }));
  cleanups.push(async () => { if (result === undefined) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DSH smoke did not finish: ${logs.replace(/token=[^\s]+/gu, 'token=<redacted>')}`)), 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('DSH exited before fixture completion.')); });
    const append = chunk => { logs += chunk.toString(); if (logs.includes('weixin-driver-smoke: complete')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', append); child.stderr.on('data', append);
  });
  const transcript = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(transcript, { replies: [reply, reply], sessionReused: true, channelContextLogged: true, pipelineReplies: [reply, reply], runtimeSessionReused: true, cursorResumed: true, sessionImageLogged: true, imagePrepared: true, nativeAttachmentReadable: true, permissionPreserved: true, unknownRetried: true });
  assert.equal(model.requests.length, 4, 'unknown delivery retry never resubmits the image task');
  assert.ok(model.requests.some(request => JSON.stringify(request.body).includes('\"type\":\"image\"')), 'provider request contains actual image input');
  assert.ok(JSON.stringify(model.requests[0].body).includes('WeChat ClawBot'));
  assert.ok(model.requests.some(request => JSON.stringify(request.body).includes('微信第一条测试消息')));
  assert.ok(JSON.stringify(model.requests.at(-1).body).includes('流水线第1条测试消息'));
  child.kill('SIGINT');
  const ending = await exited;
  assert.equal(ending.signal, null);
  assert.equal(ending.code, 130);
});
