-- 018: Предпродакшн — constraints, индексы, timestamps

-- 1. NOT NULL на координаты (модель уже nullable=False, SQL — нет)
ALTER TABLE places ALTER COLUMN lat SET NOT NULL;
ALTER TABLE places ALTER COLUMN lon SET NOT NULL;

-- 2. CHECK constraints на enum-поля
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_chk
    CHECK (role IN ('admin', 'moderator', 'user'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE groups ADD CONSTRAINT groups_visibility_chk
    CHECK (visibility IN ('private', 'friends', 'public'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE membership ADD CONSTRAINT membership_role_chk
    CHECK (role IN ('owner', 'editor', 'viewer'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE media ADD CONSTRAINT media_status_chk
    CHECK (status IN ('pending', 'processing', 'ready', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE places ADD CONSTRAINT places_moderation_status_chk
    CHECK (moderation_status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Индексы на FK для производительности
-- (idx_users_email не нужен — UNIQUE constraint уже создаёт индекс)
CREATE INDEX IF NOT EXISTS idx_places_user ON places(user_id);
CREATE INDEX IF NOT EXISTS idx_media_place ON media(place_id);
CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_from ON group_invites(from_user_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_to ON group_invites(to_user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_actor ON notifications(actor_id);
CREATE INDEX IF NOT EXISTS idx_reports_place ON reports(place_id);
CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_resolved_by ON reports(resolved_by);
CREATE INDEX IF NOT EXISTS idx_places_moderation ON places(moderation_status);

-- 4. created_at на таблицы где его нет
ALTER TABLE groups ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE membership ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
