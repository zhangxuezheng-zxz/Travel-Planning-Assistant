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
const { readOnboardingDraft, saveOnboardingDraft, clearOnboardingDraft } = load(
  fileURLToPath(new URL('../src/features/profile/onboarding-draft.ts', import.meta.url)),
);

test('首次偏好草稿恢复步骤和选择，账号之间隔离，完成后清理草稿', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const user = {
    id: 'first',
    travelPreferences: { themes: [], pace: 'standard', transportMode: 'transit', dailyBudget: 300 },
  };
  const draft = {
    step: 2,
    preferences: {
      themes: ['art', 'nature'],
      pace: 'relaxed',
      transportMode: 'walking',
      dailyBudget: 999,
    },
  };
  saveOnboardingDraft(storage, user.id, draft);
  const restored = readOnboardingDraft(storage, user);
  assert.equal(restored.step, 2);
  assert.deepEqual(restored.preferences.themes, ['art', 'nature']);
  assert.equal(restored.preferences.dailyBudget, 300, '草稿不覆盖服务器上的预算');
  assert.equal(readOnboardingDraft(storage, { ...user, id: 'second' }).step, 0);
  clearOnboardingDraft(storage, user.id);
  assert.deepEqual(readOnboardingDraft(storage, user).preferences, user.travelPreferences);
});

test('损坏、非法或不可访问的偏好草稿不阻止账号进入引导', () => {
  const user = { id: 'first' };
  for (const value of [
    '{',
    JSON.stringify({ step: 9 }),
    JSON.stringify({
      step: 1,
      preferences: { themes: ['art', 'art'], pace: 'relaxed', transportMode: 'walking' },
    }),
    JSON.stringify({
      step: 1,
      preferences: { themes: ['unknown'], pace: 'relaxed', transportMode: 'walking' },
    }),
  ]) {
    assert.equal(readOnboardingDraft({ getItem: () => value }, user).step, 0);
  }
  const unavailable = {
    getItem: () => {
      throw Error('disabled');
    },
    setItem: () => {
      throw Error('disabled');
    },
    removeItem: () => {
      throw Error('disabled');
    },
  };
  assert.equal(readOnboardingDraft(unavailable, user).step, 0);
  assert.doesNotThrow(() =>
    saveOnboardingDraft(unavailable, user.id, {
      step: 0,
      preferences: { themes: [], pace: 'standard', transportMode: 'transit', dailyBudget: null },
    }),
  );
  assert.doesNotThrow(() => clearOnboardingDraft(unavailable, user.id));
});

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
