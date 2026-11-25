require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createApp } = require('../../dist/app');
const { VerificationDeliveryService } = require('../../dist/auth/verification-delivery.service');
const { ConfigService } = require('../../dist/config/config.service');
const { VerificationService } = require('../../dist/auth/verification.service');

const connectionString = process.env.AUTH_TEST_DATABASE_URL;
test(
  'auth/profile HTTP integration against isolated PostgreSQL',
  { skip: !connectionString },
  async (t) => {
    const parsed = new URL(connectionString);
    assert.match(parsed.pathname, /_test$/, 'Use a dedicated database ending in _test');
    const pool = new Pool({ connectionString });
    const accounts = [];
    let app;
    t.after(async () => {
      if (app) await app.close();
      await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [accounts]);
      await pool.end();
    });
    process.env.DATABASE_URL = connectionString;
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DELIVERY_MODE = 'local';
    process.env.AUTH_TOKEN_SECRET = 'auth-profile-integration-only-secret-32bytes';
    app = await createApp({ logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    async function request(route, body, token, method = 'POST') {
      const response = await fetch(url + '/api' + route, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    function email() {
      const value = randomUUID() + '@auth-test.invalid';
      accounts.push(value);
      return value;
    }
    async function clearLimits() {
      await pool.query('DELETE FROM auth_rate_limits');
    }
    async function code(target, purpose = 'register', channel = 'email', token) {
      const response = await request(
        token ? '/auth/contact/code' : '/auth/code',
        { target, channel, ...(token ? {} : { purpose }) },
        token,
      );
      assert.equal(response.status, 200);
      assert.match(response.body.developmentCode, /^\d{6}$/);
      return response.body.developmentCode;
    }
    async function register(target = email()) {
      const value = await code(target);
      const response = await request('/auth/register', {
        email: target,
        password: 'Strong-Password-123',
        displayName: '旅行者',
        code: value,
      });
      assert.equal(response.status, 201);
      return { ...response.body, email: target, code: value };
    }
    async function me(token) {
      return request('/users/me', undefined, token, 'GET');
    }
    let user;
    await t.test(
      'registration requires code and returns verified identity without password disclosure',
      async () => {
        const target = email();
        const missing = await request('/auth/register', {
          email: target,
          password: 'Strong-Password-123',
          displayName: '测试',
        });
        assert.equal(missing.status, 400);
        user = await register(target);
        assert.equal(user.user.emailVerified, true);
        assert.equal(user.user.password_hash, undefined);
        assert.equal((await me(user.accessToken)).body.id, user.user.id);
        const stored = (
          await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.user.id])
        ).rows[0];
        assert.match(stored.password_hash, /^scrypt\$/);
        assert.ok(!stored.password_hash.includes('Strong-Password-123'));
      },
    );
    await t.test('used and wrong-purpose codes cannot register an account', async () => {
      assert.equal(
        (
          await request('/auth/register', {
            email: user.email,
            password: 'Strong-Password-123',
            displayName: '重复',
            code: user.code,
          })
        ).body.code,
        'INVALID_CODE',
      );
      const target = email();
      const value = await code(target, 'reset-password');
      assert.equal(
        (
          await request('/auth/register', {
            email: target,
            password: 'Strong-Password-123',
            displayName: '测试',
            code: value,
          })
        ).body.code,
        'INVALID_CODE',
      );
    });
    await t.test(
      'wrong-code attempts commit, lock after five, and expiry is enforced',
      async () => {
        const target = email();
        const value = await code(target);
        const wrong = value === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i++)
          assert.equal(
            (
              await request('/auth/register', {
                email: target,
                password: 'Strong-Password-123',
                displayName: '测试',
                code: wrong,
              })
            ).body.code,
            'INVALID_CODE',
          );
        assert.equal(
          (
            await request('/auth/register', {
              email: target,
              password: 'Strong-Password-123',
              displayName: '测试',
              code: value,
            })
          ).body.code,
          'INVALID_CODE',
        );
        const other = email();
        const expired = await code(other);
        await pool.query(
          "UPDATE auth_challenges SET expires_at = now() - interval '1 second' WHERE consumed_at IS NULL",
        );
        assert.equal(
          (
            await request('/auth/register', {
              email: other,
              password: 'Strong-Password-123',
              displayName: '测试',
              code: expired,
            })
          ).body.code,
          'INVALID_CODE',
        );
      },
    );
    await t.test(
      'resending is throttled and challenge storage never contains plaintext code',
      async () => {
        const target = email();
        const value = await code(target);
        const retry = await request('/auth/code', {
          target,
          channel: 'email',
          purpose: 'register',
        });
        assert.equal(retry.status, 429);
        const stored = (
          await pool.query('SELECT digest FROM auth_challenges WHERE consumed_at IS NULL')
        ).rows;
        assert.ok(stored.every((row) => row.digest.length === 64 && row.digest !== value));
      },
    );
    await t.test('concurrent code consumption creates exactly one account', async () => {
      const target = email();
      const value = await code(target);
      const body = {
        email: target,
        password: 'Strong-Password-123',
        displayName: '并发测试',
        code: value,
      };
      const results = await Promise.all([
        request('/auth/register', body),
        request('/auth/register', body),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) AS n FROM users WHERE email=$1', [target])).rows[0].n,
        ),
        1,
      );
    });
    await t.test(
      'profile fields persist, identity injection is rejected and other accounts are isolated',
      async () => {
        const other = await register();
        const patch = {
          displayName: '北京慢游',
          bio: '喜欢博物馆与街巷',
          homeCity: '北京',
          travelPreferences: {
            themes: ['history', 'local'],
            pace: 'relaxed',
            transportMode: 'walking',
            dailyBudget: 300,
          },
        };
        const updated = await request('/users/me', patch, user.accessToken, 'PATCH');
        assert.equal(updated.status, 200);
        const fresh = (await me(user.accessToken)).body;
        for (const key of Object.keys(patch)) assert.deepEqual(fresh[key], patch[key]);
        assert.notEqual((await me(other.accessToken)).body.displayName, patch.displayName);
        assert.equal(
          (await request('/users/me', { email: other.email }, user.accessToken, 'PATCH')).status,
          400,
        );
        assert.equal(
          (
            await request(
              '/users/me',
              { travelPreferences: { ...patch.travelPreferences, dailyBudget: -1 } },
              user.accessToken,
              'PATCH',
            )
          ).status,
          400,
        );
      },
    );
    await clearLimits();
    await t.test(
      'legacy accounts must verify email using both code and original password',
      async () => {
        const legacy = await register();
        await pool.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [legacy.user.id]);
        assert.equal((await me(legacy.accessToken)).status, 401);
        assert.equal(
          (await request('/auth/login', { email: legacy.email, password: 'Strong-Password-123' }))
            .body.code,
          'EMAIL_VERIFICATION_REQUIRED',
        );
        const value = await code(legacy.email, 'verify-email');
        assert.equal(
          (
            await request('/auth/verify-email', {
              email: legacy.email,
              password: 'Wrong-Password-123',
              code: value,
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request('/auth/verify-email', {
              email: legacy.email,
              password: 'Strong-Password-123',
              code: value,
            })
          ).status,
          200,
        );
        assert.equal(
          (await request('/auth/login', { email: legacy.email, password: 'Strong-Password-123' }))
            .status,
          200,
        );
      },
    );
    await t.test('password reset revokes all devices, pending codes and code replay', async () => {
      const second = await request('/auth/login', {
        email: user.email,
        password: 'Strong-Password-123',
      });
      const value = await code(user.email, 'reset-password');
      const pending = await code(user.email, 'verify-email');
      const reset = await request('/auth/reset-password', {
        channel: 'email',
        target: user.email,
        code: value,
        newPassword: 'New-Password-12345',
      });
      assert.equal(reset.status, 200);
      assert.equal((await me(user.accessToken)).status, 401);
      assert.equal((await me(second.body.accessToken)).status, 401);
      assert.equal(
        (
          await request('/auth/reset-password', {
            channel: 'email',
            target: user.email,
            code: value,
            newPassword: 'Another-Password-123',
          })
        ).body.code,
        'INVALID_CODE',
      );
      assert.equal(
        (
          await request('/auth/verify-email', {
            email: user.email,
            password: 'New-Password-12345',
            code: pending,
          })
        ).body.code,
        'INVALID_CODE',
      );
      assert.equal(
        (await request('/auth/login', { email: user.email, password: 'Strong-Password-123' }))
          .status,
        401,
      );
      user = {
        ...user,
        ...(await request('/auth/login', { email: user.email, password: 'New-Password-12345' }))
          .body,
      };
      assert.equal((await me(user.accessToken)).status, 200);
    });
    await t.test(
      'phone binding requires password, supports login and recovery, invalidates old sessions',
      async () => {
        const phone = '199' + String(Date.now()).slice(-8);
        const value = await code(phone, undefined, 'phone', user.accessToken);
        const wrong = await request(
          '/auth/contact',
          { channel: 'phone', target: phone, code: value, currentPassword: 'Wrong-Password-123' },
          user.accessToken,
        );
        assert.equal(wrong.body.code, 'INCORRECT_PASSWORD');
        assert.equal(
          (
            await request(
              '/auth/contact',
              {
                channel: 'phone',
                target: phone,
                code: value,
                currentPassword: 'New-Password-12345',
              },
              user.accessToken,
            )
          ).status,
          200,
        );
        assert.equal((await me(user.accessToken)).status, 401);
        const logged = await request('/auth/login', {
          email: phone,
          password: 'New-Password-12345',
        });
        assert.equal(logged.status, 200);
        assert.equal(logged.body.user.phoneVerified, true);
        const reset = await code(phone, 'reset-password', 'phone');
        assert.equal(
          (
            await request('/auth/reset-password', {
              channel: 'phone',
              target: phone,
              code: reset,
              newPassword: 'Phone-Reset-Password-123',
            })
          ).status,
          200,
        );
        const fresh = await request('/auth/login', {
          email: user.email,
          password: 'Phone-Reset-Password-123',
        });
        user = { ...user, ...fresh.body };
      },
    );
    await t.test('logout revokes the server session and invalidates a copied token', async () => {
      assert.equal((await request('/auth/logout', {}, user.accessToken)).status, 200);
      assert.equal((await me(user.accessToken)).status, 401);
    });
    await clearLimits();
    await t.test(
      'binding codes belong to their requesting user and changing email revokes the old identity',
      async () => {
        const owner = await register();
        const other = await register();
        const replacement = email();
        const value = await code(replacement, undefined, 'email', owner.accessToken);
        const body = {
          channel: 'email',
          target: replacement,
          code: value,
          currentPassword: 'Strong-Password-123',
        };
        assert.equal(
          (await request('/auth/contact', body, other.accessToken)).body.code,
          'INVALID_CODE',
        );
        assert.equal((await request('/auth/contact', body, owner.accessToken)).status, 200);
        assert.equal((await me(owner.accessToken)).status, 401);
        assert.equal(
          (await request('/auth/login', { email: owner.email, password: 'Strong-Password-123' }))
            .status,
          401,
        );
        assert.equal(
          (await request('/auth/login', { email: replacement, password: 'Strong-Password-123' }))
            .body.user.emailVerified,
          true,
        );
        assert.equal((await me(other.accessToken)).status, 200);
      },
    );
    await t.test(
      'password changes and phone removal require current password and revoke every old token',
      async () => {
        const owner = await register();
        const phone = '198' + String(Date.now()).slice(-8);
        const value = await code(phone, undefined, 'phone', owner.accessToken);
        assert.equal(
          (
            await request(
              '/auth/contact',
              {
                channel: 'phone',
                target: phone,
                code: value,
                currentPassword: 'Strong-Password-123',
              },
              owner.accessToken,
            )
          ).status,
          200,
        );
        const first = (
          await request('/auth/login', { email: phone, password: 'Strong-Password-123' })
        ).body.accessToken;
        assert.equal(
          (
            await request(
              '/auth/password',
              { currentPassword: 'wrong-password', newPassword: 'Changed-Password-123' },
              first,
            )
          ).body.code,
          'INCORRECT_PASSWORD',
        );
        assert.equal(
          (
            await request(
              '/auth/password',
              { currentPassword: 'Strong-Password-123', newPassword: 'Changed-Password-123' },
              first,
            )
          ).status,
          200,
        );
        assert.equal((await me(first)).status, 401);
        const second = (
          await request('/auth/login', { email: owner.email, password: 'Changed-Password-123' })
        ).body.accessToken;
        assert.equal(
          (
            await request(
              '/auth/contact/remove-phone',
              { currentPassword: 'Changed-Password-123' },
              second,
            )
          ).status,
          200,
        );
        assert.equal((await me(second)).status, 401);
        assert.equal(
          (await request('/auth/login', { email: phone, password: 'Changed-Password-123' })).status,
          401,
        );
        const final = (
          await request('/auth/login', { email: owner.email, password: 'Changed-Password-123' })
        ).body;
        assert.equal(final.user.phone, null);
      },
    );
    await t.test(
      'login racing password reset cannot leave a valid session from the old password',
      async () => {
        const owner = await register();
        const value = await code(owner.email, 'reset-password');
        const [login, reset] = await Promise.all([
          request('/auth/login', { email: owner.email, password: 'Strong-Password-123' }),
          request('/auth/reset-password', {
            channel: 'email',
            target: owner.email,
            code: value,
            newPassword: 'Raced-Password-123',
          }),
        ]);
        assert.equal(reset.status, 200);
        assert.ok([200, 401].includes(login.status));
        if (login.status === 200) assert.equal((await me(login.body.accessToken)).status, 401);
        assert.equal((await me(owner.accessToken)).status, 401);
        assert.equal(
          (await request('/auth/login', { email: owner.email, password: 'Raced-Password-123' }))
            .status,
          200,
        );
      },
    );
    await t.test('expired, tampered and sessionless signed tokens are rejected', async () => {
      const owner = await register();
      const pieces = owner.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString());
      pieces[1] = Buffer.from(JSON.stringify({ ...claims, sub: randomUUID() })).toString(
        'base64url',
      );
      assert.equal((await me(pieces.join('.'))).status, 401);
      await pool.query(
        "UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE user_id=$1",
        [owner.user.id],
      );
      assert.equal((await me(owner.accessToken)).status, 401);
    });
    await clearLimits();
    await t.test(
      'unknown accounts receive the same request message but cannot reset; legacy unverified contacts cannot recover',
      async () => {
        const target = email();
        const value = await code(target, 'reset-password');
        const unknown = await request('/auth/reset-password', {
          channel: 'email',
          target,
          code: value,
          newPassword: 'New-Password-12345',
        });
        assert.equal(unknown.body.code, 'INVALID_CODE');
        const legacy = await register();
        await pool.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [legacy.user.id]);
        const unverified = await code(legacy.email, 'reset-password');
        assert.equal(
          (
            await request('/auth/reset-password', {
              channel: 'email',
              target: legacy.email,
              code: unverified,
              newPassword: 'New-Password-12345',
            })
          ).body.code,
          'INVALID_CODE',
        );
      },
    );
    await t.test(
      'failed provider delivery never leaves a usable challenge, and provider responses omit dev codes',
      async () => {
        const delivery = app.get(VerificationDeliveryService);
        const original = delivery.send.bind(delivery);
        delivery.send = async () => {
          throw new Error('simulated delivery failure');
        };
        const before = Number(
          (await pool.query('SELECT count(*) AS n FROM auth_challenges')).rows[0].n,
        );
        assert.equal(
          (await request('/auth/code', { channel: 'email', target: email(), purpose: 'register' }))
            .status,
          500,
        );
        assert.equal(
          Number((await pool.query('SELECT count(*) AS n FROM auth_challenges')).rows[0].n),
          before,
        );
        delivery.send = original;
        const settings = app.get(ConfigService).values.verification;
        settings.mode = 'provider';
        settings.smtpHost = 'example.invalid';
        settings.smtpFrom = 'test@example.invalid';
        delivery.send = async () => {};
        const response = await request('/auth/code', {
          channel: 'email',
          target: email(),
          purpose: 'register',
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.developmentCode, undefined);
        settings.mode = 'local';
        delivery.send = original;
      },
    );
    await t.test(
      'persistent limits reject distributed password guessing for the same account',
      async () => {
        await clearLimits();
        const verification = app.get(VerificationService);
        for (let i = 0; i < 12; i++) await verification.limit('integration', 'same-account', 12);
        await assert.rejects(
          verification.limit('integration', 'same-account', 12),
          (failure) => failure.getStatus() === 429,
        );
      },
    );
  },
);
