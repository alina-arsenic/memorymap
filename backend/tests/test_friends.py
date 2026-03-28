"""Тесты: дружба — запросы, принятие/отклонение, удаление."""

from tests.conftest import auth_headers, create_user


def test_send_friend_request(client):
    token1, uid1 = create_user(client, "fr1", "fr1@example.com")
    _, uid2 = create_user(client, "fr2", "fr2@example.com")

    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "pending"
    assert "request_id" in data


def test_accept_friend_request(client):
    token1, uid1 = create_user(client, "fra1", "fra1@example.com")
    token2, uid2 = create_user(client, "fra2", "fra2@example.com")

    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    req_id = r.json()["request_id"]

    r = client.post(
        f"/v1/friends/requests/{req_id}/accept",
        headers=auth_headers(token2),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "accepted"

    # Проверяем, что теперь друзья
    r = client.get("/v1/friends", headers=auth_headers(token1))
    assert r.status_code == 200
    friend_ids = [f["id"] for f in r.json()["items"]]
    assert uid2 in friend_ids


def test_decline_friend_request(client):
    token1, uid1 = create_user(client, "frd1", "frd1@example.com")
    token2, uid2 = create_user(client, "frd2", "frd2@example.com")

    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    req_id = r.json()["request_id"]

    r = client.post(
        f"/v1/friends/requests/{req_id}/decline",
        headers=auth_headers(token2),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "declined"

    # Проверяем что пользователи НЕ стали друзьями
    r = client.get("/v1/friends", headers=auth_headers(token1))
    friend_ids = [f["id"] for f in r.json()["items"]]
    assert uid2 not in friend_ids


def test_list_friends_empty(client):
    token, _ = create_user(client, "frlempty", "frlempty@example.com")
    r = client.get("/v1/friends", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_remove_friend(client):
    token1, uid1 = create_user(client, "frrm1", "frrm1@example.com")
    token2, uid2 = create_user(client, "frrm2", "frrm2@example.com")

    # Становимся друзьями
    r = client.post("/v1/friends/requests", json={"to_user_id": uid2}, headers=auth_headers(token1))
    req_id = r.json()["request_id"]
    client.post(f"/v1/friends/requests/{req_id}/accept", headers=auth_headers(token2))

    # Удаляем
    r = client.delete(f"/v1/friends/{uid2}", headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "removed"

    # Проверяем, что больше не друзья
    r = client.get("/v1/friends", headers=auth_headers(token1))
    friend_ids = [f["id"] for f in r.json()["items"]]
    assert uid2 not in friend_ids


def test_mutual_request_auto_accept(client):
    """Если A → B pending, и B → A, то auto-accept."""
    token1, uid1 = create_user(client, "frm1", "frm1@example.com")
    token2, uid2 = create_user(client, "frm2", "frm2@example.com")

    # A → B
    client.post("/v1/friends/requests", json={"to_user_id": uid2}, headers=auth_headers(token1))

    # B → A (auto-accept)
    r = client.post("/v1/friends/requests", json={"to_user_id": uid1}, headers=auth_headers(token2))
    assert r.status_code == 200
    assert r.json()["status"] == "accepted_by_reverse_request"


def test_send_request_to_self(client):
    token, uid = create_user(client, "frself", "frself@example.com")
    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid,
    }, headers=auth_headers(token))
    assert r.status_code == 400


def test_list_friend_requests_inbox(client):
    token1, uid1 = create_user(client, "frinb1", "frinb1@example.com")
    token2, uid2 = create_user(client, "frinb2", "frinb2@example.com")

    client.post("/v1/friends/requests", json={"to_user_id": uid2}, headers=auth_headers(token1))

    # Входящие для uid2
    r = client.get(
        "/v1/friends/requests",
        params={"inbox": 1, "status": "pending"},
        headers=auth_headers(token2),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["from_user"]["id"] == uid1


# ---------- Legacy: POST /v1/friends (по tg_id) ----------

def test_add_friend_by_tg_id(client):
    """Legacy endpoint: отправка запроса дружбы по tg_id."""
    token1, uid1 = create_user(client, "frleg1", "frleg1@example.com")
    token2, uid2 = create_user(client, "frleg2", "frleg2@example.com")

    # Привязываем tg_id ко второму
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token2))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 70001,
    }, headers={"X-Bot-Secret": "test-bot-secret"})

    # Отправляем запрос дружбы по tg_id
    r = client.post("/v1/friends", json={
        "friend_tg_id": 70001,
    }, headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "pending"


def test_send_request_already_pending(client):
    """Повторная отправка запроса → already_pending."""
    token1, uid1 = create_user(client, "frdup1", "frdup1@example.com")
    _, uid2 = create_user(client, "frdup2", "frdup2@example.com")

    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "pending"

    # Повторная отправка
    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "already_pending"


def test_send_request_already_friends(client):
    """Запрос дружбы уже другу → already_friends."""
    token1, uid1 = create_user(client, "fraf1", "fraf1@example.com")
    token2, uid2 = create_user(client, "fraf2", "fraf2@example.com")

    # Становимся друзьями
    r = client.post("/v1/friends/requests", json={"to_user_id": uid2}, headers=auth_headers(token1))
    req_id = r.json()["request_id"]
    client.post(f"/v1/friends/requests/{req_id}/accept", headers=auth_headers(token2))

    # Пытаемся снова
    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "already_friends"


def test_send_request_to_blocked_user(client):
    """Запрос дружбы заблокированному пользователю → ошибка."""
    token1, uid1 = create_user(client, "frblk1", "frblk1@example.com")
    _, uid2 = create_user(client, "frblk2", "frblk2@example.com")

    # Блокируем
    client.post("/v1/blocks", json={"user_id": uid2}, headers=auth_headers(token1))

    # Пытаемся отправить запрос дружбы
    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    assert r.status_code == 400


def test_add_friend_by_tg_id_not_found(client):
    """Legacy: tg_id не найден."""
    token, _ = create_user(client, "frleg3", "frleg3@example.com")
    r = client.post("/v1/friends", json={
        "friend_tg_id": 99999999,
    }, headers=auth_headers(token))
    assert r.status_code == 400


# ---------- Error cases ----------

def test_accept_nonexistent_request(client):
    """Принятие несуществующего запроса → 404."""
    token, _ = create_user(client, "fracnone", "fracnone@example.com")
    r = client.post("/v1/friends/requests/99999/accept", headers=auth_headers(token))
    assert r.status_code == 404


def test_decline_nonexistent_request(client):
    """Отклонение несуществующего запроса → 404."""
    token, _ = create_user(client, "frdcnone", "frdcnone@example.com")
    r = client.post("/v1/friends/requests/99999/decline", headers=auth_headers(token))
    assert r.status_code == 404


def test_accept_not_recipient(client):
    """Принять чужой запрос → 403."""
    token1, uid1 = create_user(client, "fracoth1", "fracoth1@example.com")
    token2, uid2 = create_user(client, "fracoth2", "fracoth2@example.com")
    token3, _ = create_user(client, "fracoth3", "fracoth3@example.com")

    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    req_id = r.json()["request_id"]

    # Третий пытается принять чужой запрос
    r = client.post(f"/v1/friends/requests/{req_id}/accept", headers=auth_headers(token3))
    assert r.status_code == 403


def test_remove_non_friend(client):
    """Удаление не-друга — API возвращает removed (idempotent)."""
    token1, _ = create_user(client, "frrmnf1", "frrmnf1@example.com")
    _, uid2 = create_user(client, "frrmnf2", "frrmnf2@example.com")
    r = client.delete(f"/v1/friends/{uid2}", headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "removed"
