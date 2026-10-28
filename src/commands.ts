/** One immutable command catalog supplies admission, chat help and model channel context. */
export const CHANNEL_COMMANDS = Object.freeze([
  Object.freeze({ name: '/help', help: '显示微信命令', model: 'show channel help' }),
  Object.freeze({ name: '/status', help: '查看运行、排队和投递状态', model: 'show channel and queue status' }),
  Object.freeze({ name: '/new', help: '停止旧任务并开始新会话', model: 'stop old work and start a new conversation' }),
  Object.freeze({ name: '/stop', help: '停止当前任务并取消此前排队任务', model: 'stop active work and cancel tasks queued before this command' }),
  Object.freeze({ name: '/retry', help: '重发上次投递结果不明的回复（可能重复，不重跑任务）', model: 'resend an uncertain reply without rerunning the task; duplicate delivery is possible' }),
]);

export function isControlCommand(text: string): boolean { return CHANNEL_COMMANDS.some(command => command.name === text); }
export function channelHelp(): string { return `直接发送文字即可交给 DSH。\n${CHANNEL_COMMANDS.map(command => `${command.name}：${command.help}`).join('\n')}\n当前只支持文字消息。`; }
export const channelGuide = 'The user is messaging through WeChat ClawBot. This channel delivers final text replies and splits long answers into numbered parts. '
  + 'The following chat commands are handled locally by the channel: ' + CHANNEL_COMMANDS.map(command => `${command.name}: ${command.model}`).join('; ') + '. '
  + 'Describe these chat commands when explaining channel operation. Do not claim that images, files, or voice messages were sent through this text-only channel.';
