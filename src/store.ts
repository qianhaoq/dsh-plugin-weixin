/** SQLite owns admission, command receipts, conversation bindings and multipart delivery. */
import { chmodSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { messageSchema, userIdSchema } from './protocol.js';
import type { WeixinMessage, WeixinUserId } from './protocol.js';
import { WeixinError } from './errors.js';
import { splitReply } from './delivery.js';
import { CHANNEL_COMMANDS, isControlCommand } from './commands.js';

/** Monotonic version of the plugin-owned SQLite tables. */
export const SCHEMA_VERSION = 2;
const rowSchema = z.object({
  sequence: z.number(), id: z.string(), user_id: userIdSchema, context_token: z.string(), prompt: z.string(),
  kind: z.enum(['task', 'control', 'notice']),
  status: z.enum(['received', 'running', 'ready', 'sending', 'done', 'unknown']),
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
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'messages.sqlite');
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const version = this.meta('schema_version');
      if (version !== '' && version !== '1' && version !== String(SCHEMA_VERSION)) throw new WeixinError('STATE', 'database', 'Unsupported schema version; restore a matching plugin version.');
      const owner = this.meta('bot_id');
      if (owner && owner !== botId) throw new WeixinError('STATE', 'database', 'Credentials belong to another bot; choose a separate state directory.');
      if (version === '1') {
        const backup = join(directory, `messages.v1.${randomUUID()}.sqlite`);
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
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS outbox (
            inbox_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, text TEXT NOT NULL, client_id TEXT NOT NULL,
            status TEXT NOT NULL, PRIMARY KEY (inbox_id, ordinal)
          );
          CREATE INDEX IF NOT EXISTS inbox_work ON inbox(status, kind, user_id);
        `);
        if (version !== String(SCHEMA_VERSION)) {
          for (const command of CHANNEL_COMMANDS) this.db.prepare("UPDATE inbox SET kind='control' WHERE trim(prompt)=?").run(command.name);
        }
        this.setMeta('schema_version', String(SCHEMA_VERSION));
        this.setMeta('bot_id', botId);
      });
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
  accept(raw: readonly unknown[], cursor: string, allowed: ReadonlySet<string>, maxPromptChars: number, maxPending = Number.MAX_SAFE_INTEGER): WeixinMessage[] {
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
        const notice = !textOnly ? '当前微信连接只支持文字，请把问题作为文字发送。' :
          prompt.length > maxPromptChars ? '消息过长，请拆成较短的文字消息。' :
          !prompt.trim() ? '请发送非空文字消息。' :
          !command && this.counts().queued + this.counts().running >= maxPending ? '任务队列已满，这条消息没有交给 DSH。请稍后重发；/status 和 /stop 仍然可用。' : null;
        this.db.prepare('INSERT INTO inbox (id,user_id,context_token,prompt,status,reply,client_id,received_at,kind) VALUES (?,?,?,?,?,?,?,?,?)').run(
          message.message_id, message.from_user_id, message.context_token, prompt.slice(0, maxPromptChars),
          notice === null ? 'received' : 'ready', notice, `dsh-weixin-${message.message_id}`, Date.now(),
          notice !== null ? 'notice' : command ? 'control' : 'task',
        );
        if (command && (prompt.trim() === '/stop' || prompt.trim() === '/new')) {
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
      this.db.exec("DELETE FROM conversations WHERE user_id IN (SELECT user_id FROM inbox WHERE status='running')");
      this.db.prepare("UPDATE inbox SET status='ready', reply=? WHERE status='running'").run('上一条任务因服务中断而停止，执行结果可能不完整。请检查工作区后重新发送；后续消息会使用新会话。');
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
  ready(id: string, reply: string): void { this.db.prepare("UPDATE inbox SET status='ready', reply=? WHERE id=?").run(reply, id); }

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
  counts(user?: WeixinUserId): { pending: number; unknown: number; queued: number; running: number } {
    const count = (where: string): number => z.object({ n: z.number() }).parse(this.db.prepare(`SELECT count(*) AS n FROM inbox WHERE ${where}${user === undefined ? '' : ' AND user_id=?'}`).get(...(user === undefined ? [] : [user]))).n;
    return { pending: count("status IN ('received','running','ready','sending')"), unknown: count("status='unknown'"),
      queued: count("kind='task' AND status='received'"), running: count("kind='task' AND status='running'") };
  }
  prune(days: number): void { this.db.prepare("DELETE FROM inbox WHERE status='done' AND received_at<?").run(Date.now() - days * 86_400_000); }
  close(): void { this.db.close(); }
}
