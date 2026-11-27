import { useEffect, useRef, useState } from 'react';
import type { PublicUser, Theme, TravelPreferences } from '@travel/shared';
import type { ApiClient } from '../../lib/api-client';
import { createProfileApi, profileErrorMessage } from '../../lib/profile-client';
import { APP_NAME } from '../trip-create/branding';
import { defaultPreferences, paceLabels, themeLabels, transportLabels } from './travel-preferences';
import { clearOnboardingDraft, readOnboardingDraft, saveOnboardingDraft } from './onboarding-draft';
import beijingCover from '../../assets/beijing-cover.jpg';
import hangzhouCover from '../../assets/hangzhou-cover.jpg';
import './preference-onboarding.css';

type IconName = Theme | 'relaxed' | 'standard' | 'intensive' | 'walking' | 'transit' | 'driving';
const iconPaths: Record<IconName, string[]> = {
  history: ['M4 13h40L24 4 4 13Z', 'M8 39h32M5 44h38M11 18v17m9-17v17m9-17v17m9-17v17'],
  nature: ['M3 38 17 13l10 17 6-11 12 19H3Z', 'm12 22 5 5 5-5M33 7v5m-3-2h6'],
  landmark: ['M5 42h38M9 42V21h12V9h13v33M34 26h7v16', 'M14 27h2m-2 6h2m10-17h3m-3 8h3m-3 8h3'],
  art: ['M7 7h34v31H7V7Z', 'm13 31 8-12 6 8 5-6 5 10M24 38v6m-8 0h16', 'M29 14h.1'],
  family: [
    'M17 16a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z',
    'M5 40V28a12 12 0 0 1 24 0v12M35 27a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM28 43v-7a7 7 0 0 1 14 0v7',
  ],
  local: [
    'M7 20v22h34V20M12 42V29h10v13M29 29h6v7h-6',
    'M4 20 9 7h30l5 13M5 20c0 6 8 6 8 0 0 6 8 6 8 0 0 6 8 6 8 0 0 6 8 6 8 0 0 6 8 6 8 0',
  ],
  relaxed: ['M10 18h23v13a10 10 0 0 1-20 0V18M33 21h3a6 6 0 0 1 0 12h-3M8 43h31M18 7v5m9-7v7'],
  standard: [
    'M8 24h32M24 8v32M24 8l-6 6m6-6 6 6M40 24l-6-6m6 6-6 6M24 40l-6-6m6 6 6-6M8 24l6-6m-6 6 6 6',
  ],
  intensive: ['m26 3-16 25h13l-1 17 17-25H26V3Z'],
  walking: [
    'M27 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM21 42l3-12-7-6 5-10 8 1 5 9h8M5 25l10-4M29 21l-5 9 13 12M8 42h7',
  ],
  transit: [
    'M12 5h24a4 4 0 0 1 4 4v28H8V9a4 4 0 0 1 4-4ZM8 23h32M24 5v18M14 37l-3 7m23-7 3 7M15 30h1m16 0h1',
  ],
  driving: ['m8 20 5-12h22l5 12M8 20h32l3 8v11H5V28l3-8ZM5 31h38M11 39v5m26-5v5M11 26h4m18 0h4'],
};
function TravelIcon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

const themes: { id: Theme; caption: string; tag: string }[] = [
  { id: 'history', caption: '古建、博物馆与岁月的痕迹', tag: 'CULTURE' },
  { id: 'nature', caption: '山野、湖泊与城市里的绿意', tag: 'NATURE' },
  { id: 'landmark', caption: '去亲眼见见城市的代表作', tag: 'CITY' },
  { id: 'art', caption: '美术馆、设计与有趣的展览', tag: 'ARTS' },
  { id: 'family', caption: '适合一家人一起探索的地方', tag: 'TOGETHER' },
  { id: 'local', caption: '街巷、早市与当地人的日常', tag: 'LOCAL' },
];
const paces: { id: TravelPreferences['pace']; caption: string; detail: string }[] = [
  {
    id: 'relaxed',
    caption: '慢一点，也很好',
    detail: '少赶路，多停留。给散步和临时起意留一点空白。',
  },
  { id: 'standard', caption: '刚刚好的充实', detail: '想看的风景与休息都有安排，节奏张弛有度。' },
  {
    id: 'intensive',
    caption: '多看一点世界',
    detail: '愿意早些出发，把一天留给更多值得去的地方。',
  },
];
const transports: { id: TravelPreferences['transportMode']; caption: string; detail: string }[] = [
  { id: 'transit', caption: '跟着城市的脉络走', detail: '优先考虑公交、地铁等公共交通。' },
  { id: 'walking', caption: '用脚步认识一座城', detail: '喜欢近距离探索，慢慢走、细细看。' },
  { id: 'driving', caption: '方向盘在自己手里', detail: '适合自驾出游，行程以驾车方式规划。' },
];
const steps = ['旅行兴趣', '旅行节奏', '出行方式'];
const titles = ['什么样的风景，会让你心动？', '这次旅行，你想走多快？', '用你喜欢的方式，出发。'];
const descriptions = [
  '选几个你喜欢的主题，让第一份行程更合你的心意。',
  '没有标准答案，按自己舒服的节奏来。',
  '作为新行程的默认选项，每次出发前都可以调整。',
];

