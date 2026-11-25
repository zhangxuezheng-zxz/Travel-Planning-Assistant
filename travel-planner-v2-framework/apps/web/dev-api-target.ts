export const SHARED_TEST_API_ORIGIN = 'https://124.220.224.77';

/** 共享模式只使用公共接口配置，避免个人 .env 把它指回本机。 */
export function resolveDevApiTarget(mode: string, env: Record<string, string>): string {
  if (mode === 'shared') {
    const origin = env.SHARED_API_PROXY_TARGET?.trim() || SHARED_TEST_API_ORIGIN;
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
      throw new Error(
        'SHARED_API_PROXY_TARGET must be an HTTPS origin without credentials or a path',
      );
    }
    return origin;
  }
  return env.API_PROXY_TARGET || `http://127.0.0.1:${env.PORT || '3000'}`;
}
