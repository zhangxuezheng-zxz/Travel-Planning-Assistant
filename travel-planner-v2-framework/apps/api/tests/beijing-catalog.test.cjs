const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../../../packages/shared/data/beijing.json');
const coordinates = require('../scripts/data/beijing-places.json');
const research = require('../scripts/data/beijing-research-20261121.json');
const migration = require('../migrations/data/beijing-20261121.json');
const oldCatalog = require('../migrations/data/beijing-20261102.json');

test('北京资料保留完整426条记录，仅有可用坐标的399条进入规划目录', () => {
  assert.equal(research.attractions.length, 426);
  assert.equal(catalog.places.length, 399);
  assert.equal(catalog.excludedPlaces.length, 27);
  assert.equal(new Set(research.attractions.map((p) => p.attraction_id)).size, 426);
  const included = new Set(catalog.places.map((p) => p.datasetId));
  for (const p of research.attractions) {
    assert.equal(
      included.has(p.attraction_id),
      !['missing', 'quarantined'].includes(p.coordinate_quality),
    );
  }
  const mapping = new Map(research.idMap.map((p) => [p.datasetId, p]));
  assert.equal(new Set(research.idMap.map((p) => p.id)).size, 426);
  for (const p of catalog.places) assert.equal(p.id, mapping.get(p.datasetId).id);
});

test('旧18个景点ID保持不变，坐标使用GCJ02字段，迁移和种子数据对应同一目录', () => {
  for (const old of oldCatalog.places) {
    const current = catalog.places.find((p) => p.id === old.id);
    assert.ok(current, '旧行程引用的景点必须保留：' + old.name);
    assert.equal(current.name, old.name);
  }
  const points = new Map(coordinates.places.map((p) => [p.id, p]));
  const rows = new Map(migration.places.map((p) => [p.id, p]));
  assert.equal(points.size, catalog.places.length);
  assert.equal(rows.size, catalog.places.length);
  for (const p of catalog.places) {
    const source = research.attractions.find((r) => r.attraction_id === p.datasetId);
    const point = points.get(p.id);
    assert.equal(point.coordinateSystem, 'GCJ-02');
    assert.equal(point.longitude, source.longitude_gcj02_approx);
    assert.equal(point.latitude, source.latitude_gcj02_approx);
    assert.ok(point.longitude >= 115.4 && point.longitude <= 117.6);
    assert.ok(point.latitude >= 39.4 && point.latitude <= 41.1);
    assert.equal(rows.get(p.id).name, p.name);
    assert.equal(rows.get(p.id).openingHoursText, p.visitInfo.openingHoursText);
    assert.ok(p.suggestedDurationMinutes > 0);
  }
});

test('未知预约不变成免预约，缺失开放时间不伪造，来源日期不标成实时核验', () => {
  for (const p of catalog.places) {
    const source = research.attractions.find((r) => r.attraction_id === p.datasetId);
    if (source.reservation_policy === 'unknown') {
      assert.match(p.visitInfo.booking.policy, /待确认/);
      assert.doesNotMatch(p.visitInfo.booking.policy, /无需/);
    }
    assert.equal(p.visitInfo.openingHoursText, source.opening_hours);
    assert.equal(
      p.visitInfo.checkedAt,
      source.policy_checked_at || source.source_snapshot_retrieved_at.slice(0, 10),
    );
    assert.match(p.visitInfo.coordinateNote, /预览/);
    for (const url of [p.sourceUrl, p.visitInfo.sourceUrl, p.visitInfo.booking.url]) {
      if (url) assert.ok(['http:', 'https:'].includes(new URL(url).protocol));
    }
  }
});
