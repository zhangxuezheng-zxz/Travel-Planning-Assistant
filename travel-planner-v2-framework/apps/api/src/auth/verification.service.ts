import { Injectable } from '@nestjs/common';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ContactChannel, VerificationResponse } from '@travel/shared' with {
  'resolution-mode': 'import',
};
import { ApiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { VerificationDeliveryService } from './verification-delivery.service';

export type CodePurpose =
  'register' | 'verify-email' | 'reset-password' | 'bind-email' | 'bind-phone';
interface Challenge {
  id: string;
  digest: string;
  user_id: string | null;
  credential_version: number;
  attempts: number;
  delivered: boolean;
  consumed_at: Date | null;
  expires_at: Date;
}

export function normalizeContact(channel: ContactChannel, input: string): string {
  const value = input.trim();
  if (channel === 'email') {
    const email = value.toLowerCase();
    if (
      email.length <= 320 &&
      /^[a-z0-9.!#$%&'*+/=?^_{}|~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
        email,
      )
    )
      return email;
    throw new ApiError('VALIDATION_ERROR', '邮箱格式不正确', 400);
  }
  const phone = value.replace(/[\s-]/g, '');
  if (/^(?:\+86)?1[3-9]\d{9}$/.test(phone)) return phone.startsWith('+') ? phone : `+86${phone}`;
  throw new ApiError('VALIDATION_ERROR', '请输入正确的中国大陆手机号', 400);
}

@Injectable()
export class VerificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly delivery: VerificationDeliveryService,
  ) {}

  private digest(value: string): string {
    return createHmac('sha256', this.config.values.authTokenSecret).update(value).digest('hex');
  }

  private scope(
    channel: ContactChannel,
    target: string,
    purpose: CodePurpose,
    ownerId?: string,
  ): string {
    return this.digest(
      JSON.stringify([channel, target, purpose, purpose.startsWith('bind-') ? ownerId : null]),
    );
  }

  assertLocalAccess(ip: string): void {
    if (
      this.config.values.verification.mode === 'local' &&
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)
    ) {
      throw new ApiError('LOCAL_ONLY', '本地验证码模式仅允许本机访问', 403);
    }
  }

  async limit(label: string, value: string, maximum: number, seconds = 900): Promise<void> {
    const key = this.digest(`${label}:${value}`);
    const result = await this.database.query<{ hits: number }>(
      `INSERT INTO auth_rate_limits(key, hits, expires_at) VALUES ($1, 1, now() + $2 * interval '1 second')
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE auth_rate_limits.hits + 1 END,
         expires_at = CASE WHEN auth_rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END
       RETURNING hits`,
      [key, seconds],
    );
    if (result.rows[0].hits > maximum)
      throw new ApiError('RATE_LIMITED', '操作过于频繁，请稍后重试', 429);
  }

  async issue(
    channel: ContactChannel,
    input: string,
    purpose: CodePurpose,
    ip: string,
    ownerId?: string,
  ): Promise<VerificationResponse> {
    this.assertLocalAccess(ip);
    const target = normalizeContact(channel, input);
    if ((purpose === 'register' || purpose === 'verify-email') && channel !== 'email')
      throw new ApiError('VALIDATION_ERROR', '注册和邮箱验证请使用邮箱', 400);
    if (purpose.startsWith('bind-') && (!ownerId || purpose !== `bind-${channel}`))
      throw new ApiError('VALIDATION_ERROR', '验证用途不正确', 400);
    this.delivery.assertAvailable(channel);
    await this.limit('code-ip', ip, 20, 3600);
    // 所有用途共享目标上限，切换用途不能绕过发送限额。
    await this.limit('code-target', target, 5, 3600);
    let userId: string | null = ownerId ?? null;
    if (purpose === 'reset-password' || purpose === 'verify-email') {
      const column = channel === 'email' ? 'email' : 'phone';
      const verified = purpose === 'reset-password' ? `AND ${column}_verified_at IS NOT NULL` : '';
      const found = await this.database.query<{ id: string }>(
        `SELECT id FROM users WHERE ${column} = $1 ${verified}`,
        [target],
      );
      userId = found.rows[0]?.id ?? null;
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const id = randomUUID();
    const scope = this.scope(channel, target, purpose, ownerId);
    const version = userId
      ? ((
          await this.database.query<{ credential_version: number }>(
            'SELECT credential_version FROM users WHERE id = $1',
            [userId],
          )
        ).rows[0]?.credential_version ?? 0)
      : 0;
    const result = await this.database.query(
      `INSERT INTO auth_challenges(scope, id, user_id, digest, expires_at, credential_version)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', $5)
       ON CONFLICT (scope) DO UPDATE SET id = EXCLUDED.id, user_id = EXCLUDED.user_id,
         digest = EXCLUDED.digest, expires_at = EXCLUDED.expires_at, attempts = 0,
         sent_at = now(), delivered = false, consumed_at = NULL, credential_version = EXCLUDED.credential_version
       WHERE auth_challenges.sent_at <= now() - interval '60 seconds'
       RETURNING id`,
      [scope, id, userId, this.digest(`${id}:${code}`), version],
    );
    if (!result.rowCount) throw new ApiError('RATE_LIMITED', '请在 60 秒后重新获取验证码', 429);
    try {
      // 未注册的联系方式也接收相同文案；接口不会透露账号是否存在。
      await this.delivery.send(channel, target, code);
      await this.database.query(
        'UPDATE auth_challenges SET delivered = true WHERE scope = $1 AND id = $2',
        [scope, id],
      );
    } catch (error) {
      await this.database.query('DELETE FROM auth_challenges WHERE scope = $1 AND id = $2', [
        scope,
        id,
      ]);
      throw error;
    }
    // 限制短期凭据表增长；不保存明文验证码或完整目标地址。
    await this.database.query(
      "DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'",
    );
    await this.database.query('DELETE FROM auth_rate_limits WHERE expires_at < now()');
    await this.database.query('DELETE FROM auth_sessions WHERE expires_at < now()');
    return {
      message:
        purpose === 'reset-password'
          ? '验证码已受理，只有已验证的联系方式可以找回账号'
          : '验证码已发送，5 分钟内有效',
      retryAfter: 60,
      expiresIn: 300,
      ...(this.config.values.verification.mode === 'local' ? { developmentCode: code } : {}),
    };
  }

  async consume<T>(
    channel: ContactChannel,
    target: string,
    purpose: CodePurpose,
    ownerId: string | undefined,
    code: string,
    work: (client: PoolClient, userId: string | null) => Promise<T>,
  ): Promise<T> {
    const scope = this.scope(channel, target, purpose, ownerId);
    const result = await this.database.transaction(async (client) => {
      const found = await client.query<Challenge>(
        'SELECT * FROM auth_challenges WHERE scope = $1 FOR UPDATE',
        [scope],
      );
      const row = found.rows[0];
      let valid =
        row &&
        row.delivered &&
        !row.consumed_at &&
        row.attempts < 5 &&
        new Date(row.expires_at).getTime() > Date.now();
      if (valid && row.user_id) {
        const account = await client.query<{ credential_version: number }>(
          'SELECT credential_version FROM users WHERE id = $1 FOR UPDATE',
          [row.user_id],
        );
        valid = account.rows[0]?.credential_version === row.credential_version;
      }
      const actual = this.digest(`${row?.id ?? ''}:${code}`);
      if (
        !valid ||
        !/^\d{6}$/.test(code) ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(row.digest))
      ) {
        if (row)
          await client.query(
            'UPDATE auth_challenges SET attempts = attempts + 1 WHERE scope = $1',
            [scope],
          );
        // 返回后再抛异常，让错误次数提交，不能随事务回滚。
        return { valid: false as const };
      }
      await client.query('UPDATE auth_challenges SET consumed_at = now() WHERE scope = $1', [
        scope,
      ]);
      return { valid: true as const, value: await work(client, row.user_id) };
    });
    if (!result.valid)
      throw new ApiError('INVALID_CODE', '验证码错误、已失效或尝试次数过多，请重新获取', 400);
    return result.value;
  }
}
