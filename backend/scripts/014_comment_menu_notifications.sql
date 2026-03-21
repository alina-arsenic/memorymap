-- 014: parent_id для ответов, updated_at для редактирования, таблица уведомлений

-- parent_id для ответов (self-referencing FK, один уровень вложенности)
ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INT
  REFERENCES comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

-- updated_at для отметки редактирования
ALTER TABLE comments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NULL;

-- Таблица уведомлений
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- comment_on_place | reply_to_comment
  actor_id INT REFERENCES users(id) ON DELETE SET NULL,
  place_id INT REFERENCES places(id) ON DELETE CASCADE,
  comment_id INT REFERENCES comments(id) ON DELETE CASCADE,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT notifications_type_chk CHECK (type IN ('comment_on_place','reply_to_comment'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
