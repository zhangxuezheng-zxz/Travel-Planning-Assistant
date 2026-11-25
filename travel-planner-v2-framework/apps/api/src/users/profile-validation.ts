import type { UpdateProfileRequest, TravelPreferences } from '@travel/shared' with {
  'resolution-mode': 'import',
};
import { ApiError } from '../common/api-error';
import { rejectUnknownFields, requiredString } from '../common/json-body.pipe';

const THEMES = ['history', 'nature', 'landmark', 'art', 'family', 'local'];
function invalid(message: string): never {
  throw new ApiError('VALIDATION_ERROR', message, 400);
}

export function validateProfile(body: Record<string, unknown>): UpdateProfileRequest {
  rejectUnknownFields(body, ['displayName', 'bio', 'homeCity', 'travelPreferences']);
  if (!Object.keys(body).length) invalid('请至少修改一项资料');
  const result: UpdateProfileRequest = {};
  if ('displayName' in body)
    result.displayName = requiredString(body.displayName, 'displayName', 1, 80);
  if ('bio' in body) result.bio = requiredString(body.bio, 'bio', 0, 300);
  if ('homeCity' in body) result.homeCity = requiredString(body.homeCity, 'homeCity', 0, 100);
  if ('travelPreferences' in body) {
    const input = body.travelPreferences;
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('旅行偏好格式不正确');
    const value = input as Record<string, unknown>;
    rejectUnknownFields(value, ['themes', 'pace', 'transportMode', 'dailyBudget']);
    if (
      !Array.isArray(value.themes) ||
      value.themes.length > 6 ||
      new Set(value.themes).size !== value.themes.length ||
      value.themes.some((item) => typeof item !== 'string' || !THEMES.includes(item))
    )
      invalid('请选择有效且不重复的旅行主题');
    if (
      typeof value.pace !== 'string' ||
      !['relaxed', 'standard', 'intensive'].includes(value.pace)
    )
      invalid('旅行节奏不正确');
    if (
      typeof value.transportMode !== 'string' ||
      !['walking', 'transit', 'driving'].includes(value.transportMode)
    )
      invalid('交通偏好不正确');
    if (
      value.dailyBudget !== null &&
      (typeof value.dailyBudget !== 'number' ||
        !Number.isInteger(value.dailyBudget) ||
        value.dailyBudget < 1 ||
        value.dailyBudget > 100000)
    )
      invalid('每日预算须为 1 至 100000 元的整数，或留空');
    result.travelPreferences = value as unknown as TravelPreferences;
  }
  return result;
}
