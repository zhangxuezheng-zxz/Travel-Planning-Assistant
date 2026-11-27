import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../src/features/trip-create/trip-map-routes.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const {
  buildDays,
  canCompareRoutes,
  formatRouteSummary,
  navigationUrl,
  savedOrder,
  summarizeRoutes,
  transitSummary,
  outingProgress,
} = mod.exports;

test('出游模式包含只有活动的日期，完成后正常推进而不是提示空行程', () => {
  const activity = {
    id: 'activity',
    title: '午餐',
    date: '2026-12-01',
    startTime: '12:00',
    durationMinutes: 60,
    poiId: 'POI',
    notes: '',
    placeName: '餐厅',
    address: '',
    coordinates: { longitude: 116, latitude: 40, coordinateSystem: 'GCJ-02' },
    source: 'amap',
  };
  const trip = {
    planningInput: { cityId: 'city', transportMode: 'walking' },
    days: [{ date: activity.date, items: [] }],
    activities: [activity],
  };
  const day = buildDays(trip, [], savedOrder(trip))[0];
  const pending = outingProgress(day, new Set());
  assert.equal(pending.count, 1);
  assert.equal(pending.completed, 0);
  assert.equal(pending.next.activity.id, activity.id);
  const finished = outingProgress(day, new Set([`${activity.date}:${activity.id}`]));
  assert.equal(finished.count, 1);
  assert.equal(finished.completed, 1);
  assert.equal(finished.next, undefined);
});

test('活动按时间合并到地图站点，重连前后路线但不混入数据库景点顺序', () => {
  const trip = {
    planningInput: { cityId: 'city', transportMode: 'walking' },
    days: [
      {
        date: '2026-12-01',
        items: [
          { placeId: 'a', position: 0, startTime: '09:00', durationMinutes: 60 },
          {
            placeId: 'b',
            position: 1,
            startTime: '14:00',
            durationMinutes: 60,
            travelMinutesFromPrevious: 30,
            travelTimeSource: 'estimate',
          },
        ],
      },
    ],
    activities: [
      {
        id: 'activity',
        title: '午餐',
        notes: '备注',
        date: '2026-12-01',
        startTime: '12:00',
        durationMinutes: 60,
        poiId: 'POI',
        placeName: '餐厅',
        address: '地址',
        coordinates: { longitude: 116, latitude: 40, coordinateSystem: 'GCJ-02' },
        source: 'amap',
      },
    ],
  };
  const order = savedOrder(trip);
  assert.deepEqual(order[0].placeIds, ['a', 'b']);
  const day = buildDays(trip, [{ id: 'a' }, { id: 'b' }], order)[0];
  assert.deepEqual(
    day.stops.map((item) => item.placeId),
    ['a', 'activity', 'b'],
  );
  assert.equal(day.stops[1].place.source, 'amap');
  assert.equal(day.stops[1].activity.title, '午餐');
  assert.equal(day.stops[1].number, 2);
  assert.deepEqual(
    day.legs.map((leg) => [leg.from.placeId, leg.to.placeId]),
    [
      ['a', 'activity'],
      ['activity', 'b'],
    ],
  );
  assert.equal(day.stops[2].travelMinutesFromPrevious, 0, '旧景点间交通预留不能用于活动后的新路段');
  const moved = {
    ...trip,
    activities: [
      {
        ...trip.activities[0],
        coordinates: { longitude: 117, latitude: 40, coordinateSystem: 'GCJ-02' },
      },
    ],
  };
  assert.notEqual(
    buildDays(moved, [{ id: 'a' }, { id: 'b' }], order)[0].legs[0].key,
    day.legs[0].key,
  );
  assert.deepEqual(
    trip.days[0].items.map((item) => item.placeId),
    ['a', 'b'],
  );
});

test('调序只变更相关的有向路段，单景点日期保持独立', () => {
  const trip = {
    planningInput: { transportMode: 'walking' },
    days: [
      {
        date: '2026-11-20',
        items: ['a', 'b', 'c', 'd'].map((placeId, position) => ({ placeId, position })),
      },
      { date: '2026-11-21', items: [{ placeId: 'e', position: 0 }] },
    ],
  };
  const places = 'abcde'.split('').map((id) => ({ id }));
  const original = buildDays(trip, places, savedOrder(trip));
  const revised = buildDays(trip, places, [
    { date: '2026-11-20', placeIds: ['a', 'b', 'd', 'c'] },
    { date: '2026-11-21', placeIds: ['e'] },
  ]);
  assert.equal(original[0].legs[0].key, revised[0].legs[0].key);
  assert.notEqual(original[0].legs[1].key, revised[0].legs[1].key);
  assert.notEqual(original[0].legs[2].key, revised[0].legs[2].key);
  assert.equal(revised[1].legs.length, 0);
  assert.equal(revised[1].stops[0].number, 5);
});

test('调序耗时仅比较完整的高德结果，缺失路段不计为零', () => {
  const legs = [{ key: 'a' }, { key: 'b' }];
  const routes = new Map([['a', { source: 'provider', durationMinutes: 12 }]]);
  const pending = summarizeRoutes(legs, routes);
  assert.equal(pending.pending, 1);
  assert.match(formatRouteSummary(pending, 'walking'), /1 段已查，约 12 分钟/);
  assert.equal(canCompareRoutes(pending), false);
  routes.set('b', { source: 'estimate', durationMinutes: 8 });
  const estimated = summarizeRoutes(legs, routes);
  assert.match(formatRouteSummary(estimated, 'walking'), /20 分钟（含估算）/);
  assert.equal(canCompareRoutes(estimated), false);
  routes.set('b', { source: 'provider', durationMinutes: 9 });
  assert.equal(canCompareRoutes(summarizeRoutes(legs, routes)), true);
});

test('高德导航编码景点名并携带对应出行方式', () => {
  const url = new URL(
    navigationUrl(
      { name: '西湖·花港观鱼', coordinates: { longitude: 120.1, latitude: 30.2 } },
      'transit',
    ),
  );
  assert.equal(url.origin, 'https://uri.amap.com');
  assert.equal(url.searchParams.get('to'), '120.1,30.2,西湖·花港观鱼');
  assert.equal(url.searchParams.get('mode'), 'bus');
  assert.equal(navigationUrl({ name: '未知坐标' }, 'walking'), null);
});

test('路段跳转高德带上明确的起终点，公交摘要包含所选换乘线路', () => {
  const origin = { name: '天坛·东门', coordinates: { longitude: 116.42, latitude: 39.88 } };
  const target = { name: '地坛公园', coordinates: { longitude: 116.41, latitude: 39.95 } };
  const link = new URL(navigationUrl(target, 'transit', origin));
  assert.equal(link.searchParams.get('from'), '116.42,39.88,天坛·东门');
  assert.equal(link.searchParams.get('to'), '116.41,39.95,地坛公园');
  assert.equal(link.searchParams.get('mode'), 'bus');
  assert.equal(navigationUrl(target, 'transit', { name: '起点没有坐标' }), null);
  assert.equal(
    transitSummary({
      transitSteps: [
        { mode: 'walking', name: '步行' },
        { mode: 'bus', name: '地铁5号线' },
        { mode: 'bus', name: '公交示例线路' },
      ],
    }),
    '地铁5号线 → 公交示例线路',
  );
  assert.equal(transitSummary('unavailable'), '');
  assert.equal(transitSummary({ durationMinutes: 10 }), '');
});
