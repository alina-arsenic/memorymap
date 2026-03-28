"""Тесты: группы — создание, список, детали, участники, удаление."""

from tests.conftest import auth_headers, create_user


def test_list_groups(client):
    token, _ = create_user(client, "grplist", "grplist@example.com")
    r = client.get("/v1/groups", headers=auth_headers(token))
    assert r.status_code == 200
    assert "items" in r.json()
    # У нового пользователя есть хотя бы личная группа
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["is_personal"]  # SQLite возвращает 1 вместо True


def test_create_group(client):
    token, _ = create_user(client, "grpcreate", "grpcreate@example.com")
    r = client.post("/v1/groups", json={
        "name": "Тестовая группа",
        "visibility": "private",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    assert "id" in r.json()


def test_create_group_empty_name(client):
    token, _ = create_user(client, "grpempty", "grpempty@example.com")
    r = client.post("/v1/groups", json={
        "name": "",
        "visibility": "private",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "empty_name"


def test_create_group_invalid_visibility(client):
    token, _ = create_user(client, "grpvis", "grpvis@example.com")
    r = client.post("/v1/groups", json={
        "name": "Test",
        "visibility": "invalid",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_visibility"


def test_get_group_details(client):
    token, uid = create_user(client, "grpdetail", "grpdetail@example.com")
    r = client.post("/v1/groups", json={
        "name": "Detail Test",
        "visibility": "private",
    }, headers=auth_headers(token))
    gid = r.json()["id"]

    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token))
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "Detail Test"
    assert data["visibility"] == "private"
    assert "members" in data
    # Владелец должен быть в списке участников
    member_ids = [m["id"] for m in data["members"]]
    assert uid in member_ids


def test_rename_group(client):
    token, _ = create_user(client, "grprename", "grprename@example.com")
    r = client.post("/v1/groups", json={
        "name": "Old Name",
        "visibility": "private",
    }, headers=auth_headers(token))
    gid = r.json()["id"]

    r = client.patch(f"/v1/groups/{gid}", json={
        "name": "New Name",
    }, headers=auth_headers(token))
    assert r.status_code == 200

    # Проверяем что имя изменилось
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token))
    assert r.json()["name"] == "New Name"


def test_rename_group_not_owner(client):
    token1, _ = create_user(client, "grpowner", "grpowner@example.com")
    token2, _ = create_user(client, "grpother", "grpother@example.com")

    r = client.post("/v1/groups", json={
        "name": "Owner Group",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.patch(f"/v1/groups/{gid}", json={
        "name": "Hacked",
    }, headers=auth_headers(token2))
    assert r.status_code == 403


def test_add_and_remove_member(client):
    token1, uid1 = create_user(client, "grpmemown", "grpmemown@example.com")
    token2, uid2 = create_user(client, "grpmember", "grpmember@example.com")

    r = client.post("/v1/groups", json={
        "name": "Member Test",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    # Добавляем участника
    r = client.post(f"/v1/groups/{gid}/members", json={
        "user_id": uid2,
        "role": "editor",
    }, headers=auth_headers(token1))
    assert r.status_code == 200

    # Проверяем что участник добавлен
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token1))
    member_ids = [m["id"] for m in r.json()["members"]]
    assert uid2 in member_ids

    # Удаляем участника
    r = client.delete(
        f"/v1/groups/{gid}/members/{uid2}",
        headers=auth_headers(token1),
    )
    assert r.status_code == 200

    # Проверяем что участник удалён
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token1))
    member_ids = [m["id"] for m in r.json()["members"]]
    assert uid2 not in member_ids


def test_update_member_role(client):
    token1, uid1 = create_user(client, "grproleown", "grproleown@example.com")
    _, uid2 = create_user(client, "grprolemem", "grprolemem@example.com")

    r = client.post("/v1/groups", json={
        "name": "Role Test",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    # Добавляем как editor
    client.post(f"/v1/groups/{gid}/members", json={
        "user_id": uid2, "role": "editor",
    }, headers=auth_headers(token1))

    # Меняем на viewer
    r = client.patch(f"/v1/groups/{gid}/members/{uid2}", json={
        "role": "viewer",
    }, headers=auth_headers(token1))
    assert r.status_code == 200

    # Проверяем что роль изменилась
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token1))
    member = next(m for m in r.json()["members"] if m["id"] == uid2)
    assert member["role"] == "viewer"


def test_leave_group(client):
    token1, _ = create_user(client, "grpleaveown", "grpleaveown@example.com")
    token2, uid2 = create_user(client, "grpleavemem", "grpleavemem@example.com")

    r = client.post("/v1/groups", json={
        "name": "Leave Test",
        "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    # Добавляем второго как editor
    client.post(f"/v1/groups/{gid}/members", json={
        "user_id": uid2, "role": "editor",
    }, headers=auth_headers(token1))

    # Второй выходит
    r = client.post(f"/v1/groups/{gid}/leave", headers=auth_headers(token2))
    assert r.status_code == 200

    # Проверяем что участник покинул группу
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token1))
    member_ids = [m["id"] for m in r.json()["members"]]
    assert uid2 not in member_ids


def test_leave_group_owner_fails(client):
    token, _ = create_user(client, "grpownerleave", "grpownerleave@example.com")
    r = client.post("/v1/groups", json={
        "name": "Owner Leave",
        "visibility": "private",
    }, headers=auth_headers(token))
    gid = r.json()["id"]

    r = client.post(f"/v1/groups/{gid}/leave", headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "owner_cannot_leave"


def test_delete_group(client):
    token, _ = create_user(client, "grpdelete", "grpdelete@example.com")
    r = client.post("/v1/groups", json={
        "name": "To Delete",
        "visibility": "private",
    }, headers=auth_headers(token))
    gid = r.json()["id"]

    # Создаём точку в группе
    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Group Place", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token))
    pid = r.json()["id"]

    r = client.delete(f"/v1/groups/{gid}", headers=auth_headers(token))
    assert r.status_code == 200

    # Проверяем что группа удалена
    r = client.get(f"/v1/groups/{gid}", headers=auth_headers(token))
    assert r.status_code == 404

    # Пров��ряем что точка из группы тоже удалена
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token))
    assert r.status_code == 404


# ---------- Error cases ----------

def test_get_group_nonexistent(client):
    """Получение несуществующей группы → 404."""
    token, _ = create_user(client, "grp404", "grp404@example.com")
    r = client.get("/v1/groups/99999", headers=auth_headers(token))
    assert r.status_code == 404


def test_delete_group_not_owner(client):
    """Удаление чужой группы → 403."""
    token1, _ = create_user(client, "grpdelown", "grpdelown@example.com")
    token2, _ = create_user(client, "grpdelno", "grpdelno@example.com")

    r = client.post("/v1/groups", json={
        "name": "Protected Group", "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.delete(f"/v1/groups/{gid}", headers=auth_headers(token2))
    assert r.status_code == 403


def test_add_member_not_owner(client):
    """Добавление участника не-владельцем → 403."""
    token1, _ = create_user(client, "grpaddnown", "grpaddnown@example.com")
    token2, uid2 = create_user(client, "grpaddnmem", "grpaddnmem@example.com")
    _, uid3 = create_user(client, "grpaddntgt", "grpaddntgt@example.com")

    r = client.post("/v1/groups", json={
        "name": "Not My Group", "visibility": "private",
    }, headers=auth_headers(token1))
    gid = r.json()["id"]

    r = client.post(f"/v1/groups/{gid}/members", json={
        "user_id": uid3, "role": "editor",
    }, headers=auth_headers(token2))
    assert r.status_code == 403


def test_delete_group_nonexistent(client):
    """Удаление несуществующей группы → 404."""
    token, _ = create_user(client, "grpdel404", "grpdel404@example.com")
    r = client.delete("/v1/groups/99999", headers=auth_headers(token))
    assert r.status_code == 404
