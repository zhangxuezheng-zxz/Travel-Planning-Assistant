import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { LoginResponse } from '@travel/shared';
import AppShell from './features/shell/AppShell';
import AuthPage from './features/profile/AuthPage';
import { createApiClient } from './lib/api-client';
import { createSessionClient } from './features/trip-create/session-client';
import { tripEntryFromPath, tripEntryPath, type TripEntry } from './features/trip-create';

const auth = createSessionClient();
const PreferenceOnboarding = lazy(() => import('./features/profile/PreferenceOnboarding'));
const SESSION_KEY = 'travel:integration-session';
function persist(session: LoginResponse | null) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 存储不可用时仍可使用内存会话。 */
  }
}

export default function App() {
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [tripEntry, setTripEntry] = useState<TripEntry>(() =>
    tripEntryFromPath(window.location.pathname),
  );
  const navigateTrip = useCallback((entry: TripEntry) => {
    setTripEntry(entry);
    const path = tripEntryPath(entry);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }, []);
  useEffect(() => {
    const pop = () => setTripEntry(tripEntryFromPath(window.location.pathname));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const saved = JSON.parse(
          sessionStorage.getItem(SESSION_KEY) ?? 'null',
        ) as LoginResponse | null;
        if (saved?.accessToken && Date.parse(saved.expiresAt) > Date.now()) {
          const user = await auth.me(saved.accessToken);
          if (active) {
            setSession({ ...saved, user });
            persist({ ...saved, user });
          }
        } else persist(null);
      } catch {
        persist(null);
        if (active) setNotice('无法恢复登录状态，请重新登录；若连接失败，请检查后端服务。');
      } finally {
        if (active) setChecking(false);
      }
    }
    void restore();
    return () => {
      active = false;
    };
  }, []);

  const token = session?.accessToken;
  const expiresAt = session?.expiresAt;
  const getAccessToken = useCallback(
    () => (token && expiresAt && Date.parse(expiresAt) > Date.now() ? token : null),
    [token, expiresAt],
  );
  const apiClient = useMemo(() => createApiClient({ getAccessToken }), [getAccessToken]);
  useEffect(() => {
    if (!expiresAt) return;
    const expired = () => {
      persist(null);
      setSession(null);
      setNotice('登录已过期，请重新登录。');
    };
    const timer = window.setTimeout(expired, Math.max(0, Date.parse(expiresAt) - Date.now()));
    window.addEventListener('travel:unauthenticated', expired);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('travel:unauthenticated', expired);
    };
  }, [expiresAt]);

  async function signOut() {
    if (!token || signingOut) return;
    setSigningOut(true);
    try {
      await auth.logout(token);
      persist(null);
      setSession(null);
      setTripEntry({ view: 'list' });
      try {
        setNotice(sessionStorage.getItem('travel:auth-notice') || '已退出登录。');
        sessionStorage.removeItem('travel:auth-notice');
      } catch {
        setNotice('已退出登录。');
      }
    } catch {
      // 服务器尚未确认撤销，保留界面供重试。
      setNotice('退出未完成，无法连接服务器，请稍后重试。');
    } finally {
      setSigningOut(false);
    }
  }

  if (checking)
    return (
      <main className="trip-login" role="status">
        正在检查登录状态…
      </main>
    );
  if (session && session.user.onboardingCompleted === false)
    return (
      <>
        {notice && (
          <p className="auth-signout-notice" role="alert">
            {notice}
          </p>
        )}
        <Suspense
          fallback={
            <main className="trip-login" role="status">
              正在准备旅行偏好…
            </main>
          }
        >
          <PreferenceOnboarding
            key={session.user.id}
            user={session.user}
            client={apiClient}
            onSignOut={signOut}
            onComplete={(user) => {
              const updated = { ...session, user };
              persist(updated);
              setSession(updated);
              setNotice('');
            }}
          />
        </Suspense>
      </>
    );
  if (session)
    return (
      <>
        {notice && (
          <p className="auth-signout-notice" role="alert">
            {notice}
          </p>
        )}
        <AppShell
          key={session.user.id}
          user={session.user}
          getAccessToken={getAccessToken}
          client={apiClient}
          entry={tripEntry}
          onNavigate={navigateTrip}
          onSignOut={() => {
            void signOut();
          }}
          onUserUpdated={(user) => {
            setSession((current) => {
              if (!current) return null;
              const updated = { ...current, user };
              persist(updated);
              return updated;
            });
          }}
        />
      </>
    );
  return (
    <AuthPage
      notice={notice}
      onAuthenticated={(result) => {
        persist(result);
        setSession(result);
        setNotice('');
      }}
    />
  );
}
