"""Тесты: слои (layers) — типы групп."""

from tests.conftest import auth_headers, create_user


def test_list_layers(client):
    token, _ = create_user(client, "layeruser", "layeruser@example.com")
    r = client.get("/v1/layers", headers=auth_headers(token))
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1

    # Проверяем структуру
    for item in items:
        assert "id" in item
        assert "name" in item
        assert "type" in item
        assert item["type"] in ("public", "personal", "shared")


def test_list_layers_contains_personal(client):
    """Личная группа возвращается с типом 'personal'."""
    token, _ = create_user(client, "layerpersonal", "layerpersonal@example.com")
    r = client.get("/v1/layers", headers=auth_headers(token))
    items = r.json()["items"]
    personal = [i for i in items if i["type"] == "personal"]
    assert len(personal) == 1


def test_list_layers_unauthenticated(client):
    """Неавторизованный запрос возвращает только публичные слои."""
    # Создаём юзера (это создаёт личную группу) + публичную группу
    token, _ = create_user(client, "layerunauth", "layerunauth@example.com")
    from app.core.deps import get_db
    from app.models.models import Group
    db = next(client.app.dependency_overrides[get_db]())
    g = Group(name="Public Layer", visibility="public", owner_id=None, is_personal=False)
    db.add(g)
    db.commit()

    r = client.get("/v1/layers")
    assert r.status_code == 200
    items = r.json()["items"]
    # Должна быть хотя бы публичная группа
    assert len(items) >= 1
    # Личные группы НЕ должны возвращаться
    for item in items:
        assert item["type"] == "public"
