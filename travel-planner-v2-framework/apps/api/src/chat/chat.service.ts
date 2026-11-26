import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatReply } from '@travel/shared' with { 'resolution-mode': 'import' };
import { ApiError } from '../common/api-error';
import { ChatConfig } from './chat.config';
import { validateChatRequest } from './chat.dto';
import { buildSystemPrompt } from './chat.prompt';

export const CHAT_FETCH = Symbol('CHAT_FETCH');
export const CHAT_CLOCK = Symbol('CHAT_CLOCK');
export const CHAT_REQUEST_ID = Symbol('CHAT_REQUEST_ID');

export type ChatFetcher = typeof fetch;

/** 模型回复的字符上限，防止上游返回超长内容撑爆前端。 */
const MAX_REPLY_CHARS = 8000;
const RATE_WINDOW_MS = 60_000;
/** 记住的活跃用户上限，超了就整体重建，避免内存随用户数无限增长。 */
const MAX_TRACKED_USERS = 1000;

const UNAVAILABLE = 'AI 助手暂时不可用，请稍后重试';

/** 固定按 Asia/Shanghai 取「今天」，与行程日期口径一致。 */
export function todayInShanghai(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface ModelChoice {
  finish_reason?: unknown;
  message?: { content?: unknown; refusal?: unknown };
}

interface ModelPayload {
  choices?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  /** 进程内滑动窗口限流；多实例部署时换成共享存储，否则上限按实例放大。 */
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly config: ChatConfig,
    @Inject(CHAT_FETCH) private readonly transport: ChatFetcher,
    @Inject(CHAT_CLOCK) private readonly now: () => number,
    @Inject(CHAT_REQUEST_ID) private readonly nextRequestId: () => string,
  ) {}

  async reply(body: unknown, userId: string): Promise<ChatReply> {
    const settings = this.config.values;
    // 先看开关：没配置模型时不必校验请求体，也别让用户以为是自己填错了。
    if (!settings.enabled)
      throw new ApiError('DEPENDENCY_UNAVAILABLE', 'AI 助手还没有配置模型，请联系管理员', 503);

    const request = validateChatRequest(body, settings);
    this.assertWithinRate(userId);

    const messages = [
      {
        role: 'system',
        content: buildSystemPrompt({
          today: todayInShanghai(this.now()),
          context: request.context,
        }),
      },
      ...request.messages,
    ];
    const payload: Record<string, unknown> = {
      model: settings.model,
      messages,
      max_tokens: settings.maxTokens,
      stream: false,
    };
    if (settings.thinking !== 'omit')
      payload.thinking = { type: settings.thinking === 'on' ? 'enabled' : 'disabled' };

    let response: Response;
    try {
      response = await this.transport(`${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(settings.timeoutMs),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // 超时、DNS、连接中断都在这里；具体原因只写日志，不回传给客户端。
      this.logger.warn(`chat model request failed: ${describe(error)}`);
      throw new ApiError('DEPENDENCY_UNAVAILABLE', UNAVAILABLE, 503);
    }

    if (!response.ok) {
      this.logger.warn(`chat model returned ${response.status}`);
      throw new ApiError('DEPENDENCY_UNAVAILABLE', UNAVAILABLE, 503);
    }

    const data = await readJson(response, this.logger);
    const choice = firstChoice(data);
    const content = choice?.message?.content;
    if (choice?.message?.refusal)
      throw new ApiError(
        'DEPENDENCY_UNAVAILABLE',
        'AI 助手的回答被内容安全策略拦截，请换个问法',
        503,
      );
    if (choice?.finish_reason !== 'stop')
      throw new ApiError('DEPENDENCY_UNAVAILABLE', 'AI 助手的回答不完整，请重试', 503);
    if (typeof content !== 'string' || !content.trim())
      throw new ApiError('DEPENDENCY_UNAVAILABLE', 'AI 助手没有返回内容，请重试', 503);
    const reply = content.trim();
    if (reply.length > MAX_REPLY_CHARS)
      throw new ApiError('DEPENDENCY_UNAVAILABLE', 'AI 助手的回答过长，请把问题拆小一点', 503);

    return {
      reply,
      source: 'llm',
      requestId: this.nextRequestId(),
      model: settings.model,
      usage: {
        promptTokens: tokenCount(data?.usage?.prompt_tokens),
        completionTokens: tokenCount(data?.usage?.completion_tokens),
      },
    };
  }

  private assertWithinRate(userId: string): void {
    const now = this.now();
    const windowStart = now - RATE_WINDOW_MS;
    const stamps = (this.recent.get(userId) ?? []).filter((at) => at > windowStart);
    if (stamps.length >= this.config.values.requestsPerMinute)
      throw new ApiError('RATE_LIMITED', '发送太快了，请稍等一会儿再问', 429);
    stamps.push(now);
    if (this.recent.size >= MAX_TRACKED_USERS && !this.recent.has(userId)) this.evict(windowStart);
    this.recent.set(userId, stamps);
  }

  /** 清掉窗口外的记录；仍有活跃请求的用户保留。 */
  private evict(windowStart: number): void {
    for (const [userId, stamps] of this.recent) {
      const active = stamps.some((at) => at > windowStart);
      if (!active) this.recent.delete(userId);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : 'unknown error';
}

async function readJson(response: Response, logger: Logger): Promise<ModelPayload | null> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? (parsed as ModelPayload) : null;
  } catch {
    logger.warn('chat model returned a non-JSON body');
    return null;
  }
}

function firstChoice(data: ModelPayload | null): ModelChoice | null {
  const choices = data?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  return first && typeof first === 'object' ? (first as ModelChoice) : null;
}
