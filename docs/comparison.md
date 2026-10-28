# 社区微信插件的架构对比

对比范围是微信到 DSH 的 Host 接入、会话归属、消息可靠性、用户交互和生命周期。以下依据固定源码版本与公开问题，不把市场介绍中的功能数量当成质量证明，也不把一个项目的历史故障套到所有社区插件上。

## 固定对照

| 实现 | 对照版本 | 主要定位 |
| --- | --- | --- |
| [pan17/dsh-wechat](https://github.com/pan17/dsh-wechat/tree/312e9834831ab840c3a48f88f0fe95ee33ef2cda) | `0.14.0`，`312e983` | 微信作为 DSH 第二客户端：多媒体、原生命令、审批与问题、流式输出、设置页。 |
| [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin/tree/74cad3e17e1aaf109a94214a26a722236399aa1a) | `0.9.10`，`74cad3e` | 多账号微信通道，并包含媒体、语音、提醒、订阅和个性化能力。 |
| [xmanrui/dsh-weixin](https://github.com/xmanrui/dsh-weixin/tree/16ca866af80e8b95b2d73619579894e817095122) | `0.1.0`，`16ca866` | 较小的微信桥接和 Host/HTTP 客户端适配层，提供扫码管理。 |
| `@qianhaoq/qh-dsh-weixin` | 原始 `0.1.0` → 当前 `0.2.0` | 受限文字任务通道，强调明确授权、原生 Agent、持久化和失败恢复。 |

DSH 集成验证使用本机源码提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。插件声明的宿主范围仍是精确 `0.2.1-rc.3`；没有据此宣称兼容所有 DSH 版本。

## 优势与代价

| 方面 | 社区实现值得借鉴的部分 | 本插件的选择与代价 |
| --- | --- | --- |
| 微信内操作 | pan17 有完整命令、审批和会话管理，并直接接原生命令注册中心。 | 只维护五个渠道命令；不复制 DSH 的模型、工作区、审批和工具管理。操作面更小，远程能力也更少。 |
| 登录和管理 | pan17、panqing 有设置卡，panqing 支持多账号热接入。 | 保留独立登录 profile、单账号锁和凭据目录。首次配置仍需终端，没有新的设置页。 |
| 运行反馈 | 社区支持分段、流式过程和输入状态。 | 提供原生输入状态与完整最终答案分段，不推送草稿、推理或每步工具过程，减少发送次数和未提交输出处理。 |
| DSH 集成 | pan17 的结构类型适配减少运行时包依赖；panqing 复用腾讯传输代码，覆盖更多媒体协议。 | 使用精确版本的 DSH peer 和原生服务，获得编译期检查；宿主升级需要重新验证，媒体仍不支持。 |
| 可靠性 | 社区实现有持久化映射、去重、出站队列等实用机制。 | 游标与入站消息在同一 SQLite 事务里；分段出站逐段确认，失败结果不靠多个独立 JSON 快照拼接。 |
| 重试政策 | panqing 的 outbox 明确选择 at-least-once，优先尽力送达，允许重复。 | 未知投递不自动重发；用户 `/retry` 才续发，模型不重跑。减少重复执行和重复消息的意外，但需要用户核对。 |
| 维护范围 | 丰富的管理、媒体、提醒、陪聊能力适合更广的使用场景。 | 聚焦个人文字工作通道，不引入账号注册表、长期记忆、提醒调度或兼容旧宿主的探测分支。 |

上述取舍来自具体路径：[pan17 的 Agent 适配](https://github.com/pan17/dsh-wechat/blob/312e9834831ab840c3a48f88f0fe95ee33ef2cda/src/dsh/sessions.ts)、[出站状态文件](https://github.com/pan17/dsh-wechat/blob/312e9834831ab840c3a48f88f0fe95ee33ef2cda/src/state.ts)、[发送器](https://github.com/pan17/dsh-wechat/blob/312e9834831ab840c3a48f88f0fe95ee33ef2cda/src/weixin/send.ts)、[panqing 的 outbox 政策](https://github.com/panqing0313/dsh-plugin-weixin/blob/74cad3e17e1aaf109a94214a26a722236399aa1a/src/message/outbox.js)、[xmanrui 的持久化](https://github.com/xmanrui/dsh-weixin/blob/16ca866af80e8b95b2d73619579894e817095122/src/state-store.mjs)。社区的广覆盖是优势；它带来的更多状态和兼容代码，也意味着需要更多组合测试，不能直接推导成“功能多所以不可靠”。

## 公开问题核对

### 发送者首次登记后再次被拒绝

[panqing issue #5](https://github.com/panqing0313/dsh-plugin-weixin/issues/5) 报告：首条消息成功后，后续消息持续被拒绝，重连才恢复。固定源码的 `createInboundHandler` 在创建时保存 `accountConfig`，每条消息的 `applyScope` 从该快照恢复配置，而首次登记分支只更新本条消息的 `effectiveConfig.current`；这是公开报告对应的源码模式。参见[配置捕获与覆盖](https://github.com/panqing0313/dsh-plugin-weixin/blob/74cad3e17e1aaf109a94214a26a722236399aa1a/src/index.js#L1347)。没有使用真实微信账号复现此社区故障。

本插件没有首次联系登记机制。默认授权直接来自扫码确认的用户 ID；连续两次独立轮询都接受同一账号的回归用例，避免依赖一次消息中修改的临时配置。

### 轮询拒绝导致宿主退出

[panqing issue #3](https://github.com/panqing0313/dsh-plugin-weixin/issues/3) 报告了旧版轮询 Promise 未及时处理而触发 DSH 全局致命策略的问题。固定版本的[轮询代码](https://github.com/panqing0313/dsh-plugin-weixin/blob/74cad3e17e1aaf109a94214a26a722236399aa1a/src/transport/ilink.js#L475) 已含 catch，不应把该历史问题描述成当前版本仍然缺少异常处理。

本插件用一个可等待的账号 Promise 监督接收、调度和投递，子任务拒绝立即进入监督路径。故障注入用例连续制造网络拒绝，再验证轮询重试、Driver 只关闭一次以及锁被释放；不依赖卸载时才给后台 Promise 附上 catch。

### 微信命令对模型不可见

[pan17 issue #14](https://github.com/pan17/dsh-wechat/issues/14) 讨论了桥接层消费命令后，Agent 不知道微信操作面的情况。当前插件将命令表同时用于帮助和原生系统提示词说明，原生 DSH 集成测试验证该说明既进入模型请求，也进入 Session 的系统消息日志。这里只解决渠道能力说明；没有声称已将历史控制命令全部投影给模型。

## 对本插件自身的修正

| 原始版本的具体行为 | 当前行为 | 验证 |
| --- | --- | --- |
| 全局一个工作循环，`/status` 也等长任务。 | 用户内 FIFO、不同用户有界并行，控制命令独立。 | 长任务被屏障暂停时，状态回复仍已送出；其他用户任务可完成。 |
| `/stop` 有重复取消入口，Driver 内也同时走信号和直接取消；命令前排队任务仍可能运行。 | 取消统一经活动任务信号传递，入站事务取消命令前的排队任务。 | 四阶段用例验证排队范围；Driver 用例验证直接取消和上游信号取消都只调用一次原生 Agent.cancel。 |
| `/new` 排在旧工作后，没有显式切换阻挡。 | 取消旧工作并等待其清理后切换；后续任务不得提前进入。 | 清理屏障期间新任务未开始，状态命令仍可响应。 |
| 超长回复截断成一条文字。 | 保存全部正文，Unicode 分段，每段单独确认。 | 分段拼接等于完整原文；重启和手动续发不重发已确认前缀。 |
| 发送结果未知只能在数据库里排查。 | 核对聊天后使用 `/retry`，仅续发保存的回复。 | 模型调用次数保持一次，新的消息上下文只用于续发。 |
| Engine 和外层都调用 Driver.close，清理失败可能跳过后续释放。 | Runtime 是资源释放唯一所有者，逐项完成清理。 | 故意使 Driver.close 失败，SQLite 和账号锁仍然释放。 |

两个原始回归在旧实现上分别复现为“状态回复仍被阻塞”和“拼接结果包含截断提示、缺少后文”，然后在改进后通过。当前实现和职责图见[架构说明](architecture.md)。

## 保留的限制

本插件仍是文字通道：没有媒体收发、微信端审批、GUI 扫码设置卡、多账号热切换或任意原生命令转发。源码集成与故障测试不能替代真实微信扫码、消息可见性和长时间运行验收。对于需要完整微信第二客户端的用户，社区成熟项目的功能广度仍有明显优势。
