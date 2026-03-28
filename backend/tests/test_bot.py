"""Тесты: bot API endpoints."""

import os

from tests.conftest import auth_headers, create_user

BOT_SECRET = os.environ.get("BOT_API_SECRET", "test-bot-secret")


def _bot_headers():
    return {"X-Bot-Secret": BOT_SECRET}


def test_bot_link_telegram(client):
    """Привязка Telegram через deep link код."""
    token, uid = create_user(client, "botlink", "botlink@example.com")

    # Генерируем код через API
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]

    # Привязываем через бот
    r = client.post("/v1/bot/link-telegram", json={
        "code": code,
        "tg_id": 12345,
    }, headers=_bot_headers())
    assert r.status_code == 200
    assert r.json()["tg_id"] == 12345


def test_bot_link_code_not_found(client):
    r = client.post("/v1/bot/link-telegram", json={
        "code": "nonexistent",
        "tg_id": 99999,
    }, headers=_bot_headers())
    assert r.status_code == 404


def test_bot_link_tg_id_taken(client):
    """tg_id уже привязан к другому пользователю."""
    token1, _ = create_user(client, "bottak1", "bottak1@example.com")
    token2, _ = create_user(client, "bottak2", "bottak2@example.com")

    # Привязываем tg_id к первому
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token1))
    code1 = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code1, "tg_id": 80001,
    }, headers=_bot_headers())

    # Пытаемся привязать тот же tg_id ко второму
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token2))
    code2 = r.json()["code"]
    r = client.post("/v1/bot/link-telegram", json={
        "code": code2, "tg_id": 80001,
    }, headers=_bot_headers())
    assert r.status_code == 409
    assert r.json()["detail"] == "tg_id_taken"


def test_bot_link_code_used(client):
    """Повторное использование кода → 409."""
    token, _ = create_user(client, "botused", "botused@example.com")

    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]

    # Первый раз — ок
    r = client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 80002,
    }, headers=_bot_headers())
    assert r.status_code == 200

    # Второй раз — код уже использован
    r = client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 80003,
    }, headers=_bot_headers())
    assert r.status_code == 409
    assert r.json()["detail"] == "code_used"


def test_bot_link_code_expired(client):
    """Просроченный код → 400."""
    from datetime import datetime, timedelta, timezone

    from app.core.deps import get_db
    from app.models.models import TelegramLinkCode

    token, _ = create_user(client, "botexp", "botexp@example.com")

    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]

    # Вручную выставляем expires_at в прошлое
    db = next(client.app.dependency_overrides[get_db]())
    row = db.query(TelegramLinkCode).filter(TelegramLinkCode.code == code).one()
    row.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db.commit()

    r = client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 80004,
    }, headers=_bot_headers())
    assert r.status_code == 400
    assert r.json()["detail"] == "code_expired"


def test_bot_list_groups(client):
    """Список групп через бот."""
    token, uid = create_user(client, "botgrp", "botgrp@example.com")

    # Привязываем tg_id
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 11111,
    }, headers=_bot_headers())

    r = client.get(
        "/v1/bot/groups",
        params={"tg_id": 11111},
        headers=_bot_headers(),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1


def test_bot_without_secret_forbidden(client):
    r = client.post("/v1/bot/link-telegram", json={
        "code": "test",
        "tg_id": 1,
    })
    assert r.status_code == 403


def test_bot_wrong_secret_forbidden(client):
    r = client.post("/v1/bot/link-telegram", json={
        "code": "test",
        "tg_id": 1,
    }, headers={"X-Bot-Secret": "wrong-secret"})
    assert r.status_code == 403


def test_bot_create_place(client):
    """Создание точки через бот."""
    token, uid = create_user(client, "botplace", "botplace@example.com")

    # Привязываем tg_id
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 22222,
    }, headers=_bot_headers())

    # Получаем группу
    r = client.get("/v1/bot/groups", params={"tg_id": 22222}, headers=_bot_headers())
    gid = r.json()["items"][0]["id"]

    # Создаём точку
    r = client.post("/v1/places/bot", json={
        "group_id": gid,
        "tg_id": 22222,
        "title": "Bot Point",
        "lat": 55.75,
        "lon": 37.61,
    }, headers=_bot_headers())
    assert r.status_code == 200
    pid = r.json()["id"]

    # Проверяем что точка сохранилась с правильными данными
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["title"] == "Bot Point"
    assert r.json()["lat"] == 55.75
    assert r.json()["lon"] == 37.61


