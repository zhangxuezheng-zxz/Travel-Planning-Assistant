import { Body, Controller, Get, Header, Patch, UseGuards } from '@nestjs/common';
import { JsonBodyPipe } from '../common/json-body.pipe';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { UsersService } from './users.service';
import { validateProfile } from './profile-validation';

@Controller('users/me')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getById(user.userId);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new JsonBodyPipe()) body: Record<string, unknown>,
  ) {
    return this.users.updateProfile(user.userId, validateProfile(body));
  }
}
