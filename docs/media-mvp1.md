# MVP1：文字＋图片入站

本阶段在原有 `accept → queue → driver → text outbox` 中增加图片准备，不添加账号层或第二套 Agent 调度。语音、视频当前不下载、不使用附带转写、不解码，分别明确提示「尚未识别语音内容」「尚未解析视频」。出站保持最终文字。

## 流水线与恢复

1. 接收事务保存原序 text/media/notice 清单、媒体下载描述符和同步游标；不执行网络或附件保存。可靠 envelope 缺少身份/回复上下文使事务失败；坏媒体作为局部失败记账，推进游标。未授权、群聊和 bot echo 不创建下载任务。
2. 原用户队列中的 RunningTask 先进入 `phase=preparing`。消息第一次准备时保存 120 秒截止时间；下载并发默认 2，验证/附件保存并发 1，排队与 1/3 秒退避都消耗该预算。只有网络/429/5xx 最多三次；重启不重置尝试次数和截止时间。
3. 图片流式解密到私有随机暂存文件，同时限制密文/明文。通过 PKCS#7、字节格式、像素尺寸和宿主完整解码后，fsync、同文件系统 rename、fsync 目录，再提交原件大小/MIME/SHA-256 及 ready 状态。原件发布后清除临时 URL/key。
4. 检查渠道 Agent 当前 Session 的 provider/model：`llm.resolveModelInfo` 必须明确包含 `image`。不可确认时只保存原件并返回准确 notice。支持时调用 `attachments.saveImages`，把真实返回引用连同文字说明按原序组成 image parts，落 `prepared_json`；绝不伪造引用、直接写宿主附件目录或把绝对路径当作视觉输入。
5. 调用 driver 前提交 `phase=agent`。同一微信消息最多一次 user message、一次 Agent 任务。局部失败说明进入 user message，并由 Engine 强制添加到最终回复前缀。没有可消费内容则本地 notice，不提交 Agent。

preparing 中断可校验已保存原件并恢复；Agent 阶段或旧 `phase=NULL` 的 running 仍保守转中断 notice，不重跑。`/stop`、`/new` 取消下载，`/new` 等原任务退出后换 Session；只准备失败不重置原会话。`/retry` 只重发未知投递文字。

## 网络、存储与权限

CDN 与 iLink API 的 host allowlist 完全分开，默认仅 `novac2c.cdn.weixin.qq.com`。默认 base 是 `https://novac2c.cdn.weixin.qq.com/c2c`。优先校验并使用 `full_url`，否则对 `encrypt_query_param` 编码一次构造 download URL；非法 full URL 不回退。只允许 HTTPS、精确 host、`/c2c/download`，拒绝 userinfo、显式端口、fragment、路径规范化逃逸、IP/本机地址与重定向。不发送 Authorization、bot/context token。

图片优先 32 位 hex `image_item.aeskey`，否则 `media.aes_key` 支持 base64(16 raw bytes) 与 base64(32 ASCII hex)。编码严格校验，AES-128-ECB/PKCS#7 失败不回退明文。只有明确 `encrypt_type=0` 且无 key 才允许明文，仍须完整验图。未知加密方式拒绝。

原件存于 `stateDirectory/inbound/<本机 media UUID>/original.<字节验证格式>`；远端 ID、用户名与文件名不参与路径。目录/文件 `0700/0600`，检查已有对象归属和符号链接，暂存文件排他创建并 no-follow。数据库、WAL/SHM 和迁移备份同样私有。单图默认 10 MiB、3200 万像素，注入图片默认最多 4 张/12 MiB，且取宿主数量/字节/像素/尺寸限制中的更严格值；原件合计 60 MiB。图片内存读取有界，完整解码由可信宿主附件服务负责，不安装额外解码器。

原件、暂存及在途最坏情况预留受默认 1 GiB 配额限制；预留保守计数，额度不足时先清理到期终态数据，再明确拒绝媒体，文字/控制仍可用。GC 先保存待删清单，再幂等删文件，最后删数据库引用；启动、下载前、投递后及每小时维护时清理无主文件，跳过活跃媒体。仅清理 done 且超过 `historyRetentionDays` 的记录；unknown 和未完成任务保留。宿主共享附件不由本插件清理，也不计入这 1 GiB。

Agent 使用配置的 permissionPreset（默认 `danger-full-access`）和审批 `never`；媒体准备只向私有状态目录和宿主附件服务保存图片，不向 workspace 写入媒体原件，也不重启或重配现有 profile。Agent 任务本身可按所选权限预设操作文件。

## schema v3 与许可

v1/v2 升级前 `VACUUM INTO` 到预建 0600 备份，事务内加 `input_json`、`prepared_json`、`phase`、`prepare_deadline` 及 `inbound_media`、`media_artifacts`、`media_gc`，最后写 schema 3。旧文字补等价清单，保留 rowid、message ID、游标、Session、outbox/client ID；历史媒体 notice 不补抓、不重放。迁移失败回滚；较新 schema 拒绝打开。回退必须恢复对应备份，会丢失备份之后的新状态。

`src/vendor/tencent-weixin` 仅精简移植腾讯 2.4.10 的 AES/key/下载 URL 规则，附完整 Tencent MIT、源文件摘要与修改清单。构建把 LICENSE/SOURCES.md 复制进 dist，发布包同时带仓库 NOTICE 和第三方许可。不包含上游 downloader、插件注册、账号管理或出站媒体代码。

## 验证与边界

`pnpm check` 包含文字/命令/调度/投递回归，以及 wire、CDN、AES、流量、像素、落盘权限/配额、取消、恢复、GC、迁移和有序图片附件测试。

`DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness pnpm test:integration` 使用隔离 `DSH_HOME`、临时 profile 和本地 Messages mock，验证真实宿主图片解码/附件保存、user message/Session 图片引用、provider 请求的图片输入、相同 Session 恢复、显式配置的 read-only/never、分段回复和 unknown 后 `/retry` 不重跑 Agent；不接触现有 web 进程。

仍需真实微信人工验收：单图、配文＋图、多图和实际部署视觉模型对已知图片的描述；当前线上路由是否声明 image、实际 CDN wire/域名及手机呈现，不能由 mock 测试替代。宿主 `validateImage`/`saveImages` 没有 AbortSignal 参数：插件取消后等待正在执行的有界宿主解码/保存退出，再完成清理；期间及完成后都不会晚到提交 Agent。媒体原件到期后不承诺原路径永久存在；宿主共享附件按其自身保留策略管理。
