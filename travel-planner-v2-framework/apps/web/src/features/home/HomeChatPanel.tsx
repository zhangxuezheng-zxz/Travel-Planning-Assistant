import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Place } from '@travel/shared';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { isModelUnavailable, isRateLimited, sendChatMessage } from './chat-client';
import { FALLBACK_NOTE, fallbackReply } from './chat-fallback';

interface Bubble {
  role: 'user' | 'assistant';
  text: string;
  /** 本地兜底或出错时置位，界面上要明确标注，不能冒充模型回答。 */
  degraded?: boolean;
}

export interface HomeChatPanelProps {
  client: ApiClient;
  cityId?: string;
  cityName?: string;
  places: Place[];
}

/** 首页「旅行灵感」对话：请求服务端模型，失败时才退回本地目录提示。 */
export default function HomeChatPanel({ client, cityId, cityName, places }: HomeChatPanelProps) {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 组件卸载或城市切换时丢掉在途请求，避免把旧回答写进新会话。
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, pending]);

  async function send() {
    const text = input.trim();
    if (!text || pending) return;

    const history: ChatMessage[] = [
      ...messages.map((message) => ({ role: message.role, content: message.text })),
      { role: 'user', content: text },
    ];
    setMessages((current) => [...current, { role: 'user', text }]);
    setInput('');
    setError('');
    setPending(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const reply = await sendChatMessage(client, history, {
        context: {
          cityId,
          cityName: cityName ?? undefined,
          placeNames: places.map((place) => place.name),
        },
        signal: controller.signal,
      });
      setMessages((current) => [...current, { role: 'assistant', text: reply.reply }]);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (isModelUnavailable(failure)) {
        setMessages((current) => [
          ...current,
          {
            role: 'assistant',
            text: fallbackReply(text, cityName ?? null, places),
            degraded: true,
          },
        ]);
      } else if (isRateLimited(failure)) {
        setError('发送太快了，请稍等一会儿再问。');
      } else {
        setError(failure instanceof ApiError ? failure.message : 'AI 助手暂时连不上，请稍后重试。');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPending(false);
    }
  }

  return (
    <div className="chat-panel" aria-label="旅行灵感对话">
      <div className="chat-messages" ref={listRef} aria-live="polite">
        {messages.length === 0 ? (
          <p className="chat-hint">问我「景点推荐」「美食推荐」，聊聊想去的地方。</p>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              className={message.role === 'user' ? 'chat-turn is-user' : 'chat-turn'}
            >
              <p className={`chat-message ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}>
                {message.text}
              </p>
              {message.degraded && <p className="chat-note">{FALLBACK_NOTE}</p>}
            </div>
          ))
        )}
        {pending && (
          <p className="chat-message is-assistant is-pending" role="status">
            正在思考…
          </p>
        )}
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-input-row">
        <input
          type="text"
          value={input}
          placeholder="例如：有什么景点推荐？"
          maxLength={2000}
          disabled={pending}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void send();
          }}
        />
        <button type="button" onClick={() => void send()} disabled={pending || !input.trim()}>
          {pending ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  );
}
