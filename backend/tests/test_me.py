"""Тесты: профиль, смена пароля/логина/email, telegram, удаление аккаунта."""

from app.core.deps import get_db
from app.models.models import EmailVerificationCode

from tests.conftest import auth_headers, create_user


def test_get_me(client):
    token, uid = create_user(client, "meuser", "meuser@example.com")
    r = client.get("/v1/me", headers=auth_headers(token))
    assert r.status_code == 200
    data = r.json()
    assert data["id"] == uid
    assert data["login"] == "meuser"
    assert data["email"] == "meuser@example.com"
    assert data["role"] in ("admin", "user")
    assert "groups" in data
    assert "friends" in data


def test_get_me_unauthenticated(client):
    r = client.get("/v1/me")
    assert r.status_code == 401


def test_change_password(client):
    token, _ = create_user(client, "chpw", "chpw@example.com", password="OldPass123")
    r = client.post("/v1/me/change-password", json={
        "old_password": "OldPass123",
        "new_password": "NewPass456",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert "access_token" in data  # новый токен

    # Старый пароль не работает
    r = client.post("/v1/auth/login", json={
        "login": "chpw",
        "password": "OldPass123",
    })
    assert r.status_code == 401

    # Новый работает
    r = client.post("/v1/auth/login", json={
        "login": "chpw",
        "password": "NewPass456",
    })
    assert r.status_code == 200


def test_old_token_invalid_after_password_change(client):
    """Старый JWT-токен невалиден после смены пароля (tokens_valid_after)."""
    import time
    token_old, _ = create_user(client, "chpwtok", "chpwtok@example.com", password="OldPass123")

    # Ждём 1.1с чтобы iat старого токена был строго < tokens_valid_after
    # (JWT iat имеет секундную гранулярность)
    time.sleep(1.1)

    # Меняем пароль, получаем новый токен
    r = client.post("/v1/me/change-password", json={
        "old_password": "OldPass123",
        "new_password": "NewPass456",
    }, headers=auth_headers(token_old))
    assert r.status_code == 200
    token_new = r.json()["access_token"]

    # Старый токен → 401 (get_current_user вернёт None → endpoint вернёт 401)
    r = client.get("/v1/me", headers=auth_headers(token_old))
    assert r.status_code == 401

    # Новый токен работает
    r = client.get("/v1/me", headers=auth_headers(token_new))
    assert r.status_code == 200
    assert r.json()["login"] == "chpwtok"


def test_change_password_wrong_old(client):
    token, _ = create_user(client, "chpwwrong", "chpwwrong@example.com")
    r = client.post("/v1/me/change-password", json={
        "old_password": "WrongOld123",
        "new_password": "NewPass456",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "wrong_password"


def test_change_password_too_short(client):
    token, _ = create_user(client, "chpwshort", "chpwshort@example.com", password="TestPass123")
    r = client.post("/v1/me/change-password", json={
        "old_password": "TestPass123",
        "new_password": "short",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "password_too_short"


def test_change_login(client):
    token, _ = create_user(client, "oldlogin", "chlogin@example.com")
    r = client.post("/v1/me/change-login", json={
        "new_login": "newlogin",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["login"] == "newlogin"


def test_change_login_taken(client):
    create_user(client, "taken_login", "taken1@example.com")
    token2, _ = create_user(client, "other_login", "taken2@example.com")
    r = client.post("/v1/me/change-login", json={
        "new_login": "taken_login",
    }, headers=auth_headers(token2))
    assert r.status_code == 409
    assert r.json()["detail"] == "login_taken"


def test_change_login_same(client):
    token, _ = create_user(client, "samelogin", "samelogin@example.com")
    r = client.post("/v1/me/change-login", json={
        "new_login": "samelogin",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "login_same"


def test_telegram_link_start(client):
    token, _ = create_user(client, "tglink", "tglink@example.com")
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    assert r.status_code == 200
    data = r.json()
    assert "code" in data
    assert "bot_link" in data
    assert data["bot_link"] is not None  # мок get_bot_username возвращает "test_bot"


def test_delete_account_with_password(client):
    token, uid = create_user(client, "delacc", "delacc@example.com", password="TestPass123")
    r = client.post("/v1/me/delete", json={
        "password": "TestPass123",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["detail"] == "account_deleted"


def test_delete_account_cascade(client):
    """Удаление аккаунта удаляет точки и дружбы."""
    token1, uid1 = create_user(client, "delcasc1", "delcasc1@example.com", password="TestPass123")
    token2, uid2 = create_user(client, "delcasc2", "delcasc2@example.com")

    # Создаём точку
    r = client.get("/v1/me", headers=auth_headers(token1))
    gid = next(g["id"] for g in r.json()["groups"] if g.get("is_personal"))
    r = client.post("/v1/places", json={
        "group_id": gid, "title": "Cascade Place", "lat": 55.0, "lon": 37.0,
    }, headers=auth_headers(token1))
    pid = r.json()["id"]

    # Становимся друзьями
    r = client.post("/v1/friends/requests", json={"to_user_id": uid2}, headers=auth_headers(token1))
    req_id = r.json()["request_id"]
    client.post(f"/v1/friends/requests/{req_id}/accept", headers=auth_headers(token2))

    # Удаляем аккаунт
    r = client.post("/v1/me/delete", json={"password": "TestPass123"}, headers=auth_headers(token1))
    assert r.status_code == 200

    # Точка удалена
    r = client.get(f"/v1/places/{pid}", headers=auth_headers(token2))
    assert r.status_code == 404

    # Дружба удалена
    r = client.get("/v1/friends", headers=auth_headers(token2))
    friend_ids = [f["id"] for f in r.json()["items"]]
    assert uid1 not in friend_ids


def test_delete_account_wrong_password(client):
    token, _ = create_user(client, "delaccwrong", "delaccwrong@example.com", password="TestPass123")
    r = client.post("/v1/me/delete", json={
        "password": "WrongPass",
    }, headers=auth_headers(token))
    assert r.status_code == 403
    assert r.json()["detail"] == "wrong_password"


# ---------- Смена email ----------

def test_change_email(client):
    """Запрос смены email отправляет код."""
    token, _ = create_user(client, "chgemail", "chgemail@example.com")
    r = client.post("/v1/me/change-email", json={
        "new_email": "newemail@example.com",
    }, headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["status"] == "sent"


def test_change_email_same(client):
    """Смена на тот же email — ошибка."""
    token, _ = create_user(client, "sameemail", "sameemail@example.com")
    r = client.post("/v1/me/change-email", json={
        "new_email": "sameemail@example.com",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "email_same"


def test_change_email_taken(client):
    """Смена на email другого юзера — ошибка."""
    create_user(client, "emailtaken1", "taken@example.com")
    token2, _ = create_user(client, "emailtaken2", "other@example.com")
    r = client.post("/v1/me/change-email", json={
        "new_email": "taken@example.com",
    }, headers=auth_headers(token2))
    assert r.status_code == 409
    assert r.json()["detail"] == "email_taken"


def test_confirm_email(client):
    """Полный flow смены email: запрос → подтверждение кодом."""
    token, uid = create_user(client, "confirme", "confirme@example.com")

    # Запрашиваем смену
    r = client.post("/v1/me/change-email", json={
        "new_email": "newaddr@example.com",
    }, headers=auth_headers(token))
    assert r.status_code == 200

    # Получаем код из БД
    db = next(client.app.dependency_overrides[get_db]())
    code_row = (
        db.query(EmailVerificationCode)
        .filter(
            EmailVerificationCode.user_id == uid,
            EmailVerificationCode.used_at.is_(None),
        )
        .order_by(EmailVerificationCode.id.desc())
        .first()
    )
    assert code_row is not None

    # Подтверждаем
    r = client.post("/v1/me/confirm-email", json={
        "new_email": "newaddr@example.com",
        "code": code_row.code,
    }, headers=auth_headers(token))
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert "access_token" in data

    # Проверяем что email изменился
    r = client.get("/v1/me", headers=auth_headers(data["access_token"]))
    assert r.json()["email"] == "newaddr@example.com"


def test_confirm_email_wrong_code(client):
    """Подтверждение с неверным кодом."""
    token, _ = create_user(client, "badcode", "badcode@example.com")
    client.post("/v1/me/change-email", json={
        "new_email": "newbad@example.com",
    }, headers=auth_headers(token))

    r = client.post("/v1/me/confirm-email", json={
        "new_email": "newbad@example.com",
        "code": "000000",
    }, headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "wrong_code"


# ---------- Отвязка Telegram ----------

def test_unlink_telegram(client):
    """Отвязка Telegram от аккаунта."""
    token, uid = create_user(client, "tgunlink", "tgunlink@example.com")

    # Привязываем Telegram
    r = client.post("/v1/me/telegram-link/start", headers=auth_headers(token))
    code = r.json()["code"]
    client.post("/v1/bot/link-telegram", json={
        "code": code, "tg_id": 77777,
    }, headers={"X-Bot-Secret": "test-bot-secret"})

    # Отвязываем
    r = client.delete("/v1/me/telegram", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    # Проверяем что tg_id сброшен
    r = client.get("/v1/me", headers=auth_headers(token))
    assert r.json().get("tg_id") is None


def test_unlink_telegram_not_linked(client):
    """Отвязка Telegram, когда он не привязан."""
    token, _ = create_user(client, "tgnotlinked", "tgnotlinked@example.com")
    r = client.delete("/v1/me/telegram", headers=auth_headers(token))
    assert r.status_code == 400
    assert r.json()["detail"] == "telegram_not_linked"


# ---------- Legacy: DELETE /me (без пароля) ----------

def test_delete_account_legacy(client):
    """Удаление аккаунта через legacy endpoint (без пароля)."""
    token, uid = create_user(client, "dellegacy", "dellegacy@example.com")
    r = client.delete("/v1/me", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["detail"] == "account_deleted"

    # Проверяем что аккаунт удалён (логин не работает)
    r = client.post("/v1/auth/login", json={
        "login": "dellegacy", "password": "TestPass123",
    })
    assert r.status_code == 401