def test_bot_list_places(client):
    """Список точек через бот."""
    token, uid = create_user(client, "botlistpl", "botlistpl@example.com")

    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 33333,
    }, headers=_bot_headers())

    # Создаём точку через API
    r = client.get("/v1/me", headers=auth_headers(token))
    gid = next(g["id"] for g in r.json()["groups"] if g.get("is_personal"))
    client.post("/v1/places", json={
        "group_id": gid, "title": "My bot point", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))

    r = client.get("/v1/bot/places", params={"tg_id": 33333}, headers=_bot_headers())
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1


def test_bot_delete_place(client):
    """Удаление точки через бот."""
    token, uid = create_user(client, "botdelpl", "botdelpl@example.com")

    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 44444,
    }, headers=_bot_headers())

    r = client.get("/v1/bot/groups", params={"tg_id": 44444}, headers=_bot_headers())
    gid = r.json()["items"][0]["id"]

    r = client.post("/v1/places/bot", json={
        "group_id": gid, "tg_id": 44444, "title": "To delete", "lat": 55.0, "lon": 37.0,
    }, headers=_bot_headers())
    pid = r.json()["id"]

    r = client.delete(
        f"/v1/bot/places/{pid}",
        params={"tg_id": 44444},
        headers=_bot_headers(),
    )
    assert r.status_code == 200

    # Проверяем что точка удалена
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.status_code == 404


def test_bot_create_group(client):
    """Создание слоя через бот."""
    token, uid = create_user(client, "botcgrp", "botcgrp@example.com")

    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 55555,
    }, headers=_bot_headers())

    r = client.post("/v1/bot/groups", json={
        "tg_id": 55555,
        "name": "Bot Layer",
        "visibility": "private",
    }, headers=_bot_headers())
    assert r.status_code == 200
    data = r.json()
    assert "id" in data
    assert data["name"] == "Bot Layer"

    # Проверяем что группа появилась в списке
    r = client.get("/v1/bot/groups", params={"tg_id": 55555}, headers=_bot_headers())
    names = [g["name"] for g in r.json()["items"]]
    assert "Bot Layer" in names


# ---------- Хелпер: привязать tg_id к юзеру ----------

def _link_tg(client, token, tg_id):
    """Привязывает tg_id к юзеру через deep link flow."""
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": tg_id,
    }, headers=_bot_headers())


def _create_bot_place(client, tg_id):
    """Создаёт точку через бот, возвращает (place_id, group_id)."""
    r = client.get("/v1/bot/groups", params={"tg_id": tg_id}, headers=_bot_headers())
    gid = r.json()["items"][0]["id"]
    r = client.post("/v1/places/bot", json={
        "group_id": gid, "tg_id": tg_id, "title": "Bot Place", "lat": 55.0, "lon": 37.0,
    }, headers=_bot_headers())
    return r.json()["id"], gid


# ---------- Presign upload через бот ----------

def test_bot_presign_upload(client):
    """Presign upload фото через бот."""
    token, _ = create_user(client, "botpresign", "botpresign@example.com")
    _link_tg(client, token, 60001)
    pid, _ = _create_bot_place(client, 60001)

    r = client.post("/v1/bot/media/presign-upload", json={
        "mime": "image/jpeg",
        "ext": "jpg",
        "place_id": pid,
    }, headers=_bot_headers())
    assert r.status_code == 200
    data = r.json()
    assert "key" in data
    assert "url" in data


def test_bot_presign_upload_invalid_ext(client):
    """Presign upload с невалидным расширением."""
    token, _ = create_user(client, "botbadext", "botbadext@example.com")
    _link_tg(client, token, 60002)
    pid, _ = _create_bot_place(client, 60002)

    r = client.post("/v1/bot/media/presign-upload", json={
        "mime": "image/jpeg",
        "ext": "exe",
        "place_id": pid,
    }, headers=_bot_headers())
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_extension"


# ---------- Отвязка Telegram через бот ----------

