"""Т��сты: CRUD точек, модерация, медиа."""

from app.core.deps import get_db
from app.models.models import Group

from tests.conftest import auth_headers, create_user


def _get_personal_group_id(client, token):
    """Получает ID личной группы пользователя."""
    r = client.get("/v1/me", headers=auth_headers(token))
    groups = r.json()["groups"]
    for g in groups:
        if g.get("is_personal"):
            return g["id"]
    raise AssertionError("Personal group not found")


def _create_public_group(db):
    """Создаёт публичную группу напрямую в БД."""
    g = Group(name="Public Test", visibility="public", owner_id=None, is_personal=False)
    db.add(g)
    db.commit()
    db.refresh(g)
    return g.id


def test_create_place_personal_group(client):
    """Точка в личной группе → auto-approved."""
    token, uid = create_user(client, "placeuser", "placeuser@example.com")
    gid = _get_personal_group_id(client, token)
    assert gid is not None

    r = client.post("/v1/places", json={
        "group_id": gid,
        "title": "Моя точка",
        "note": "Заметка",
        "lat": 55.75,
        "lon": 37.61,
    }, headers=auth_headers(token))
    assert r.status_code == 200
    pid = r.json()["id"]

    # Проверяем что точка сохранилась
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["title"] == "Моя точка"
    assert r.json()["lat"] == 55.75
    assert r.json()["lon"] == 37.61


def test_create_place_public_group_pending(client):
    """Точка в публичной группе обычным юзером → pending."""
    # Создаём admin и обычного юзера
    token_admin, _ = create_user(client, "padmin", "padmin@example.com")
    token_user, uid_user = create_user(client, "puser", "puser@example.com")

    # Создаём публичную группу
    db = next(client.app.dependency_overrides[get_db]())
    pub_gid = _create_public_group(db)

    r = client.post("/v1/places", json={
        "group_id": pub_gid,
        "title": "Публичная точка",
        "lat": 55.75,
        "lon": 37.61,
    }, headers=auth_headers(token_user))
    assert r.status_code == 200
    place_id = r.json()["id"]

    # Проверяем статус модерации через feed
    r = client.get(
        "/v1/places",
        params={"group_id": pub_gid, "bbox": "37,55,38,56"},
        headers=auth_headers(token_user),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    own_place = [i for i in items if i["id"] == place_id]
    assert len(own_place) == 1
    assert own_place[0]["moderation_status"] == "pending"


def test_list_places_by_bbox(client):
    token, _ = create_user(client, "bboxuser", "bboxuser@example.com")
    gid = _get_personal_group_id(client, token)

    # Создаём точку в bbox
    client.post("/v1/places", json={
        "group_id": gid, "title": "Inside", "lat": 55.75, "lon": 37.61,
    }, headers=auth_headers(token))

    # Создаём точку вне bbox
    client.post("/v1/places", json={
        "group_id": gid, "title": "Outside", "lat": 10.0, "lon": 10.0,
    }, headers=auth_headers(token))

    r = client.get(
        "/v1/places",
        params={"group_id": gid, "bbox": "37,55,38,56"},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    titles = [i["title"] for i in items]
    assert "Inside" in titles
    assert "Outside" not in titles


def test_list_places_feed(client):
    token, _ = create_user(client, "feeduser", "feeduser@example.com")
    gid = _get_personal_group_id(client, token)

    client.post("/v1/places", json={
        "group_id": gid, "title": "Feed Point", "lat": 55.75, "lon": 37.61,
    }, headers=auth_headers(token))

    r = client.get(
        "/v1/places/feed",
        params={"bbox": "37,55,38,56", "scope": "mine"},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["title"] == "Feed Point"


def test_get_place_by_id(client):
    token, _ = create_user(client, "getplace", "getplace@example.com")
    gid = _get_personal_group_id(client, token)

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Single", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    pid = r.json()["id"]

    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["title"] == "Single"


def test_update_place(client):
    token, _ = create_user(client, "updateplace", "updateplace@example.com")
    gid = _get_personal_group_id(client, token)

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Original", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    pid = r.json()["id"]

    r = client.patch(f"/v1/places/{pid}", json={
        "title": "Updated",
        "note": "New note",
    }, headers=auth_headers(token))
    assert r.status_code == 200

    # Проверяем что title изменился (note не возвращается в GET /places/{id})
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.json()["title"] == "Updated"


def test_update_place_not_owner(client):
    token1, _ = create_user(client, "owner1", "owner1@example.com")
    token2, _ = create_user(client, "notowner", "notowner@example.com")
    gid = _get_personal_group_id(client, token1)

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Owner place", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token1))
    pid = r.json()["id"]

    r = client.patch(f"/v1/places/{pid}", json={
        "title": "Hacked",
    }, headers=auth_headers(token2))
    assert r.status_code == 403


def test_delete_place(client):
    token, _ = create_user(client, "delplace", "delplace@example.com")
    gid = _get_personal_group_id(client, token)

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "To delete", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    pid = r.json()["id"]

    r = client.delete(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.status_code == 200

    # Проверяем, что точка удалена
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.status_code == 404


def test_delete_place_not_owner(client):
    token1, _ = create_user(client, "delowner", "delowner@example.com")
    token2, _ = create_user(client, "delnot", "delnot@example.com")
    gid = _get_personal_group_id(client, token1)

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Protected", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token1))
    pid = r.json()["id"]

    r = client.delete(f"/v1/places/{pid}", headers=auth_headers(token2))
    assert r.status_code == 403


def test_create_place_nonexistent_group(client):
    token, _ = create_user(client, "nogroup", "nogroup@example.com")
    r = client.post("/v1/places", json={
        "group_id": 99999,
        "title": "Nowhere",
        "lat": 55.0,
        "lon": 37.0,
    }, headers=auth_headers(token))
    assert r.status_code == 404


def test_add_media_to_place(client):
    token, uid = create_user(client, "mediaplace", "mediaplace@example.com")
    gid = _get_personal_group_id(client, token)

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "With media", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    pid = r.json()["id"]

    r = client.post(f"/v1/places/{pid}/media", json={
        "temp_key": f"uploads/{uid}/550e8400-e29b-41d4-a716-446655440000.jpg",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    assert "id" in r.json()


def test_admin_can_delete_any_place(client):
    """Админ может удалить чужую точку."""
    token_admin, _ = create_user(client, "admdelpl1", "admdelpl1@example.com")
    token_user, _ = create_user(client, "admdelpl2", "admdelpl2@example.com")
    gid = _get_personal_group_id(client, token_user)

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "User Place", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token_user))
    pid = r.json()["id"]

    # Админ удаляет чужую точку
    r = client.delete(f"/v1/places/{pid}", headers=auth_headers(token_admin))
    assert r.status_code == 200

    # Проверяем что точка удалена
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token_admin))
    assert r.status_code == 404


# ---------- Error cases ----------

def test_get_place_nonexistent(client):
    """Получение несуществующей точки → 404."""
    token, _ = create_user(client, "place404", "place404@example.com")
    r = client.get("/v1/places/99999", headers=auth_headers(token))
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_update_place_nonexistent(client):
    """Обновление несуществующей точки → 404."""
    token, _ = create_user(client, "upd404", "upd404@example.com")
    r = client.patch("/v1/places/99999", json={
        "title": "Nope",
    }, headers=auth_headers(token))
    assert r.status_code == 404


def test_delete_place_nonexistent(client):
    """Удаление несуществующей точки → 403 (no access)."""
    token, _ = create_user(client, "del404", "del404@example.com")
    r = client.delete("/v1/places/99999", headers=auth_headers(token))
    assert r.status_code == 403
