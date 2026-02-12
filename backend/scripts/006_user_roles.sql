-- Задача 3a: система ролей пользователей (admin / moderator / user)

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- Первый зарегистрированный пользователь — администратор
UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users);
