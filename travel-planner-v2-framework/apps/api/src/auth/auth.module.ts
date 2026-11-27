import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { VerificationDeliveryService } from './verification-delivery.service';
import { VerificationService } from './verification.service';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, VerificationService, VerificationDeliveryService],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
