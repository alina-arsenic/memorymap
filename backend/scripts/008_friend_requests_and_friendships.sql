-- 008_friend_requests_and_friendships.sql
-- Adds mutual friendships + friend requests (invitations)

-- Mutual friendship pairs (store once with user1_id < user2_id)
CREATE TABLE IF NOT EXISTS friendships (
  user1_id INT REFERENCES users(id) ON DELETE CASCADE,
  user2_id INT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user1_id, user2_id),
  CONSTRAINT friendships_order CHECK (user1_id < user2_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_user1 ON friendships(user1_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user2 ON friendships(user2_id);

-- Friend requests (invitations)
CREATE TABLE IF NOT EXISTS friend_requests (
  id SERIAL PRIMARY KEY,
  from_user_id INT REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | canceled
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ NULL,
  CONSTRAINT friend_requests_not_self CHECK (from_user_id <> to_user_id),
  CONSTRAINT friend_requests_status_chk CHECK (status IN ('pending','accepted','declined','canceled'))
);

-- Prevent duplicate pending requests for same direction
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'ux_friend_requests_pending_pair'
  ) THEN
    CREATE UNIQUE INDEX ux_friend_requests_pending_pair
      ON friend_requests(from_user_id, to_user_id)
      WHERE status = 'pending';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_friend_requests_to_status ON friend_requests(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from_status ON friend_requests(from_user_id, status);

-- Optional: migrate legacy friends table (accepted edges) into mutual friendships
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'friends'
  ) THEN
    INSERT INTO friendships (user1_id, user2_id)
    SELECT LEAST(user_id, friend_id) AS user1_id,
           GREATEST(user_id, friend_id) AS user2_id
    FROM friends
    WHERE status = 'accepted'
      AND user_id IS NOT NULL
      AND friend_id IS NOT NULL
      AND user_id <> friend_id
    ON CONFLICT DO NOTHING;
  END IF;
END$$;
