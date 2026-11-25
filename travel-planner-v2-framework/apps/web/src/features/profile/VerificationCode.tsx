import { useEffect, useRef, useState } from 'react';
import type { VerificationResponse } from '@travel/shared';

interface Props {
  identity: string;
  value: string;
  onChange: (value: string) => void;
  issue: () => Promise<VerificationResponse>;
  disabled?: boolean;
}

export default function VerificationCode({ identity, value, onChange, issue, disabled }: Props) {
  const [sending, setSending] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [developmentCode, setDevelopmentCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    setDevelopmentCode('');
    setMessage('');
    setError('');
    onChange('');
  }, [identity, onChange]);
  useEffect(() => {
    if (!remaining) return;
    const timer = window.setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  async function send() {
    if (sending || remaining) return;
    const sentIdentity = identity;
    setSending(true);
    setError('');
    setDevelopmentCode('');
    try {
      const result = await issue();
      if (currentIdentity.current !== sentIdentity) return;
      setMessage(result.message);
      setDevelopmentCode(result.developmentCode ?? '');
      setRemaining(result.retryAfter);
    } catch (failure) {
      if (currentIdentity.current !== sentIdentity) return;
      setError(failure instanceof Error ? failure.message : '发送失败，请稍后重试');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="verification-field">
      <label>
        验证码
        <div className="verification-row">
          <input
            aria-label="验证码"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
            placeholder="6 位验证码"
          />
          <button
            type="button"
            disabled={disabled || sending || remaining > 0}
            onClick={() => void send()}
          >
            {sending ? '正在发送…' : remaining ? `${remaining} 秒后重发` : '获取验证码'}
          </button>
        </div>
      </label>
      {message && (
        <p className="profile-hint" role="status">
          {message}
        </p>
      )}
      {developmentCode && (
        <p className="auth-local-code" role="status">
          本地联调验证码：<strong>{developmentCode}</strong>
          <br />
          当前不会发送邮件或短信，仅用于本机测试。
        </p>
      )}
      {error && (
        <p className="profile-alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
