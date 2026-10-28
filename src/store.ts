/** SQLite owns admission, command receipts, conversation bindings and multipart delivery. */
import { chmodSync, existsSync, openSync, closeSync, constants, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { messageSchema, userIdSchema } from './protocol.js';
import type { WeixinMessage, WeixinUserId } from './protocol.js';
import { WeixinError } from './errors.js';
import { splitReply } from './delivery.js';
import { CHANNEL_COMMANDS, isControlCommand } from './commands.js';
import { privateDirectory, privateFile } from './media/storage.js';
import { descriptorSchema, IMAGE_NOTICE, VOICE_NOTICE, VIDEO_NOTICE, UNSUPPORTED_NOTICE } from './media/types.js';
import type { InboundInput, PreparedInbound, MediaRow, Artifact } from './media/types.js';

/** Monotonic version of the plugin-owned SQLite tables. */
export const SCHEMA_VERSION = 3;
const rowSchema = z.object({
  sequence: z.number(), id: z.string(), user_id: userIdSchema, context_token: z.string(), prompt: z.string(),
  kind: z.enum(['task', 'control', 'notice']),
  status: z.enum(['received', 'running', 'ready', 'sending', 'done', 'unknown']),
  phase: z.string().nullable(), input_json: z.string(), prepared_json: z.string().nullable(), prepare_deadline: z.number().nullable(),
  reply: z.string().nullable(), client_id: z.string(),
});
export type InboxRow = z.infer<typeof rowSchema>;
const deliverySchema = z.object({
  id: z.string(), user_id: userIdSchema, context_token: z.string(), ordinal: z.number(),
  text: z.string(), client_id: z.string(),
});
export type Delivery = z.infer<typeof deliverySchema>;

/** One account's durable work. A committed cursor includes every accepted message. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(directory: string, botId: string) {
    privateDirectory(directory);
    const path = join(directory, 'messages.sqlite');
    if (existsSync(path)) privateFile(path);
    else closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    for (const suffix of ['-wal', '-shm']) {
      try { privateFile(path + suffix); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    for (const name of readdirSync(directory)) if (/^messages\.v\d+\..*\.sqlite$/u.test(name)) privateFile(join(directory, name));
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const version = this.meta('schema_version');
      if (version !== '' && version !== '1' && version !== '2' && version !== String(SCHEMA_VERSION)) throw new WeixinError('STATE', 'database', 'Unsupported schema version; restore a matching plugin version.');
      const owner = this.meta('bot_id');
      if (owner && owner !== botId) throw new WeixinError('STATE', 'database', 'Credentials belong to another bot; choose a separate state directory.');
      if (version === '1' || version === '2') {
        const backup = join(directory, `messages.v${version}.${randomUUID()}.sqlite`);
        closeSync(openSync(backup, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        this.db.prepare('VACUUM INTO ?').run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS conversations (user_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS inbox (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, context_token TEXT NOT NULL,
            prompt TEXT NOT NULL, status TEXT NOT NULL, reply TEXT,
            client_id TEXT NOT NULL, received_at INTEGER NOT NULL
          );
        `);
        const columns = this.db.prepare('PRAGMA table_info(inbox)').all();
        if (!columns.some(row => row['name'] === 'kind')) this.db.exec("ALTER TABLE inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
        for (const [name, definition] of Object.entries({ input_json: "TEXT NOT NULL DEFAULT '{\"version\":1,\"parts\":[]}'", prepared_json: 'TEXT', phase: 'TEXT', prepare_deadline: 'INTEGER' })) {
          if (!columns.some(row => row['name'] === name)) this.db.exec(`ALTER TABLE inbox ADD COLUMN ${name} ${definition}`);
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS inbound_media (
            id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
            item_ordinal INTEGER NOT NULL, kind TEXT NOT NULL, descriptor_json TEXT, status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, notice TEXT, processor_version INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL, UNIQUE(inbox_id,item_ordinal)
          );
          CREATE TABLE IF NOT EXISTS media_artifacts (
            media_id TEXT PRIMARY KEY REFERENCES inbound_media(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'original',
            relative_path TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, attachment_json TEXT
          );
          CREATE TABLE IF NOT EXISTS media_gc (inbox_id TEXT NOT NULL, relative_path TEXT NOT NULL, PRIMARY KEY(inbox_id,relative_path));
        `);
        if (version !== String(SCHEMA_VERSION)) {
          for (const row of this.db.prepare('SELECT id,prompt FROM inbox').all()) {
            this.db.prepare('UPDATE inbox SET input_json=? WHERE id=?').run(JSON.stringify({ version: 1, parts: [{ type: 'text', text: row['prompt'] }] }), row['id']!);
          }
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS outbox (
            inbox_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, text TEXT NOT NULL, client_id TEXT NOT NULL,
            status TEXT NOT NULL, PRIMARY KEY (inbox_id, ordinal)
          );
          CREATE INDEX IF NOT EXISTS inbox_work ON inbox(status, kind, user_id);
        `);
        if (version !== String(SCHEMA_VERSION)) {
          for (const command of CHANNEL_COMMANDS) this.db.prepare("UPDATE inbox SET kind='control' WHERE kind='task' AND trim(prompt)=?").run(command.name);
        }
        this.setMeta('schema_version', String(SCHEMA_VERSION));
        this.setMeta('bot_id', botId);
      });
      for (const suffix of ['-wal', '-shm']) {
        try { privateFile(path + suffix); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      }
    } catch (error) { this.db.close(); throw error; }
  }

  private meta(key: string): string {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row === undefined ? '' : z.object({ value: z.string() }).parse(row).value;
  }
  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cursor(): string { return this.meta('cursor'); }

  /** Commit messages and cursor together. Full task queues reject new tasks visibly; controls remain available. */
  accept(raw: readonly unknown[], cursor: string, allowed: ReadonlySet<string>, maxPromptChars: number, maxPending = Number.MAX_SAFE_INTEGER, maxMedia = 4): WeixinMessage[] {
    return this.transaction(() => {
      const added: WeixinMessage[] = [];
      for (const value of raw) {
        const envelope = z.object({ message_type: z.number(), group_id: z.string().optional() }).safeParse(value);
        if (envelope.success && (envelope.data.message_type !== 1 || envelope.data.group_id)) continue;
        const parsed = messageSchema.safeParse(value);
        if (!parsed.success) throw new WeixinError('PROTOCOL', 'incoming message', 'Malformed message; cursor was not advanced.');
        const message = parsed.data;
        if (message.group_id || !allowed.has(message.from_user_id)) continue;
        if (!message.context_token) throw new WeixinError('PROTOCOL', 'incoming message', 'Missing reply context; cursor was not advanced.');
        if (this.db.prepare('SELECT id FROM inbox WHERE id=?').get(message.message_id)) continue;
        const textOnly = message.item_list.length > 0 && message.item_list.every(item => item.type === 1 && item.text_item && item.ref_msg === undefined);
        const prompt = message.item_list.map(item => item.text_item?.text ?? '').join('\n');
        const command = textOnly && isControlCommand(prompt.trim());
        const referenced = message.item_list.some(item => item.ref_msg !== undefined);
        const mediaCount = message.item_list.filter(item => item.type !== 1).length;
        const notice = referenced ? '当前尚不支持引用消息，请单独发送文字或图片。' :
          prompt.length > maxPromptChars ? '消息过长，请拆成较短的文字消息。' :
          mediaCount > maxMedia ? `单条消息最多支持 ${maxMedia} 个媒体条目，请拆分后重发。` :
          !message.item_list.length || (textOnly && !prompt.trim()) ? '请发送非空文字消息。' :
          !command && this.counts().queued + this.counts().running >= maxPending ? '任务队列已满，这条消息没有交给 DSH。请稍后重发；/status 和 /stop 仍然可用。' : null;
        const input: InboundInput = { version: 1, parts: [] };
        const media: { id: string; ordinal: number; kind: string; descriptor: string | null; notice: string | null; errorCode: string | null }[] = [];
        if (notice === null) for (const [ordinal, item] of message.item_list.entries()) {
          if (item.type === 1 && item.text_item) { input.parts.push({ type: 'text', text: item.text_item.text }); continue; }
          if (item.type === 3 || item.type === 5) {
            const text = item.type === 3 ? VOICE_NOTICE : VIDEO_NOTICE;
            media.push({ id: randomUUID(), ordinal, kind: item.type === 3 ? 'voice' : 'video', descriptor: null, notice: text, errorCode: 'STAGE_NOT_ENABLED' });
            input.parts.push({ type: 'notice', text }); continue;
          }
          if (item.type !== 2) { input.parts.push({ type: 'notice', text: UNSUPPORTED_NOTICE }); continue; }
          const image = z.object({ media: descriptorSchema, aeskey: z.string().max(128).optional() }).safeParse(item.image_item);
          const descriptor = image.success ? { ...image.data.media, ...(image.data.aeskey === undefined ? {} : { aeskey: image.data.aeskey }) } : undefined;
          const valid = descriptor && (descriptor.full_url || descriptor.encrypt_query_param) &&
            (descriptor.aeskey !== undefined || descriptor.aes_key !== undefined || descriptor.encrypt_type === 0);
          const id = randomUUID();
          media.push({ id, ordinal, kind: 'image', descriptor: valid ? JSON.stringify(descriptor) : null, notice: valid ? null : IMAGE_NOTICE, errorCode: valid ? null : 'INVALID_DESCRIPTOR' });
          input.parts.push({ type: 'media', mediaId: id, ordinal });
        }
        // Unsupported-only messages remain local; mixed messages get exactly one prepared user message.
        const onlyNotices = input.parts.length > 0 && input.parts.every(part => part.type === 'notice' || (part.type === 'media' && media.find(item => item.id === part.mediaId)?.notice));
        const localNotice = notice ?? (onlyNotices ? input.parts.map(part => part.type === 'notice' ? part.text : part.type === 'media' ? media.find(item => item.id === part.mediaId)?.notice ?? '' : '').join('\n') : null);
        this.db.prepare('INSERT INTO inbox (id,user_id,context_token,prompt,status,reply,client_id,received_at,kind,input_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
          message.message_id, message.from_user_id, message.context_token, prompt.slice(0, maxPromptChars),
          localNotice === null ? 'received' : 'ready', localNotice, `dsh-weixin-${message.message_id}`, Date.now(),
          localNotice !== null ? 'notice' : command ? 'control' : 'task', JSON.stringify(input),
        );
        for (const item of media) this.db.prepare('INSERT INTO inbound_media(id,inbox_id,item_ordinal,kind,descriptor_json,status,error_code,notice,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
          item.id, message.message_id, item.ordinal, item.kind, item.descriptor, item.notice ? 'failed' : 'pending', item.errorCode, item.notice, Date.now());
        if (command && (prompt.trim() === '/stop' || prompt.trim() === '/new')) {
          this.db.prepare("UPDATE inbound_media SET descriptor_json=NULL,status='failed',error_code='CANCELLED',notice='任务已取消' WHERE inbox_id IN (SELECT id FROM inbox WHERE user_id=? AND kind='task' AND status='received')").run(message.from_user_id);
          this.db.prepare("UPDATE inbox SET status='ready', reply=? WHERE user_id=? AND kind='task' AND status='received'").run('排队中的任务已被你的会话控制命令取消，没有运行。', message.from_user_id);
        }
        added.push(message);
      }
      this.setMeta('cursor', cursor);
      return added;
    });
  }

  /** Never replay interrupted tasks or sends, including records migrated from v1. */
  recover(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM conversations WHERE user_id IN (SELECT user_id FROM inbox WHERE status='running' AND (phase IS NULL OR phase!='preparing'))");
      this.db.prepare("UPDATE inbox SET status='ready', reply=? WHERE status='running' AND (phase IS NULL OR phase!='preparing')").run('上一条任务因服务中断而停止，执行结果可能不完整。请检查工作区后重新发送；后续消息会使用新会话。');
      this.db.exec("UPDATE inbox SET status='received' WHERE status='running' AND phase='preparing'; UPDATE inbound_media SET status='pending' WHERE status='downloading';");
      this.db.exec("UPDATE outbox SET status='unknown' WHERE status='sending'; UPDATE inbox SET status='unknown' WHERE status='sending'");
    });
  }
  next(): InboxRow | undefined {
    const row = this.db.prepare("SELECT rowid AS sequence,* FROM inbox WHERE status IN ('received','ready') ORDER BY rowid LIMIT 1").get();
    return row === undefined ? undefined : rowSchema.parse(row);
  }
  controls(): InboxRow[] { return this.db.prepare("SELECT rowid AS sequence,* FROM inbox WHERE kind='control' AND status='received' ORDER BY rowid").all().map(row => rowSchema.parse(row)); }
  nextTask(excluded: readonly string[]): InboxRow | undefined {
    const condition = excluded.length ? ` AND user_id NOT IN (${excluded.map(() => '?').join(',')})` : '';
    const row = this.db.prepare(`SELECT rowid AS sequence,* FROM inbox WHERE kind='task' AND status='received'${condition} ORDER BY rowid LIMIT 1`).get(...excluded);
    return row === undefined ? undefined : rowSchema.parse(row);
  }
  status(id: string, status: InboxRow['status']): void { this.db.prepare('UPDATE inbox SET status=? WHERE id=?').run(status, id); }
  ready(id: string, reply: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE inbox SET status='ready', reply=? WHERE id=?").run(reply, id);
      this.db.prepare("UPDATE inbound_media SET descriptor_json=NULL,status='failed',error_code='CANCELLED',notice='准备已结束' WHERE inbox_id=? AND status IN ('pending','downloading')").run(id);
    });
  }

  private parts(row: InboxRow, limit: number): void {
    if (this.db.prepare('SELECT ordinal FROM outbox WHERE inbox_id=? LIMIT 1').get(row.id)) return;
    if (row.reply === null) throw new WeixinError('STATE', 'saved reply', 'Reply text is missing; preserve the database and inspect the account state.');
    const texts = splitReply(row.reply, limit);
    for (const [ordinal, text] of texts.entries()) this.db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?)').run(row.id, ordinal, text, ordinal === 0 ? row.client_id : `${row.client_id}:${ordinal + 1}`, 'pending');
  }
  nextDelivery(limit: number): Delivery | undefined {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT rowid AS sequence,* FROM inbox WHERE status='ready' AND NOT EXISTS (SELECT 1 FROM outbox WHERE inbox_id=inbox.id)").all();
      for (const row of rows) this.parts(rowSchema.parse(row), limit);
    });
    const row = this.db.prepare(`SELECT i.id,i.user_id,i.context_token,o.ordinal,o.text,o.client_id FROM outbox o
      JOIN inbox i ON i.id=o.inbox_id WHERE i.status='ready' AND o.status='pending'
      ORDER BY CASE i.kind WHEN 'control' THEN 0 ELSE 1 END,i.rowid,o.ordinal LIMIT 1`).get();
    return row === undefined ? undefined : deliverySchema.parse(row);
  }
  startDelivery(part: Delivery): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET status='sending' WHERE inbox_id=? AND ordinal=?").run(part.id, part.ordinal);
      this.status(part.id, 'sending');
    });
  }
  acknowledge(part: Delivery): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET status='done' WHERE inbox_id=? AND ordinal=?").run(part.id, part.ordinal);
      const remaining = this.db.prepare("SELECT ordinal FROM outbox WHERE inbox_id=? AND status!='done' LIMIT 1").get(part.id);
      this.status(part.id, remaining ? 'ready' : 'done');
    });
  }
  unknown(part: Delivery): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET status='unknown' WHERE inbox_id=? AND ordinal=?").run(part.id, part.ordinal);
      this.status(part.id, 'unknown');
    });
  }
  /** Explicit user consent retries only the unknown part and remaining parts, never acknowledged parts or model work. */
  retryLatest(user: WeixinUserId, context: string, limit: number): boolean {
    return this.transaction(() => {
      const value = this.db.prepare("SELECT rowid AS sequence,* FROM inbox WHERE user_id=? AND status='unknown' AND NOT (kind='control' AND trim(prompt)='/retry') ORDER BY rowid DESC LIMIT 1").get(user);
      if (!value) return false;
      const row = rowSchema.parse(value);
      this.parts(row, limit);
      this.db.prepare("UPDATE outbox SET status='pending' WHERE inbox_id=? AND status='unknown'").run(row.id);
      this.db.prepare("UPDATE inbox SET context_token=?, status='ready' WHERE id=?").run(context, row.id);
      return true;
    });
  }
  session(user: WeixinUserId): string | undefined {
    const row = this.db.prepare('SELECT session_id FROM conversations WHERE user_id=?').get(user);
    return row === undefined ? undefined : z.object({ session_id: z.string() }).parse(row).session_id;
  }
  bind(user: WeixinUserId, session: string): void { this.db.prepare('INSERT INTO conversations VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id').run(user, session); }
  forget(user: WeixinUserId): void { this.db.prepare('DELETE FROM conversations WHERE user_id=?').run(user); }
  counts(user?: WeixinUserId): { pending: number; unknown: number; queued: number; running: number; preparing: number } {
    const count = (where: string): number => z.object({ n: z.number() }).parse(this.db.prepare(`SELECT count(*) AS n FROM inbox WHERE ${where}${user === undefined ? '' : ' AND user_id=?'}`).get(...(user === undefined ? [] : [user]))).n;
    return { pending: count("status IN ('received','running','ready','sending')"), unknown: count("status='unknown'"),
      queued: count("kind='task' AND status='received'"), running: count("kind='task' AND status='running'"), preparing: count("kind='task' AND status='running' AND phase='preparing'") };
  }
  prune(days: number): void { this.db.prepare("DELETE FROM inbox WHERE status='done' AND received_at<? AND NOT EXISTS (SELECT 1 FROM inbound_media m JOIN media_artifacts a ON a.media_id=m.id WHERE m.inbox_id=inbox.id)").run(Date.now() - days * 86_400_000); }
  preparingPhase(id: string): void { this.db.prepare("UPDATE inbox SET phase='preparing' WHERE id=? AND status='running'").run(id); }
  beginPreparation(id: string, timeout: number): number {
    this.db.prepare("UPDATE inbox SET phase='preparing', prepare_deadline=coalesce(prepare_deadline,?) WHERE id=? AND status='running'").run(Date.now() + timeout, id);
    return Number(this.db.prepare('SELECT prepare_deadline FROM inbox WHERE id=?').get(id)!['prepare_deadline']);
  }
  prepared(id: string, input: PreparedInbound): void { this.db.prepare("UPDATE inbox SET prepared_json=? WHERE id=? AND status='running' AND phase='preparing'").run(JSON.stringify(input), id); }
  agentPhase(id: string): void { this.db.prepare("UPDATE inbox SET phase='agent' WHERE id=? AND status='running'").run(id); }
  media(id: string): MediaRow & { notice: string | null } { return this.db.prepare('SELECT * FROM inbound_media WHERE id=?').get(id) as unknown as MediaRow & { notice: string | null }; }
  attempt(id: string): void { this.db.prepare("UPDATE inbound_media SET attempts=attempts+1,status='downloading',updated_at=? WHERE id=?").run(Date.now(), id); }
  mediaFailure(id: string, code: string, notice: string): void { this.db.prepare("UPDATE inbound_media SET status='failed',error_code=?,notice=?,descriptor_json=NULL,updated_at=? WHERE id=?").run(code, notice, Date.now(), id); }
  artifact(id: string): Artifact | undefined { return this.db.prepare('SELECT * FROM media_artifacts WHERE media_id=?').get(id) as unknown as Artifact | undefined; }
  saveArtifact(artifact: Artifact): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO media_artifacts(media_id,relative_path,bytes,mime,sha256,attachment_json) VALUES (?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET attachment_json=excluded.attachment_json').run(artifact.media_id, artifact.relative_path, artifact.bytes, artifact.mime, artifact.sha256, artifact.attachment_json);
      this.db.prepare("UPDATE inbound_media SET status='ready',descriptor_json=NULL,error_code=NULL,notice=NULL,updated_at=? WHERE id=?").run(Date.now(), artifact.media_id);
    });
  }
  hasArtifactPath(path: string): boolean { return Boolean(this.db.prepare('SELECT media_id FROM media_artifacts WHERE relative_path=?').get(path)); }
  artifactPaths(): string[] { return this.db.prepare('SELECT relative_path FROM media_artifacts').all().map(row => String(row['relative_path'])); }
  markMediaGc(days: number): { inbox_id: string; relative_path: string }[] {
    this.db.prepare("INSERT OR IGNORE INTO media_gc SELECT i.id,a.relative_path FROM inbox i JOIN inbound_media m ON m.inbox_id=i.id JOIN media_artifacts a ON a.media_id=m.id WHERE i.status='done' AND i.received_at<?").run(Date.now() - days * 86_400_000);
    return this.db.prepare('SELECT * FROM media_gc').all() as unknown as { inbox_id: string; relative_path: string }[];
  }
  finishMediaGc(id: string): void { this.transaction(() => { this.db.prepare("DELETE FROM inbox WHERE id=? AND status='done'").run(id); this.db.prepare('DELETE FROM media_gc WHERE inbox_id=?').run(id); }); }

  close(): void { this.db.close(); }
}
