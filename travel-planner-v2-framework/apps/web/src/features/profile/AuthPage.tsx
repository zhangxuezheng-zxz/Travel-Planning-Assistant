import { useState } from 'react';
import type { ContactChannel, LoginResponse } from '@travel/shared';
import { createSessionClient } from '../trip-create/session-client';
import { APP_NAME } from '../trip-create/branding';
import VerificationCode from './VerificationCode';
import './auth.css';

const auth = createSessionClient();
type Mode = 'login' | 'register' | 'reset' | 'verify';
export default function AuthPage({
  onAuthenticated,
  notice = '',
}: {
  onAuthenticated: (session: LoginResponse) => void;
  notice?: string;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [channel, setChannel] = useState<ContactChannel>('email');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(notice);
  const newPassword = mode === 'register' || mode === 'reset';

  function switchMode(next: Mode) {
    setMode(next);
    setPassword('');
    setConfirmation('');
    setCode('');
    setError('');
    setMessage('');
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (newPassword && password !== confirmation) throw new Error('两次输入的密码不一致');
      if (mode === 'login') onAuthenticated(await auth.login(target.trim(), password));
      else if (mode === 'register')
        onAuthenticated(await auth.register(target.trim(), password, displayName.trim(), code));
      else if (mode === 'reset') {
        const result = await auth.resetPassword(channel, target.trim(), code, password);
        setMode('login');
        setPassword('');
        setConfirmation('');
        setCode('');
        setMessage(result.message);
      } else {
        const result = await auth.verifyEmail(target.trim(), password, code);
        setMode('login');
        setPassword('');
        setCode('');
        setMessage(result.message);
      }
    } catch (failure) {
      if (
        failure &&
        typeof failure === 'object' &&
        'code' in failure &&
        failure.code === 'EMAIL_VERIFICATION_REQUIRED'
      )
        setMode('verify');
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="trip-login auth-page">
      <p className="auth-eyebrow">WANDER · YOUR NEXT JOURNEY</p>
      <h1>{APP_NAME}</h1>
      <h2>
        {
          { login: '欢迎回来', register: '创建账号', reset: '找回密码', verify: '验证账号邮箱' }[
            mode
          ]
        }
      </h2>
      <p>
        {mode === 'register'
          ? '验证邮箱后注册，行程和偏好会保存在你的账号中。'
          : mode === 'reset'
            ? '使用已验证的邮箱或已绑定的手机号，设置新密码。'
            : mode === 'verify'
              ? '旧账号需先确认邮箱归属，验证后即可继续使用。'
              : '登录后，继续你的旅行计划。'}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy}>
          {mode === 'register' && (
            <label>
              昵称
              <input
                required
                maxLength={80}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="nickname"
              />
            </label>
          )}
          {mode === 'reset' && (
            <label>
              找回方式
              <select
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as ContactChannel);
                  setTarget('');
                }}
              >
                <option value="email">已验证的邮箱</option>
                <option value="phone">已绑定的手机号</option>
              </select>
            </label>
          )}
          <label>
            {mode === 'login'
              ? '邮箱或已绑定的手机号'
              : mode === 'reset' && channel === 'phone'
                ? '手机号'
                : '邮箱'}
            <input
              type={
                mode === 'login'
                  ? 'text'
                  : mode === 'reset' && channel === 'phone'
                    ? 'tel'
                    : 'email'
              }
              required
              maxLength={320}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              autoComplete="username"
            />
          </label>
          {mode !== 'login' && (
            <VerificationCode
              identity={`${mode}:${channel}:${target}`}
              value={code}
              onChange={setCode}
              issue={() =>
                auth.code(
                  mode === 'reset' ? channel : 'email',
                  target.trim(),
                  mode === 'reset'
                    ? 'reset-password'
                    : mode === 'register'
                      ? 'register'
                      : 'verify-email',
                )
              }
            />
          )}
          <label>
            {mode === 'reset' ? '新密码' : mode === 'verify' ? '原账号密码' : '密码'}
            <input
              type="password"
              required
              minLength={newPassword ? 12 : 1}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={newPassword ? 'new-password' : 'current-password'}
            />
          </label>
          {newPassword && (
            <>
              <p className="profile-hint">
                12–128 位，建议使用多个不相关的词组，不要复用其他网站的密码。
              </p>
              <label>
                再次输入密码
                <input
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </>
          )}
        </fieldset>
        {message && (
          <p role="status" className="profile-notice">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="profile-alert">
            {error}
          </p>
        )}
        <button className="workspace-primary" disabled={busy}>
          {busy
            ? '正在处理…'
            : { login: '登录', register: '验证并注册', reset: '重置密码', verify: '确认验证' }[
                mode
              ]}
        </button>
        <div className="auth-links">
          <button
            type="button"
            disabled={busy}
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? '注册账号' : '返回登录'}
          </button>
          {mode === 'login' && (
            <button type="button" disabled={busy} onClick={() => switchMode('reset')}>
              忘记密码
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
