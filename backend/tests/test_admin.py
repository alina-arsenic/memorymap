"""Тесты: управление ролями (admin)."""

from app.core.deps import get_db
from app.models.models import Group

from tests.conftest import auth_headers, create_user


def test_list_users_as_admin(client):
    token_admin, _ = create_user(client, "admlst", "admlst@example.com")
    create_user(client, "admlst2", "admlst2@example.com")

    r = client.get("/v1/admin/users", headers=auth_headers(token_admin))
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 2
    # Admin видит PII
    assert "email" in items[0]


def test_list_users_not_admin(client):
    create_user(client, "admforbid1", "admforbid1@example.com")  # admin (первый)
    token2, _ = create_user(client, "admforbid2", "admforbid2@example.com")  # user

    r = client.get("/v1/admin/users", headers=auth_headers(token2))
    assert r.status_code == 403


def test_set_role_to_moderator(client):
    token_admin, _ = create_user(client, "admrole1", "admrole1@example.com")
    _, uid2 = create_user(client, "admrole2", "admrole2@example.com")

    r = client.patch(f"/v1/admin/users/{uid2}/role", json={
        "role": "moderator",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200
    assert r.json()["role"] == "moderator"

    # Проверяем что роль сохранилась
    r = client.get("/v1/admin/users", headers=auth_headers(token_admin))
    target = next(u for u in r.json()["items"] if u["id"] == uid2)
    assert target["role"] == "moderator"


def test_list_users_as_moderator_no_pii(client):
    """Moderator может получить список юзеров, но без PII (email, tg_id)."""
    token_admin, _ = create_user(client, "admpii1", "admpii1@example.com")
    _, uid2 = create_user(client, "admpii2", "admpii2@example.com")

    # Повышаем до moderator
    r = client.patch(f"/v1/admin/users/{uid2}/role", json={
        "role": "moderator",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200

    # Логинимся как moderator
    r = client.post("/v1/auth/login", json={
        "login": "admpii2", "password": "TestPass123",
    })
    token_mod = r.json()["access_token"]

    # Moderator видит список юзеров
    r = client.get("/v1/admin/users", headers=auth_headers(token_mod))
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) >= 2

    # Но НЕ видит PII
    assert "email" not in items[0]
    assert "tg_id" not in items[0]
    # Видит login и role
    assert "login" in items[0]
    assert "role" in items[0]


def test_set_role_not_admin_fails(client):
    create_user(client, "admnonadm1", "admnonadm1@example.com")  # admin
    token2, uid2 = create_user(client, "admnonadm2", "admnonadm2@example.com")  # user
    _, uid3 = create_user(client, "admnonadm3", "admnonadm3@example.com")  # user

    r = client.patch(f"/v1/admin/users/{uid3}/role", json={
        "role": "moderator",
    }, headers=auth_headers(token2))
    assert r.status_code == 403


def test_cannot_change_own_role(client):
    token_admin, uid_admin = create_user(client, "admself", "admself@example.com")
    r = client.patch(f"/v1/admin/users/{uid_admin}/role", json={
        "role": "user",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 400
    assert r.json()["detail"] == "cannot_change_own_role"


def test_promote_to_moderator_auto_approves_pending(client):
    """Повышение до moderator автоматически одобряет pending-точки юзера."""
    token_admin, uid_admin = create_user(client, "admpromo1", "admpromo1@example.com")
    token_user, uid_user = create_user(client, "admpromo2", "admpromo2@example.com")

    # Создаём публичную группу
    db = next(client.app.dependency_overrides[get_db]())
    g = Group(name="Promo Public", visibility="public", owner_id=uid_admin, is_personal=False)
    db.add(g)
    db.commit()
    db.refresh(g)

    # Обычный юзер создаёт точку → pending
    r = client.post("/v1/places", json={
        "group_id": g.id,
        "title": "Pending Promo",
        "lat": 55.0,
        "lon": 37.0,
    }, headers=auth_headers(token_user))
    place_id = r.json()["id"]

    # Проверяем что точка pending
    r = client.get(
        "/v1/places",
        params={"group_id": g.id, "bbox": "36,54,38,56"},
        headers=auth_headers(token_user),
    )
    place = next(p for p in r.json()["items"] if p["id"] == place_id)
    assert place["moderation_status"] == "pending"

    # Повышаем до moderator
    r = client.patch(f"/v1/admin/users/{uid_user}/role", json={
        "role": "moderator",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200

    # Проверяем что точка стала approved
    r = client.get(
        "/v1/places",
        params={"group_id": g.id, "bbox": "36,54,38,56"},
        headers=auth_headers(token_user),
    )
    place = next(p for p in r.json()["items"] if p["id"] == place_id)
    assert place["moderation_status"] == "approved"
