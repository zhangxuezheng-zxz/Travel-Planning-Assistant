const { resolve } = require('node:path');
const nodemailer = require('nodemailer');
const { readConfig } = require('../dist/config/config.service');
require('dotenv').config({ path: resolve(__dirname, '../../../.env') });

async function main() {
  const settings = readConfig(process.env).verification;
  if (!settings.smtpHost || !settings.smtpUser || !settings.smtpPassword || !settings.smtpFrom) {
    console.error(
      'SMTP configuration incomplete: set SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM in the local .env.',
    );
    process.exitCode = 1;
    return;
  }
  const transport = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    requireTLS: !settings.smtpSecure,
    auth: { user: settings.smtpUser, pass: settings.smtpPassword },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    logger: false,
    debug: false,
  });
  try {
    await transport.verify();
    console.log('SMTP connection, TLS and authentication verified. No email was sent.');
  } catch (failure) {
    const code = failure && typeof failure === 'object' ? failure.code : undefined;
    const category =
      code === 'EAUTH'
        ? 'AUTHENTICATION_FAILED'
        : ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS'].includes(code)
          ? 'CONNECTION_FAILED'
          : 'CHECK_FAILED';
    console.error(
      'SMTP ' +
        category +
        '. Check the sender account, SMTP authorization code and network. Credentials and provider response are not printed.',
    );
    process.exitCode = 1;
  } finally {
    transport.close();
  }
}
main().catch(() => {
  console.error('SMTP configuration check failed. Check the local .env configuration.');
  process.exitCode = 1;
});
