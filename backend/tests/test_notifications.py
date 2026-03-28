"""Тесты: уведомления."""

from app.core.deps import get_db
from app.models.models import Group

from tests.conftest import auth_headers, create_user


def _create_public_place(client, token):
    """Создаёт точку в публичной группе (для комментариев)."""
    db = next(client.app.dependency_overrides[get_db]())
    g = Group(name="Notif Test", visibility="public", owner_id=None, is_personal=False)
    db.add(g)
    db.commit()
    db.refresh(g)

    r = client.post("/v1/places", json={
        "group_id": g.id, "title": "Notif Place", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    return r.json()["id"]


def test_list_notifications_empty(client):
    token, _ = create_user(client, "notifempty", "notifempty@example.com")
    r = client.get("/v1/notifications", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_mark_all_read(client):
    """Пометить все уведомления прочитанными (с реальным уведомлением)."""
    token1, _ = create_user(client, "notifread", "notifread@example.com")
    token2, _ = create_user(client, "notifread2", "notifread2@example.com")

    # Создаём уведомление через комментарий
    pid = _create_public_place(client, token1)
    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Trigger notification",
    }, headers=auth_headers(token2))
    assert r.status_code == 200

    # Проверяем что уведомление создано и не прочитано
    r = client.get("/v1/notifications", headers=auth_headers(token1))
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["is_read"] is False

    # Помечаем все прочитанными
    r = client.patch("/v1/notifications/read-all", headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["updated"] >= 1

    # Проверяем что уведомление стало прочитанным
    r = client.get("/v1/notifications", headers=auth_headers(token1))
    assert r.json()["items"][0]["is_read"] is True


def test_comment_creates_notification(client):
    """Комментарий к чужой точке создаёт уведомление владельцу."""
    token1, uid1 = create_user(client, "notifown", "notifown@example.com")
    token2, uid2 = create_user(client, "notifcomm", "notifcomm@example.com")

    # Создаём точку в публичной группе (комментарии запрещены в личных)
    pid = _create_public_place(client, token1)

    # Второй комментирует
    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Nice place!",
    }, headers=auth_headers(token2))
    assert r.status_code == 200

    # Первый проверяет уведомления
    r = client.get("/v1/notifications", headers=auth_headers(token1))
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    # Проверяем содержимое уведомления
    notif = items[0]
    assert notif["type"] == "comment_on_place"
    assert notif["actor_login"] == "notifcomm"
    assert notif["place_id"] == pid
    assert notif["is_read"] is False


def test_mark_single_notification_read(client):
    """Пометить одно уведомление прочитанным."""
    token1, _ = create_user(client, "notif1own", "notif1own@example.com")
    token2, _ = create_user(client, "notif1comm", "notif1comm@example.com")

    # Публичная группа (комментарии запрещены в личных)
    pid = _create_public_place(client, token1)

    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Comment!",
    }, headers=auth_headers(token2))
    assert r.status_code == 200

    r = client.get("/v1/notifications", headers=auth_headers(token1))
    items = r.json()["items"]
    assert len(items) == 1, "Уведомление о комментарии не создано"
    nid = items[0]["id"]
    r = client.patch(
        f"/v1/notifications/{nid}/read",
        headers=auth_headers(token1),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    # Проверяем что уведомление стало прочитанным
    r = client.get("/v1/notifications", headers=auth_headers(token1))
    notif = next(n for n in r.json()["items"] if n["id"] == nid)
    assert notif["is_read"] is True


def test_mark_nonexistent_notification(client):
    """Пометить несуществующее уведомление → 404."""
    token, _ = create_user(client, "notif404", "notif404@example.com")
    r = client.patch("/v1/notifications/99999/read", headers=auth_headers(token))
    assert r.status_code == 404
    assert r.json()["detail"] == "notification_not_found"


def test_notifications_unauthenticated(client):
    r = client.get("/v1/notifications")
    assert r.status_code == 401
