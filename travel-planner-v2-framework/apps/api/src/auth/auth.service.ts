import { Injectable } from '@nestjs/common';
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ContactChannel, LoginResponse } from '@travel/shared' with {
  'resolution-mode': 'import',
};
import { DatabaseService } from '../database/database.service';
import { ConfigService } from '../config/config.service';
import { ApiError } from '../common/api-error';
import { ACCOUNT_COLUMNS, publicUser, type AccountRow } from '../users/public-user';
import { normalizeContact, VerificationService } from './verification.service';

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, SCRYPT_OPTIONS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly verification: VerificationService,
  ) {}

  private validatePassword(password: string): void {
    if (password.length < 12 || password.length > 128 || !password.trim()) {
      throw new ApiError('VALIDATION_ERROR', '密码长度必须为 12 到 128 个字符，不能全为空格', 400);
    }
  }

  async register(
    input: string,
    password: string,
    displayName: string,
    code: string,
  ): Promise<LoginResponse> {
    const email = normalizeContact('email', input);
    this.validatePassword(password);
    const passwordHash = await this.hashPassword(password);
    try {
      return await this.verification.consume(
        'email',
        email,
        'register',
        undefined,
        code,
        async (client) => {
          const result = await client.query<AccountRow>(
            `INSERT INTO users(email, display_name, password_hash, email_verified_at)
           VALUES ($1, $2, $3, now()) RETURNING ${ACCOUNT_COLUMNS}`,
            [email, displayName, passwordHash],
          );
          return this.issueSession(result.rows[0], client);
        },
      );
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ApiError('EMAIL_IN_USE', '该邮箱已注册，请登录或找回密码', 409);
      throw error;
    }
  }

  async login(input: string, password: string): Promise<LoginResponse> {
    const channel = input.includes('@') ? 'email' : 'phone';
    const target = normalizeContact(channel, input);
    await this.verification.limit('login-target', target, 12);
    return this.database.transaction(async (client) => {
      const result = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS}, password_hash FROM users WHERE ${channel} = $1 FOR UPDATE`,
        [target],
      );
      const user = result.rows[0];
      if (!user?.password_hash || !(await this.verifyPassword(password, user.password_hash))) {
        if (!user?.password_hash) await deriveKey(password, Buffer.alloc(16));
        throw new ApiError('UNAUTHENTICATED', '账号或密码不正确', 401);
      }
      if (!user.email_verified_at)
        throw new ApiError(
          'EMAIL_VERIFICATION_REQUIRED',
          '此账号的邮箱尚未验证，请先验证邮箱',
          403,
        );
      if (channel === 'phone' && !user.phone_verified_at)
        throw new ApiError('UNAUTHENTICATED', '账号或密码不正确', 401);
      return this.issueSession(user, client);
    });
  }

  private async issueSession(user: AccountRow, client: PoolClient): Promise<LoginResponse> {
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();
    const ttl = this.config.values.authTokenTtlSeconds;
    const expiresAt = new Date((now + ttl) * 1000).toISOString();
    await client.query('INSERT INTO auth_sessions(id, user_id, expires_at) VALUES ($1, $2, $3)', [
      id,
      user.id,
      expiresAt,
    ]);
    return {
      accessToken: this.signToken({ sub: user.id, jti: id, iat: now, exp: now + ttl }),
      expiresAt,
      user: publicUser(user),
    };
  }

  private readToken(token: string): { sub: string; jti: string } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [header, payload, signature] = parts;
      const actual = Buffer.from(signature, 'base64url');
      const expected = Buffer.from(this.sign(`${header}.${payload}`), 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString()) as {
        alg?: unknown;
        typ?: unknown;
      };
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const now = Math.floor(Date.now() / 1000);
      if (
        parsedHeader.alg !== 'HS256' ||
        parsedHeader.typ !== 'JWT' ||
        typeof parsed.sub !== 'string' ||
        !uuid.test(parsed.sub) ||
        typeof parsed.jti !== 'string' ||
        !uuid.test(parsed.jti) ||
        typeof parsed.exp !== 'number' ||
        !Number.isSafeInteger(parsed.exp) ||
        parsed.exp <= now ||
        typeof parsed.iat !== 'number' ||
        !Number.isSafeInteger(parsed.iat) ||
        parsed.iat > now + 30 ||
        parsed.exp <= parsed.iat ||
        parsed.exp - parsed.iat > TOKEN_TTL_SECONDS
      )
        return null;
      return { sub: parsed.sub, jti: parsed.jti };
    } catch {
      return null;
    }
  }

  async verifyAccessToken(token: string): Promise<string | null> {
    const claims = this.readToken(token);
    if (!claims) return null;
    const result = await this.database.query(
      `SELECT s.id FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.expires_at > now() AND u.email_verified_at IS NOT NULL`,
      [claims.jti, claims.sub],
    );
    return result.rowCount ? claims.sub : null;
  }

  async logout(token: string): Promise<{ message: string }> {
    const claims = this.readToken(token);
    if (claims)
      await this.database.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [
        claims.jti,
        claims.sub,
      ]);
    return { message: '已退出登录' };
  }

  async verifyEmail(input: string, password: string, code: string): Promise<{ message: string }> {
    const email = normalizeContact('email', input);
    await this.verification.limit('verify-account', email, 12);
    return this.verification.consume(
      'email',
      email,
      'verify-email',
      undefined,
      code,
      async (client, userId) => {
        const result = await client.query<AccountRow>(
          'SELECT * FROM users WHERE id = $1 AND email = $2 FOR UPDATE',
          [userId, email],
        );
        const user = result.rows[0];
        if (!user?.password_hash || !(await this.verifyPassword(password, user.password_hash)))
          throw new ApiError('UNAUTHENTICATED', '账号或密码不正确', 401);
        await client.query(
          'UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1',
          [user.id],
        );
        await this.revokeAll(client, user.id);
        return { message: '邮箱已验证，请登录' };
      },
    );
  }

  async resetPassword(
    channel: ContactChannel,
    input: string,
    code: string,
    password: string,
  ): Promise<{ message: string }> {
    const target = normalizeContact(channel, input);
    this.validatePassword(password);
    const hash = await this.hashPassword(password);
    return this.verification.consume(
      channel,
      target,
      'reset-password',
      undefined,
      code,
      async (client, userId) => {
        const result = await client.query(
          `UPDATE users SET password_hash = $3, updated_at = now()
         WHERE id = $1 AND ${channel} = $2 AND ${channel}_verified_at IS NOT NULL RETURNING id`,
          [userId, target, hash],
        );
        if (!result.rowCount)
          throw new ApiError(
            'INVALID_CODE',
            '无法使用此验证码找回账号，请检查已验证的联系方式',
            400,
          );
        await this.revokeAll(client, userId!);
        return { message: '密码已重置，请使用新密码登录' };
      },
    );
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    await this.verification.limit('security-user', userId, 12);
    this.validatePassword(newPassword);
    const hash = await this.hashPassword(newPassword);
    await this.database.transaction(async (client) => {
      await this.confirmPassword(client, userId, currentPassword);
      if (newPassword === currentPassword)
        throw new ApiError('VALIDATION_ERROR', '新密码不能与原密码相同', 400);
      await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
        userId,
        hash,
      ]);
      await this.revokeAll(client, userId);
    });
    return { message: '密码已修改，所有设备已退出，请重新登录' };
  }

  async bindContact(
    userId: string,
    channel: ContactChannel,
    input: string,
    code: string,
    password: string,
  ): Promise<{ message: string }> {
    await this.verification.limit('security-user', userId, 12);
    const target = normalizeContact(channel, input);
    try {
      return await this.verification.consume(
        channel,
        target,
        `bind-${channel}`,
        userId,
        code,
        async (client, challengeOwner) => {
          if (challengeOwner !== userId)
            throw new ApiError('INVALID_CODE', '验证码用途不正确', 400);
          await this.confirmPassword(client, userId, password);
          await client.query(
            `UPDATE users SET ${channel} = $2, ${channel}_verified_at = now(), updated_at = now() WHERE id = $1`,
            [userId, target],
          );
          await this.revokeAll(client, userId);
          return { message: '联系方式已验证并保存，请重新登录' };
        },
      );
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ApiError('CONTACT_IN_USE', '该联系方式已被其他账号使用', 409);
      throw error;
    }
  }

  async removePhone(userId: string, password: string): Promise<{ message: string }> {
    await this.verification.limit('security-user', userId, 12);
    await this.database.transaction(async (client) => {
      await this.confirmPassword(client, userId, password);
      await client.query(
        'UPDATE users SET phone = NULL, phone_verified_at = NULL, updated_at = now() WHERE id = $1 AND email_verified_at IS NOT NULL',
        [userId],
      );
      await this.revokeAll(client, userId);
    });
    return { message: '手机号已解绑，请使用邮箱重新登录' };
  }

  private async confirmPassword(
    client: PoolClient,
    userId: string,
    password: string,
  ): Promise<void> {
    const result = await client.query<AccountRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [
      userId,
    ]);
    const user = result.rows[0];
    if (!user?.password_hash || !(await this.verifyPassword(password, user.password_hash)))
      throw new ApiError('INCORRECT_PASSWORD', '当前密码不正确', 400);
  }

  private async revokeAll(client: PoolClient, userId: string): Promise<void> {
    await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
    // 使该用户此前所有用途的验证码失效，避免锁住其他验证码行造成死锁。
    await client.query(
      'UPDATE users SET credential_version = credential_version + 1 WHERE id = $1',
      [userId],
    );
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  private async verifyPassword(password: string, encoded: string): Promise<boolean> {
    const [algorithm, n, r, p, saltText, hashText, extra] = encoded.split('$');
    if (
      algorithm !== 'scrypt' ||
      Number(n) !== SCRYPT_OPTIONS.N ||
      Number(r) !== SCRYPT_OPTIONS.r ||
      Number(p) !== SCRYPT_OPTIONS.p ||
      !saltText ||
      !hashText ||
      extra
    )
      return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    return timingSafeEqual(await deriveKey(password, salt), expected);
  }

  private signToken(payload: { sub: string; jti: string; iat: number; exp: number }): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.${this.sign(`${header}.${body}`)}`;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.values.authTokenSecret)
      .update(value)
      .digest('base64url');
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
  }
}
