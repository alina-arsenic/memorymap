-- Таблица инвайтов в группы (слои)
CREATE TABLE IF NOT EXISTS group_invites (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  from_user_id INT REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',  -- editor | viewer
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | canceled
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ NULL,
  CONSTRAINT group_invites_not_self CHECK (from_user_id <> to_user_id),
  CONSTRAINT group_invites_status_chk CHECK (status IN ('pending','accepted','declined','canceled')),
  CONSTRAINT group_invites_role_chk CHECK (role IN ('editor','viewer'))
);

-- Только один pending-инвайт на пару (group, user) одновременно
CREATE UNIQUE INDEX IF NOT EXISTS ux_group_invites_pending
  ON group_invites(group_id, to_user_id)
  WHERE status = 'pending';
