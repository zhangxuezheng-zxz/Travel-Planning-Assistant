import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { validLlmBaseUrl } from '../common/llm-base-url';

/**
 * 首页 AI 对话的模型配置。
 *
 * 复用 B 行程排序使用的三个供应商变量（`LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`），
 * 但开关独立：对话开着不代表推荐排序要用模型，反之亦然。
 */
export interface ChatConfigValues {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  maxMessages: number;
  maxChars: number;
  /** `off` 显式关闭思考模式，`on` 打开，`omit` 不传该字段（供应商不支持时用）。 */
  thinking: 'off' | 'on' | 'omit';
  requestsPerMinute: number;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

function choice<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  options: readonly T[],
  fallback: T,
): T {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!options.includes(raw as T)) throw new Error(`Invalid ${name}`);
  return raw as T;
}

export function readChatConfig(env: NodeJS.ProcessEnv): ChatConfigValues {
  const enabled = choice(env, 'CHAT_LLM_ENABLED', ['true', 'false'], 'false') === 'true';
  const baseUrl = env.LLM_API_BASE_URL?.trim() || '';
  const apiKey = env.LLM_API_KEY?.trim() || '';
  const model = env.LLM_MODEL?.trim() || '';
  if (enabled) {
    if (!baseUrl || !apiKey || !model)
      throw new Error('Enabled chat model requires LLM_API_BASE_URL, LLM_API_KEY and LLM_MODEL');
    if (!validLlmBaseUrl(baseUrl)) throw new Error('Invalid LLM_API_BASE_URL');
  }
  return {
    enabled,
    baseUrl,
    apiKey,
    model,
    // 对话比结构化排序慢：实测 800 token 以内 1–3.5 秒，留足余量。
    timeoutMs: integer(env, 'CHAT_LLM_TIMEOUT_MS', 20000, 60000),
    maxTokens: integer(env, 'CHAT_LLM_MAX_TOKENS', 800, 4096),
    maxMessages: integer(env, 'CHAT_MAX_MESSAGES', 20, 50),
    maxChars: integer(env, 'CHAT_MAX_CHARS', 8000, 20000, 100),
    thinking: choice(env, 'CHAT_LLM_THINKING', ['off', 'on', 'omit'], 'off'),
    requestsPerMinute: integer(env, 'CHAT_RATE_LIMIT_PER_MINUTE', 10, 120),
  };
}

@Injectable()
export class ChatConfig {
  readonly values: ChatConfigValues;
  constructor(config: ConfigService) {
    // ConfigService 负责先加载 workspace .env，这里才能读到可选的模型设置。
    void config.values;
    this.values = readChatConfig(process.env);
  }
}
