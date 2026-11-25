import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import type { PublicUser } from '../auth/auth.types';
import type { UpdateProfileRequest } from '@travel/shared' with { 'resolution-mode': 'import' };
import { ACCOUNT_COLUMNS, publicUser, type AccountRow } from './public-user';

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async getById(userId: string): Promise<PublicUser> {
    const result = await this.database.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = $1`,
      [userId],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', '用户不存在', 404);
    return publicUser(result.rows[0]);
  }

  async updateDisplayName(userId: string, displayName: string): Promise<PublicUser> {
    return this.updateProfile(userId, { displayName });
  }

  async updateProfile(userId: string, input: UpdateProfileRequest): Promise<PublicUser> {
    const fields: [string, unknown][] = [];
    if (input.displayName !== undefined) fields.push(['display_name', input.displayName]);
    if (input.bio !== undefined) fields.push(['bio', input.bio]);
    if (input.homeCity !== undefined) fields.push(['home_city', input.homeCity]);
    if (input.travelPreferences !== undefined)
      fields.push(['travel_preferences', JSON.stringify(input.travelPreferences)]);
    const result = await this.database.query<AccountRow>(
      `UPDATE users SET ${fields.map(([column], i) => `${column} = $${i + 2}`).join(', ')},
       updated_at = now() WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      [userId, ...fields.map(([, value]) => value)],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', '用户不存在', 404);
    return publicUser(result.rows[0]);
  }
}