def test_bot_unlink_telegram(client):
    """Отвязка Telegram через бот API."""
    token, _ = create_user(client, "botunlink", "botunlink@example.com")
    _link_tg(client, token, 60003)

    r = client.delete(
        "/v1/bot/unlink-telegram",
        params={"tg_id": 60003},
        headers=_bot_headers(),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_bot_unlink_not_linked(client):
    """Отвязка Telegram для несуществующего tg_id."""
    r = client.delete(
        "/v1/bot/unlink-telegram",
        params={"tg_id": 99999},
        headers=_bot_headers(),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "telegram_not_linked"


# ---------- Редактирование точки через бот ----------

def test_bot_update_place(client):
    """Редактирование точки через бот."""
    token, _ = create_user(client, "botupd", "botupd@example.com")
    _link_tg(client, token, 60004)
    pid, _ = _create_bot_place(client, 60004)

    r = client.patch(f"/v1/bot/places/{pid}", json={
        "tg_id": 60004,
        "title": "Updated Title",
        "note": "New note",
    }, headers=_bot_headers())
    assert r.status_code == 200
    assert r.json()["ok"] is True

    # Проверяем что title изменился (note не возвращается в GET /places/{id})
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.json()["title"] == "Updated Title"


def test_bot_update_place_wrong_owner(client):
    """Редактирование чужой точки через бот — 403."""
    token1, _ = create_user(client, "botupdown", "botupdown@example.com")
    token2, _ = create_user(client, "botupd2", "botupd2@example.com")
    _link_tg(client, token1, 60005)
    _link_tg(client, token2, 60006)
    pid, _ = _create_bot_place(client, 60005)

    r = client.patch(f"/v1/bot/places/{pid}", json={
        "tg_id": 60006,
        "title": "Hacked",
    }, headers=_bot_headers())
    assert r.status_code == 403


# ---------- Медиа точки через бот ----------

def test_bot_get_place_media(client):
    """Получение списка медиа через бот."""
    token, _ = create_user(client, "botmedia", "botmedia@example.com")
    _link_tg(client, token, 60007)
    pid, _ = _create_bot_place(client, 60007)

    r = client.get(
        f"/v1/bot/places/{pid}/media",
        params={"tg_id": 60007},
        headers=_bot_headers(),
    )
    assert r.status_code == 200
    assert "items" in r.json()


def test_bot_link_media_to_place(client):
    """Привязка загруженного фото к точке через бот."""
    token, uid = create_user(client, "botlinkmedia", "botlinkmedia@example.com")
    _link_tg(client, token, 60008)
    pid, _ = _create_bot_place(client, 60008)

    r = client.post(f"/v1/bot/places/{pid}/media", json={
        "tg_id": 60008,
        "temp_key": f"uploads/{uid}/550e8400-e29b-41d4-a716-446655440000.jpg",
    }, headers=_bot_headers())
    assert r.status_code == 200
    assert "id" in r.json()


def test_bot_delete_media(client):
    """Удаление медиа через бот."""
    token, uid = create_user(client, "botdelmedia", "botdelmedia@example.com")
    _link_tg(client, token, 60009)
    pid, _ = _create_bot_place(client, 60009)

    # Привязываем медиа
    r = client.post(f"/v1/bot/places/{pid}/media", json={
        "tg_id": 60009,
        "temp_key": f"uploads/{uid}/550e8400-e29b-41d4-a716-446655440000.jpg",
    }, headers=_bot_headers())
    mid = r.json()["id"]

    # Удаляем
    r = client.delete(
        f"/v1/bot/media/{mid}",
        params={"tg_id": 60009},
        headers=_bot_headers(),
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    # Проверяем что медиа удалено (список пуст)
    r = client.get(
        f"/v1/bot/places/{pid}/media",
        params={"tg_id": 60009},
        headers=_bot_headers(),
    )
    assert r.status_code == 200
    assert len(r.json()["items"]) == 0


# ---------- Error cases ----------

def test_bot_delete_place_nonexistent(client):
    """Удаление несуществующей точки через бот → 404."""
    token, _ = create_user(client, "botdel404", "botdel404@example.com")
    _link_tg(client, token, 70001)

    r = client.delete(
        "/v1/bot/places/99999",
        params={"tg_id": 70001},
        headers=_bot_headers(),
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_bot_delete_place_wrong_owner(client):
    """Удаление чужой точки через бот → 403."""
    token1, _ = create_user(client, "botdelown1", "botdelown1@example.com")
    token2, _ = create_user(client, "botdelown2", "botdelown2@example.com")
    _link_tg(client, token1, 70002)
    _link_tg(client, token2, 70003)
    pid, _ = _create_bot_place(client, 70002)

    r = client.delete(
        f"/v1/bot/places/{pid}",
        params={"tg_id": 70003},
        headers=_bot_headers(),
    )
    assert r.status_code == 403


def test_bot_patch_place_nonexistent(client):
    """Редактирование несуществующей точки → 404."""
    r = client.patch("/v1/bot/places/99999", json={
        "tg_id": 70001, "title": "Nope",
    }, headers=_bot_headers())
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_bot_get_media_nonexistent(client):
    """Получение медиа несуществующей точки → 404."""
    r = client.get(
        "/v1/bot/places/99999/media",
        params={"tg_id": 70001},
        headers=_bot_headers(),
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_bot_delete_media_nonexistent(client):
    """Удаление несуществующего медиа → 404."""
    r = client.delete(
        "/v1/bot/media/99999",
        params={"tg_id": 70001},
        headers=_bot_headers(),
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_bot_list_places_not_linked(client):
    """Список точек для непривязанного tg_id → 400."""
    r = client.get(
        "/v1/bot/places",
        params={"tg_id": 88888},
        headers=_bot_headers(),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "telegram_not_linked"
