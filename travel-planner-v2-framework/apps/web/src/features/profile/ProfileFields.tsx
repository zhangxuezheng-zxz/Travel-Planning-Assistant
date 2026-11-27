import type { Theme, TravelPreferences, TripPace, TransportMode } from '@travel/shared';
import { themeLabels, paceLabels, transportLabels } from './travel-preferences';

interface Props {
  bio: string;
  setBio: (value: string) => void;
  homeCity: string;
  setHomeCity: (value: string) => void;
  preferences: TravelPreferences;
  setPreferences: (value: TravelPreferences) => void;
  disabled?: boolean;
}
export default function ProfileFields({
  bio,
  setBio,
  homeCity,
  setHomeCity,
  preferences,
  setPreferences,
  disabled,
}: Props) {
  return (
    <fieldset className="profile-preferences" disabled={disabled}>
      <label>
        常住城市
        <input
          maxLength={100}
          value={homeCity}
          placeholder="例如：北京"
          onChange={(event) => setHomeCity(event.target.value)}
          autoComplete="address-level2"
        />
      </label>
      <label>
        个人简介
        <textarea
          maxLength={300}
          rows={3}
          value={bio}
          placeholder="喜欢怎样的旅行，或记下自己的出行习惯"
          onChange={(event) => setBio(event.target.value)}
        />
        <small>{bio.length}/300</small>
      </label>
      <fieldset className="profile-theme-options">
        <legend>喜欢的旅行主题（可多选）</legend>
        {(Object.keys(themeLabels) as Theme[]).map((theme) => (
          <label key={theme}>
            <input
              type="checkbox"
              checked={preferences.themes.includes(theme)}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  themes: event.target.checked
                    ? [...preferences.themes, theme]
                    : preferences.themes.filter((item) => item !== theme),
                })
              }
            />
            {themeLabels[theme]}
          </label>
        ))}
      </fieldset>
      <div className="profile-preference-grid">
        <label>
          旅行节奏
          <select
            value={preferences.pace}
            onChange={(event) =>
              setPreferences({ ...preferences, pace: event.target.value as TripPace })
            }
          >
            {(Object.keys(paceLabels) as TripPace[]).map((item) => (
              <option key={item} value={item}>
                {paceLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <label>
          交通偏好
          <select
            value={preferences.transportMode}
            onChange={(event) =>
              setPreferences({ ...preferences, transportMode: event.target.value as TransportMode })
            }
          >
            {(Object.keys(transportLabels) as TransportMode[]).map((item) => (
              <option key={item} value={item}>
                {transportLabels[item]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        每日预算（元 / 人）
        <input
          type="number"
          min={1}
          max={100000}
          step={1}
          value={preferences.dailyBudget ?? ''}
          placeholder="选填，例如 500"
          onChange={(event) =>
            setPreferences({
              ...preferences,
              dailyBudget: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        />
      </label>
      <p className="profile-hint">
        旅行主题、节奏和交通方式将用作新行程的默认偏好；已有行程保持自己的安排。预算用于记录个人偏好，目前不作为自动排程的费用限制。
      </p>
    </fieldset>
  );
}
