import type { ChatContext, ChatMessage, ChatReply } from '@travel/shared';
import { ApiError, type ApiClient } from '../../lib/api-client';

export interface SendChatOptions {
  /** 当前城市与景点名，服务端只用来限定回答范围。 */
  context?: ChatContext;
  signal?: AbortSignal;
}

/**
 * 发送一轮对话。
 *
 * 历史由前端携带：服务端不存对话，所以每次都要把最近几轮一起发上去。
 * 空白消息在这里就被丢掉，避免用一次请求换一个 400。
 */
export async function sendChatMessage(
  client: ApiClient,
  history: ChatMessage[],
  options: SendChatOptions = {},
): Promise<ChatReply> {
  const messages = history
    .map((message) => ({ role: message.role, content: message.content.trim() }))
    .filter((message) => message.content.length > 0);
  if (messages.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', '请先输入问题');

  const context = normalizeContext(options.context);
  const reply = await client.request<ChatReply>('/chat/messages', {
    method: 'POST',
    body: context ? { messages, context } : { messages },
    signal: options.signal,
  });
  if (typeof reply?.reply !== 'string' || !reply.reply.trim())
    throw new ApiError(502, 'INVALID_RESPONSE', 'AI 助手返回了空回答，请重试');
  return { ...reply, reply: reply.reply.trim() };
}

function normalizeContext(context: ChatContext | undefined): ChatContext | undefined {
  if (!context) return undefined;
  const placeNames = (context.placeNames ?? []).map((name) => name.trim()).filter(Boolean);
  const result: ChatContext = {
    ...(context.cityId ? { cityId: context.cityId } : {}),
    ...(context.cityName ? { cityName: context.cityName.trim() } : {}),
    ...(placeNames.length ? { placeNames } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 503 表示服务端没配模型或上游挂了：这时才值得退回本地提示。 */
export function isModelUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'RATE_LIMITED';
}
