import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { sms } from 'tencentcloud-sdk-nodejs-sms';
import type { ContactChannel } from '@travel/shared' with { 'resolution-mode': 'import' };
import { ConfigService } from '../config/config.service';
import { ApiError } from '../common/api-error';

@Injectable()
export class VerificationDeliveryService {
  constructor(private readonly config: ConfigService) {}

  assertAvailable(channel: ContactChannel): void {
    const settings = this.config.values.verification;
    if (settings.mode === 'local') return;
    const ready =
      channel === 'email'
        ? settings.smtpHost && settings.smtpFrom
        : settings.smsSecretId &&
          settings.smsSecretKey &&
          settings.smsAppId &&
          settings.smsSignName &&
          settings.smsTemplateId;
    if (!ready)
      throw new ApiError(
        'DELIVERY_NOT_CONFIGURED',
        channel === 'email'
          ? '邮件发送服务尚未配置，请联系管理员'
          : '短信发送服务尚未配置，请联系管理员',
        503,
      );
  }

  async send(channel: ContactChannel, target: string, code: string): Promise<void> {
    this.assertAvailable(channel);
    const settings = this.config.values.verification;
    if (settings.mode === 'local') return;
    try {
      if (channel === 'email') {
        const transport = nodemailer.createTransport({
          host: settings.smtpHost,
          port: settings.smtpPort,
          secure: settings.smtpSecure,
          requireTLS: !settings.smtpSecure,
          auth: settings.smtpUser
            ? { user: settings.smtpUser, pass: settings.smtpPassword }
            : undefined,
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 10000,
        });
        const result = await transport.sendMail({
          from: settings.smtpFrom,
          to: { address: target, name: '' },
          subject: '随心行 · 验证码',
          text: `你的验证码是 ${code}，5 分钟内有效。请勿向他人透露。如果不是本人操作，请忽略此邮件。`,
        });
        if (!result.accepted?.length) throw new Error('Delivery refused');
      } else {
        const client = new sms.v20210111.Client({
          credential: { secretId: settings.smsSecretId, secretKey: settings.smsSecretKey },
          region: 'ap-guangzhou',
          profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com', reqTimeout: 10 } },
        });
        const result = await client.SendSms({
          PhoneNumberSet: [target],
          SmsSdkAppId: settings.smsAppId,
          SignName: settings.smsSignName,
          TemplateId: settings.smsTemplateId,
          TemplateParamSet: [code, '5'],
        });
        if (result.SendStatusSet?.[0]?.Code !== 'Ok') throw new Error('Delivery refused');
      }
    } catch {
      // 不将包含服务商凭据、收件人或验证码的原始错误写入响应/日志。
      throw new ApiError('DELIVERY_FAILED', '验证码发送失败，请稍后重试或联系管理员', 503);
    }
  }
}
