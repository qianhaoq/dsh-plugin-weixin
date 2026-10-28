# 升级到 0.2.0

先停止正在使用这个插件的 DSH 进程，再安装依赖、构建并重新启动。新版本继续使用原来的 `credentials.json`、`messages.sqlite` 和微信用户到 DSH Session 的映射，不要求删除数据或重新扫码；只有凭据确实不能恢复时才需要登录。

```sh
cd /absolute/path/to/dsh-plugin-weixin
git pull --ff-only
pnpm install --frozen-lockfile
pnpm check
dsh web --patch ~/.dsh/weixin-run.patch.yml
```

## 配置与交互变化

- `maxReplyChars` 现在限制每个消息段的码点数，包含段号标签；完整答案不再被截断。旧版本已经截去的正文无法从旧数据库重建。
- `/stop` 取消当前任务及命令之前尚未开始的排队任务，之后到达的消息保留。
- `/new` 取消旧任务和旧排队工作，等待清理后再建立新会话。
- `maxPendingMessages` 现在是模型任务接纳上限。队满时新任务收到明确拒绝通知；轮询不停止，控制命令继续可用。
- 不同用户默认可同时运行，`maxConcurrentUsers: 1` 可限制为一个模型执行槽；同一用户仍然严格顺序执行。
- `queueIntervalMs` 保留为无消息轮询的间隔，空闲工作器由通知唤醒，不再定时扫描数据库。
- 新增 `/retry`。请先确认上一条回复是否已经在微信中可见；此命令可能产生重复文字，但不会重新执行模型任务或已确认段。
- 默认启用原生输入状态；`typingIntervalMs: 0` 可关闭。状态请求失败不影响任务。
- 新增 `reconnectMaxDelayMs`、`sessionRecoveryAttempts`、`shutdownTimeoutMs` 和 `outboundIntervalMs`，默认值见 README 配置表。审批与授权默认值没有改变。

## SQLite 升级

`SCHEMA_VERSION` 从 `1` 单向升级到 `2`。升级前创建一份 `messages.v1.<随机标识>.sqlite`，权限为 `0600`（POSIX）。这份备份包含升级前的私密聊天数据，用于诊断；不要上传到 GitHub。

迁移在事务中添加消息类型和分段 outbox，保留游标、去重记录、会话映射和已保存回复。旧版 `sending` 记录仍然标记为未知投递，不自动重发。已确认的分段状态在新版本重启后继续生效。

旧版插件拒绝读取版本 2。不要还原一个旧同步游标后直接继续收取消息：备份之后执行过的任务不在旧去重记录中，可能被重复执行。这里不提供自动降级或游标回退流程。

插件升级不改变 DSH 的 Session 日志格式，也不移动 Session 文件。首次启动失败时请保留原目录，按照日志中具体的配置、宿主服务或凭据错误处理。
