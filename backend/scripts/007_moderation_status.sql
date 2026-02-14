-- Задача 3b: премодерация публичных точек

-- Статус модерации: pending (ожидает), approved (одобрена), rejected (отклонена)
-- Существующие точки считаются одобренными (DEFAULT 'approved')
ALTER TABLE places ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved';
