// 固定的2026-11-21资料快照；仅更新目录，不删除行程或改动已有景点ID。
const catalog = require('./data/beijing-20261121.json');
const json = (value) => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";

exports.up = (pgm) => {
  pgm.sql(`
    DO $catalog_refresh$
    DECLARE imported integer;
    BEGIN
      INSERT INTO destinations (id,name,level,parent_id,adcode,amap_citycode,time_zone)
      SELECT d.id,d.name,d.level,d."parentId",d.adcode,d."amapCitycode",d."timeZone"
      FROM jsonb_to_recordset(${json(catalog.destinations)}) AS d(
        id uuid,name text,level text,"parentId" uuid,adcode text,"amapCitycode" text,"timeZone" text)
      ON CONFLICT (id) DO UPDATE SET name=excluded.name,
        amap_citycode=excluded.amap_citycode,time_zone=excluded.time_zone
      WHERE destinations.adcode=excluded.adcode AND destinations.level=excluded.level;
      GET DIAGNOSTICS imported = ROW_COUNT;
      IF imported <> ${catalog.destinations.length} THEN
        RAISE EXCEPTION 'Beijing destination ID conflicts; no catalog changes committed';
      END IF;

      INSERT INTO places
        (id,city_id,name,categories,address,longitude,latitude,coordinate_system,
         suggested_duration_minutes,description,opening_hours_text,source)
      SELECT p.id,p."cityId",p.name,p.categories,p.address,p.longitude,p.latitude,'GCJ-02',
        p."suggestedDurationMinutes",p.description,p."openingHoursText",'curated'
      FROM jsonb_to_recordset(${json(catalog.places)}) AS p(
        id uuid,"cityId" uuid,name text,categories text[],address text,
        longitude double precision,latitude double precision,
        "suggestedDurationMinutes" integer,description text,"openingHoursText" text)
      ON CONFLICT (id) DO UPDATE SET
        categories=excluded.categories,address=excluded.address,
        longitude=excluded.longitude,latitude=excluded.latitude,
        suggested_duration_minutes=excluded.suggested_duration_minutes,
        description=excluded.description,opening_hours_text=excluded.opening_hours_text,
        updated_at=NOW()
      WHERE places.source='curated' AND places.city_id=excluded.city_id
        AND places.name=excluded.name;
      GET DIAGNOSTICS imported = ROW_COUNT;
      IF imported <> ${catalog.places.length} THEN
        RAISE EXCEPTION 'Beijing catalog ID conflicts; no catalog changes committed';
      END IF;
    END $catalog_refresh$;
  `);
};

// 新景点可能已被行程引用，不能通过回滚数据迁移删除它们。
exports.down = false;
