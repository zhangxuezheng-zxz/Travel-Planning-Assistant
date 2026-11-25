import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  databaseConnectionTimeoutMs: number;
  databaseQueryTimeoutMs: number;
  mediaStorageDir: string;
  authTokenSecret: string;
  authTokenTtlSeconds: number;
  trustLoopbackProxy: boolean;
  amapWebServiceKey: string;
  verification: {
    mode: 'local' | 'provider';
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPassword: string;
    smtpFrom: string;
    smsSecretId: string;
    smsSecretKey: string;
    smsAppId: string;
    smsSignName: string;
    smsTemplateId: string;
  };
}

function positiveInteger(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let protocol: string;
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  const corsOrigins = (env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (corsOrigins.length === 0) throw new Error('CORS_ORIGIN cannot be empty');
  for (const origin of corsOrigins) {
    let valid = false;
    try {
      const url = new URL(origin);
      valid = ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
    } catch {
      valid = false;
    }
    if (!valid) throw new Error('CORS_ORIGIN must contain HTTP or HTTPS origins');
  }
  if (env.NODE_ENV === 'production' && !env.AUTH_TOKEN_SECRET?.trim()) {
    throw new Error('AUTH_TOKEN_SECRET is required in production');
  }
  const deliveryMode = env.AUTH_DELIVERY_MODE || 'provider';
  if (env.TRUST_PROXY && !['off', 'loopback'].includes(env.TRUST_PROXY)) {
    throw new Error('TRUST_PROXY must be off or loopback');
  }
  if (!['local', 'provider'].includes(deliveryMode)) throw new Error('Invalid AUTH_DELIVERY_MODE');
  if (deliveryMode === 'local' && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('Local verification requires NODE_ENV=development or test');
  }
  const authTokenSecret = env.AUTH_TOKEN_SECRET?.trim() || randomBytes(32).toString('base64url');
  if (Buffer.byteLength(authTokenSecret, 'utf8') < 32) {
    throw new Error('AUTH_TOKEN_SECRET must be at least 32 bytes');
  }
  return {
    port: positiveInteger(env.PORT ?? '3000', 'PORT', 65535),
    databaseUrl,
    corsOrigins,
    databaseConnectionTimeoutMs: positiveInteger(
      env.DB_CONNECTION_TIMEOUT_MS ?? '2000',
      'DB_CONNECTION_TIMEOUT_MS',
      60000,
    ),
    databaseQueryTimeoutMs: positiveInteger(
      env.DB_QUERY_TIMEOUT_MS ?? '10000',
      'DB_QUERY_TIMEOUT_MS',
      60000,
    ),
    mediaStorageDir: resolve(
      env.MEDIA_STORAGE_DIR?.trim() || resolve(__dirname, '../../../../apps/api/.data/media'),
    ),
    authTokenSecret,
    trustLoopbackProxy: env.TRUST_PROXY === 'loopback',
    authTokenTtlSeconds: positiveInteger(
      env.AUTH_TOKEN_TTL_SECONDS ?? '604800',
      'AUTH_TOKEN_TTL_SECONDS',
      604800,
    ),
    amapWebServiceKey: env.AMAP_WEB_SERVICE_KEY?.trim() ?? '',
    verification: {
      mode: deliveryMode as 'local' | 'provider',
      smtpHost: env.SMTP_HOST?.trim() ?? '',
      smtpPort: positiveInteger(env.SMTP_PORT ?? '465', 'SMTP_PORT', 65535),
      smtpSecure: env.SMTP_SECURE !== 'false',
      smtpUser: env.SMTP_USER?.trim() ?? '',
      smtpPassword: env.SMTP_PASSWORD ?? '',
      smtpFrom: env.SMTP_FROM?.trim() ?? '',
      smsSecretId: env.TENCENT_SMS_SECRET_ID?.trim() ?? '',
      smsSecretKey: env.TENCENT_SMS_SECRET_KEY?.trim() ?? '',
      smsAppId: env.TENCENT_SMS_APP_ID?.trim() ?? '',
      smsSignName: env.TENCENT_SMS_SIGN_NAME?.trim() ?? '',
      smsTemplateId: env.TENCENT_SMS_TEMPLATE_ID?.trim() ?? '',
    },
  };
}

@Injectable()
export class ConfigService {
  readonly values: AppConfig;

  constructor() {
    // src/config and dist/config have the same depth below the workspace root.
    loadEnv({ path: resolve(__dirname, '../../../..', '.env') });
    this.values = readConfig(process.env);
  }
}
