"""Тесты: приглашения в группы."""

from tests.conftest import auth_headers, create_user


def _make_friends(client, token1, uid1, token2, uid2):
    """Делает двух пользователей друзьями."""
    r = client.post("/v1/friends/requests", json={"to_user_id": uid2}, headers=auth_headers(token1))
    req_id = r.json()["request_id"]
    client.post(f"/v1/friends/requests/{req_id}/accept", headers=auth_headers(token2))


def test_send_invite(client):
    token1, uid1 = create_user(client, "inv1", "inv1@example.com")
    token2, uid2 = create_user(client, "inv2", "inv2@example.com")
    _make_friends(client, token1, uid1, token2, uid2)

    # Создаём группу
    r = client.post("/v1/groups", json={
        "name": "Invite Group",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    # Отправляем инвайт
    r = client.post(f"/v1/groups/{gid}/invites", json={
        "user_id": uid2,
        "role": "editor",
    }, headers=auth_headers(token1))
    assert r.status_code == 200
    assert r.json()["status"] == "pending"
    assert "invite_id" in r.json()


def test_accept_invite(client):
    token1, uid1 = create_user(client, "invacc1", "invacc1@example.com")
    token2, uid2 = create_user(client, "invacc2", "invacc2@example.com")
    _make_friends(client, token1, uid1, token2, uid2)

    r = client.post("/v1/groups", json={
        "name": "Accept Group",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.post(f"/v1/groups/{gid}/invites", json={
        "user_id": uid2, "role": "editor",
    }, headers=auth_headers(token1))
    invite_id = r.json()["invite_id"]

    r = client.post(
        f"/v1/groups/invites/{invite_id}/accept",
        headers=auth_headers(token2),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "accepted"

    # Проверяем, что пользователь стал участником группы с правильной ролью
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token2))
    assert r.status_code == 200
    member = next(m for m in r.json()["members"] if m["id"] == uid2)
    assert member["role"] == "editor"


def test_decline_invite(client):
    token1, uid1 = create_user(client, "invdec1", "invdec1@example.com")
    token2, uid2 = create_user(client, "invdec2", "invdec2@example.com")
    _make_friends(client, token1, uid1, token2, uid2)

    r = client.post("/v1/groups", json={
        "name": "Decline Group",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.post(f"/v1/groups/{gid}/invites", json={
        "user_id": uid2, "role": "viewer",
    }, headers=auth_headers(token1))
    invite_id = r.json()["invite_id"]

    r = client.post(
        f"/v1/groups/invites/{invite_id}/decline",
        headers=auth_headers(token2),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "declined"

    # Проверяем что пользователь НЕ стал участником
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token1))
    member_ids = [m["id"] for m in r.json()["members"]]
    assert uid2 not in member_ids


def test_cancel_invite(client):
    token1, uid1 = create_user(client, "invcan1", "invcan1@example.com")
    token2, uid2 = create_user(client, "invcan2", "invcan2@example.com")
    _make_friends(client, token1, uid1, token2, uid2)

    r = client.post("/v1/groups", json={
        "name": "Cancel Group",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.post(f"/v1/groups/{gid}/invites", json={
        "user_id": uid2, "role": "viewer",
    }, headers=auth_headers(token1))
    invite_id = r.json()["invite_id"]

    r = client.delete(
        f"/v1/groups/invites/{invite_id}",
        headers=auth_headers(token1),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "canceled"

    # Проверяем что инвайт исчез из inbox получателя
    r = client.get("/v1/groups/invites", params={"inbox": 1}, headers=auth_headers(token2))
    assert r.status_code == 200
    pending = [i for i in r.json()["items"] if i.get("status") == "pending"]
    assert len(pending) == 0


def test_list_invites_inbox(client):
    token1, uid1 = create_user(client, "invlist1", "invlist1@example.com")
    token2, uid2 = create_user(client, "invlist2", "invlist2@example.com")
    _make_friends(client, token1, uid1, token2, uid2)

    r = client.post("/v1/groups", json={
        "name": "List Group",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    client.post(f"/v1/groups/{gid}/invites", json={
        "user_id": uid2, "role": "editor",
    }, headers=auth_headers(token1))

    r = client.get(
        "/v1/groups/invites",
        params={"inbox": 1},
        headers=auth_headers(token2),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1


def test_send_invite_not_friend(client):
    """Нельзя пригласить в группу не-друга."""
    token1, uid1 = create_user(client, "invnf1", "invnf1@example.com")
    _, uid2 = create_user(client, "invnf2", "invnf2@example.com")

    r = client.post("/v1/groups", json={
        "name": "No Friend Group",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.post(f"/v1/groups/{gid}/invites", json={
        "user_id": uid2, "role": "viewer",
    }, headers=auth_headers(token1))
    assert r.status_code == 400
    detail = r.json()["detail"].lower()
    assert "друз" in detail or "friend" in detail


# ---------- Error cases ----------

def test_accept_invite_not_recipient(client):
    """Принятие чужого инвайта → 403."""
    token1, uid1 = create_user(client, "invnr1", "invnr1@example.com")
    token2, uid2 = create_user(client, "invnr2", "invnr2@example.com")
    token3, _ = create_user(client, "invnr3", "invnr3@example.com")
    _make_friends(client, token1, uid1, token2, uid2)

    r = client.post("/v1/groups", json={
        "name": "NR Group", "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.post(f"/v1/groups/{gid}/invites", json={
        "user_id": uid2, "role": "editor",
    }, headers=auth_headers(token1))
    invite_id = r.json()["invite_id"]

    # Третий (не получатель) пытается принять
    r = client.post(f"/v1/groups/invites/{invite_id}/accept", headers=auth_headers(token3))
    assert r.status_code == 403


def test_accept_invite_nonexistent(client):
    """Принятие несуществующего инвайта → 404."""
    token, _ = create_user(client, "invne", "invne@example.com")
    r = client.post("/v1/groups/invites/99999/accept", headers=auth_headers(token))
    assert r.status_code == 404


def test_decline_invite_nonexistent(client):
    """Отклонение несуществующего инвайта → 404."""
    token, _ = create_user(client, "invdne", "invdne@example.com")
    r = client.post("/v1/groups/invites/99999/decline", headers=auth_headers(token))
    assert r.status_code == 404


def test_cancel_invite_nonexistent(client):
    """Отмена несуществующего инвайта → 404."""
    token, _ = create_user(client, "invcne", "invcne@example.com")
    r = client.delete("/v1/groups/invites/99999", headers=auth_headers(token))
    assert r.status_code == 404
