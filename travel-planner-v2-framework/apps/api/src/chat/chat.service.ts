import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatNotice, ChatReply } from '@travel/shared' with { 'resolution-mode': 'import' };
import { ApiError } from '../common/api-error';
import { ChatConfig } from './chat.config';
import { validateChatRequest } from './chat.dto';
import { buildSystemPrompt } from './chat.prompt';
import { DEFAULT_ACCURACY_POLICY, inspectReply } from './chat-accuracy';
import type { AccuracyCode, AccuracyReport } from './chat-accuracy';

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

const NOTICE_MESSAGES: Record<AccuracyCode, string> = {
  FABRICATED_PRICE: '回答包含未提供的票价信息，请以官方渠道为准',
  FABRICATED_HOURS: '回答包含未提供的开放时间，请以官方渠道为准',
  PLACE_OUTSIDE_CATALOG: '回答提到了当前目录外的地点，请谨慎参考',
};

/** 重试时追加的纠正指令：只说违反了哪一类，不透露校验实现细节。 */
function buildCorrection(report: AccuracyReport): string {
  const labels = [...new Set(report.findings.map((item) => NOTICE_MESSAGES[item.code]))];
  return [
    '上一条回答不符合要求：',
    ...labels.map((label) => `- ${label}`),
    '请只用本消息给出的景点名称重新回答，不要给出票价、开放时间等具体数字，也不要提到其他城市。',
  ].join('\n');
}

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

interface Completion {
  reply: string;
  usage: ChatReply['usage'];
}

type OutgoingMessage = { role: 'system' | 'user' | 'assistant'; content: string };

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

    const messages: OutgoingMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          today: todayInShanghai(this.now()),
          context: request.context,
        }),
      },
      ...request.messages,
    ];

    let completion = await this.complete(messages, settings);
    let report = this.inspect(completion.reply, request.context.placeNames, settings);

    for (
      let attempt = 0;
      settings.accuracyMode === 'enforce' &&
      report.blocking &&
      attempt < settings.accuracyMaxRetries;
      attempt += 1
    ) {
      this.logger.warn(
        `chat reply rejected by accuracy guard, retrying: ${report.findings
          .map((item) => item.code)
          .join(',')}`,
      );
      messages.push(
        { role: 'assistant', content: completion.reply },
        { role: 'user', content: buildCorrection(report) },
      );
      completion = await this.complete(messages, settings);
      report = this.inspect(completion.reply, request.context.placeNames, settings);
    }

    if (settings.accuracyMode === 'enforce' && report.blocking) {
      this.logger.warn(
        `chat reply still fails accuracy guard after retries: ${report.findings
          .map((item) => item.code)
          .join(',')}`,
      );
      throw new ApiError(
        'DEPENDENCY_UNAVAILABLE',
        'AI 助手的回答未通过准确性校验，请换个问法或稍后重试',
        503,
      );
    }

    const notices = this.notices(report);
    return {
      reply: completion.reply,
      source: 'llm',
      requestId: this.nextRequestId(),
      model: settings.model,
      usage: completion.usage,
      ...(notices.length ? { notices } : {}),
    };
  }

  /** 准确性校验；关闭时直接放行，连正则都不跑。 */
  private inspect(
    reply: string,
    catalog: readonly string[],
    settings: ChatConfig['values'],
  ): AccuracyReport {
    if (settings.accuracyMode === 'off') return { findings: [], blocking: false };
    return inspectReply(reply, catalog, DEFAULT_ACCURACY_POLICY);
  }

  /** 只把非阻断的发现转成给用户看的提示，同一类错误只出现一次。 */
  private notices(report: AccuracyReport): ChatNotice[] {
    const codes = [
      ...new Set(
        report.findings.filter((item) => item.severity === 'warn').map((item) => item.code),
      ),
    ];
    return codes.map((code) => ({ code, message: NOTICE_MESSAGES[code] }));
  }

  private async complete(
    messages: OutgoingMessage[],
    settings: ChatConfig['values'],
  ): Promise<Completion> {
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
