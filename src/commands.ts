/** One immutable command catalog supplies admission, chat help and model channel context. */
export const CHANNEL_COMMANDS = Object.freeze([
  Object.freeze({ name: '/help', help: '显示微信命令', model: 'show channel help' }),
  Object.freeze({ name: '/status', help: '查看运行、排队和投递状态', model: 'show channel and queue status' }),
  Object.freeze({ name: '/new', help: '停止旧任务并开始新会话', model: 'stop old work and start a new conversation' }),
  Object.freeze({ name: '/stop', help: '停止当前任务并取消此前排队任务', model: 'stop active work and cancel tasks queued before this command' }),
  Object.freeze({ name: '/retry', help: '重发上次投递结果不明的回复（可能重复，不重跑任务）', model: 'resend an uncertain reply without rerunning the task; duplicate delivery is possible' }),
]);

export function isControlCommand(text: string): boolean { return CHANNEL_COMMANDS.some(command => command.name === text); }
export function channelHelp(options: { maxMediaItems?: number; maxImageBytes?: number } = {}): string { return `直接发送文字或图片即可交给 DSH（看图需模型明确支持图片输入）。\n${CHANNEL_COMMANDS.map(command => `${command.name}：${command.help}`).join('\n')}\n入站支持文字＋图片；每条最多 ${options.maxMediaItems ?? 4} 个媒体条目，单图上限 ${(options.maxImageBytes ?? 10485760) / 1048576} MiB。语音尚未识别，视频尚未解析，请改发文字或关键截图。出站仅发送最终文字。`; }
export const channelGuide = 'The user is messaging through WeChat ClawBot. This channel delivers final text replies and splits long answers into numbered parts. '
  + 'The following chat commands are handled locally by the channel: ' + CHANNEL_COMMANDS.map(command => `${command.name}: ${command.model}`).join('; ') + '. '
  + 'Describe these chat commands when explaining channel operation. Inbound supports text and native image attachments when the current model declares image input; outbound delivers final text only. Voice is not recognized and video is not parsed in this stage. Files and quoted messages are unsupported. Only pure text messages can invoke channel commands. Never infer content of missing or failed media, or claim to have heard voice or watched video. Media notices are explicit limitations, not user content.';
