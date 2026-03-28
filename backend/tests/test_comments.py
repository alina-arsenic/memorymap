"""Тесты: комментарии к точкам."""

from app.core.deps import get_db
from app.models.models import Group

from tests.conftest import auth_headers, create_user


def _create_place_in_public_group(client, token):
    """Создаёт точку в публичной группе (комментарии запрещены в личных)."""
    db = next(client.app.dependency_overrides[get_db]())
    g = Group(name="Comments Test", visibility="public", owner_id=None, is_personal=False)
    db.add(g)
    db.commit()
    db.refresh(g)

    r = client.post("/v1/places", json={
        "group_id": g.id, "title": "Comment Place", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    return r.json()["id"]


def test_create_comment(client):
    token, _ = create_user(client, "comm1", "comm1@example.com")
    pid = _create_place_in_public_group(client, token)

    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Отличное место!",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert "comment" in data
    assert data["comment"]["text"] == "Отличное место!"


def test_create_nested_comment(client):
    token1, _ = create_user(client, "commnest1", "commnest1@example.com")
    token2, _ = create_user(client, "commnest2", "commnest2@example.com")
    pid = _create_place_in_public_group(client, token1)

    # Первый комментарий
    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Главный комментарий",
    }, headers=auth_headers(token1))
    parent_id = r.json()["comment"]["id"]

    # Ответ
    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Ответ на комментарий",
        "parent_id": parent_id,
    }, headers=auth_headers(token2))
    assert r.status_code == 200
    assert r.json()["comment"]["parent_id"] == parent_id


def test_list_comments(client):
    token, _ = create_user(client, "commlist", "commlist@example.com")
    pid = _create_place_in_public_group(client, token)

    client.post(f"/v1/places/{pid}/comments", json={
        "text": "Comment 1",
    }, headers=auth_headers(token))
    client.post(f"/v1/places/{pid}/comments", json={
        "text": "Comment 2",
    }, headers=auth_headers(token))

    r = client.get(f"/v1/places/{pid}/comments", headers=auth_headers(token))
    assert r.status_code == 200
    comments = r.json()["comments"]
    assert len(comments) == 2


def test_edit_comment(client):
    token, _ = create_user(client, "commedit", "commedit@example.com")
    pid = _create_place_in_public_group(client, token)

    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Original text",
    }, headers=auth_headers(token))
    cid = r.json()["comment"]["id"]

    r = client.patch(f"/v1/comments/{cid}", json={
        "text": "Edited text",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["comment"]["text"] == "Edited text"


def test_delete_comment(client):
    token, _ = create_user(client, "commdel", "commdel@example.com")
    pid = _create_place_in_public_group(client, token)

    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "To delete",
    }, headers=auth_headers(token))
    cid = r.json()["comment"]["id"]

    r = client.delete(f"/v1/comments/{cid}", headers=auth_headers(token))
    assert r.status_code == 200

    # Проверяем что комментарий удалён
    r = client.get(f"/v1/places/{pid}/comments", headers=auth_headers(token))
    comment_ids = [c["id"] for c in r.json()["comments"]]
    assert cid not in comment_ids


def test_edit_comment_not_author(client):
    token1, _ = create_user(client, "commauth1", "commauth1@example.com")
    token2, _ = create_user(client, "commauth2", "commauth2@example.com")
    pid = _create_place_in_public_group(client, token1)

    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Author comment",
    }, headers=auth_headers(token1))
    cid = r.json()["comment"]["id"]

    r = client.patch(f"/v1/comments/{cid}", json={
        "text": "Hacked",
    }, headers=auth_headers(token2))
    assert r.status_code == 403


def test_delete_comment_by_place_owner(client):
    """Владелец точки может удалить чужой комментарий."""
    token1, _ = create_user(client, "commownr1", "commownr1@example.com")
    token2, _ = create_user(client, "commownr2", "commownr2@example.com")
    pid = _create_place_in_public_group(client, token1)

    # Второй оставляет комментарий
    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Чужой комментарий",
    }, headers=auth_headers(token2))
    cid = r.json()["comment"]["id"]

    # Владелец точки удаляет чужой комментарий
    r = client.delete(f"/v1/comments/{cid}", headers=auth_headers(token1))
    assert r.status_code == 200

    # Проверяем что комментарий удалён
    r = client.get(f"/v1/places/{pid}/comments", headers=auth_headers(token1))
    comment_ids = [c["id"] for c in r.json()["comments"]]
    assert cid not in comment_ids


def test_delete_comment_by_admin(client):
    """Админ может удалить любой комментарий."""
    # Первый юзер — admin (первый зарегистрированный)
    token_admin, _ = create_user(client, "commadm1", "commadm1@example.com")
    token2, _ = create_user(client, "commadm2", "commadm2@example.com")
    pid = _create_place_in_public_group(client, token2)

    # Второй оставляет комментарий к своей точке
    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Комментарий обычного юзера",
    }, headers=auth_headers(token2))
    cid = r.json()["comment"]["id"]

    # Админ удаляет комментарий
    r = client.delete(f"/v1/comments/{cid}", headers=auth_headers(token_admin))
    assert r.status_code == 200

    # Проверяем что удалён
    r = client.get(f"/v1/places/{pid}/comments", headers=auth_headers(token2))
    comment_ids = [c["id"] for c in r.json()["comments"]]
    assert cid not in comment_ids


def test_edit_comment_time_expired(client):
    """Редактирование комментария через 1 час — запрещено."""
    from datetime import datetime, timedelta, timezone

    from app.core.deps import get_db
    from app.models.models import Comment

    token, _ = create_user(client, "commlimit", "commlimit@example.com")
    pid = _create_place_in_public_group(client, token)

    r = client.post(f"/v1/places/{pid}/comments", json={
        "text": "Temporary comment",
    }, headers=auth_headers(token))
    cid = r.json()["comment"]["id"]

    # Вручную сдвигаем created_at на 2 часа назад
    db = next(client.app.dependency_overrides[get_db]())
    comment = db.query(Comment).filter(Comment.id == cid).one()
    comment.created_at = datetime.now(timezone.utc) - timedelta(hours=2)
    db.commit()

    r = client.patch(f"/v1/comments/{cid}", json={
        "text": "Edited too late",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "edit_time_expired"


# ---------- Error cases ----------

def test_delete_comment_nonexistent(client):
    """Удаление несуществующего комментария → 404."""
    token, _ = create_user(client, "commdel404", "commdel404@example.com")
    r = client.delete("/v1/comments/99999", headers=auth_headers(token))
    assert r.status_code == 404
    assert r.json()["detail"] == "comment_not_found"


def test_edit_comment_nonexistent(client):
    """Редактирование несуществующего комментария → 404."""
    token, _ = create_user(client, "commedit404", "commedit404@example.com")
    r = client.patch("/v1/comments/99999", json={
        "text": "Edited",
    }, headers=auth_headers(token))
    assert r.status_code == 404
    assert r.json()["detail"] == "comment_not_found"


def test_create_comment_nonexistent_place(client):
    """Комментарий к несуществующей точке → 404."""
    token, _ = create_user(client, "comm404place", "comm404place@example.com")
    r = client.post("/v1/places/99999/comments", json={
        "text": "No place",
    }, headers=auth_headers(token))
    assert r.status_code == 404
    assert r.json()["detail"] == "place_not_found"
