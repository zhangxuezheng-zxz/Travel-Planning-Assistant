require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool, Client } = require('pg');
const { ServiceUnavailableException } = require('@nestjs/common');
const { createApp } = require('../../dist/app');
const { AmapLocationService } = require('../../dist/footprints/amap-location.service');
const { seedB } = require('../../scripts/seed-b.cjs');
const databaseUrl = process.env.TRIP_TEST_DATABASE_URL;

test(
  'trip activities and curated additions persist over real HTTP/PostgreSQL',
  { skip: !databaseUrl },
  async (t) => {
    assert.match(new URL(databaseUrl).pathname, /_test$/);
    const pool = new Pool({ connectionString: databaseUrl });
    const accounts = [];
    let app;
    t.after(async () => {
      if (app) await app.close();
      await pool.query('DELETE FROM users WHERE email=ANY($1::text[])', [accounts]);
      await pool.end();
    });
    const seed = new Client({ connectionString: databaseUrl });
    await seed.connect();
    try {
      await seedB(seed);
    } finally {
      await seed.end();
    }
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      AUTH_TOKEN_SECRET: 'trip-activity-integration-only-secret-32bytes',
      AMAP_WEB_SERVICE_KEY: '',
      B_LLM_ENABLED: 'false',
    });
    app = await createApp({ logger: false, abortOnError: false });
    const amap = app.get(AmapLocationService);
    const city = (
      await pool.query(
        'SELECT city_id FROM places GROUP BY city_id HAVING count(*)>=2 ORDER BY city_id LIMIT 1',
      )
    ).rows[0].city_id;
    const adcode = (await pool.query('SELECT adcode FROM destinations WHERE id=$1', [city])).rows[0]
      .adcode;
    const places = (
      await pool.query(
        'SELECT id,suggested_duration_minutes FROM places WHERE city_id=$1 ORDER BY suggested_duration_minutes,id',
        [city],
      )
    ).rows;
    let searches = 0,
      resolves = 0;
    const location = {
      poiId: 'POI_TEST',
      name: '测试咖啡馆',
      address: '测试地址',
      longitude: 120.15,
      latitude: 30.24,
      coordinateSystem: 'GCJ-02',
      cityAdcode: adcode,
      cityName: '测试城市',
      provinceName: null,
      provinceAdcode: null,
    };
    amap.searchPlaces = async (keyword, region) => {
      searches++;
      assert.equal(region, adcode);
      return [location];
    };
    amap.resolve = async (_lon, _lat, _system, poiId) => {
      resolves++;
      if (poiId === 'FAIL') throw new ServiceUnavailableException('Provider unavailable');
      return {
        poiId,
        placeName: location.name,
        placeAddress: location.address,
        longitude: location.longitude,
        latitude: location.latitude,
        cityAdcode: poiId === 'OTHER' ? '990100' : adcode,
      };
    };
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function request(path, body, token, method = 'POST') {
      const response = await fetch(base + '/api' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }
    async function register() {
      const email = randomUUID() + '@trip-test.invalid';
      accounts.push(email);
      const result = await request('/auth/register', {
        email,
        password: 'Strong-Travel-Password-2026',
        displayName: '活动测试',
      });
      assert.equal(result.status, 201);
      return result.body;
    }
    const owner = await register(),
      other = await register();
    const token = owner.accessToken;
    let trip;
    async function plan() {
      let result = await request('/trips', { title: '活动持久化测试', cityId: city }, token);
      assert.equal(result.status, 201);
      let current = result.body;
      result = await request(
        '/trips/' + current.id,
        {
          expectedRevision: current.revision,
          planningInput: {
            startDate: '2026-12-01',
            endDate: '2026-12-03',
            pace: 'standard',
            transportMode: 'walking',
            themes: [],
          },
        },
        token,
        'PATCH',
      );
      assert.equal(result.status, 200);
      current = result.body;
      result = await request(
        '/trips/' + current.id + '/selections',
        { expectedRevision: current.revision, placeIds: [places[0].id] },
        token,
        'PUT',
      );
      assert.equal(result.status, 200);
      current = result.body;
      const proposal = await request('/recommendations/itinerary', current.planningInput, token);
      assert.equal(proposal.status, 200);
      result = await request(
        '/trips/' + current.id + '/apply-proposal',
        { expectedRevision: current.revision, proposalId: proposal.body.proposalId },
        token,
      );
      assert.equal(result.status, 200);
      return result.body;
    }
    function input(overrides = {}) {
      return {
        expectedRevision: trip.revision,
        title: '咖啡小憩',
        notes: '靠窗的位置',
        date: '2026-12-01',
        startTime: '19:00',
        durationMinutes: 60,
        poiId: 'POI_TEST',
        ...overrides,
      };
    }
    async function fresh() {
      const result = await request('/trips/' + trip.id, undefined, token, 'GET');
      assert.equal(result.status, 200);
      return result.body;
    }
    const countsBefore = Number((await pool.query('SELECT count(*) AS n FROM places')).rows[0].n);
    trip = await plan();
    let activity;

    await t.test('external search is scoped to owned planned trip and selected city', async () => {
      const result = await request(
        '/trips/' + trip.id + '/activity-locations?keywords=' + encodeURIComponent('咖啡'),
        undefined,
        token,
        'GET',
      );
      assert.equal(result.status, 200);
      assert.equal(result.body[0].poiId, 'POI_TEST');
      assert.equal(
        (
          await request(
            '/trips/' + trip.id + '/activity-locations?keywords=x',
            undefined,
            other.accessToken,
            'GET',
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            '/trips/' + trip.id + '/activity-locations?keywords=x',
            undefined,
            undefined,
            'GET',
          )
        ).status,
        401,
      );
      assert.equal(searches, 1);
    });
    await t.test(
      'activity saves verified POI coordinates and remains outside scenic selections',
      async () => {
        const result = await request('/trips/' + trip.id + '/activities', input(), token);
        assert.equal(result.status, 200);
        trip = result.body;
        activity = trip.activities[0];
        assert.equal(activity.source, 'amap');
        assert.equal(activity.placeName, location.name);
        assert.equal(activity.coordinates.longitude, location.longitude);
        assert.deepEqual(trip.planningInput.selectedPlaceIds, [places[0].id]);
        assert.equal(
          Number((await pool.query('SELECT count(*) AS n FROM places')).rows[0].n),
          countsBefore,
        );
        assert.deepEqual((await fresh()).activities, trip.activities);
        const saved = await request(
          '/trips/' + trip.id + '/schedule',
          { expectedRevision: trip.revision, days: trip.days },
          token,
          'PUT',
        );
        assert.equal(saved.status, 200);
        trip = saved.body;
        assert.equal(trip.activities[0].id, activity.id);
      },
    );
    await t.test(
      'edit persists notes and dates, while overlaps, invented coordinates and other cities fail atomically',
      async () => {
        const initialResolves = resolves;
        const changed = await request(
          '/trips/' + trip.id + '/activities/' + activity.id,
          input({ date: '2026-12-02', startTime: '13:00', notes: '改到第二天下午' }),
          token,
          'PATCH',
        );
        assert.equal(changed.status, 200);
        trip = changed.body;
        activity = trip.activities[0];
        assert.equal(resolves, initialResolves);
        assert.equal((await fresh()).activities[0].notes, '改到第二天下午');
        for (const [body, status] of [
          [input({ startTime: '09:00', date: '2026-12-01' }), 422],
          [input({ date: '2026-12-04' }), 400],
          [input({ coordinates: { longitude: 0, latitude: 0 } }), 400],
          [input({ poiId: 'OTHER' }), 400],
          [input({ poiId: 'FAIL' }), 503],
        ]) {
          assert.equal(
            (await request('/trips/' + trip.id + '/activities', body, token)).status,
            status,
          );
          assert.equal((await fresh()).revision, trip.revision);
        }
        const moved = structuredClone(trip.days);
        const item = moved[0].items.shift();
        item.startTime = '13:00';
        moved[1].items.push(item);
        const conflict = await request(
          '/trips/' + trip.id + '/schedule',
          { expectedRevision: trip.revision, days: moved },
          token,
          'PUT',
        );
        assert.equal(conflict.status, 422);
        assert.equal(conflict.body.code, 'ACTIVITY_TIME_CONFLICT');
        assert.deepEqual((await fresh()).days, trip.days);
        assert.equal(
          (
            await request(
              '/trips/' + trip.id + '/activities/' + activity.id,
              input(),
              other.accessToken,
              'PATCH',
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      'activity completion persists without generating a database scenic footprint',
      async () => {
        const key = `${activity.date}:${activity.id}`;
        const count = async () =>
          Number(
            (
              await pool.query('SELECT count(*) AS n FROM footprint_entries WHERE owner_id=$1', [
                owner.user.id,
              ])
            ).rows[0].n,
          );
        const before = await count();
        const saved = await request(
          '/trips/' + trip.id + '/state',
          { visited: [key] },
          token,
          'PUT',
        );
        assert.equal(saved.status, 200);
        assert.deepEqual(saved.body.visited, [key]);
        assert.deepEqual(saved.body.footprints, {});
        const restored = await request('/trips/' + trip.id + '/state', undefined, token, 'GET');
        assert.deepEqual(restored.body.visited, [key]);
        assert.equal(await count(), before);
        assert.equal(
          (await request('/trips/' + trip.id + '/state', { visited: [] }, token, 'PUT')).status,
          200,
        );
      },
    );
    await t.test(
      'concurrent additions accept one revision and reject stale mutations',
      async () => {
        const result = await Promise.all([
          request('/trips/' + trip.id + '/activities', input({ startTime: '20:00' }), token),
          request('/trips/' + trip.id + '/activities', input({ startTime: '22:00' }), token),
        ]);
        assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
        trip = result.find((r) => r.status === 200).body;
        assert.equal(trip.activities.length, 2);
        assert.equal(
          (
            await request(
              '/trips/' +
                trip.id +
                '/activities/' +
                activity.id +
                '?expectedRevision=' +
                (trip.revision - 1),
              undefined,
              token,
              'DELETE',
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await request(
              '/trips/' +
                trip.id +
                '/activities/' +
                activity.id +
                '?expectedRevision=' +
                trip.revision,
              undefined,
              other.accessToken,
              'DELETE',
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      'curated addition uses database identity without external lookup and preserves activities',
      async () => {
        const before = resolves;
        const added = await request(
          '/trips/' + trip.id + '/scenic-stops',
          { expectedRevision: trip.revision, placeId: places[1].id, date: '2026-12-03' },
          token,
        );
        assert.equal(added.status, 200);
        trip = added.body;
        assert.equal(resolves, before);
        assert.equal(trip.activities.length, 2);
        assert.equal(trip.planningInput.selectedPlaceIds.length, 2);
        assert.equal(
          (
            await request(
              '/trips/' + trip.id + '/scenic-stops',
              { expectedRevision: trip.revision, placeId: randomUUID(), date: '2026-12-03' },
              token,
            )
          ).status,
          400,
        );
        const removed = await request(
          '/trips/' +
            trip.id +
            '/scenic-stops/' +
            places[1].id +
            '?expectedRevision=' +
            trip.revision,
          undefined,
          token,
          'DELETE',
        );
        assert.equal(removed.status, 200);
        trip = removed.body;
        assert.equal(trip.activities.length, 2);
      },
    );
    await t.test(
      'removal is persistent and deleting a trip cascades only its own activities',
      async () => {
        let result = await request(
          '/trips/' + trip.id + '/activities/' + activity.id + '?expectedRevision=' + trip.revision,
          undefined,
          token,
          'DELETE',
        );
        assert.equal(result.status, 200);
        trip = result.body;
        assert.equal((await fresh()).activities.length, 1);
        const response = await fetch(
          base + '/api/trips/' + trip.id + '?expectedRevision=' + trip.revision,
          { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } },
        );
        assert.equal(response.status, 204);
        assert.equal(
          Number(
            (
              await pool.query('SELECT count(*) AS n FROM trip_activities WHERE trip_id=$1', [
                trip.id,
              ])
            ).rows[0].n,
          ),
          0,
        );
        trip = await plan();
        result = await request('/trips/' + trip.id + '/activities', input(), token);
        assert.equal(result.status, 200);
        trip = result.body;
        result = await request(
          '/trips/' + trip.id,
          { expectedRevision: trip.revision, planningInput: { pace: 'intensive' } },
          token,
          'PATCH',
        );
        assert.equal(result.status, 409);
        result = await request(
          '/trips/' + trip.id,
          {
            expectedRevision: trip.revision,
            planningInput: { pace: 'intensive' },
            acknowledgeScheduleReset: true,
          },
          token,
          'PATCH',
        );
        assert.equal(result.status, 200);
        trip = result.body;
        assert.equal(trip.status, 'draft');
        assert.deepEqual(trip.activities, []);
        assert.equal(
          (await request('/trips/' + trip.id + '/activities', input(), token)).status,
          422,
        );
      },
    );
  },
);
