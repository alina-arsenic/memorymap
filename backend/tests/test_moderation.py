"""Тесты: модерация и жалобы."""

from app.core.deps import get_db
from app.models.models import Group

from tests.conftest import auth_headers, create_user


def _setup_moderation(client):
    """Создаёт admin + обычного юзера + публичную группу + pending-точку."""
    token_admin, uid_admin = create_user(client, "modadmin", "modadmin@example.com")
    token_user, uid_user = create_user(client, "moduser", "moduser@example.com")

    # Создаём публичную группу
    db = next(client.app.dependency_overrides[get_db]())
    g = Group(name="Mod Public", visibility="public", owner_id=uid_admin, is_personal=False)
    db.add(g)
    db.commit()
    db.refresh(g)
    pub_gid = g.id

    # Обычный юзер создаёт точку → pending
    r = client.post("/v1/places", json={
        "group_id": pub_gid,
        "title": "Pending Point",
        "lat": 55.0,
        "lon": 37.0,
    }, headers=auth_headers(token_user))
    place_id = r.json()["id"]

    return token_admin, uid_admin, token_user, uid_user, pub_gid, place_id


def test_list_pending_places(client):
    token_admin, _, _, _, _, _ = _setup_moderation(client)

    r = client.get(
        "/v1/moderation/places",
        params={"status": "pending"},
        headers=auth_headers(token_admin),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1


def test_approve_place(client):
    token_admin, _, _, _, _, place_id = _setup_moderation(client)

    r = client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "approved",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200
    assert r.json()["moderation_status"] == "approved"


def test_reject_place(client):
    token_admin, _, _, _, _, place_id = _setup_moderation(client)

    r = client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "rejected",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200
    assert r.json()["moderation_status"] == "rejected"


def test_moderation_requires_role(client):
    """Обычный юзер не может модерировать."""
    _, _, token_user, _, _, _ = _setup_moderation(client)

    r = client.get(
        "/v1/moderation/places",
        headers=auth_headers(token_user),
    )
    assert r.status_code == 403


def test_report_place(client):
    """Жалоба на точку."""
    token_admin, uid_admin, token_user, uid_user, pub_gid, place_id = _setup_moderation(client)

    # Сначала одобряем точку (жалоба только на approved)
    client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "approved",
    }, headers=auth_headers(token_admin))

    # Admin жалуется на точку юзера (не своя)
    r = client.post(f"/v1/places/{place_id}/report", json={
        "category": "spam",
        "comment": "Это спам",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_report_own_place_fails(client):
    """Нельзя жаловаться на свою точку."""
    token_admin, uid_admin, token_user, uid_user, pub_gid, place_id = _setup_moderation(client)

    # Одобряем
    client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "approved",
    }, headers=auth_headers(token_admin))

    # Юзер жалуется на свою точку
    r = client.post(f"/v1/places/{place_id}/report", json={
        "category": "spam",
    }, headers=auth_headers(token_user))
    assert r.status_code == 400
    assert r.json()["detail"] == "cannot_report_own_place"


def test_report_invalid_category(client):
    """Жалоба с невалидной категорией → 400."""
    token_admin, _, token_user, _, _, place_id = _setup_moderation(client)
    client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "approved",
    }, headers=auth_headers(token_admin))

    r = client.post(f"/v1/places/{place_id}/report", json={
        "category": "nonexistent_category",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_category"


def test_report_place_not_approved(client):
    """Жалоба на pending-точку → 400."""
    token_admin, _, token_user, _, _, place_id = _setup_moderation(client)

    # Точка pending — жалоба запрещена
    r = client.post(f"/v1/places/{place_id}/report", json={
        "category": "spam",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 400
    assert r.json()["detail"] == "place_not_approved"


def test_report_already_reported(client):
    """Повторная жалоба от того же юзера → already_reported."""
    token_admin, _, token_user, _, _, place_id = _setup_moderation(client)
    client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "approved",
    }, headers=auth_headers(token_admin))

    # Первая жалоба — ок
    r = client.post(f"/v1/places/{place_id}/report", json={
        "category": "spam",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200

    # Повторная жалоба
    r = client.post(f"/v1/places/{place_id}/report", json={
        "category": "offensive",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 400
    assert r.json()["detail"] == "already_reported"


def test_report_nonexistent_place(client):
    """Жалоба на несуществующую точку → 404."""
    token, _ = create_user(client, "modrep404", "modrep404@example.com")
    r = client.post("/v1/places/99999/report", json={
        "category": "spam",
    }, headers=auth_headers(token))
    assert r.status_code == 404
    assert r.json()["detail"] == "place_not_found"


def test_approve_resolves_reports(client):
    """Одобрение точки резолвит pending-жалобы."""
    token_admin, _, token_user, _, pub_gid, place_id = _setup_moderation(client)

    # Одобряем, жалуемся, потом одобряем снова
    client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "approved",
    }, headers=auth_headers(token_admin))

    client.post(f"/v1/places/{place_id}/report", json={
        "category": "spam",
        "comment": "Test report",
    }, headers=auth_headers(token_admin))

    # Повторное одобрение → жалобы dismissed
    r = client.patch(f"/v1/moderation/places/{place_id}", json={
        "status": "approved",
    }, headers=auth_headers(token_admin))
    assert r.status_code == 200

    # Проверяем что жалоба уже не pending (через модерацию)
    r = client.get(
        "/v1/moderation/places",
        params={"status": "pending"},
        headers=auth_headers(token_admin),
    )
    place_ids = [p["id"] for p in r.json()["items"]]
    assert place_id not in place_ids
