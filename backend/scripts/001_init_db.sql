CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE,
  username TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',  -- private | friends | public
  owner_id INT REFERENCES users(id) ON DELETE SET NULL,
  is_personal BOOLEAN NOT NULL DEFAULT FALSE
);


CREATE TABLE IF NOT EXISTS membership (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',       -- owner | editor | viewer
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS places (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT,
  note TEXT,
  geom GEOGRAPHY(POINT, 4326) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_places_geom ON places USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_places_group ON places (group_id);

ALTER TABLE places ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE places ADD COLUMN IF NOT EXISTS lon double precision;
ALTER TABLE places ALTER COLUMN geom DROP NOT NULL;

CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  place_id INT REFERENCES places(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  s3_key TEXT NOT NULL,
  mime TEXT,
  status TEXT NOT NULL DEFAULT 'ready',      -- pending | processing | ready | failed
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  place_id INT REFERENCES places(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- система друзей
CREATE TABLE IF NOT EXISTS friends (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  friend_id INT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);

SELECT setval(
  pg_get_serial_sequence('groups', 'id'),
  COALESCE((SELECT MAX(id) FROM groups), 1),
  true
);

-- One personal group per owner
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personal_group_per_owner ON groups (owner_id) WHERE is_personal = TRUE;
