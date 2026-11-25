import type { PublicUser, TravelPreferences } from '@travel/shared' with {
  'resolution-mode': 'import',
};

export interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash?: string;
  email_verified_at?: Date | null;
  phone?: string | null;
  phone_verified_at?: Date | null;
  bio?: string;
  home_city?: string;
  travel_preferences?: Partial<TravelPreferences>;
  onboarding_completed_at?: Date | null;
}

export const ACCOUNT_COLUMNS =
  'id, email, display_name, email_verified_at, phone, phone_verified_at, bio, home_city, travel_preferences, onboarding_completed_at';

export function publicUser(row: AccountRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: Boolean(row.email_verified_at),
    phone: row.phone ?? null,
    phoneVerified: Boolean(row.phone_verified_at),
    bio: row.bio ?? '',
    homeCity: row.home_city ?? '',
    onboardingCompleted: Boolean(row.onboarding_completed_at),
    travelPreferences: {
      themes: row.travel_preferences?.themes ?? [],
      pace: row.travel_preferences?.pace ?? 'standard',
      transportMode: row.travel_preferences?.transportMode ?? 'transit',
      dailyBudget: row.travel_preferences?.dailyBudget ?? null,
    },
  };
}
