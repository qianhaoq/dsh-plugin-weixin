import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { messageSchema, userIdSchema } from './protocol.js';
import type { WeixinMessage, WeixinUserId } from './protocol.js';
import { WeixinError } from './errors.js';

const rowSchema = z.object({
  id: z.string(), user_id: userIdSchema, context_token: z.string(), prompt: z.string(),
  status: z.enum(['received', 'running', 'ready', 'sending', 'done', 'unknown']),
  reply: z.string().nullable(), client_id: z.string(),
});
export type InboxRow = z.infer<typeof rowSchema>;

/** Monotonic version of the plugin-owned SQLite tables. */
export const SCHEMA_VERSION = 1;

/** Durable inbox/cursor transaction. A saved cursor never discards an accepted message. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(directory: string, botId: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'messages.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (user_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, context_token TEXT NOT NULL,
        prompt TEXT NOT NULL, status TEXT NOT NULL, reply TEXT,
        client_id TEXT NOT NULL, received_at INTEGER NOT NULL
      );
    `);
    const version = this.meta('schema_version');
    if (version !== '' && version !== String(SCHEMA_VERSION)) { this.close(); throw new WeixinError('STATE', 'database', 'Unsupported schema version; restore a matching plugin version.'); }
    const owner = this.meta('bot_id');
    if (owner && owner !== botId) { this.close(); throw new WeixinError('STATE', 'database', 'Credentials belong to another bot; choose a separate state directory.'); }
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    this.setMeta('bot_id', botId);
  }

  private meta(key: string): string {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
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

  /** Persist accepted messages and the next cursor atomically. Returns newly accepted messages. */
  accept(raw: readonly unknown[], cursor: string, allowed: ReadonlySet<string>, maxPromptChars: number): WeixinMessage[] {
    return this.transaction(() => {
      const added: WeixinMessage[] = [];
      for (const value of raw) {
        const envelope = z.object({ message_type: z.number(), group_id: z.string().optional() }).safeParse(value);
        if (envelope.success && (envelope.data.message_type !== 1 || envelope.data.group_id)) continue;
        const parsed = messageSchema.safeParse(value);
        if (!parsed.success) throw new WeixinError('PROTOCOL', 'incoming message', 'Malformed message; cursor was not advanced.');
        const message = parsed.data;
        if (message.message_type !== 1 || message.group_id || !allowed.has(message.from_user_id)) continue;
        if (!message.context_token) throw new WeixinError('PROTOCOL', 'incoming message', 'Missing reply context; cursor was not advanced.');
        const textOnly = message.item_list.length > 0 && message.item_list.every(item => item.type === 1 && item.text_item && item.ref_msg === undefined);
        const prompt = message.item_list.map(item => item.text_item?.text ?? '').join('\n');
        const unsupported = !textOnly ? '当前微信连接只支持文字，请把问题作为文字发送。' :
          prompt.length > maxPromptChars ? '消息过长，请拆成较短的文字消息。' : null;
        const result = this.db.prepare('INSERT OR IGNORE INTO inbox VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          message.message_id, message.from_user_id, message.context_token,
          prompt, unsupported === null ? 'received' : 'ready', unsupported,
          `dsh-weixin-${message.message_id}`, Date.now(),
        );
        if (Number(result.changes) > 0) added.push(message);
      }
      this.setMeta('cursor', cursor);
      return added;
    });
  }

  /** Interrupted tasks are never rerun; interrupted sends remain visibly unknown. */
  recover(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM conversations WHERE user_id IN (SELECT user_id FROM inbox WHERE status = 'running')");
      this.db.prepare("UPDATE inbox SET status = 'ready', reply = ? WHERE status = 'running'").run('上一条任务因服务中断而停止，执行结果可能不完整。请检查工作区后重新发送；后续消息会使用新会话。');
      this.db.exec("UPDATE inbox SET status = 'unknown' WHERE status = 'sending'");
    });
  }
  next(): InboxRow | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE status IN ('received', 'ready') ORDER BY rowid LIMIT 1").get();
    return row === undefined ? undefined : rowSchema.parse(row);
  }
  status(id: string, status: InboxRow['status']): void { this.db.prepare('UPDATE inbox SET status=? WHERE id=?').run(status, id); }
  ready(id: string, reply: string): void { this.db.prepare("UPDATE inbox SET status='ready', reply=? WHERE id=?").run(reply, id); }
  session(user: WeixinUserId): string | undefined {
    const row = this.db.prepare('SELECT session_id FROM conversations WHERE user_id=?').get(user);
    return row === undefined ? undefined : z.object({ session_id: z.string() }).parse(row).session_id;
  }
  bind(user: WeixinUserId, session: string): void { this.db.prepare('INSERT INTO conversations VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id').run(user, session); }
  forget(user: WeixinUserId): void { this.db.prepare('DELETE FROM conversations WHERE user_id=?').run(user); }
  counts(): { pending: number; unknown: number } {
    const count = (where: string): number => z.object({ n: z.number() }).parse(this.db.prepare(`SELECT count(*) AS n FROM inbox WHERE ${where}`).get()).n;
    return { pending: count("status IN ('received','running','ready')"), unknown: count("status='unknown'") };
  }
  prune(days: number): void { this.db.prepare("DELETE FROM inbox WHERE status='done' AND received_at < ?").run(Date.now() - days * 86_400_000); }
  close(): void { this.db.close(); }
}
