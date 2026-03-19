-- 011: Таблица жалоб на точки (постмодерация)
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  place_id INT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | dismissed | upheld
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  resolved_by INT REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT reports_category_chk CHECK (category IN ('spam','offensive','wrong_location','privacy','other')),
  CONSTRAINT reports_status_chk CHECK (status IN ('pending','dismissed','upheld'))
);

-- Уникальный индекс: один пользователь — одна активная жалоба на точку
CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_active
  ON reports(place_id, user_id) WHERE status = 'pending';
