import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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
  assert.equal((await stat(join(root, backups[0]))).mode & 0o777, 0o600);
  const backup = new DatabaseSync(join(root, backups[0]));
  try { assert.equal(backup.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '1'); }
  finally { backup.close(); }
  const reopened = new Store(root, 'bot'); reopened.close();
  assert.equal((await readdir(root)).filter(name => /^messages\.v1\..*\.sqlite$/u.test(name)).length, 1);
});

test('v2 → v3 preserves ordering, prepared text, historical notices and multipart receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'messages.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE conversations(user_id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
    CREATE TABLE inbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,context_token TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,reply TEXT,client_id TEXT NOT NULL,received_at INTEGER NOT NULL,kind TEXT NOT NULL);
    CREATE TABLE outbox(inbox_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,text TEXT NOT NULL,client_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(inbox_id,ordinal));
    INSERT INTO metadata VALUES ('schema_version','2'),('bot_id','bot'),('cursor','v2-cursor');
    INSERT INTO conversations VALUES ('owner','old-session');
    INSERT INTO inbox VALUES ('large-18446744073709551615','owner','ctx','hello','running',NULL,'stable-client',1,'task');
    INSERT INTO inbox VALUES ('notice','owner','ctx','','done','old media notice','notice-client',2,'notice');
    INSERT INTO inbox VALUES ('reply','other','ctx','prompt','unknown','saved','reply-client',3,'task');
    INSERT INTO outbox VALUES ('reply',0,'prefix','stable-part-0','done'),('reply',1,'suffix','stable-part-1','unknown');`);
  old.close();
  const store = new Store(root, 'bot');
  try {
    assert.equal(store.next(), undefined);
    store.recover(); assert.equal(store.session('owner'), undefined);
    assert.equal(store.next().sequence, 1); assert.match(store.next().reply, /中断/);
    assert.deepEqual(JSON.parse(store.next().input_json), { version: 1, parts: [{ type: 'text', text: 'hello' }] });
    assert.equal(store.cursor(), 'v2-cursor');
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare("SELECT kind FROM inbox WHERE id='notice'").get().kind, 'notice');
      assert.equal(db.prepare('SELECT count(*) AS n FROM inbound_media').get().n, 0);
      assert.deepEqual(db.prepare('SELECT client_id,status FROM outbox ORDER BY ordinal').all().map(r => ({...r})), [{client_id:'stable-part-0',status:'done'}, {client_id:'stable-part-1',status:'unknown'}]);
    } finally { db.close(); }
  } finally { store.close(); }
  assert.equal((await readdir(root)).filter(name => /^messages\.v2\..*\.sqlite$/u.test(name)).length, 1);
});

test('failed v2 migration rolls back added columns and schema metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-migration-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'messages.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('schema_version','2'),('bot_id','bot');
    CREATE TABLE inbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,context_token TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,reply TEXT,client_id TEXT NOT NULL,received_at INTEGER NOT NULL,kind TEXT NOT NULL);
    CREATE TRIGGER reject_version BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;`);
  old.close();
  assert.throws(() => new Store(root, 'bot'), /fixture migration failure/);
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '2');
    assert.equal(db.prepare('PRAGMA table_info(inbox)').all().some(r => r.name === 'phase'), false);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='inbound_media'").get(), undefined);
  } finally { db.close(); }
});
