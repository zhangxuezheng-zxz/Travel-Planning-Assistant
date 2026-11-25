import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const cache = new Map();
function load(path) {
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} };
  cache.set(path, module);
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', source)(
    (specifier) => load(resolve(dirname(path), specifier + '.ts')),
    module,
    module.exports,
  );
  return module.exports;
}
const { tripPreferenceDefaults } = load(
  fileURLToPath(new URL('../src/features/profile/travel-preferences.ts', import.meta.url)),
);
const { createSessionClient } = load(
  fileURLToPath(new URL('../src/features/trip-create/session-client.ts', import.meta.url)),
);

test('旅行偏好映射到新行程的六类主题且不修改账号数据', () => {
  const prefs = {
    themes: ['history', 'art', 'local'],
    pace: 'relaxed',
    transportMode: 'walking',
    dailyBudget: 300,
  };
  const defaults = tripPreferenceDefaults(prefs);
  assert.deepEqual(defaults, {
    themes: ['历史文化', '艺术设计', '老街与在地体验'],
    pace: 'relaxed',
    transport: 'walking',
  });
  defaults.themes.pop();
  assert.equal(prefs.themes.length, 3);
  assert.deepEqual(tripPreferenceDefaults(), {
    themes: [],
    pace: 'standard',
    transport: 'transit',
  });
});

test('注册发送验证码，找回和退出请求使用约定的用途、渠道及令牌', async () => {
  const requests = [];
  const client = createSessionClient(async (url, init) => {
    requests.push({ url, ...init, parsed: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ message: 'ok' }) };
  });
  await client.register('verified@example.com', 'Strong-Password-123', '旅行者', '123456');
  await client.code('email', 'verified@example.com', 'register');
  await client.resetPassword('phone', '13800138000', '654321', 'Changed-Password-123');
  await client.logout('signed-session-token');
  assert.deepEqual(requests[0].parsed, {
    email: 'verified@example.com',
    password: 'Strong-Password-123',
    displayName: '旅行者',
    code: '123456',
  });
  assert.equal(requests[1].parsed.purpose, 'register');
  assert.equal(requests[2].parsed.channel, 'phone');
  assert.equal(requests[3].url, '/api/auth/logout');
  assert.equal(requests[3].headers.Authorization, 'Bearer signed-session-token');
});
