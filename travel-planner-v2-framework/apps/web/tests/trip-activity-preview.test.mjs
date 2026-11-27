import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(path) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', source)(
    (name) => (name.startsWith('.') ? load(resolve(dirname(path), name + '.ts')) : require(name)),
    module,
    module.exports,
  );
  return module.exports;
}
const { previewScheduleChanges } = load(
  fileURLToPath(new URL('../src/features/trip-create/trip-schedule-preview.ts', import.meta.url)),
);
const { buildDays } = load(
  fileURLToPath(new URL('../src/features/trip-create/trip-map-routes.ts', import.meta.url)),
);
const places = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  cityId: 'city',
  name: id,
  suggestedDurationMinutes: 60,
  categories: [],
  district: 'same',
  excursion: false,
}));
function item(placeId, position = 0, startTime = '09:00') {
  return {
    placeId,
    position,
    startTime,
    durationMinutes: 60,
    travelMinutesFromPrevious: position ? 30 : 0,
    travelTimeSource: position ? 'estimate' : 'none',
    reason: '',
  };
}
function fixture() {
  return {
    planningInput: {
      cityId: 'city',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      pace: 'standard',
      transportMode: 'walking',
      themes: [],
      selectedPlaceIds: ['a', 'b'],
    },
    days: [
      { date: '2026-12-01', items: [item('a')] },
      { date: '2026-12-02', items: [item('b')] },
    ],
    activities: [
      {
        id: 'activity',
        title: '午餐',
        date: '2026-12-01',
        startTime: '10:45',
        durationMinutes: 60,
        notes: '',
        poiId: 'POI',
        placeName: '餐厅',
        address: '',
        coordinates: { longitude: 116, latitude: 40, coordinateSystem: 'GCJ-02' },
        source: 'amap',
      },
    ],
  };
}

test('景点调序与活动重叠时，预览明确返回冲突而不是到保存时才失败', () => {
  const trip = fixture();
  const preview = previewScheduleChanges(
    trip,
    places,
    [
      { date: '2026-12-01', placeIds: ['a', 'b'] },
      { date: '2026-12-02', placeIds: [] },
    ],
    new Set(['2026-12-01', '2026-12-02']),
  );
  assert.deepEqual(preview.unassigned, []);
  assert.deepEqual(preview.activityConflicts, ['activity']);
  assert.deepEqual(trip.days[1].items, [item('b')]);
});
test('未影响的日程保持原样，活动不冲突时允许保存预览', () => {
  const trip = fixture();
  const preview = previewScheduleChanges(
    trip,
    places,
    [
      { date: '2026-12-01', placeIds: ['a'] },
      { date: '2026-12-02', placeIds: ['b'] },
    ],
    new Set(['2026-12-01']),
  );
  assert.deepEqual(preview.activityConflicts, []);
  assert.deepEqual(preview.days[1], trip.days[1]);
});
test('部分景点超出每日上限时，地图保留未排下站点的 ID 和时间，避免活动路线读取空值', () => {
  const trip = fixture();
  trip.planningInput.selectedPlaceIds = ['a', 'b', 'c', 'd'];
  trip.days[0].items = [item('a'), item('b', 1, '10:45')];
  trip.days[1].items = [item('c'), item('d', 1, '10:45')];
  trip.activities[0].startTime = '17:00';
  const order = [
    { date: '2026-12-01', placeIds: ['a', 'b', 'c', 'd'] },
    { date: '2026-12-02', placeIds: [] },
  ];
  const preview = previewScheduleChanges(
    trip,
    places,
    order,
    new Set(order.map((day) => day.date)),
  );
  assert.equal(preview.unassigned.length, 1);
  const day = buildDays(trip, places, order, preview.days)[0];
  assert.deepEqual(
    new Set(day.stops.map((stop) => stop.placeId)),
    new Set(['a', 'b', 'c', 'd', 'activity']),
  );
  for (const leg of day.legs) {
    assert.equal(typeof leg.from.startTime, 'string');
    assert.equal(typeof leg.to.startTime, 'string');
    assert.ok(leg.from.placeId);
    assert.ok(leg.to.placeId);
  }
  assert.equal(day.stops.find((stop) => stop.placeId === 'c').startTime, '12:30');
});
