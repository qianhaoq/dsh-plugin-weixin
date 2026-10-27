# DSH 微信插件

[English](README.en.md) | 中文

通过微信 ClawBot 的 iLink Bot API，直接向本机 DeepSeek Harness 发送文字任务，并接收 DSH 的最终文字回复。插件运行在 DSH 的 Cordis profile 中，不依赖 OpenClaw，也不提供独立应用启动器。

当前版本为 `0.1.0`，针对 DSH `0.2.1-rc.3` 和 Node.js 24.9+ 开发。iLink 接口可能变化；自动化测试使用协议 fixture，真实微信收发需要扫码后的人工验收。此项目由社区维护，并非腾讯或 DeepSeek 官方插件。

## 安装

先安装可用的 `dsh`。源码安装方法见 [DSH README](https://github.com/deepseek-ai/deepseek-harness#run-from-source)。私有仓库请使用已登录 GitHub 的 `gh` 克隆：

```sh
gh repo clone qianhaoq/dsh-plugin-weixin
cd dsh-plugin-weixin
pnpm install --frozen-lockfile
pnpm test

# 安装到日常使用的 Web profile，默认处于 disabled 状态。
dsh plugin --profile web add "$PWD"

# 扫码登录使用独立的 base-backed profile，避免占用现有 Web 端口。
dsh plugin --profile weixin-login add "$PWD"
dsh --profile weixin-login --patch "$PWD/examples/login.patch.yml"
```

使用微信扫一扫终端二维码，并在手机上确认；如果手机要求输入数字，在终端输入显示的验证码。二维码失效后重新执行登录命令。登录成功后，凭据只保存在 `$DSH_HOME/weixin/credentials.json`，默认目录是 `~/.dsh/weixin`。插件不会读取或迁移 OpenClaw 的微信凭据。请为 DSH 单独绑定，不要让两个程序同时轮询同一个 bot。

## 启动

复制 `examples/run.patch.yml`，把 `workspaceRoot` 改成允许微信操作的**绝对目录**，然后启动：

```sh
dsh web --patch /absolute/path/to/your/run.patch.yml
```

已有的 `dsh web` 需要重启并带上这份 patch，才能启用微信连接；仅安装包不会开始接收消息。模型与登录凭据沿用该 Web profile 的 DSH 配置；也可以在 patch 中同时明确指定 `provider` 和 `model`。每条微信任务使用自己的 DSH Session，该 Session 会附加到配置的工作区，能够在 Web 界面中查看。它不会接管你原来打开的聊天会话。

默认只接受扫码微信用户的私聊。要开放给其他用户，明确配置 `allowedUsers` 为 iLink user ID 列表；该列表一旦非空就完全替代默认扫码账号。群聊和 bot 消息会被忽略，不会执行模型任务。

在微信 ClawBot 聊天中发送普通文字即可运行任务：

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示命令和文字消息限制。 |
| `/new` | 释放当前微信用户的 Agent，下一条任务创建新会话；历史日志保留。 |
| `/stop` | 立即请求取消当前正在运行的任务；已完成的操作不会撤销。 |
| `/status` | 显示待处理数量与回复投递结果未知的数量。 |

第一版不下载或执行图片、语音、视频、文件以及引用内容；包含这些条目的消息会收到文字提示。所有用户的任务按接收顺序串行执行，轮询与任务执行独立，因此运行任务时仍可接收 `/stop`。同一批响应可能使队列短暂超过 `maxPendingMessages`；达到阈值后暂停后续轮询，已经接收的整批消息仍被保存。

## 权限与运行要求

默认 `permissionPreset: read-only`，并且 Agent 的审批策略固定为 `never`：需要额外批准的操作自动拒绝，不会通过微信放行，也不会自动提升权限。若明确选择 `workspace-write`，DSH 会使用该预设允许的工作区写入权限。不要仅为了消除错误而选择更高权限。

电脑需要联网并持续运行 DSH。断网期间轮询会重试，已接收任务仍保存在本机；微信凭据失效（`-14`）时连接停止，需要重新扫码。后台故障同时写入 stderr 和 Cordis 日志，即使 profile 没有日志 exporter 也能看到。日志不会输出 bot token、context token、原始接口响应或模型回复；终端二维码链接本身属于登录信息，不要公开分享。

## 持久化与失败语义

插件数据目录包含私密凭据和 `messages.sqlite`，后者保存微信文字、回复上下文、最终回复、同步游标和微信用户到 DSH Session 的映射。新建目录权限为 `0700`，凭据与数据库文件权限为 `0600`（POSIX）；Windows 使用账号目录访问控制。备份这些文件时应按聊天记录和凭据处理。

一把进程锁保证同一插件目录只有一个运行实例。入站消息与下一次轮询游标在同一 SQLite 事务中保存；同一 bot 下的精确消息 ID 用于去重，包括超过 JavaScript 安全整数范围的 ID。已完成消息保留 `historyRetentionDays` 天，之后清理；去重保证覆盖保留期间。

任务在写入 `running` 状态后才交给 DSH；正常完成后先 flush Session，再保存回复并发送。重启后，`running` 任务不会自动重跑，系统会发送中断提示，并让该用户的后续任务使用新会话。已经保存但尚未发送的回复可以继续投递。

发送前写入 `sending`；发送失败或进程在投递期间退出后，状态记为 `unknown`，不自动重发，也不重跑任务。稳定 `client_id` 不被当成服务端去重承诺。请先核对微信聊天和 DSH Session，再决定是否重发任务；`/status` 和默认日志都会报告未知投递。插件不承诺 exactly-once 网络投递。

## 配置

`weixin` entry 的 patch 会替换完整配置对象；省略值使用下表默认值。`provider` 和 `model` 必须同时设置。`run` 依赖 Web profile 提供的 Agent、预设、工作区和 Session 服务。

| 字段 | 默认值 / 说明 |
| --- | --- |
| `mode` | `disabled`；可选 `login`、`run`、`status`。 |
| `stateDirectory` | `$DSH_HOME/weixin`，必须为绝对路径。切换 bot 使用独立目录；已有数据库拒绝不同 bot 身份。 |
| `workspaceRoot` | `run` 必填；现有绝对目录。 |
| `allowedUsers` | `[]`，只接受扫码账号；非空时使用精确白名单。 |
| `agentPreset` / `permissionPreset` | `standard` / `read-only`。 |
| `provider` / `model` | 省略时使用 DSH 当前默认模型，新会话时解析。 |
| `loginBaseUrl` | `https://ilinkai.weixin.qq.com`。 |
| `allowedApiHosts` | `ilinkai.weixin.qq.com`、`ilinkai.wxqcloud.qq.com`；只允许精确主机名的 HTTPS origin，禁止 URL 凭据与 HTTP 重定向。新增后端域名必须由操作者明确加入。 |
| `requestTimeoutMs` / `pollTimeoutMs` | `15000` / `40000`。 |
| `loginTimeoutMs` / `loginPollIntervalMs` | `300000` / `1000`。 |
| `reconnectDelayMs` / `queueIntervalMs` | `3000` / `250`。 |
| `taskTimeoutMs` | `180000`；超时请求取消，不撤销已完成的操作。 |
| `maxPromptChars` / `maxReplyChars` | `16000` UTF-16 代码单元 / `1800` Unicode 码点；超长输入拒绝进入模型，超长回复截断并提示查看 DSH。 |
| `maxPendingMessages` | `100`，达到后暂停轮询。 |
| `historyRetentionDays` | `30`，只清理已完成记录。 |

在没有启动 Web 的独立 profile 中查看本机状态：

```sh
dsh --profile weixin-login --patch /absolute/path/to/dsh-plugin-weixin/examples/status.patch.yml
```

这个命令与运行中的微信实例使用同一把排他锁；若提示锁已占用，使用微信 `/status` 或查看运行实例的日志。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

测试覆盖协议鉴权、64 位 ID、可信主机、扫码与验证码、凭据权限、游标事务、去重、发送者隔离、中断恢复、未知投递、任务失败及并行轮询取消。测试使用独立临时目录、可注入 transport 和事件屏障，不登录真实微信、不发送真实消息、不调用付费模型 API。CI 在 Linux 和 Windows 的 Node.js 24/26 上执行检查。

另有针对已构建 DSH 源码 checkout 的集成测试：真实 CLI 加载插件，真实 Agent 通过本地 Messages mock 运行两轮，并在释放 Agent 后恢复原来的持久会话。测试创建独立 Harness home 和工作区，并关闭会话日志上传：

```sh
DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness \
DSH_BIN=/absolute/path/to/dsh \
pnpm run test:integration
```

未设置 `DSH_SOURCE_DIR` 时，这个单独的测试命令会明确跳过集成用例，不能算作集成通过。

协议参考：[腾讯微信插件源码](https://github.com/Tencent/openclaw-weixin)、[DSH 插件开发](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。微信接口兼容性和真实账号验收不能由 fixture 测试代替。
