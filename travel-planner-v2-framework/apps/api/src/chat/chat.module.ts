import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '../config/config.module';
import { ChatConfig } from './chat.config';
import { ChatController } from './chat.controller';
import { CHAT_CLOCK, CHAT_FETCH, CHAT_REQUEST_ID, ChatService } from './chat.service';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [ChatController],
  providers: [
    ChatConfig,
    ChatService,
    // 与 B 的 B_FETCH 同一手法：把 fetch、时钟和 ID 生成注入进来，单测可直接替换。
    { provide: CHAT_FETCH, useValue: (...args: Parameters<typeof fetch>) => fetch(...args) },
    { provide: CHAT_CLOCK, useValue: () => Date.now() },
    { provide: CHAT_REQUEST_ID, useValue: () => randomUUID() },
  ],
})
export class ChatModule {}
