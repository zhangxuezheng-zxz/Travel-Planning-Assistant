/**
 * AI 对话（首页「旅行灵感」）。
 *
 * 服务端不保存对话：历史由前端每轮带上，后端只做校验、拼提示词和转发模型。
 * `context` 是前端已知的行程上下文，服务端同样不信任其中内容，只用来拼提示词。
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 前端从目录接口读到的上下文；服务端据此提示模型只谈真实城市与景点。 */
export interface ChatContext {
  cityId?: string;
  cityName?: string;
  /** 当前城市的景点名，最多 30 个，服务端按不可信数据截断后使用。 */
  placeNames?: string[];
}

export interface ChatRequest {
  /** 最近若干轮对话，最后一条必须是 user。 */
  messages: ChatMessage[];
  context?: ChatContext;
}

export interface ChatReply {
  reply: string;
  /** 目前只有真实模型一种来源；降级在客户端本地完成，不由服务端伪造。 */
  source: 'llm';
  requestId: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  /** 准确性校验的非阻断提示（例如提到了目录外的地点），可能需要展示给用户。 */
  notices?: ChatNotice[];
}

export interface ChatNotice {
  code: string;
  message: string;
}
