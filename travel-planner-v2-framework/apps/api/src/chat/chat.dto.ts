import { ApiError } from '../common/api-error';
import type { ChatConfigValues } from './chat.config';

/** 单条消息的字数上限；总字数由 `CHAT_MAX_CHARS` 控制。 */
export const MAX_MESSAGE_CHARS = 2000;
const MAX_CITY_NAME_CHARS = 50;
const MAX_PLACE_NAMES = 30;
const MAX_PLACE_NAME_CHARS = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ValidatedChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ValidatedChatRequest {
  messages: ValidatedChatMessage[];
  context: { cityId?: string; cityName?: string; placeNames: string[] };
}

function invalid(message: string): never {
  throw new ApiError('VALIDATION_ERROR', message, 400);
}

function record(
  value: unknown,
  keys: readonly string[],
  message: string,
  shapeMessage = message,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(shapeMessage);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid(message);
  return result;
}

/** 去掉换行与控制字符，避免把「上下文」当成新的指令行插进提示词。 */
function singleLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function placeNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PLACE_NAMES)
    invalid(`景点名单最多 ${MAX_PLACE_NAMES} 个`);
  const names = value.map((item) => {
    if (typeof item !== 'string') invalid('景点名单必须是字符串数组');
    return singleLine(item).slice(0, MAX_PLACE_NAME_CHARS);
  });
  return [...new Set(names.filter(Boolean))].slice(0, MAX_PLACE_NAMES);
}

/**
 * 校验对话请求。限制写在服务端而不是信任前端：
 * 条数、单条长度、总长度、角色顺序，任何一项不合法都返回 400 而不是让模型硬跑。
 */
export function validateChatRequest(
  body: unknown,
  limits: Pick<ChatConfigValues, 'maxMessages' | 'maxChars'>,
): ValidatedChatRequest {
  const input = record(
    body,
    ['messages', 'context'],
    '请求体只能包含 messages 和 context',
    '请求体必须是 JSON 对象',
  );
  if (!Array.isArray(input.messages) || input.messages.length === 0) invalid('消息列表不能为空');
  if (input.messages.length > limits.maxMessages)
    invalid(`一次最多发送 ${limits.maxMessages} 条消息，当前 ${input.messages.length} 条`);

  let total = 0;
  const messages = input.messages.map((item) => {
    const message = record(item, ['role', 'content'], '每条消息只能包含 role 和 content');
    if (message.role !== 'user' && message.role !== 'assistant')
      invalid('role 只能是 user 或 assistant');
    if (typeof message.content !== 'string' || !message.content.trim()) invalid('消息内容不能为空');
    const content = message.content.trim();
    if (content.length > MAX_MESSAGE_CHARS)
      invalid(`单条消息最多 ${MAX_MESSAGE_CHARS} 字，当前 ${content.length} 字`);
    total += content.length;
    return { role: message.role, content } as ValidatedChatMessage;
  });

  if (total > limits.maxChars) invalid(`消息总字数最多 ${limits.maxChars} 字，当前 ${total} 字`);
  if (messages[messages.length - 1]?.role !== 'user') invalid('最后一条消息必须是你发送的内容');

  const context =
    input.context === undefined
      ? {}
      : record(
          input.context,
          ['cityId', 'cityName', 'placeNames'],
          'context 只能包含 cityId、cityName 和 placeNames',
        );

  let cityId: string | undefined;
  if (context.cityId !== undefined) {
    if (typeof context.cityId !== 'string' || !UUID.test(context.cityId))
      invalid('cityId 格式不合法');
    cityId = context.cityId.toLowerCase();
  }
  let cityName: string | undefined;
  if (context.cityName !== undefined) {
    if (typeof context.cityName !== 'string' || !context.cityName.trim())
      invalid('cityName 不能为空');
    cityName = singleLine(context.cityName).slice(0, MAX_CITY_NAME_CHARS);
    if (!cityName) invalid('cityName 不能为空');
  }

  return { messages, context: { cityId, cityName, placeNames: placeNames(context.placeNames) } };
}
