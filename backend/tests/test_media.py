"""Тесты: presign upload/download, удаление медиа."""

from tests.conftest import auth_headers, create_user


def test_presign_upload(client):
    token, uid = create_user(client, "mediaup", "mediaup@example.com")
    r = client.post("/v1/media/presign-upload", json={
        "mime": "image/jpeg",
        "ext": "jpg",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    data = r.json()
    assert "key" in data
    assert "url" in data
    assert data["key"].startswith(f"uploads/{uid}/")


def test_presign_upload_invalid_extension(client):
    token, _ = create_user(client, "mediaext", "mediaext@example.com")
    r = client.post("/v1/media/presign-upload", json={
        "mime": "image/jpeg",
        "ext": "exe",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_extension"


def test_presign_upload_invalid_mime(client):
    token, _ = create_user(client, "mediamime", "mediamime@example.com")
    r = client.post("/v1/media/presign-upload", json={
        "mime": "application/pdf",
        "ext": "jpg",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_mime"


def test_presign_download(client):
    """Download presign для ключа uploads/{uid}/..."""
    token, uid = create_user(client, "mediadl", "mediadl@example.com")
    key = f"uploads/{uid}/550e8400-e29b-41d4-a716-446655440000.jpg"
    r = client.get(
        "/v1/media/presign-download",
        params={"key": key},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    assert "url" in r.json()


def test_presign_download_other_user_forbidden(client):
    """Нельзя скачать чужой upload."""
    token1, uid1 = create_user(client, "mediadlown", "mediadlown@example.com")
    _, uid2 = create_user(client, "mediadlother", "mediadlother@example.com")

    key = f"uploads/{uid2}/550e8400-e29b-41d4-a716-446655440000.jpg"
    r = client.get(
        "/v1/media/presign-download",
        params={"key": key},
        headers=auth_headers(token1),
    )
    assert r.status_code == 403


def test_delete_media(client):
    token, uid = create_user(client, "mediadel", "mediadel@example.com")

    # Создаём точку + медиа
    r = client.get("/v1/me", headers=auth_headers(token))
    gid = next(g["id"] for g in r.json()["groups"] if g.get("is_personal"))

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Media delete", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    pid = r.json()["id"]

    r = client.post(f"/v1/places/{pid}/media", json={
        "temp_key": f"uploads/{uid}/550e8400-e29b-41d4-a716-446655440000.jpg",
    }, headers=auth_headers(token))
    mid = r.json()["id"]

    r = client.delete(f"/v1/media/{mid}", headers=auth_headers(token))
    assert r.status_code == 200

    # Проверяем что медиа удалено (повторное удаление → 404)
    r = client.delete(f"/v1/media/{mid}", headers=auth_headers(token))
    assert r.status_code == 404


def test_delete_media_not_owner(client):
    token1, uid1 = create_user(client, "mediadelown", "mediadelown@example.com")
    token2, _ = create_user(client, "mediadelno", "mediadelno@example.com")

    r = client.get("/v1/me", headers=auth_headers(token1))
    gid = next(g["id"] for g in r.json()["groups"] if g.get("is_personal"))

    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Protected media", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token1))
    pid = r.json()["id"]

    r = client.post(f"/v1/places/{pid}/media", json={
        "temp_key": f"uploads/{uid1}/550e8400-e29b-41d4-a716-446655440000.jpg",
    }, headers=auth_headers(token1))
    mid = r.json()["id"]

    r = client.delete(f"/v1/media/{mid}", headers=auth_headers(token2))
    assert r.status_code == 403
