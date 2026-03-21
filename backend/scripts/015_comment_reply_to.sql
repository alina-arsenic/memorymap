-- 015: reply_to_id — хранит ID комментария, на который реально ответили
-- parent_id используется для группировки (всегда top-level), reply_to_id — для отображения «↩ @автор»

ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_to_id INT
  REFERENCES comments(id) ON DELETE SET NULL;
