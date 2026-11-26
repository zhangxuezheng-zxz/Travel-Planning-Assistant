import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ChatService } from './chat.service';

/**
 * 首页 AI 对话。服务端无状态：每轮由前端带上最近的历史，服务端只做校验与转发。
 * 身份取自服务端校验过的 token，请求体里不接受任何 userId。
 */
@Controller('chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('messages')
  @HttpCode(200)
  send(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.chat.reply(body, user.userId);
  }
}
