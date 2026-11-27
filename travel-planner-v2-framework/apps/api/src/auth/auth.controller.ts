import { Body, Controller, Header, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { ContactChannel } from '@travel/shared' with { 'resolution-mode': 'import' };
import { ApiError } from '../common/api-error';
import { JsonBodyPipe, rejectUnknownFields, requiredString } from '../common/json-body.pipe';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './auth.types';
import { VerificationService } from './verification.service';

interface RequestAddress {
  ip?: string;
  socket: { remoteAddress?: string };
}
function clientAddress(request: RequestAddress): string {
  return request.ip ?? request.socket.remoteAddress ?? '';
}
function channelOf(value: unknown): ContactChannel {
  if (value !== 'email' && value !== 'phone')
    throw new ApiError('VALIDATION_ERROR', '请选择邮箱或手机号', 400);
  return value;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly verification: VerificationService,
  ) {}

  private async protect(request: RequestAddress): Promise<void> {
    const ip = clientAddress(request);
    this.verification.assertLocalAccess(ip);
    await this.verification.limit('auth-ip', ip, 60);
  }

  @Post('code')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async code(
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['channel', 'target', 'purpose']);
    const purpose = body.purpose;
    if (purpose !== 'register' && purpose !== 'verify-email' && purpose !== 'reset-password')
      throw new ApiError('VALIDATION_ERROR', '验证码用途不正确', 400);
    return this.verification.issue(
      channelOf(body.channel),
      requiredString(body.target, 'target', 3, 320),
      purpose,
      clientAddress(request),
    );
  }

  @Post('register')
  @Header('Cache-Control', 'no-store')
  async register(
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['email', 'password', 'displayName', 'code']);
    await this.protect(request);
    return this.auth.register(
      requiredString(body.email, 'email', 3, 320),
      requiredString(body.password, 'password', 12, 128),
      requiredString(body.displayName, 'displayName', 1, 80),
      requiredString(body.code, 'code', 6, 6),
    );
  }

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async login(
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['email', 'password']);
    await this.protect(request);
    return this.auth.login(
      requiredString(body.email, 'email', 3, 320),
      requiredString(body.password, 'password', 1, 128),
    );
  }

  @Post('verify-email')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async verifyEmail(
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['email', 'password', 'code']);
    await this.protect(request);
    return this.auth.verifyEmail(
      requiredString(body.email, 'email', 3, 320),
      requiredString(body.password, 'password', 1, 128),
      requiredString(body.code, 'code', 6, 6),
    );
  }

  @Post('reset-password')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async resetPassword(
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['channel', 'target', 'code', 'newPassword']);
    await this.protect(request);
    return this.auth.resetPassword(
      channelOf(body.channel),
      requiredString(body.target, 'target', 3, 320),
      requiredString(body.code, 'code', 6, 6),
      requiredString(body.newPassword, 'newPassword', 12, 128),
    );
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async logout(@Headers('authorization') header?: string) {
    return this.auth.logout(header?.startsWith('Bearer ') ? header.slice(7).trim() : '');
  }

  @Post('password')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async password(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['currentPassword', 'newPassword']);
    await this.protect(request);
    return this.auth.changePassword(
      user.userId,
      requiredString(body.currentPassword, 'currentPassword', 1, 128),
      requiredString(body.newPassword, 'newPassword', 12, 128),
    );
  }

  @Post('contact/code')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async contactCode(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['channel', 'target']);
    const channel = channelOf(body.channel);
    return this.verification.issue(
      channel,
      requiredString(body.target, 'target', 3, 320),
      `bind-${channel}`,
      clientAddress(request),
      user.userId,
    );
  }

  @Post('contact')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async contact(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['channel', 'target', 'code', 'currentPassword']);
    await this.protect(request);
    return this.auth.bindContact(
      user.userId,
      channelOf(body.channel),
      requiredString(body.target, 'target', 3, 320),
      requiredString(body.code, 'code', 6, 6),
      requiredString(body.currentPassword, 'currentPassword', 1, 128),
    );
  }

  @Post('contact/remove-phone')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async removePhone(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
    @Req() request: RequestAddress,
  ) {
    rejectUnknownFields(body, ['currentPassword']);
    await this.protect(request);
    return this.auth.removePhone(
      user.userId,
      requiredString(body.currentPassword, 'currentPassword', 1, 128),
    );
  }
}
