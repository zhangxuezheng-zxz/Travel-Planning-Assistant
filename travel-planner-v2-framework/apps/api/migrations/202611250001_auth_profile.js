exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN email_verified_at timestamptz,
      ADD COLUMN phone varchar(20) UNIQUE,
      ADD COLUMN phone_verified_at timestamptz,
      ADD COLUMN credential_version integer NOT NULL DEFAULT 0,
      ADD COLUMN bio varchar(300) NOT NULL DEFAULT '',
      ADD COLUMN home_city varchar(100) NOT NULL DEFAULT '',
      ADD COLUMN travel_preferences jsonb NOT NULL DEFAULT '{}',
      ADD CONSTRAINT users_preferences_object CHECK (jsonb_typeof(travel_preferences) = 'object'),
      ADD CONSTRAINT users_phone_verified CHECK ((phone IS NULL) = (phone_verified_at IS NULL));
    CREATE TABLE auth_sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON auth_sessions(user_id);
    CREATE INDEX ON auth_sessions(expires_at);
    CREATE TABLE auth_challenges (
      scope text PRIMARY KEY,
      id uuid NOT NULL UNIQUE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      credential_version integer NOT NULL DEFAULT 0,
      digest text NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      delivered boolean NOT NULL DEFAULT false,
      consumed_at timestamptz
    );
    CREATE INDEX ON auth_challenges(expires_at);
    CREATE TABLE auth_rate_limits (
      key text PRIMARY KEY,
      hits integer NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX ON auth_rate_limits(expires_at);
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('auth_rate_limits');
  pgm.dropTable('auth_challenges');
  pgm.dropTable('auth_sessions');
  pgm.sql(`ALTER TABLE users
    DROP CONSTRAINT users_phone_verified,
    DROP CONSTRAINT users_preferences_object,
    DROP COLUMN travel_preferences, DROP COLUMN home_city, DROP COLUMN bio,
    DROP COLUMN phone_verified_at, DROP COLUMN phone, DROP COLUMN email_verified_at, DROP COLUMN credential_version`);
};
