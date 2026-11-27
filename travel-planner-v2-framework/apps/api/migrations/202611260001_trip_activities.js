exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE trip_activities (
    id uuid PRIMARY KEY,
    trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    title varchar(120) NOT NULL,
    notes varchar(1000) NOT NULL DEFAULT '',
    date date NOT NULL,
    start_time time NOT NULL,
    duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 720),
    poi_id varchar(80) NOT NULL,
    place_name text NOT NULL,
    address text NOT NULL,
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90)
  );
  CREATE INDEX ON trip_activities(trip_id, date, start_time);`);
};
exports.down = (pgm) => pgm.dropTable('trip_activities');