export default function PreferenceOnboarding({
  user,
  client,
  onComplete,
  onSignOut,
}: {
  user: PublicUser;
  client: ApiClient;
  onComplete: (updated: PublicUser) => void;
  onSignOut: () => Promise<void>;
}) {
  const [initialDraft] = useState(() => {
    try {
      return readOnboardingDraft(sessionStorage, user);
    } catch {
      return { step: 0, preferences: defaultPreferences(user.travelPreferences) };
    }
  });
  const [step, setStep] = useState(initialDraft.step);
  const [preferences, setPreferences] = useState(initialDraft.preferences);
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const selected = preferences.themes;

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  useEffect(() => {
    try {
      saveOnboardingDraft(sessionStorage, user.id, { step, preferences });
    } catch {
      /* 浏览器可能禁用 sessionStorage；仍保留当前页面内的选择。 */
    }
  }, [user.id, step, preferences]);

  function go(next: number) {
    setStep(next);
    setError('');
    requestAnimationFrame(() => heading.current?.focus());
  }
  function toggleTheme(theme: Theme) {
    setPreferences((current) => ({
      ...current,
      themes: current.themes.includes(theme)
        ? current.themes.filter((value) => value !== theme)
        : [...current.themes, theme],
    }));
  }
  async function finish(skip = false) {
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setSkipping(skip);
    setError('');
    try {
      const updated = await createProfileApi(client).update({
        onboardingCompleted: true,
        // 跳过不覆盖账号已有偏好，也不提交尚未确认的选择。
        ...(skip ? {} : { travelPreferences: preferences }),
      });
      try {
        clearOnboardingDraft(sessionStorage, user.id);
      } catch {
        /* 登录资料仍正常更新。 */
      }
      onComplete(updated);
    } catch (failure) {
      setError(profileErrorMessage(failure));
    } finally {
      submitting.current = false;
      setSaving(false);
      setSkipping(false);
    }
  }

  return (
    <main className="preference-onboarding">
      <aside className="onboarding-story" aria-label="欢迎开始旅行">
        <img
          className={`onboarding-scene ${step === 1 ? '' : 'is-visible'}`}
          src={beijingCover}
          alt="暮色中的北京故宫与城市天际线"
        />
        <img
          className={`onboarding-scene ${step === 1 ? 'is-visible' : ''}`}
          src={hangzhouCover}
          alt="杭州西湖的湖光山色"
        />
        <div className="onboarding-story-shade" />
        <div className="onboarding-brand">
          <span className="onboarding-brand-mark" aria-hidden="true">
            行
          </span>
          <strong>{APP_NAME}</strong>
          <span>把日子过成旅程</span>
        </div>
        <div className="onboarding-story-copy">
          <span className="onboarding-small-title">A JOURNEY, YOUR WAY</span>
          <h1>
            把喜欢的风景，
            <br />
            放进行程里。
          </h1>
          <p>
            不必照着别人的清单出发。
            <br />
            从你的喜欢开始，找到自己的旅行方式。
          </p>
          <div className="onboarding-story-rule" />
          <span className="onboarding-story-caption">
            {step === 1 ? '杭州 · 在湖山之间，慢下来' : '北京 · 在日落之前，遇见一座城'}
          </span>
        </div>
        <div className="onboarding-story-bottom">
          <span>为下一次出发，留一点期待。</span>
          <span aria-hidden="true">{step === 1 ? '30° N · 120° E' : '40° N · 116° E'}</span>
        </div>
      </aside>

      <section className="onboarding-panel" aria-label="首次旅行偏好设置">
        <header className="onboarding-topbar">
          <span>很高兴认识你，{user.displayName || '旅行者'}</span>
          <button type="button" disabled={saving} onClick={() => void finish(true)}>
            {skipping ? '正在跳过…' : '暂时跳过'}
            <span aria-hidden="true">↗</span>
          </button>
        </header>
        <div className="onboarding-content">
          <ol className="onboarding-progress" aria-label="设置进度">
            {steps.map((label, i) => (
              <li
                key={label}
                className={i <= step ? 'is-reached' : ''}
                aria-current={i === step ? 'step' : undefined}
              >
                <span>{i < step ? '✓' : `0${i + 1}`}</span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
          <div className="onboarding-heading" key={step}>
            <span className="onboarding-section-label">
              YOUR TRAVEL PROFILE <span>0{step + 1} / 03</span>
            </span>
            <h2 ref={heading} tabIndex={-1}>
              {titles[step]}
            </h2>
            <p>{descriptions[step]}</p>
          </div>

          <fieldset className="onboarding-choices" disabled={saving}>
            <legend className="onboarding-sr-only">
              {steps[step]}
              {step === 0 ? '，可多选' : '，单选'}
            </legend>
            {step === 0 ? (
              <>
                <div className="onboarding-choice-hint">
                  <span>随心选择，可以多选</span>
                  <span role="status" aria-live="polite">
                    {selected.length ? `已选 ${selected.length} 项` : '还没有想法？也可以直接继续'}
                  </span>
                </div>
                <div className="onboarding-theme-grid">
                  {themes.map(({ id, caption, tag }, i) => (
                    <label
                      key={id}
                      className={`onboarding-theme onboarding-theme--${id} ${selected.includes(id) ? 'is-selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(id)}
                        onChange={() => toggleTheme(id)}
                      />
                      <span className="onboarding-theme-top">
                        <span>
                          {`0${i + 1}`} / {tag}
                        </span>
                        <span className="onboarding-check" aria-hidden="true">
                          {selected.includes(id) ? '✓' : ''}
                        </span>
                      </span>
                      <span className="onboarding-theme-art">
                        <TravelIcon name={id} />
                      </span>
                      <span className="onboarding-theme-name">{themeLabels[id]}</span>
                      <span className="onboarding-theme-caption">{caption}</span>
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <div className="onboarding-option-list">
                {(step === 1 ? paces : transports).map(({ id, caption, detail }, i) => {
                  const checked =
                    step === 1 ? preferences.pace === id : preferences.transportMode === id;
                  return (
                    <label key={id} className={`onboarding-option ${checked ? 'is-selected' : ''}`}>
                      <input
                        type="radio"
                        name={step === 1 ? 'pace' : 'transport'}
                        value={id}
                        checked={checked}
                        onChange={() =>
                          setPreferences((current) =>
                            step === 1
                              ? { ...current, pace: id as TravelPreferences['pace'] }
                              : {
                                  ...current,
                                  transportMode: id as TravelPreferences['transportMode'],
                                },
                          )
                        }
                      />
                      <span className="onboarding-option-art">
                        <TravelIcon name={id} />
                      </span>
                      <span className="onboarding-option-text">
                        <span className="onboarding-option-title">
                          {step === 1
                            ? paceLabels[id as keyof typeof paceLabels]
                            : transportLabels[id as keyof typeof transportLabels]}
                          <span>{`0${i + 1}`}</span>
                        </span>
                        <strong>{caption}</strong>
                        <span>{detail}</span>
                      </span>
                      <span className="onboarding-radio" aria-hidden="true" />
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="onboarding-summary" aria-label="当前偏好摘要">
            <span className="onboarding-summary-label">你的旅行底色</span>
            <p>
              {selected.length
                ? selected.map((id) => themeLabels[id]).join(' · ')
                : '保留好奇，不设边界'}
              <span>
                {paceLabels[preferences.pace]}
                <i aria-hidden="true">/</i>
                {transportLabels[preferences.transportMode]}
              </span>
            </p>
          </div>
          {error && (
            <p className="onboarding-error" role="alert">
              {error} 当前选择已保留，可以重试。
            </p>
          )}
          <footer className="onboarding-footer">
            <div>
              <span className="onboarding-footer-note">偏好会用于新行程的默认设置</span>
              <span>之后可在「我的」中随时修改</span>
            </div>
            <div className="onboarding-actions">
              {step > 0 && (
                <button
                  className="onboarding-back"
                  type="button"
                  disabled={saving}
                  onClick={() => go(step - 1)}
                >
                  上一步
                </button>
              )}
              <button
                className="onboarding-next"
                type="button"
                disabled={saving}
                onClick={() => (step < 2 ? go(step + 1) : void finish())}
              >
                {saving ? '正在保存…' : step === 2 ? '开启我的旅程' : '下一步'}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </footer>
          <button
            className="onboarding-switch-account"
            type="button"
            disabled={saving}
            onClick={() => void onSignOut()}
          >
            退出当前账号
          </button>
        </div>
      </section>
    </main>
  );
}
