import type { TravelPreferences } from '@travel/shared';

export const themeLabels = {
  history: '历史人文',
  nature: '自然风光',
  landmark: '城市地标',
  art: '艺术展览',
  family: '亲子出游',
  local: '市井生活',
} as const;
export const paceLabels = {
  relaxed: '轻松慢游',
  standard: '适中安排',
  intensive: '充实行程',
} as const;
export const transportLabels = { walking: '步行', transit: '公共交通', driving: '自驾' } as const;
export function defaultPreferences(value?: TravelPreferences): TravelPreferences {
  return {
    themes: [...(value?.themes ?? [])],
    pace: value?.pace ?? 'standard',
    transportMode: value?.transportMode ?? 'transit',
    dailyBudget: value?.dailyBudget ?? null,
  };
}

export function tripPreferenceDefaults(value?: TravelPreferences) {
  const prefs = defaultPreferences(value);
  const labels = {
    history: '历史文化',
    nature: '园林自然',
    landmark: '城市地标',
    art: '艺术设计',
    family: '亲子体验',
    local: '老街与在地体验',
  };
  return {
    themes: prefs.themes.map((item) => labels[item]),
    pace: prefs.pace,
    transport: prefs.transportMode,
  };
}
