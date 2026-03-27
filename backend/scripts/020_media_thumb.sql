-- Миниатюры фото: thumb_key хранит S3-ключ уменьшенной версии
ALTER TABLE media ADD COLUMN IF NOT EXISTS thumb_key TEXT;
