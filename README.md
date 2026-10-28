# DSH 微信插件

[English](README.en.md) | 中文

通过微信 ClawBot 的 iLink Bot API，直接向本机 DeepSeek Harness 发送文字和图片任务，并接收 DSH 的最终文字回复。插件运行在 DSH 的 Cordis profile 中，不依赖 OpenClaw，也不提供独立应用启动器。

当前版本为 `0.2.0`，针对 DSH `0.2.1-rc.3` 和 Node.js 24.9+ 开发。iLink 接口可能变化；自动化测试使用协议 fixture，真实微信收发需要扫码后的人工验收。此项目由社区维护，并非腾讯或 DeepSeek 官方插件。媒体边界与配置见[图片入站说明](docs/media-mvp1.md)。设计与取舍见[架构说明](docs/architecture.md)、[社区对比](docs/comparison.md)；已有用户先读[升级说明](docs/upgrade-0.2.md)。

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

已有的 `dsh web` 需要重启并带上这份 patch，才能启用微信连接；仅安装包不会开始接收消息。模型与登录凭据沿用该 Web profile 的 DSH 配置；也可以在 patch 中同时明确指定 `provider` 和 `model`。每个微信用户使用独立的持久 DSH Session，连续消息续接同一会话；该 Session 会附加到配置的工作区，能够在 Web 界面中查看。它不会接管你原来打开的聊天会话。

默认只接受扫码微信用户的私聊。要开放给其他用户，明确配置 `allowedUsers` 为 iLink user ID 列表；该列表一旦非空就完全替代默认扫码账号。群聊和 bot 消息会被忽略，不会执行模型任务。

在微信 ClawBot 聊天中发送文字或图片即可运行任务；看图需要当前模型明确声明支持图片输入：

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示命令和入站媒体限制。 |
| `/new` | 取消当前任务和此前排队工作，等待清理后切换新会话；历史日志保留。 |
| `/stop` | 请求停止当前任务，并取消命令之前的排队任务；之后的消息保留，已完成操作不撤销。 |
| `/status` | 显示你自己的运行、排队和未知投递数量，长任务期间也可响应。 |
| `/retry` | 核对聊天后，续发自己最近一条投递结果不明的回复；可能重复，不重跑模型或已确认段。 |

MVP1 入站支持文字＋图片：配文和多张图片按原顺序进入同一条 DSH user message，图片经宿主 `attachments.saveImages` 保存并注入原生 image parts。语音尚未识别（包括微信附带的转写字段），视频尚未解析；这两类在当前阶段不下载，明确提示改发文字或关键截图。文件和引用消息也尚不支持。混合消息保留可用文字/图片，并在最终回复中明确列出缺失部分。只有无媒体、无引用的纯文字才识别渠道命令。同一用户按顺序执行任务，不同用户有界并行；控制命令不占模型执行槽。任务运行期间显示原生“正在输入”，输入状态接口失败不会影响任务。

达到 `maxPendingMessages` 时，新文字任务收到明确的队满通知，不会暗中丢弃或假装已排队；轮询继续接收控制命令。每个 Agent 的渠道说明使用同一命令表，并通过 DSH 原生系统提示词和 Session 日志记录，模型能据此解释微信里的操作方式。

## 权限与运行要求

默认 `permissionPreset: read-only`，并且 Agent 的审批策略固定为 `never`：需要额外批准的操作自动拒绝，不会通过微信放行，也不会自动提升权限。若明确选择 `workspace-write`，DSH 会使用该预设允许的工作区写入权限。不要仅为了消除错误而选择更高权限。

电脑需要联网并持续运行 DSH。断网期间轮询采用有上限的指数退避，已接收任务仍保存在本机。会话返回 `-14` 时，先在 `sessionRecoveryAttempts` 范围内尝试恢复后端会话；持续失败才停止并提示重新登录。后台故障同时写入 stderr 和 Cordis 日志，即使 profile 没有日志 exporter 也能看到。日志不会输出 bot token、context token、原始接口响应或模型回复；终端二维码链接本身属于登录信息，不要公开分享。

## 持久化与失败语义

插件数据目录包含 `inbound/` 图片原件、私密凭据和 schema v3 的 `messages.sqlite`，后者保存微信文字、回复上下文、最终回复、同步游标和微信用户到 DSH Session 的映射。新建目录权限为 `0700`，凭据与数据库文件权限为 `0600`（POSIX）；Windows 使用账号目录访问控制。备份这些文件时应按聊天记录和凭据处理。

一把进程锁保证同一插件目录只有一个运行实例。入站消息与下一次轮询游标在同一 SQLite 事务中保存；同一 bot 下的精确消息 ID 用于去重，包括超过 JavaScript 安全整数范围的 ID。已完成消息保留 `historyRetentionDays` 天，之后清理；去重保证覆盖保留期间。

任务先进入 `running/phase=preparing`，图片准备完成后先持久化 `phase=agent` 再交给 DSH；正常完成后先 flush Session，再保存完整回复并按段发送。段号计入长度限制，每段有稳定 ID 和独立确认状态；正文不会被截断。重启后，尚在 preparing 的任务可使用原件、剩余下载次数和原截止时间继续准备；已进入 agent 阶段的任务不会自动重跑，系统会发送中断提示，并让该用户的后续任务使用新会话。已经保存但尚未发送的回复可以继续投递，已确认的段不会再次发送。

