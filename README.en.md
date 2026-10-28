# DSH WeChat plugin

English | [中文](README.md)

A community Cordis plugin connecting WeChat ClawBot directly to DeepSeek Harness through the iLink bot API. It sends text and inbound image prompts to channel-owned DSH Sessions and returns final text responses. OpenClaw is not required. This project is not an official Tencent or DeepSeek product.

Version `0.2.0` targets DSH `0.2.1-rc.3` and Node.js 24.9+. Protocol fixtures cover automated behavior; real WeChat compatibility still requires QR login and an account-level acceptance test. See the Chinese [architecture](docs/architecture.md), [community comparison](docs/comparison.md), and [0.2 upgrade guide](docs/upgrade-0.2.md).

## Install and connect

```sh
gh repo clone qianhaoq/qh-dsh-weixin
cd qh-dsh-weixin
pnpm install --frozen-lockfile
pnpm test
dsh plugin --profile web add "$PWD"
dsh plugin --profile weixin-login add "$PWD"
dsh --profile weixin-login --patch "$PWD/examples/login.patch.yml"
```

Scan the terminal QR code with WeChat and confirm on the phone. Enter a phone verification code in the terminal if requested. An expired QR requires another login attempt. Credentials are stored in `$DSH_HOME/weixin/credentials.json`, with `~/.dsh` as the default Harness home. The plugin never reads OpenClaw credentials; use a dedicated bot binding and do not poll the same bot from two applications.

Copy `examples/run.patch.yml`, set `workspaceRoot` to an existing absolute directory, then run:

```sh
dsh web --patch /absolute/path/to/your/run.patch.yml
```

Installation is disabled by default. Restart an existing Web process with this patch to enable the channel. The selected Web profile supplies model credentials and its default model; explicit `provider` and `model` must be supplied together. Each sender gets a separate persistent DSH Session attached to the configured workspace, rather than taking over an existing browser conversation.

Send text or images in the ClawBot conversation (image input requires a model route that explicitly declares image support). `/help` lists commands; `/new` cancels old work and waits for cleanup before a fresh conversation; `/stop` cancels the active task and tasks queued before the command, retaining later messages and completed effects; `/status` reports your own running, queued and uncertain deliveries even during a long task. After checking the chat, `/retry` resumes your latest uncertain reply without rerunning model work or acknowledged parts; duplicate delivery is possible. Only the QR owner's private messages are accepted by default. A nonempty `allowedUsers` list replaces that default. Groups and bot messages are ignored. MVP1 admits captions and images in order into one native DSH user message using `attachments.saveImages` and image attachment references. Voice is not recognized (including embedded transcripts) and video is not parsed; neither is downloaded in this stage. Files and quoted messages remain unsupported. Mixed messages retain usable text/images and explicitly prefix replies with any missing-media notices. Only pure unquoted text can invoke channel commands.

Each user's tasks retain FIFO order, while different users progress with bounded concurrency. Controls do not occupy model execution slots. A full task queue produces an explicit rejection notice and continues accepting controls. Native typing indicators provide activity feedback without extra text messages. Their failure does not fail the task. The command catalog also supplies a scoped DSH system-prompt section, recorded in the Session so the model can explain channel operation.

## Permissions and operation

The default permission preset is `read-only`. Approval policy is fixed to `never`: actions needing extra approval are rejected, never automatically authorized. An explicitly selected `workspace-write` preset permits its normal sandboxed workspace writes. Interactive permission approval through WeChat is not implemented. The computer and DSH must remain running and online.

Polling retries transient connection failures with capped exponential backoff. Session rejection permits a bounded backend reconnect using existing credentials; persistent rejection stops the channel and requires QR login. Background failures go to stderr and Cordis logging, including profiles without a log exporter. Account operations use an exclusive process lock. New data directories use POSIX mode `0700`; credentials and the SQLite database use `0600`. Windows uses the account directory's access controls. The database contains private chat text, reply context, answers, cursors and sender-to-Session mappings; protect backups accordingly. Logs exclude credentials, raw response bodies and model replies. QR links themselves are sensitive login information.

Inbound messages and the next polling cursor commit in one transaction. Exact message IDs, including 64-bit integer identities, deduplicate accepted messages. Completed records are retained for `historyRetentionDays`; deduplication covers that retention window. Interrupted preparation resumes using verified originals, the persisted deadline and remaining download attempts. Tasks marked `phase=agent` are never automatically replayed: recovery produces an interruption notice and discards the resumable sender mapping. Already saved replies can still be delivered.

Complete answers are saved and split into numbered Unicode-safe parts. Each part has a stable client ID and durable `pending → sending → done` state. Failed or interrupted sends become `unknown`, parking the remainder without an automatic resend. After checking WeChat, `/retry` uses a fresh message context and resumes only the unknown and remaining parts; the model task and acknowledged prefix are never repeated. Stable client IDs do not imply server-side deduplication or exactly-once delivery, and API acknowledgement is not a phone read receipt. Unknown deliveries are visible in `/status` and default logs.

