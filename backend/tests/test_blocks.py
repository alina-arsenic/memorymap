"""Тесты: блокировка пользователей."""

from tests.conftest import auth_headers, create_user


def test_block_user(client):
    token1, uid1 = create_user(client, "blk1", "blk1@example.com")
    _, uid2 = create_user(client, "blk2", "blk2@example.com")

    r = client.post("/v1/blocks", json={
        "user_id": uid2,
    }, headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "blocked"


def test_block_already_blocked(client):
    token1, _ = create_user(client, "blkdup1", "blkdup1@example.com")
    _, uid2 = create_user(client, "blkdup2", "blkdup2@example.com")

    client.post("/v1/blocks", json={"user_id": uid2}, headers=auth_headers(token1))
    r = client.post("/v1/blocks", json={"user_id": uid2}, headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "already_blocked"


def test_list_blocked(client):
    token1, _ = create_user(client, "blklist1", "blklist1@example.com")
    _, uid2 = create_user(client, "blklist2", "blklist2@example.com")

    client.post("/v1/blocks", json={"user_id": uid2}, headers=auth_headers(token1))

    r = client.get("/v1/blocks", headers=auth_headers(token1))
    assert r.status_code == 200
    items = r.json()["items"]
    blocked_ids = [i["id"] for i in items]
    assert uid2 in blocked_ids


def test_unblock_user(client):
    token1, _ = create_user(client, "blkunb1", "blkunb1@example.com")
    _, uid2 = create_user(client, "blkunb2", "blkunb2@example.com")

    client.post("/v1/blocks", json={"user_id": uid2}, headers=auth_headers(token1))

    r = client.delete(f"/v1/blocks/{uid2}", headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "unblocked"

    # Проверяем, что разблокирован
    r = client.get("/v1/blocks", headers=auth_headers(token1))
    blocked_ids = [i["id"] for i in r.json()["items"]]
    assert uid2 not in blocked_ids


def test_block_cancels_friendship(client):
    """Блокировка удаляет дружбу."""
    token1, uid1 = create_user(client, "blkfr1", "blkfr1@example.com")
    token2, uid2 = create_user(client, "blkfr2", "blkfr2@example.com")

    # Становимся друзьями
    r = client.post("/v1/friends/requests", json={"to_user_id": uid2}, headers=auth_headers(token1))
    req_id = r.json()["request_id"]
    client.post(f"/v1/friends/requests/{req_id}/accept", headers=auth_headers(token2))

    # Блокируем
    client.post("/v1/blocks", json={"user_id": uid2}, headers=auth_headers(token1))

    # Проверяем — дружбы нет
    r = client.get("/v1/friends", headers=auth_headers(token1))
    friend_ids = [f["id"] for f in r.json()["items"]]
    assert uid2 not in friend_ids


def test_block_cancels_pending_requests(client):
    """Блокировка отменяет pending-запросы дружбы."""
    token1, uid1 = create_user(client, "blkreq1", "blkreq1@example.com")
    token2, uid2 = create_user(client, "blkreq2", "blkreq2@example.com")

    # Отправляем запрос дружбы
    r = client.post("/v1/friends/requests", json={
        "to_user_id": uid2,
    }, headers=auth_headers(token1))
    assert r.json()["status"] == "pending"

    # Блокируем
    client.post("/v1/blocks", json={"user_id": uid2}, headers=auth_headers(token1))

    # Проверяем что запрос исчез из входящих
    r = client.get(
        "/v1/friends/requests",
        params={"inbox": 1, "status": "pending"},
        headers=auth_headers(token2),
    )
    from_ids = [i["from_user"]["id"] for i in r.json()["items"]]
    assert uid1 not in from_ids


def test_block_self_fails(client):
    token, uid = create_user(client, "blkself", "blkself@example.com")
    r = client.post("/v1/blocks", json={"user_id": uid}, headers=auth_headers(token))
    assert r.status_code == 400
    assert "заблокировать" in r.json()["detail"].lower() or "self" in r.json()["detail"].lower()
