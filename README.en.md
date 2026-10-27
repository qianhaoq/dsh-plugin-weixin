# DSH WeChat plugin

English | [中文](README.md)

A community Cordis plugin connecting WeChat ClawBot directly to DeepSeek Harness through the iLink bot API. It sends text prompts to channel-owned DSH Sessions and returns final text responses. OpenClaw is not required. This project is not an official Tencent or DeepSeek product.

Version `0.1.0` targets DSH `0.2.1-rc.3` and Node.js 24.9+. Protocol fixtures cover automated behavior; real WeChat compatibility still requires QR login and an account-level acceptance test.

## Install and connect

```sh
gh repo clone qianhaoq/dsh-plugin-weixin
cd dsh-plugin-weixin
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

Send text in the ClawBot conversation. `/help` lists commands; `/new` starts a fresh conversation while retaining old Session logs; `/stop` requests cancellation of the active task without undoing completed actions; `/status` reports pending work and unknown reply deliveries. Only the QR owner's private messages are accepted by default. A nonempty `allowedUsers` list replaces that default. Groups and bot messages are ignored. Image, voice, video, file and quoted-message payloads are not processed in this version.

## Permissions and operation

The default permission preset is `read-only`. Approval policy is fixed to `never`: actions needing extra approval are rejected, never automatically authorized. An explicitly selected `workspace-write` preset permits its normal sandboxed workspace writes. Interactive permission approval through WeChat is not implemented. The computer and DSH must remain running and online.

Polling retries transient connection failures. Expired credentials stop the channel and require QR login. Background failures go to stderr and Cordis logging, including profiles without a log exporter. Account operations use an exclusive process lock. New data directories use POSIX mode `0700`; credentials and the SQLite database use `0600`. Windows uses the account directory's access controls. The database contains private chat text, reply context, answers, cursors and sender-to-Session mappings; protect backups accordingly. Logs exclude credentials, raw response bodies and model replies. QR links themselves are sensitive login information.

Inbound messages and the next polling cursor commit in one transaction. Exact message IDs, including 64-bit integer identities, deduplicate accepted messages. Completed records are retained for `historyRetentionDays`; deduplication covers that retention window. Tasks interrupted after admission are never automatically replayed: recovery produces an interruption notice and discards the resumable sender mapping. Already saved replies can still be delivered.

Each send is preceded by a durable `sending` state. Failed or interrupted sends become `unknown` and are not automatically resent; neither is the model task replayed. Stable client IDs do not imply server-side deduplication or exactly-once delivery. Check WeChat and the DSH Session before repeating a task. Unknown deliveries are visible in `/status` and default logs.

## Configuration

The `weixin` row accepts `mode` (`disabled`, `login`, `run`, `status`), absolute `stateDirectory` and `workspaceRoot`, `allowedUsers`, `agentPreset`, `permissionPreset`, and paired `provider`/`model`. Run mode requires the Web profile's Agent, preset, workspace and Session services. Changing a bot requires a separate state directory.

Network configuration includes `loginBaseUrl` and exact `allowedApiHosts` (defaults: `ilinkai.weixin.qq.com`, `ilinkai.wxqcloud.qq.com`). Only allowlisted HTTPS origins are accepted; URL credentials and HTTP redirects are rejected. The operator must explicitly allow a newly assigned backend host. Timing defaults in milliseconds: `requestTimeoutMs=15000`, `pollTimeoutMs=40000`, `loginTimeoutMs=300000`, `loginPollIntervalMs=1000`, `reconnectDelayMs=3000`, `queueIntervalMs=250`, `taskTimeoutMs=180000`. A timeout cancels work without undoing committed effects.

Input is limited by `maxPromptChars=16000` UTF-16 code units. Replies are capped at `maxReplyChars=1800` Unicode code points with an explicit truncation notice. `maxPendingMessages=100` pauses further polls; an already received batch is saved in full and may temporarily exceed the threshold. `historyRetentionDays=30` cleans only completed records. Tasks run serially, while polling remains independent so `/stop` can interrupt active work.

Use `examples/status.patch.yml` in the separate login profile to inspect local counts. This operation requires the account lock; when the channel is active, use WeChat `/status` or its logs instead. Profile patches replace the whole configuration object; omitted fields use defaults. The [Chinese configuration table](README.md#配置) lists every option.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

Tests use isolated temporary directories, injected transports and state barriers. They do not log in to WeChat, send live messages, or call paid model APIs. CI covers Linux and Windows with Node.js 24 and 26. Source references: [Tencent's WeChat plugin](https://github.com/Tencent/openclaw-weixin) and [DSH plugin packaging](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

An additional integration test loads the bundle through a real source-built DSH CLI, drives two Agent turns against the local Messages mock, and resumes the persistent Session after Agent disposal. It uses an isolated Harness home and workspace with session-log uploads disabled. Run `DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness DSH_BIN=/absolute/path/to/dsh pnpm run test:integration` after building DSH. Without `DSH_SOURCE_DIR`, this separate command explicitly skips the integration case and does not establish integration success.
