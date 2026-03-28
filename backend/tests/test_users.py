"""Тесты: поиск пользователей."""

from tests.conftest import auth_headers, create_user


def test_search_users_by_login(client):
    token1, _ = create_user(client, "searchme", "searchme@example.com")
    create_user(client, "findable", "findable@example.com")

    r = client.get(
        "/v1/users/search",
        params={"q": "findable"},
        headers=auth_headers(token1),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    logins = [i["login"] for i in items]
    assert "findable" in logins


def test_search_excludes_self(client):
    token, _ = create_user(client, "searchself", "searchself@example.com")
    r = client.get(
        "/v1/users/search",
        params={"q": "searchself"},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    items = r.json()["items"]
    logins = [i["login"] for i in items]
    assert "searchself" not in logins


def test_search_unauthenticated(client):
    r = client.get("/v1/users/search", params={"q": "test"})
    assert r.status_code == 401
