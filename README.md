# MemoryMap — PoC/MVP Starter

Прототип: FastAPI + Postgres/PostGIS + Redis + MinIO (S3) + Telegram bot + карта (MapLibre).

## Запуск
```
cp .env.example .env
# Укажите TELEGRAM_BOT_TOKEN.
docker compose up -d --build
```

- API/Frontend: http://localhost:8000
- MinIO console: http://localhost:9001 (minioadmin/minioadmin)
- Postgres: localhost:5432
- Redis: localhost:6379

### Создайте бакет
В MinIO Console создайте bucket `memorymap-media` (если не создан).

### Проверка
1. Откройте http://localhost:8000 - карта Москвы.
2. Откройте бот `@memorymap_bot`
2. Отправьте боту **геолокацию** - появится точка.
3. Отправьте боту **фото** - загрузится в S3 по presigned PUT.

## Эндпойнты
- `GET /healthz`
- `POST /v1/media/presign-upload {mime, ext?}` → `{key, url}`
- `GET /v1/media/presign-download?key=...`
- `POST /v1/places {group_id, lat, lon, title?, note?}`
- `GET /v1/places?group_id=1&bbox=left,bottom,right,top`
