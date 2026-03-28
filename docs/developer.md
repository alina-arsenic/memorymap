# Документация разработчика MemoryMap

---

## Содержание

- [Архитектура](#архитектура)
- [Стек и обоснование](#стек-и-обоснование)
- [API эндпоинты](#api-эндпоинты)
- [Модели БД](#модели-бд)
- [SQL-миграции](#sql-миграции)
- [Авторизация и безопасность](#авторизация-и-безопасность)
- [Медиа-система](#медиа-система)
- [Модерация](#модерация)
- [Telegram-бот](#telegram-бот)
- [Docker Compose](#docker-compose)
- [Деплой (K3s)](#деплой-k3s)
- [CI](#ci)
- [Переменные окружения](#переменные-окружения)
- [Тестирование](#тестирование)
- [Запуск для разработки](#запуск-для-разработки)

---

## Архитектура

Приложение построено по трёхслойной архитектуре:

```
API роутеры (api/)  →  Сервисы (services/)  →  Модели (models/)  →  PostgreSQL + PostGIS
```

- **API роутеры** (`backend/app/api/`) — обработка HTTP-запросов, валидация входных данных (Pydantic), проверка прав доступа. Подключаются в `main.py` с префиксом `/v1`.
- **Сервисы** (`backend/app/services/`) — бизнес-логика: модерация, дружба, группы, email.
- **Модели** (`backend/app/models/models.py`) — SQLAlchemy ORM, описание таблиц и связей.

Дополнительно:

- **Frontend**: SPA на Vanilla JS, монтируется как статика в FastAPI (`StaticFiles`).
- **Bot**: отдельный сервис на aiogram 3, общается с Backend API через HTTP + заголовок `X-Bot-Secret`.

---

## Стек и обоснование

| Компонент            | Технология                | Обоснование                                                                 |
|----------------------|---------------------------|-----------------------------------------------------------------------------|
| Backend              | FastAPI (Python 3.11)     | Async, встроенная валидация (Pydantic), DI через `Depends`, автогенерация OpenAPI |
| БД                   | PostgreSQL + PostGIS      | Геопространственные запросы (bbox), индекс GIST, стандарт для ГИС          |
| Хранилище медиа      | MinIO (S3-совместимое)    | Presigned URLs — загрузка/скачивание без проксирования через API            |
| Карта                | MapLibre GL               | Open-source замена Mapbox GL, raster tiles (OSM), рендеринг через WebGL    |
| Telegram-бот         | aiogram 3.4.1             | Async, FSM, удобная работа с inline-кнопками                               |
| Frontend             | Vanilla JS                | Минимум зависимостей, SPA без фреймворка, быстрая загрузка                 |
| Хеширование паролей  | bcrypt (passlib)          | Отраслевой стандарт, адаптивная сложность                                  |
| Миниатюры            | Pillow                    | Серверная генерация thumbnail для фото (JPEG, max 200px)                   |
| Очереди              | Redis + RQ                | Фоновые задачи (в requirements, подготовлено для будущего использования)    |

---

## API эндпоинты

Все эндпоинты имеют префикс `/v1`, если не указано иное.

### auth.py — Аутентификация (6 эндпоинтов)

| Метод | Путь                    | Описание                                                  | Авторизация |
|-------|-------------------------|-----------------------------------------------------------|-------------|
| POST  | `/auth/register`        | Регистрация (логин, email, пароль). Отправка кода на email | Нет         |
| POST  | `/auth/verify-email`    | Подтверждение email 6-значным кодом                       | Нет         |
| POST  | `/auth/resend-code`     | Повторная отправка кода подтверждения                      | Нет         |
| POST  | `/auth/login`           | Вход — возвращает JWT access token                        | Нет         |
| POST  | `/auth/forgot-password` | Запрос кода восстановления пароля                         | Нет         |
| POST  | `/auth/reset-password`  | Сброс пароля по коду, инвалидация всех токенов            | Нет         |

### me.py — Профиль текущего пользователя (10 эндпоинтов)

| Метод  | Путь                       | Описание                                                    | Авторизация |
|--------|----------------------------|-------------------------------------------------------------|-------------|
| GET    | `/me`                      | Профиль: группы, друзья, уведомления, pending-счётчик       | Да          |
| POST   | `/friends`                 | Запрос дружбы по tg_id (legacy)                             | Да          |
| POST   | `/me/telegram-link/start`  | Генерация deep link кода для подключения Telegram            | Да          |
| DELETE | `/me/telegram`             | Отключение Telegram (проверка наличия пароля)               | Да          |
| DELETE | `/me`                      | Удаление аккаунта (legacy, без пароля)                      | Да          |
| POST   | `/me/delete`               | Удаление аккаунта с подтверждением паролем                  | Да          |
| POST   | `/me/change-password`      | Смена пароля, инвалидация токенов                           | Да          |
| POST   | `/me/change-login`         | Смена логина (3–64 символа, уникальность)                   | Да          |
| POST   | `/me/change-email`         | Инициация смены email — отправка кода на новый адрес        | Да          |
| POST   | `/me/confirm-email`        | Подтверждение нового email кодом, выдача нового токена      | Да          |

### users.py — Поиск пользователей (1 эндпоинт)

| Метод | Путь             | Описание                                                         | Авторизация |
|-------|------------------|------------------------------------------------------------------|-------------|
| GET   | `/users/search`  | Поиск по логину/username (min 1 символ, limit 1–50, default 20)  | Да          |

### places.py — Точки на карте (8 эндпоинтов)

| Метод  | Путь                        | Описание                                                          | Авторизация          |
|--------|-----------------------------|-------------------------------------------------------------------|----------------------|
| POST   | `/places`                   | Создание точки (title, note, координаты, group_id, media_keys)   | Да                   |
| GET    | `/places`                   | Список точек в bbox для указанной группы                          | Опционально          |
| GET    | `/places/feed`              | Список точек по нескольким группам (scope: all/mine)              | Опционально          |
| GET    | `/places/{place_id}`        | Одна точка по ID (для ссылок-шеринга)                             | Опционально          |
| POST   | `/places/bot`               | Создание точки из Telegram-бота                                   | Bot-only             |
| PATCH  | `/places/{place_id}`        | Обновление title, note, group_id. Пересчёт статуса модерации     | Да (владелец)        |
| POST   | `/places/{place_id}/media`  | Прикрепление загруженного фото к точке (temp_key → final)         | Да (владелец)        |
| DELETE | `/places/{place_id}`        | Удаление точки и всех медиа                                       | Да (владелец/admin/moderator) |

### media.py — Медиа-файлы (3 эндпоинта)

| Метод  | Путь                       | Описание                                                 | Авторизация   |
|--------|----------------------------|----------------------------------------------------------|---------------|
| POST   | `/media/presign-upload`    | Генерация presigned URL для загрузки в S3 (600 сек)      | Да            |
| GET    | `/media/presign-download`  | Генерация presigned URL для скачивания из S3 (300 сек)   | Да            |
| DELETE | `/media/{media_id}`        | Удаление медиа из S3 и БД                                | Да (владелец) |

### groups.py — Групповые слои (9 эндпоинтов)

| Метод  | Путь                                       | Описание                                    | Авторизация   |
|--------|--------------------------------------------|---------------------------------------------|---------------|
| GET    | `/groups`                                  | Список доступных групп                      | Опционально   |
| POST   | `/groups`                                  | Создание группы (name, visibility)          | Да            |
| GET    | `/groups/{group_id}`                       | Детали группы с участниками                 | Да            |
| PATCH  | `/groups/{group_id}`                       | Переименование группы                       | Да (владелец) |
| POST   | `/groups/{group_id}/members`               | Добавление участника с ролью                | Да (владелец) |
| DELETE | `/groups/{group_id}/members/{user_id}`     | Удаление участника                          | Да (владелец) |
| PATCH  | `/groups/{group_id}/members/{user_id}`     | Изменение роли участника                    | Да (владелец) |
| POST   | `/groups/{group_id}/leave`                 | Выход из группы                             | Да            |
| DELETE | `/groups/{group_id}`                       | Удаление группы и всех точек                | Да (владелец) |

### layers.py — Слои с классификацией (1 эндпоинт)

| Метод | Путь       | Описание                                                 | Авторизация |
|-------|------------|----------------------------------------------------------|-------------|
| GET   | `/layers`  | Список групп с типом: public / personal / shared         | Да          |

### friends.py — Друзья (6 эндпоинтов)

| Метод  | Путь                                     | Описание                                           | Авторизация |
|--------|------------------------------------------|-----------------------------------------------------|-------------|
| GET    | `/friends`                               | Список друзей                                       | Да          |
| DELETE | `/friends/{other_user_id}`               | Удаление из друзей (двустороннее)                   | Да          |
| POST   | `/friends/requests`                      | Отправка запроса дружбы                              | Да          |
| GET    | `/friends/requests`                      | Список запросов (inbox/outbox, status, limit)       | Да          |
| POST   | `/friends/requests/{request_id}/accept`  | Принятие запроса → создание Friendship              | Да          |
| POST   | `/friends/requests/{request_id}/decline` | Отклонение запроса                                   | Да          |

### group_invites.py — Приглашения в группы (5 эндпоинтов)

| Метод  | Путь                                        | Описание                                     | Авторизация   |
|--------|---------------------------------------------|----------------------------------------------|---------------|
| POST   | `/groups/{group_id}/invites`                | Приглашение друга в группу (роль: editor/viewer) | Да (владелец) |
| GET    | `/groups/invites`                           | Список приглашений (inbox/outbox, status, limit)  | Да            |
| POST   | `/groups/invites/{invite_id}/accept`        | Принятие приглашения → добавление в группу    | Да            |
| POST   | `/groups/invites/{invite_id}/decline`       | Отклонение приглашения                        | Да            |
| DELETE | `/groups/invites/{invite_id}`               | Отмена приглашения отправителем               | Да (отправитель) |

### blocks.py — Блокировка пользователей (3 эндпоинта)

| Метод  | Путь                | Описание                       | Авторизация |
|--------|---------------------|--------------------------------|-------------|
| POST   | `/blocks`           | Заблокировать пользователя     | Да          |
| DELETE | `/blocks/{user_id}` | Разблокировать пользователя    | Да          |
| GET    | `/blocks`           | Список заблокированных         | Да          |

### comments.py — Комментарии (4 эндпоинта)

| Метод  | Путь                              | Описание                                                   | Авторизация                          |
|--------|-----------------------------------|-------------------------------------------------------------|--------------------------------------|
| POST   | `/places/{place_id}/comments`     | Создание комментария (top-level или reply, 1–1000 символов) | Да                                   |
| GET    | `/places/{place_id}/comments`     | Список комментариев к точке                                 | Опционально                          |
| PATCH  | `/comments/{comment_id}`          | Редактирование текста комментария                           | Да (автор, в течение 1 часа)         |
| DELETE | `/comments/{comment_id}`          | Удаление комментария с ответами (cascade)                   | Да (автор/владелец точки/admin/mod)  |

### reports.py — Жалобы (1 эндпоинт)

| Метод | Путь                            | Описание                                                  | Авторизация |
|-------|---------------------------------|-----------------------------------------------------------|-------------|
| POST  | `/places/{place_id}/report`     | Жалоба на точку (category + comment)                      | Да          |

### notifications.py — Уведомления (3 эндпоинта)

| Метод | Путь                                      | Описание                                 | Авторизация |
|-------|-------------------------------------------|------------------------------------------|-------------|
| GET   | `/notifications`                          | Список уведомлений текущего пользователя | Да          |
| PATCH | `/notifications/read-all`                 | Пометить все как прочитанные             | Да          |
| PATCH | `/notifications/{notification_id}/read`   | Пометить одно как прочитанное            | Да          |

### moderation.py — Модерация (2 эндпоинта)

| Метод | Путь                                | Описание                                                       | Авторизация       |
|-------|-------------------------------------|----------------------------------------------------------------|-------------------|
| GET   | `/moderation/places`                | Очередь: pending-точки + approved с жалобами (limit 200)       | admin / moderator |
| PATCH | `/moderation/places/{place_id}`     | Одобрить / отклонить точку, авторазрешение жалоб               | admin / moderator |

### admin.py — Управление пользователями (2 эндпоинта)

| Метод | Путь                             | Описание                                                          | Авторизация |
|-------|----------------------------------|-------------------------------------------------------------------|-------------|
| GET   | `/admin/users`                   | Список пользователей с поиском (admin видит PII, moderator — без PII) | admin / moderator |
| PATCH | `/admin/users/{user_id}/role`    | Назначение роли moderator/user. Автоодобрение pending-точек      | admin       |

### bot.py — Эндпоинты для Telegram-бота (5 эндпоинтов)

| Метод  | Путь                         | Описание                                              | Авторизация |
|--------|------------------------------|-------------------------------------------------------|-------------|
| POST   | `/bot/link-telegram`         | Подключение Telegram по коду deep link                | Bot-only    |
| GET    | `/bot/groups`                | Список групп пользователя (автосоздание личной)       | Bot-only    |
| POST   | `/bot/media/presign-upload`  | Presigned URL для загрузки фото через бота            | Bot-only    |
| POST   | `/bot/groups`                | Создание группы из бота (private/public)              | Bot-only    |
| DELETE | `/bot/unlink-telegram`       | Отключение Telegram (проверка пароля)                 | Bot-only    |

### bot_places.py — Точки через бота (6 эндпоинтов)

| Метод  | Путь                              | Описание                                      | Авторизация |
|--------|-----------------------------------|-----------------------------------------------|-------------|
| GET    | `/bot/places`                     | Последние 5 точек пользователя                | Bot-only    |
| PATCH  | `/bot/places/{place_id}`          | Обновление точки (title, note, group, coords) | Bot-only    |
| DELETE | `/bot/places/{place_id}`          | Удаление точки                                 | Bot-only    |
| GET    | `/bot/places/{place_id}/media`    | Список медиа точки с presigned URLs           | Bot-only    |
| DELETE | `/bot/media/{media_id}`           | Удаление одного медиа                          | Bot-only    |
| POST   | `/bot/places/{place_id}/media`    | Прикрепление загруженного фото к точке         | Bot-only    |

### analytics.py — Аналитика (1 эндпоинт, опциональный)

| Метод | Путь            | Описание                                                   | Авторизация |
|-------|-----------------|-------------------------------------------------------------|-------------|
| GET   | `/admin/stats`  | Сводная статистика: пользователи, точки, медиа, группы     | admin       |

> Файл не в git (.gitignore), подключается условно через `ImportError` в `main.py`. Требует миграции 019.

### main.py — Служебные маршруты (2 эндпоинта)

| Метод | Путь         | Описание                                    | Авторизация |
|-------|--------------|---------------------------------------------|-------------|
| GET   | `/healthz`   | Проверка работоспособности сервера           | Нет         |
| GET   | `/settings`  | SPA fallback — отдаёт `index.html`          | Нет         |

**Итого: 75 эндпоинтов** (без учёта аналитики и служебных маршрутов main.py).

---

## Модели БД

### ORM-модели (SQLAlchemy) — 15 таблиц

#### User (`users`)

| Поле               | Тип                   | Описание                               |
|--------------------|-----------------------|----------------------------------------|
| `id`               | Integer, PK           | Идентификатор                          |
| `tg_id`            | BigInteger, unique    | Telegram ID                            |
| `username`         | Text                  | Telegram username                      |
| `login`            | Text, unique          | Логин для авторизации                  |
| `password_hash`    | Text                  | Хеш пароля (bcrypt)                    |
| `email`            | Text, unique          | Email адрес                            |
| `email_verified`   | Boolean               | Подтверждён ли email (default: false)  |
| `role`             | Text                  | Роль: admin / moderator / user         |
| `tokens_valid_after` | DateTime(tz)        | Инвалидация JWT до этого timestamp     |

#### Group (`groups`)

| Поле           | Тип               | Описание                                |
|----------------|--------------------|-----------------------------------------|
| `id`           | Integer, PK        | Идентификатор (id=1 — публичный слой)   |
| `name`         | Text, NOT NULL     | Название группы                         |
| `visibility`   | Text               | private / friends / public              |
| `owner_id`     | Integer, FK→users  | Владелец (SET NULL при удалении)        |
| `is_personal`  | Boolean            | Личная карта (auto-created per user)    |
| `created_at`   | DateTime(tz)       | Дата создания (только SQL, нет в ORM)   |

#### Place (`places`)

| Поле                | Тип               | Описание                              |
|---------------------|--------------------|---------------------------------------|
| `id`                | Integer, PK        | Идентификатор                         |
| `group_id`          | Integer, FK→groups | Слой (CASCADE при удалении группы)    |
| `user_id`           | Integer, FK→users  | Автор (SET NULL при удалении)         |
| `title`             | Text               | Название точки                        |
| `note`              | Text               | Описание                             |
| `lat`               | Float, NOT NULL    | Широта                                |
| `lon`               | Float, NOT NULL    | Долгота                               |
| `moderation_status` | Text               | pending / approved / rejected         |
| `source`            | Text               | web / bot (только SQL, нет в ORM)     |
| `created_at`        | DateTime(tz)       | Дата создания (только SQL, нет в ORM) |

#### Media (`media`)

| Поле         | Тип               | Описание                     |
|--------------|--------------------|------------------------------|
| `id`         | Integer, PK        | Идентификатор                |
| `place_id`   | Integer, FK→places | Точка (CASCADE)              |
| `user_id`    | Integer, FK→users  | Загрузивший (SET NULL)       |
| `s3_key`     | Text, NOT NULL     | Ключ объекта в MinIO         |
| `thumb_key`  | Text               | S3-ключ миниатюры            |
| `mime`       | Text               | MIME-тип файла               |
| `status`     | Text               | pending / processing / ready / failed |
| `created_at` | DateTime(tz)       | Дата загрузки                |

#### Friendship (`friendships`)

| Поле         | Тип          | Описание                                  |
|--------------|--------------|-------------------------------------------|
| `user1_id`   | Integer, PK  | Меньший user ID (CHECK: user1_id < user2_id) |
| `user2_id`   | Integer, PK  | Больший user ID                           |
| `created_at` | DateTime(tz) | Дата создания дружбы                      |

#### FriendRequest (`friend_requests`)

| Поле           | Тип               | Описание                              |
|----------------|--------------------|---------------------------------------|
| `id`           | Integer, PK        | Идентификатор                         |
| `from_user_id` | Integer, FK→users  | Отправитель                           |
| `to_user_id`   | Integer, FK→users  | Получатель                            |
| `status`       | Text               | pending / accepted / declined / canceled |
| `created_at`   | DateTime(tz)       | Дата отправки                         |
| `responded_at` | DateTime(tz)       | Дата ответа                           |

#### GroupInvite (`group_invites`)

| Поле           | Тип               | Описание                              |
|----------------|--------------------|---------------------------------------|
| `id`           | Integer, PK        | Идентификатор                         |
| `group_id`     | Integer, FK→groups | Группа                                |
| `from_user_id` | Integer, FK→users  | Пригласивший                          |
| `to_user_id`   | Integer, FK→users  | Приглашённый                          |
| `role`         | Text               | editor / viewer                       |
| `status`       | Text               | pending / accepted / declined / canceled |
| `created_at`   | DateTime(tz)       | Дата отправки                         |
| `responded_at` | DateTime(tz)       | Дата ответа                           |

#### UserBlock (`user_blocks`)

| Поле         | Тип               | Описание              |
|--------------|--------------------|----------------------|
| `id`         | Integer, PK        | Идентификатор         |
| `blocker_id` | Integer, FK→users  | Кто блокирует         |
| `blocked_id` | Integer, FK→users  | Кого блокируют        |
| `created_at` | DateTime(tz)       | Дата блокировки       |

#### Comment (`comments`)

| Поле          | Тип                  | Описание                                      |
|---------------|-----------------------|-----------------------------------------------|
| `id`          | Integer, PK           | Идентификатор                                 |
| `place_id`    | Integer, FK→places    | Точка (CASCADE)                               |
| `user_id`     | Integer, FK→users     | Автор (SET NULL)                              |
| `text`        | Text, NOT NULL        | Текст комментария (1–1000 символов)           |
| `parent_id`   | Integer, FK→comments  | Группировка ответов (top-level, CASCADE)      |
| `reply_to_id` | Integer, FK→comments  | На какой комментарий ответ (SET NULL)         |
| `created_at`  | DateTime(tz)          | Дата создания                                 |
| `updated_at`  | DateTime(tz)          | Дата последнего редактирования                |

#### Notification (`notifications`)

| Поле         | Тип                 | Описание                                  |
|--------------|----------------------|-------------------------------------------|
| `id`         | Integer, PK          | Идентификатор                             |
| `user_id`    | Integer, FK→users    | Получатель (CASCADE)                      |
| `type`       | Text, NOT NULL       | comment_on_place / reply_to_comment       |
| `actor_id`   | Integer, FK→users    | Кто вызвал уведомление (SET NULL)         |
| `place_id`   | Integer, FK→places   | Связанная точка (CASCADE)                 |
| `comment_id` | Integer, FK→comments | Связанный комментарий (CASCADE)           |
| `is_read`    | Boolean              | Прочитано (default: false)                |
| `created_at` | DateTime(tz)         | Дата создания                             |

#### Report (`reports`)

| Поле          | Тип               | Описание                                          |
|---------------|--------------------|----------------------------------------------------|
| `id`          | Integer, PK        | Идентификатор                                      |
| `place_id`    | Integer, FK→places | Точка, на которую жалоба (CASCADE)                 |
| `user_id`     | Integer, FK→users  | Кто пожаловался (CASCADE)                          |
| `category`    | Text, NOT NULL     | spam / offensive / wrong_location / privacy / other |
| `comment`     | Text               | Текст жалобы                                       |
| `status`      | Text               | pending / dismissed / upheld                       |
| `created_at`  | DateTime(tz)       | Дата создания                                      |
| `resolved_at` | DateTime(tz)       | Дата разрешения                                    |
| `resolved_by` | Integer, FK→users  | Кто рассмотрел (SET NULL)                          |

#### EmailVerificationCode (`email_verification_codes`)

| Поле         | Тип               | Описание                     |
|--------------|--------------------|------------------------------|
| `id`         | Integer, PK        | Идентификатор                |
| `user_id`    | Integer, FK→users  | Пользователь (CASCADE)       |
| `code`       | Text, NOT NULL     | 6-значный код                |
| `expires_at` | DateTime(tz)       | Срок действия                |
| `used_at`    | DateTime(tz)       | Когда использован            |
| `created_at` | DateTime(tz)       | Когда создан                 |

#### PasswordResetCode (`password_reset_codes`)

| Поле         | Тип               | Описание                     |
|--------------|--------------------|------------------------------|
| `id`         | Integer, PK        | Идентификатор                |
| `user_id`    | Integer, FK→users  | Пользователь (CASCADE)       |
| `code`       | Text, NOT NULL     | 6-значный код                |
| `expires_at` | DateTime(tz)       | Срок действия                |
| `used_at`    | DateTime(tz)       | Когда использован            |

#### TelegramLinkCode (`telegram_link_codes`)

| Поле         | Тип               | Описание                     |
|--------------|--------------------|------------------------------|
| `id`         | Integer, PK        | Идентификатор                |
| `user_id`    | Integer, FK→users  | Пользователь (CASCADE)       |
| `code`       | Text, unique       | Код deep link                |
| `expires_at` | DateTime(tz)       | Срок действия                |
| `used_at`    | DateTime(tz)       | Когда использован            |
| `created_at` | DateTime(tz)       | Когда создан                 |

#### Friend (`friends`) — deprecated

Устаревшая таблица. Заменена на `friendships` + `friend_requests` (миграция 008).

### Raw SQL-таблица (без ORM-модели)

#### membership

| Поле         | Тип               | Описание                  |
|--------------|--------------------|--------------------------|
| `user_id`    | Integer, PK, FK→users  | Участник               |
| `group_id`   | Integer, PK, FK→groups | Группа                 |
| `role`       | Text               | owner / editor / viewer   |
| `created_at` | DateTime(tz)       | Дата добавления           |

Доступ к таблице через raw SQL-запросы в сервисах (не через ORM).

---

## SQL-миграции

Скрипты в `backend/scripts/`, выполняются при инициализации БД (монтируются в `/docker-entrypoint-initdb.d`).

| #   | Файл                                     | Описание                                                                   |
|-----|-------------------------------------------|-----------------------------------------------------------------------------|
| 001 | `001_init_db.sql`                         | Основная схема: users, groups, membership, places (с PostGIS geom), media, comments, friends (legacy) |
| 002 | `002_users_auth.sql`                      | Добавление login (unique) и password_hash для парольной авторизации         |
| 003 | `003_seed.sql`                            | Создание публичного слоя: groups (id=1, name='Public map', visibility='public') |
| 004 | `004_telegram_link_codes.sql`             | Таблица telegram_link_codes для deep link подключения                       |
| 005 | `005_email_verification.sql`              | Поля email, email_verified в users + таблица email_verification_codes       |
| 006 | `006_user_roles.sql`                      | Поле role в users (default='user'). Первый пользователь → admin             |
| 007 | `007_moderation_status.sql`               | Поле moderation_status в places (pending/approved/rejected)                 |
| 008 | `008_friend_requests_and_friendships.sql`  | Таблицы friendships и friend_requests. Миграция из legacy friends           |
| 009 | `009_personal_groups.sql`                 | Поля owner_id, is_personal в groups. Дедупликация личных групп             |
| 010 | `010_group_invites.sql`                   | Таблица group_invites для приглашений в слои                                |
| 011 | `011_reports.sql`                         | Таблица reports для жалоб на точки (постмодерация)                          |
| 012 | `012_user_blocks.sql`                     | Таблица user_blocks для блокировки пользователей                            |
| 013 | `013_comments_index.sql`                  | Индекс на comments(place_id)                                                |
| 014 | `014_comment_menu_notifications.sql`       | parent_id и updated_at в comments. Таблица notifications                   |
| 015 | `015_comment_reply_to.sql`                | Поле reply_to_id в comments (для «↩ @автор»)                               |
| 016 | `016_tokens_valid_after.sql`              | Поле tokens_valid_after в users для инвалидации JWT                         |
| 017 | `017_password_reset_codes.sql`            | Таблица password_reset_codes для восстановления пароля                      |
| 018 | `018_hardening.sql`                       | NOT NULL на координаты, CHECK constraints на enum-поля, FK-индексы, created_at |
| 019 | `019_analytics.sql`                       | Поле source в places, last_active_at в users. Индекс на активность         |
| 020 | `020_media_thumb.sql`                     | Поле thumb_key в media для хранения S3-ключа миниатюры                     |

---

## Авторизация и безопасность

### JWT

- Алгоритм: **HS256**.
- TTL: **24 часа** (1440 минут, настраивается через `JWT_EXPIRES_MINUTES`).
- Инвалидация: при смене пароля, сбросе пароля, смене email — обновляется `tokens_valid_after`, все ранее выданные токены становятся невалидными.

### Пароли

- Хеширование: **bcrypt** через passlib.
- Ограничение длины: максимум **128 символов** (защита от DoS через длинные пароли).

### Бот-API

- Заголовок `X-Bot-Secret` со значением `BOT_API_SECRET` — обязателен для всех bot-эндпоинтов.

### Роли пользователей

| Роль        | Права                                                                |
|-------------|----------------------------------------------------------------------|
| `admin`     | Все права + управление пользователями + назначение moderator         |
| `moderator` | Все права user + модерация точек + удаление чужих точек (API)        |
| `user`      | Базовые функции: точки, друзья, группы, комментарии                  |

### Роли в группах (membership)

| Роль      | Просмотр | Добавление точек | Управление участниками | Удаление группы |
|-----------|:--------:|:----------------:|:---------------------:|:---------------:|
| `owner`   | +        | +                | +                     | +               |
| `editor`  | +        | +                | -                     | -               |
| `viewer`  | +        | -                | -                     | -               |

### Middleware

- **GZip**: сжатие ответов ≥500 байт (`GZipMiddleware`).
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- **Cache-Control**: `.js/.css` → `max-age=3600`, `.html` → `max-age=300`.

---

## Медиа-система

### Presigned URL flow

```
1. Клиент → POST /v1/media/presign-upload (mime, ext, place_id)
   ← {url, key}                                   # key = uploads/{user_id}/{uuid}.{ext}

2. Клиент → PUT url (файл, Content-Type)          # прямая загрузка в MinIO
   ← 200 OK

3. Клиент → POST /v1/places/{id}/media (temp_key)
   Backend: move uploads/{user_id}/{uuid}.ext → places/{place_id}/{uuid}.ext
   Backend: генерация миниатюры (Pillow, JPEG, max 200px) → places/{place_id}/t_{uuid}.jpg
   Backend: создание записи Media в БД (s3_key + thumb_key)
   ← {media_id, s3_key}
```

### Ограничения

- **Лимит**: 12 фотографий на точку (проверяется при presign-upload и при attach).
- **Форматы**: backend валидирует расширение и MIME-тип при presign-upload. Допустимые расширения: `jpg, jpeg, png, gif, webp` (`ALLOWED_IMAGE_EXTENSIONS`). Допустимые MIME: `image/jpeg, image/png, image/gif, image/webp` (`ALLOWED_IMAGE_MIMES`). Frontend использует `accept="image/*"`, но реальное ограничение — на стороне backend.
- **TTL presigned URL**: загрузка — 600 сек, скачивание — 300 сек.

### Миниатюры

При прикреплении фото к точке backend генерирует миниатюру через **Pillow**: JPEG, max 200×200px (`THUMB_MAX_SIZE`), EXIF-ориентация корректируется (`ImageOps.exif_transpose`). Ключ миниатюры: `places/{place_id}/t_{uuid}.jpg`.

### Пути в S3

- Временные загрузки: `uploads/{user_id}/{uuid}.{ext}`
- Финальные файлы: `places/{place_id}/{uuid}.{ext}`
- Миниатюры: `places/{place_id}/t_{uuid}.jpg`

### Валидация temp_key

Формат проверяется регулярным выражением: `^uploads/(\d+)/[0-9a-f\-]{36}\.\w{1,5}$`. Защита от path traversal и S3 key injection.

---

## Модерация

### Премодерация

- Точки в публичном слое от пользователей с ролью `user` создаются со статусом **pending**.
- Точки от `admin` / `moderator` создаются со статусом **approved**.
- При перемещении точки из личного/группового в публичный слой — статус пересчитывается.
- При перемещении из публичного в частный — статус устанавливается в **approved**.

### Постмодерация

- Пользователи отправляют **жалобы** (reports) на approved-точки.
- Одобренные точки с активными жалобами попадают в очередь модерации.
- При одобрении: жалобы → `dismissed`. При отклонении: жалобы → `upheld`.

---

## Telegram-бот

### Стек

- **aiogram 3.4.1** — async Telegram bot framework.
- **FSM (Finite State Machine)** — управление состоянием диалога.

### Команды

| Команда           | Описание                              |
|-------------------|---------------------------------------|
| `/start`          | Главное меню или подключение по deep link |
| `/start КОД`      | Подключение аккаунта                  |
| `/link КОД`       | Подключение аккаунта (альтернатива)   |
| `/mypoints`       | Последние 5 точек для редактирования  |
| `/newlayer Имя`   | Создание нового слоя                  |
| `/whoami`         | Показать Telegram ID                  |

### Reply-кнопки (клавиатура)

| Кнопка              | Действие                                  |
|---------------------|-------------------------------------------|
| «Новое место»       | Очистка FSM, запрос геолокации            |
| «Последние места»   | Аналог `/mypoints`                        |
| «Ещё»              | Inline-меню: «Создать слой», «Отключить Telegram» |

### FSM-состояния (10 состояний)

| Состояние                  | Описание                                    |
|---------------------------|---------------------------------------------|
| `waiting_group`            | Ожидание выбора слоя после отправки геолокации |
| `waiting_title`            | Ожидание ввода названия точки               |
| `waiting_note`             | Ожидание ввода описания точки               |
| `waiting_photo`            | Ожидание загрузки фото (можно несколько)    |
| `selecting_point`          | Выбор точки из списка (/mypoints)           |
| `waiting_new_group`        | Ожидание выбора нового слоя (при редактировании) |
| `waiting_new_location`     | Ожидание новой геолокации (при редактировании)   |
| `waiting_delete_photo`     | Выбор фото для удаления                    |
| `confirming_delete_point`  | Подтверждение удаления точки                |
| `waiting_new_layer_name`   | Ожидание названия нового слоя              |

### Взаимодействие с API

Все запросы к backend идут через HTTP с заголовком `X-Bot-Secret`. Используется `requests` (sync) для простоты. Timeout: 10 секунд.

---

## Docker Compose

Четыре сервиса:

| Сервис | Образ                     | Порты       | Описание                              |
|--------|---------------------------|-------------|---------------------------------------|
| `db`   | `postgis/postgis:15-3.3`  | 5432:5432   | PostgreSQL + PostGIS, healthcheck     |
| `minio`| `minio/minio:latest`      | 9000, 9001  | S3-хранилище + консоль управления     |
| `api`  | `./backend` (build)       | 8000:8000   | FastAPI, depends on db + minio        |
| `bot`  | `./bot` (build)           | —           | aiogram, depends on api               |

### Volumes

- `pgdata` — данные PostgreSQL (persistent).
- `minio_data` — данные MinIO (persistent).
- `./frontend:/app/frontend:ro` — фронтенд монтируется как read-only volume в api.

### Зависимости

```
db (healthcheck: pg_isready) ← api ← bot
minio (service_started)      ← api
```

---

## Деплой (K3s)

- **Сервер**: K3s, namespace `memory-map-ru`.
- **Процесс**: rsync → docker build → k3s ctr images import → rollout restart.

### Dockerfile.api (K3s)

```dockerfile
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend/app /app/app

# Основные файлы фронтенда (всегда в репо)
COPY frontend/index.html frontend/app.js frontend/styles.css /app/frontend/
# admin-stats.html и analytics.py — в .gitignore, копируются отдельно через deploy.sh

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

> В K3s-образе фронтенд **копируется** в образ (не volume) — при изменении `app.js` нужна пересборка.

### Dockerfile бота

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY bot.py /app/bot.py
CMD ["python", "bot.py"]
```

---

## CI

GitHub Actions: `.github/workflows/lint.yml`

Три job, запускаются параллельно на push/PR во все ветки:

### Python (Ruff)

```bash
pip install ruff
ruff check backend/ bot/
```

### Python (pytest)

```bash
pip install -r backend/requirements.txt -r backend/requirements-dev.txt
cd backend && pytest -v
```

199 интеграционных + unit-тестов. Тестовая БД — SQLite in-memory (вместо PostgreSQL). S3 и SMTP замоканы. Покрыты все 18 API-роутеров.

### JavaScript (ESLint)

```bash
cd frontend && npm install
npx eslint app.js
```

---

## Переменные окружения

Полный список переменных из `.env.example` и кода:

| Переменная                      | По умолчанию              | Описание                                   |
|---------------------------------|---------------------------|---------------------------------------------|
| `APP_BASE_URL`                  | `http://api:8000`         | Внутренний URL API (для бота)               |
| `POSTGRES_DB`                   | `memorymap`               | Имя базы данных                             |
| `POSTGRES_USER`                 | `mmuser`                  | Пользователь БД                             |
| `POSTGRES_PASSWORD`             | `mmsecret`                | Пароль БД                                   |
| `POSTGRES_HOST`                 | `db`                      | Хост БД                                     |
| `POSTGRES_PORT`                 | `5432`                    | Порт БД                                     |
| `S3_ENDPOINT`                   | `http://minio:9000`       | Внутренний URL MinIO                        |
| `S3_PUBLIC_ENDPOINT`            | —                         | Публичный URL MinIO (для presigned URLs)    |
| `S3_BUCKET`                     | `memorymap-media`         | Имя S3-бакета                               |
| `S3_ACCESS_KEY`                 | `minioadmin`              | Access key MinIO                            |
| `S3_SECRET_KEY`                 | `minioadmin`              | Secret key MinIO                            |
| `S3_REGION`                     | `us-east-1`               | Регион S3                                   |
| `S3_USE_SSL`                    | `false`                   | Использовать SSL для S3                     |
| `MEDIA_LIMIT_PER_PLACE`         | `12`                      | Максимум фотографий на точку                |
| `JWT_SECRET`                    | `change-me`               | Секрет для подписи JWT (обязательно сменить)|
| `JWT_ALG`                       | `HS256`                   | Алгоритм JWT                                |
| `JWT_EXPIRES_MINUTES`           | `1440`                    | TTL токена в минутах (24 часа)              |
| `TELEGRAM_BOT_TOKEN`            | —                         | Токен Telegram-бота от @BotFather           |
| `BOT_API_SECRET`                | `mm-secret`               | Общий секрет между ботом и API (сменить в проде) |
| `TELEGRAM_LINK_CODE_TTL_MINUTES`| `10`                      | TTL кода подключения Telegram (минуты)      |
| `SMTP_HOST`                     | —                         | SMTP-сервер (например, smtp.gmail.com)      |
| `SMTP_PORT`                     | `587`                     | Порт SMTP                                   |
| `SMTP_USER`                     | —                         | Логин SMTP                                  |
| `SMTP_PASSWORD`                 | —                         | Пароль SMTP (app password для Gmail)        |
| `SMTP_FROM`                     | —                         | Адрес отправителя email                     |
| `EMAIL_CODE_TTL_MINUTES`        | `10`                      | TTL кода подтверждения email (минуты)       |

---

## Тестирование

### Запуск тестов

```bash
# Установка зависимостей для тестов
pip install -r backend/requirements.txt
pip install -r backend/requirements-dev.txt

# Запуск всех тестов
cd backend && pytest -v

# Запуск одного файла
pytest tests/test_auth.py -v

# Запуск одного теста
pytest tests/test_auth.py::test_register_success -v
```

### Инфраструктура тестов

- **БД**: SQLite in-memory (вместо PostgreSQL + PostGIS). ORM-таблицы создаются через `Base.metadata.create_all()`, `membership` — через raw SQL.
- **S3 (MinIO)**: замокан — `presign_get/put`, `move_to_place_folder`, `generate_thumbnail`, `delete_object` возвращают заглушки.
- **SMTP**: замокан — коды подтверждения email перехватываются для использования в тестах.
- **Фикстуры**: `conftest.py` содержит `client` (TestClient), `create_user()` (регистрация + верификация + логин), `auth_headers()`.

### Покрытие

| Файл                     | Количество тестов | Что покрыто                                        |
|--------------------------|:-----------------:|----------------------------------------------------|
| `test_auth.py`           | 23                | Регистрация, верификация, логин, сброс пароля      |
| `test_me.py`             | 21                | Профиль, смена пароля/логина/email, удаление       |
| `test_places.py`         | 15                | CRUD точек, модерация, bbox, feed                  |
| `test_groups.py`         | 16                | Группы, участники, права, удаление                 |
| `test_friends.py`        | 17                | Запросы дружбы, принятие, отклонение, удаление     |
| `test_group_invites.py`  | 10                | Приглашения в группы, принятие, отклонение          |
| `test_comments.py`       | 12                | Комментарии, треды, редактирование, удаление       |
| `test_notifications.py`  | 6                 | Список уведомлений, пометка прочитанными           |
| `test_moderation.py`     | 11                | Модерация, жалобы, одобрение, отклонение           |
| `test_blocks.py`         | 7                 | Блокировка, разблокировка, побочные эффекты        |
| `test_media.py`          | 7                 | Presign upload/download, удаление                  |
| `test_users.py`          | 3                 | Поиск пользователей                                |
| `test_admin.py`          | 7                 | Управление ролями, авто-одобрение pending           |
| `test_layers.py`         | 3                 | Список слоёв                                       |
| `test_bot.py`            | 27                | Bot API: link, группы, создание/удаление точек     |
| `test_utils.py`          | 14                | validate_temp_key, detect_mime, JWT                 |

**Итого: 199 тестов**, 16 файлов, все 18 API-роутеров покрыты.

### Линтеры

```bash
# Python (Ruff) — запускается в CI
ruff check backend/ bot/

# JavaScript (ESLint) — запускается в CI
cd frontend && npx eslint app.js
```

---

## Запуск для разработки

```bash
# 1. Скопировать и заполнить переменные окружения
cp .env.example .env
# Обязательно заполнить: TELEGRAM_BOT_TOKEN, BOT_API_SECRET, JWT_SECRET
# Для email-подтверждения: SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM

# 2. Запустить все сервисы
docker compose up -d --build
```

После запуска:

| Сервис          | URL                         |
|-----------------|-----------------------------|
| Web UI          | http://localhost:8000        |
| MinIO Console   | http://localhost:9001        |
| PostgreSQL      | localhost:5432               |

### Линтеры (перед коммитом)

```bash
# Python (Ruff)
docker compose exec api ruff check backend/ bot/

# JavaScript (ESLint)
cd frontend && npx eslint app.js
```
