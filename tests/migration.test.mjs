import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../dist/store.js';

test('v1 migration preserves cursor, Session mapping, replies and unknown delivery without replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'messages.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE conversations(user_id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
    CREATE TABLE inbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,context_token TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,reply TEXT,client_id TEXT NOT NULL,received_at INTEGER NOT NULL);
    INSERT INTO metadata VALUES ('schema_version','1'),('bot_id','bot'),('cursor','old-cursor');
    INSERT INTO conversations VALUES ('owner','session-existing');
    INSERT INTO inbox VALUES ('1','owner','ctx','hello','ready','saved answer','stable-client-1',1);
    INSERT INTO inbox VALUES ('2','owner','ctx','hello','sending','uncertain answer','stable-client-2',2);`);
  old.close();
  const store = new Store(root, 'bot');
  try {
    store.recover();
    assert.equal(store.cursor(), 'old-cursor');
    assert.equal(store.session('owner'), 'session-existing');
    assert.equal(store.counts().unknown, 1);
    const part = store.nextDelivery(100);
    assert.equal(part.text, 'saved answer');
    assert.equal(part.client_id, 'stable-client-1');
    store.startDelivery(part); store.acknowledge(part);
    assert.equal(store.nextDelivery(100), undefined);
  } finally { store.close(); }
  const upgraded = new DatabaseSync(path);
  try { assert.equal(upgraded.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, String(SCHEMA_VERSION)); }
  finally { upgraded.close(); }
  const backups = (await readdir(root)).filter(name => /^messages\.v1\..*\.sqlite$/u.test(name));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(root, backups[0]));
  try { assert.equal(backup.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '1'); }
  finally { backup.close(); }
  const reopened = new Store(root, 'bot'); reopened.close();
  assert.equal((await readdir(root)).filter(name => /^messages\.v1\..*\.sqlite$/u.test(name)).length, 1);
});
