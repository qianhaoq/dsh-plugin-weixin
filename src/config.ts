/** Deployment validation and Cordis configuration form. */
import Schema from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { WeixinError } from './errors.js';
import { apiOrigin } from './protocol.js';

const optionsSchema = z.object({
  mode: z.enum(['disabled', 'login', 'run', 'status']).default('disabled'),
  stateDirectory: z.string().default(join(resolveDshHome(), 'weixin')),
  workspaceRoot: z.string().optional(),
  allowedUsers: z.array(z.string().min(1)).default([]),
  allowedApiHosts: z.array(z.string().min(1)).min(1).default(['ilinkai.weixin.qq.com', 'ilinkai.wxqcloud.qq.com']),
  loginBaseUrl: z.string().default('https://ilinkai.weixin.qq.com'),
  agentPreset: z.string().default('standard'), permissionPreset: z.string().default('read-only'),
  provider: z.string().min(1).optional(), model: z.string().min(1).optional(),
  requestTimeoutMs: z.number().int().min(100).default(15000),
  pollTimeoutMs: z.number().int().min(100).default(40000),
  loginTimeoutMs: z.number().int().min(100).default(300000),
  loginPollIntervalMs: z.number().int().min(10).default(1000),
  reconnectDelayMs: z.number().int().min(10).default(3000),
  reconnectMaxDelayMs: z.number().int().min(10).default(30000),
  sessionRecoveryAttempts: z.number().int().min(0).default(1),
  queueIntervalMs: z.number().int().min(10).default(250),
  taskTimeoutMs: z.number().int().min(100).default(180000),
  maxPromptChars: z.number().int().positive().default(16000),
  maxReplyChars: z.number().int().min(100).default(1800),
  maxPendingMessages: z.number().int().positive().default(100),
  maxConcurrentUsers: z.number().int().positive().default(4),
  shutdownTimeoutMs: z.number().int().min(100).default(2000),
  typingIntervalMs: z.number().int().min(0).default(10000),
  outboundIntervalMs: z.number().int().min(0).default(300),
  historyRetentionDays: z.number().int().positive().default(30),
}).strict();

/** Deployment configuration. State and workspace paths must be absolute. */
export type Config = z.input<typeof optionsSchema>;
export type ResolvedConfig = z.output<typeof optionsSchema>;
export const Config = Schema.object({
  mode: Schema.union(['disabled', 'login', 'run', 'status']).default('disabled'),
  stateDirectory: Schema.string(), workspaceRoot: Schema.string(),
  allowedUsers: Schema.array(Schema.string()), allowedApiHosts: Schema.array(Schema.string()).default(['ilinkai.weixin.qq.com', 'ilinkai.wxqcloud.qq.com']),
  loginBaseUrl: Schema.string(), agentPreset: Schema.string(), permissionPreset: Schema.string(),
  provider: Schema.string(), model: Schema.string(),
  requestTimeoutMs: Schema.number(), pollTimeoutMs: Schema.number(), loginTimeoutMs: Schema.number(),
  loginPollIntervalMs: Schema.number(), reconnectDelayMs: Schema.number(), reconnectMaxDelayMs: Schema.number(), sessionRecoveryAttempts: Schema.number(), queueIntervalMs: Schema.number(),
  taskTimeoutMs: Schema.number(), maxPromptChars: Schema.number(), maxReplyChars: Schema.number(),
  maxPendingMessages: Schema.number(), maxConcurrentUsers: Schema.number(), shutdownTimeoutMs: Schema.number(), typingIntervalMs: Schema.number(), outboundIntervalMs: Schema.number(), historyRetentionDays: Schema.number(),
});

/** Validate all deployment fields before registering effects. */
export function resolveConfig(input: Config): z.output<typeof optionsSchema> {
  const result = optionsSchema.safeParse(input);
  if (!result.success) throw new WeixinError('STATE', 'configuration', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const config = result.data;
  if (!isAbsolute(config.stateDirectory) || (config.workspaceRoot !== undefined && !isAbsolute(config.workspaceRoot))) throw new WeixinError('STATE', 'configuration', 'stateDirectory and workspaceRoot must be absolute paths.');
  if (config.mode === 'run' && !config.workspaceRoot) throw new WeixinError('STATE', 'configuration', 'Run mode requires an explicit workspaceRoot.');
  if (Boolean(config.provider) !== Boolean(config.model)) throw new WeixinError('STATE', 'configuration', 'provider and model must be specified together.');
  if (config.reconnectMaxDelayMs < config.reconnectDelayMs) throw new WeixinError('STATE', 'configuration', 'reconnectMaxDelayMs must be at least reconnectDelayMs.');
  apiOrigin(config.loginBaseUrl, config.allowedApiHosts);
  return config;
}
