import { useState } from 'react';
import type { ContactChannel, PublicUser, VerificationResponse } from '@travel/shared';
import type { ApiClient } from '../../lib/api-client';
import VerificationCode from './VerificationCode';

type Operation = 'email' | 'phone' | 'password' | 'remove-phone';
export default function AccountSecurity({
  user,
  client,
  onSignOut,
}: {
  user: PublicUser;
  client: ApiClient;
  onSignOut: () => void;
}) {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [target, setTarget] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function open(next: Operation | null) {
    setOperation(next);
    setTarget('');
    setCode('');
    setPassword('');
    setNewPassword('');
    setConfirmation('');
    setError('');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!operation || busy) return;
    setBusy(true);
    setError('');
    try {
      if (operation === 'password' && newPassword !== confirmation)
        throw new Error('两次输入的新密码不一致');
      const result = await client.request<{ message: string }>(
        operation === 'password'
          ? '/auth/password'
          : operation === 'remove-phone'
            ? '/auth/contact/remove-phone'
            : '/auth/contact',
        {
          body:
            operation === 'password'
              ? { currentPassword: password, newPassword }
              : operation === 'remove-phone'
                ? { currentPassword: password }
                : { channel: operation, target: target.trim(), code, currentPassword: password },
        },
      );
      try {
        sessionStorage.setItem('travel:auth-notice', result.message);
      } catch {
        /* 仅影响通知。 */
      }
      setPassword('');
      setNewPassword('');
      setConfirmation('');
      onSignOut();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '修改失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  const phone = user.phone ? user.phone.replace(/(\d{3})\d{4}(\d{4})$/, '$1****$2') : '未绑定';
  return (
    <div className="settings-card account-security">
      <h3>账号安全</h3>
      <div className="security-status">
        <span>邮箱 · {user.emailVerified ? '已验证' : '未验证'}</span>
        <span>{user.email}</span>
      </div>
      <div className="security-status">
        <span>手机 · {user.phoneVerified ? '已验证' : '未绑定'}</span>
        <span>{phone}</span>
      </div>
      <div className="security-buttons">
        <button type="button" disabled={busy} onClick={() => open('email')}>
          更换邮箱
        </button>
        <button type="button" disabled={busy} onClick={() => open('phone')}>
          {user.phone ? '更换手机' : '绑定手机'}
        </button>
        <button type="button" disabled={busy} onClick={() => open('password')}>
          修改密码
        </button>
        {user.phone && (
          <button type="button" disabled={busy} onClick={() => open('remove-phone')}>
            解绑手机
          </button>
        )}
      </div>
      {operation && (
        <form className="profile-form" onSubmit={(event) => void save(event)}>
          <h4>
            {
              {
                email: '更换并验证邮箱',
                phone: '绑定并验证手机',
                password: '修改登录密码',
                'remove-phone': '解绑手机号',
              }[operation]
            }
          </h4>
          <p className="profile-hint">
            {operation === 'remove-phone'
              ? '解绑后只能使用邮箱登录和找回账号。'
              : '更换联系方式或修改密码后，所有设备需重新登录。'}
          </p>
          <fieldset disabled={busy}>
            {(operation === 'email' || operation === 'phone') && (
              <>
                <label>
                  {operation === 'email' ? '新邮箱' : '手机号'}
                  <input
                    type={operation === 'email' ? 'email' : 'tel'}
                    required
                    maxLength={320}
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  />
                </label>
                <VerificationCode
                  identity={`${operation}:${target}`}
                  value={code}
                  onChange={setCode}
                  issue={() =>
                    client.request<VerificationResponse>('/auth/contact/code', {
                      body: { channel: operation as ContactChannel, target: target.trim() },
                    })
                  }
                />
              </>
            )}
            <label>
              当前密码
              <input
                type="password"
                required
                autoComplete="current-password"
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {operation === 'password' && (
              <>
                <label>
                  新密码
                  <input
                    type="password"
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <label>
                  再次输入新密码
                  <input
                    type="password"
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              </>
            )}
          </fieldset>
          {error && (
            <p className="profile-alert" role="alert">
              {error}
            </p>
          )}
          <div className="profile-actions">
            <button type="button" disabled={busy} onClick={() => open(null)}>
              取消
            </button>
            <button type="submit" disabled={busy}>
              {busy ? '正在保存…' : '确认并重新登录'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