SQLite schemas 1 and 2 upgrade transactionally to schema 3 after creating a private database backup. Credentials and Session paths remain unchanged. One account runtime owns resource release: drain admitted work, close the Driver, close SQLite, attempt the bounded stop notification, then release the lock. Cleanup failures do not skip later resource releases.

## Configuration

The `weixin` row accepts `mode` (`disabled`, `login`, `run`, `status`), absolute `stateDirectory` and `workspaceRoot`, `allowedUsers`, `agentPreset`, `permissionPreset`, and paired `provider`/`model`. Run mode requires the Web profile's Agent, preset, workspace, Session, `attachments` and `llm` services (login/status do not require these media services). Changing a bot requires a separate state directory.

Network configuration includes `loginBaseUrl` and exact `allowedApiHosts` (defaults: `ilinkai.weixin.qq.com`, `ilinkai.wxqcloud.qq.com`). Only allowlisted HTTPS origins are accepted; URL credentials and HTTP redirects are rejected. The operator must explicitly allow a newly assigned backend host. Timing defaults in milliseconds: `requestTimeoutMs=15000`, `pollTimeoutMs=40000`, `loginTimeoutMs=300000`, `loginPollIntervalMs=1000`, `reconnectDelayMs=3000`, `reconnectMaxDelayMs=30000`, `queueIntervalMs=250`, `taskTimeoutMs=180000`. `queueIntervalMs` paces empty polls; idle workers use notifications. `sessionRecoveryAttempts=1` bounds consecutive backend recovery attempts. A timeout cancels work without undoing committed effects.

Input is limited by `maxPromptChars=16000` UTF-16 code units. `maxReplyChars=1800` limits each Unicode-safe reply part including its label; the complete answer is retained. `maxPendingMessages=100` caps admitted model work while controls continue. `maxConcurrentUsers=4` permits different users to progress concurrently. `typingIntervalMs=10000` refreshes native typing, with `0` disabling it. `shutdownTimeoutMs=2000` bounds stop notifications and auxiliary typing requests. `outboundIntervalMs=300` paces outgoing parts. `historyRetentionDays=30` cleans only completed records.

Use `examples/status.patch.yml` in the separate login profile to inspect local counts. This operation requires the account lock; when the channel is active, use WeChat `/status` or its logs instead. Profile patches replace the whole configuration object; omitted fields use defaults. The [Chinese configuration table](README.md#配置) lists every option.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

Tests use isolated temporary directories, injected transports and state barriers. They do not log in to WeChat, send live messages, or call paid model APIs. CI covers Linux and Windows with Node.js 24 and 26. Source references: [Tencent's WeChat plugin](https://github.com/Tencent/openclaw-weixin) and [DSH plugin packaging](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

An additional integration test loads the bundle through a real source-built DSH CLI, drives two Agent turns against the local Messages mock, and checks that channel context is logged. It also runs the complete simulated WeChat ingress, scheduling and multipart acknowledgement pipeline across account-runtime restart, checking both the polling cursor and persistent Session. It uses an isolated Harness home and workspace with session-log uploads disabled. Run `DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness DSH_BIN=/absolute/path/to/dsh pnpm run test:integration` after building DSH. Without `DSH_SOURCE_DIR`, this separate command explicitly skips the integration case and does not establish integration success.

## Inbound images (MVP1)

Originals live under `stateDirectory/inbound/<local UUID>/original.<verified format>`, with `0700` directories and `0600` files. The receive transaction commits the input manifest, media tasks and cursor before asynchronous downloads. Images pass streamed ciphertext/plaintext limits, AES padding checks, format/pixel gates and the host's full decode before atomic publication. Image refs and prepared user content are recorded in SQLite; keys/URLs are removed from descriptors once originals are saved. Unknown model capabilities produce an explicit local notice; no model is switched and no Agent permission is elevated.

CDN trust uses **independent** `allowedCdnHosts` (default `novac2c.cdn.weixin.qq.com`) and `cdnBaseUrl` (`https://novac2c.cdn.weixin.qq.com/c2c`). CDN URLs must use HTTPS and the exact `/c2c/download` endpoint, with no URL credentials, explicit port, fragment or redirects. Bot credentials are never sent to CDN. Do not add CDN hosts to `allowedApiHosts`.

Defaults: `maxMediaItems=4`, `maxImageBytes=10485760`, `maxImagePixels=32000000`, `maxMessageMediaBytes=62914560`, `maxMessageImageBytes=12582912`, `mediaDownloadConcurrency=2`, `mediaDownloadTimeoutMs=20000`, `mediaPrepareTimeoutMs=120000`, `inboundQuotaBytes=1073741824`. Host image limits further restrict admission. Decode/attachment operations are serialized. Downloads retry only network/429/5xx failures, at most three attempts with 1/3 second backoff. Deadlines and attempts survive restarts; `/retry` only resends saved final text.

GC journals deletion before removing files and references; startup, hourly and delivery-time maintenance reclaim orphan files. Only completed, expired messages are pruned (`historyRetentionDays=30`); active and unknown-delivery records are retained. The quota covers plugin originals/temp files/reservations, excluding the host's shared attachment store, whose retention belongs to DSH. See [media details](docs/media-mvp1.md). Real WeChat messages and a deployed vision model still require manual acceptance.
