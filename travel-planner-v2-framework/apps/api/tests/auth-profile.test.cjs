require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config/config.service');
const { normalizeContact, VerificationService } = require('../dist/auth/verification.service');
const { validateProfile } = require('../dist/users/profile-validation');
const { VerificationDeliveryService } = require('../dist/auth/verification-delivery.service');

test('local verification requires explicit development/test environment and stable production secret', () => {
  const base = { DATABASE_URL: 'postgres://test:test@localhost/test', AUTH_DELIVERY_MODE: 'local' };
  for (const NODE_ENV of ['production', '', undefined])
    assert.throws(() => readConfig({ ...base, NODE_ENV }));
  const values = readConfig({ ...base, NODE_ENV: 'test' });
  assert.equal(values.verification.mode, 'local');
  const verifier = new VerificationService({}, { values }, {});
  assert.doesNotThrow(() => verifier.assertLocalAccess('127.0.0.1'));
  assert.throws(() => verifier.assertLocalAccess('192.168.1.10'));
  assert.throws(
    () => readConfig({ DATABASE_URL: base.DATABASE_URL, NODE_ENV: 'production' }),
    /AUTH_TOKEN_SECRET/,
  );
});

test('email and phone normalization reject malformed contacts', () => {
  assert.equal(normalizeContact('email', ' TEST@Example.com '), 'test@example.com');
  assert.equal(normalizeContact('phone', '138-0013-8000'), '+8613800138000');
  for (const value of ['abc', 'a@b', 'a b@example.com'])
    assert.throws(() => normalizeContact('email', value));
  for (const value of ['123', '+12025550123', '12800138000'])
    assert.throws(() => normalizeContact('phone', value));
});

test('profile validation rejects identity injection, invalid preferences and invalid budgets', () => {
  const prefs = {
    themes: ['history'],
    pace: 'relaxed',
    transportMode: 'transit',
    dailyBudget: null,
  };
  assert.deepEqual(validateProfile({ bio: '', travelPreferences: prefs }), {
    bio: '',
    travelPreferences: prefs,
  });
  for (const body of [
    {},
    { email: 'injected@example.com' },
    { phoneVerified: true },
    { onboardingCompleted: false },
    { onboardingCompleted: 'true' },
    { onboardingCompleted: null },
    { bio: 'x'.repeat(301) },
    { travelPreferences: { ...prefs, themes: ['history', 'history'] } },
    { travelPreferences: { ...prefs, themes: ['unknown'] } },
    { travelPreferences: { ...prefs, pace: 'fast' } },
    { travelPreferences: { ...prefs, dailyBudget: -1 } },
    { travelPreferences: { ...prefs, dailyBudget: 2.5 } },
    { travelPreferences: { ...prefs, dailyBudget: '100' } },
    { travelPreferences: { ...prefs, admin: true } },
  ])
    assert.throws(() => validateProfile(body));
});

test('unconfigured providers fail explicitly rather than pretending codes were sent', async () => {
  const values = readConfig({ DATABASE_URL: 'postgres://test:test@localhost/test' });
  const delivery = new VerificationDeliveryService({ values });
  for (const channel of ['email', 'phone']) {
    await assert.rejects(
      delivery.send(channel, 'unused', '123456'),
      (error) => error.code === 'DELIVERY_NOT_CONFIGURED' && error.getStatus() === 503,
    );
  }
});
