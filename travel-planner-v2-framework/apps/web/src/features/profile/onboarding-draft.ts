import type { PublicUser, TravelPreferences } from '@travel/shared';
import { defaultPreferences, paceLabels, themeLabels, transportLabels } from './travel-preferences';

interface OnboardingDraft {
  step: number;
  preferences: TravelPreferences;
}
function key(userId: string) {
  return `travel:preference-onboarding:${userId}`;
}
export function readOnboardingDraft(
  storage: Pick<Storage, 'getItem'>,
  user: PublicUser,
): OnboardingDraft {
  const fallback = { step: 0, preferences: defaultPreferences(user.travelPreferences) };
  try {
    const value = JSON.parse(storage.getItem(key(user.id)) ?? 'null');
    if (!value || !Number.isInteger(value.step) || value.step < 0 || value.step > 2)
      return fallback;
    const prefs = value.preferences;
    if (
      !prefs ||
      !Array.isArray(prefs.themes) ||
      prefs.themes.length > 6 ||
      new Set(prefs.themes).size !== prefs.themes.length ||
      prefs.themes.some(
        (theme: unknown) => typeof theme !== 'string' || !Object.hasOwn(themeLabels, theme),
      ) ||
      !Object.hasOwn(paceLabels, prefs.pace) ||
      !Object.hasOwn(transportLabels, prefs.transportMode)
    )
      return fallback;
    return {
      step: value.step,
      preferences: {
        ...fallback.preferences,
        themes: prefs.themes,
        pace: prefs.pace,
        transportMode: prefs.transportMode,
      },
    };
  } catch {
    return fallback;
  }
}
export function saveOnboardingDraft(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  draft: OnboardingDraft,
) {
  try {
    storage.setItem(key(userId), JSON.stringify(draft));
  } catch {
    /* 存储不可用不阻止设置偏好。 */
  }
}
export function clearOnboardingDraft(storage: Pick<Storage, 'removeItem'>, userId: string) {
  try {
    storage.removeItem(key(userId));
  } catch {
    /* 完成状态以数据库为准。 */
  }
}