每段发送前写入 `sending`；发送失败或进程在投递期间退出后，该段记为 `unknown`，后续段暂停，不自动重发。请先核对微信聊天和 DSH Session，再用 `/retry` 续发；它只发送保存的正文，不重跑任务。稳定 `client_id` 不被当成服务端去重承诺，API 确认也不等同于手机已读；插件不承诺 exactly-once 网络投递。`/status` 和默认日志都会报告未知投递。

数据库版本 1 首次升级到版本 2 前，会自动生成一份私密 SQLite 备份，再以事务迁移；凭据和 Session 文件位置保持不变。关闭时由一个 Runtime 依次完成操作 drain、Driver 释放、数据库关闭和账号锁释放，清理失败也不会跳过后续释放。

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
| `reconnectMaxDelayMs` / `sessionRecoveryAttempts` | `30000` / `1`；轮询退避上限与连续会话拒绝的恢复次数。 |
| `maxConcurrentUsers` | `4`；不同用户的模型执行槽，同一用户始终串行。 |
| `typingIntervalMs` | `10000`；原生输入状态刷新间隔，`0` 关闭。 |
| `shutdownTimeoutMs` | `2000`；停止通知与辅助输入状态请求的时间预算。 |
| `outboundIntervalMs` | `300`；已处理的消息段之间的发送间隔。 |
| `taskTimeoutMs` | `180000`；超时请求取消，不撤销已完成的操作。 |
| `maxPromptChars` / `maxReplyChars` | `16000` UTF-16 代码单元 / 每段 `1800` Unicode 码点（含段号）；超长输入拒绝进入模型，回复完整分段。 |
| `maxPendingMessages` | `100`，模型任务接纳上限；队满仍接收控制命令。 |
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

测试覆盖协议鉴权、64 位 ID、可信主机、扫码与验证码、凭据权限、游标事务、去重、发送者隔离、用户内顺序与用户间并行、队满控制、分段确认、手动续发、升级备份和有序清理。测试使用独立临时目录、可注入 transport 和事件屏障，不登录真实微信、不发送真实消息、不调用付费模型 API。CI 在 Linux 和 Windows 的 Node.js 24/26 上执行检查。

另有针对已构建 DSH 源码 checkout 的集成测试：真实 CLI 加载插件，真实 Agent 通过本地 Messages mock 运行两轮，验证渠道说明已经记录到 Session。完整的模拟微信入站、调度、分段确认和账号运行实例重启还会验证游标与会话续接。测试创建独立 Harness home 和工作区，并关闭会话日志上传：

```sh
DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness \
DSH_BIN=/absolute/path/to/dsh \
pnpm run test:integration
```

未设置 `DSH_SOURCE_DIR` 时，这个单独的测试命令会明确跳过集成用例，不能算作集成通过。

协议参考：[腾讯微信插件源码](https://github.com/Tencent/openclaw-weixin)、[DSH 插件开发](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。微信接口兼容性和真实账号验收不能由 fixture 测试代替。

## 图片入站（MVP1）

Run profile 需要 `attachments` 和 `llm`，login/status 模式不依赖它们。实际 provider/model 未明确声明 `image` 能力时，只归档图片并明确通知，不把本地路径冒充视觉输入；不会切换模型或提升 Agent 权限。

`allowedCdnHosts` 默认仅含 `novac2c.cdn.weixin.qq.com`，独立于携带 bot token 的 `allowedApiHosts`。默认 `cdnBaseUrl` 为 `https://novac2c.cdn.weixin.qq.com/c2c`；full URL 只允许该白名单 HTTPS 的 `/c2c/download`，禁止凭据、显式端口、fragment 与重定向。CDN 请求不携带 iLink 凭据。

原件存放在 `stateDirectory/inbound/<本机 UUID>/original.<格式>`，目录/文件权限为 `0700/0600`。接收记录和游标一起提交后才异步下载；不会因为坏图片退回游标。先完成流式限额、AES padding、图片格式/像素和宿主完整解码验证，再原子发布并记录哈希。原件额度默认 1 GiB，保留期沿用 `historyRetentionDays=30`，只清理已完成且到期的消息；未知投递和未完成任务保留。宿主共享附件不计入该额度，也不由插件删除。

主要媒体配置（可调低，范围限制见 `src/config.ts`）：

| 配置 | 默认值 |
| --- | --- |
| `maxMediaItems` | 4 个/消息 |
| `maxImageBytes` / `maxImagePixels` | 10 MiB / 3200 万像素 |
| `maxMessageMediaBytes` / `maxMessageImageBytes` | 原件 60 MiB / 注入图片 12 MiB |
| `mediaDownloadConcurrency` | 2；解码和附件保存串行 |
| `mediaDownloadTimeoutMs` / `mediaPrepareTimeoutMs` | 单次 20000 / 消息准备合计 120000 ms |
| `inboundQuotaBytes` | 1073741824（1 GiB） |

图片数量、字节、像素与尺寸也受宿主 `imageLimits` 中更严格的限制。只有网络、429、5xx 至多尝试三次，退避 1/3 秒；403/404、key、padding、大小与解码错误不重试。`/retry` 仍仅重发投递不明的最终文字，不重新下载媒体或运行 Agent。真实微信和实际视觉模型仍需部署方人工验收；自动化已覆盖隔离 DSH 的原生图片附件、Session 和模型请求。
