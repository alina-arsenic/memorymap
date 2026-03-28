"""Тес��ы: регистрация, логин, верификация email, сброс пароля."""

from app.core.deps import get_db
from app.models.models import EmailVerificationCode, PasswordResetCode

from tests.conftest import auth_headers, create_user

# ---------- Регистрация ----------

def test_register_happy_path(client):
    r = client.post("/v1/auth/register", json={
        "login": "newuser",
        "email": "new@example.com",
        "password": "TestPass123",
    })
    assert r.status_code == 200
    data = r.json()
    assert "id" in data
    assert data["email_verification_required"] is True


def test_register_duplicate_login(client):
    client.post("/v1/auth/register", json={
        "login": "dupuser",
        "email": "dup1@example.com",
        "password": "TestPass123",
    })
    r = client.post("/v1/auth/register", json={
        "login": "dupuser",
        "email": "dup2@example.com",
        "password": "TestPass123",
    })
    assert r.status_code == 409
    assert r.json()["detail"] == "login_taken"


def test_register_duplicate_email(client):
    client.post("/v1/auth/register", json={
        "login": "emaildup1",
        "email": "same@example.com",
        "password": "TestPass123",
    })
    r = client.post("/v1/auth/register", json={
        "login": "emaildup2",
        "email": "same@example.com",
        "password": "TestPass123",
    })
    assert r.status_code == 409
    assert r.json()["detail"] == "email_taken"


def test_register_case_insensitive_login(client):
    client.post("/v1/auth/register", json={
        "login": "CaseUser",
        "email": "case1@example.com",
        "password": "TestPass123",
    })
    r = client.post("/v1/auth/register", json={
        "login": "caseuser",
        "email": "case2@example.com",
        "password": "TestPass123",
    })
    assert r.status_code == 409
    assert r.json()["detail"] == "login_taken"


def test_register_short_password(client):
    r = client.post("/v1/auth/register", json={
        "login": "shortpw",
        "email": "shortpw@example.com",
        "password": "short",
    })
    assert r.status_code == 400
    assert r.json()["detail"] == "password_too_short"


def test_register_invalid_login_chars(client):
    r = client.post("/v1/auth/register", json={
        "login": "bad login!",
        "email": "badlogin@example.com",
        "password": "TestPass123",
    })
    assert r.status_code == 400
    assert r.json()["detail"] == "login_invalid_chars"


def test_register_empty_login(client):
    r = client.post("/v1/auth/register", json={
        "login": "",
        "email": "empty@example.com",
        "password": "TestPass123",
    })
    assert r.status_code == 400


def test_register_invalid_email(client):
    r = client.post("/v1/auth/register", json={
        "login": "bademail",
        "email": "not-an-email",
        "password": "TestPass123",
    })
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_email"


def test_register_first_user_is_admin(client):
    """Первый зарегистрированный пользователь получает роль admin."""
    token, uid = create_user(client, "firstadmin", "admin@example.com")
    r = client.get("/v1/me", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["role"] == "admin"


# ---------- Верификация email ----------

def test_verify_email_correct_code(client):
    r = client.post("/v1/auth/register", json={
        "login": "verifyok",
        "email": "verify@example.com",
        "password": "TestPass123",
    })
    user_id = r.json()["id"]

    db = next(client.app.dependency_overrides[get_db]())
    code_row = (
        db.query(EmailVerificationCode)
        .filter(EmailVerificationCode.user_id == user_id)
        .order_by(EmailVerificationCode.id.desc())
        .first()
    )

    r = client.post("/v1/auth/verify-email", json={
        "email": "verify@example.com",
        "code": code_row.code,
    })
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_verify_email_wrong_code(client):
    client.post("/v1/auth/register", json={
        "login": "verifyfail",
        "email": "verifyfail@example.com",
        "password": "TestPass123",
    })
    r = client.post("/v1/auth/verify-email", json={
        "email": "verifyfail@example.com",
        "code": "000000",
    })
    assert r.status_code == 400
    assert r.json()["detail"] == "wrong_code"


# ---------- Логин ----------

def test_login_happy_path(client):
    token, _ = create_user(client, "loginok", "loginok@example.com")
    assert token is not None
    assert len(token) > 0


def test_login_wrong_password(client):
    create_user(client, "loginwrong", "loginwrong@example.com")
    r = client.post("/v1/auth/login", json={
        "login": "loginwrong",
        "password": "WrongPassword",
    })
    assert r.status_code == 401
    assert r.json()["detail"] == "bad_credentials"


def test_login_case_insensitive(client):
    create_user(client, "logincase", "logincase@example.com", password="TestPass123")
    r = client.post("/v1/auth/login", json={
        "login": "LoginCase",
        "password": "TestPass123",
    })
    assert r.status_code == 200
    assert "access_token" in r.json()


def test_login_unverified_email(client):
    """Логин с неподтверждённым email возвращает 403."""
    client.post("/v1/auth/register", json={
        "login": "unverified",
        "email": "unverified@example.com",
        "password": "TestPass123",
    })
    r = client.post("/v1/auth/login", json={
        "login": "unverified",
        "password": "TestPass123",
    })
    assert r.status_code == 403
    assert r.json()["detail"] == "email_not_verified"


# ---------- Забыл/сброс пароля ----------

def test_forgot_password_existing_user(client):
    create_user(client, "forgotpw", "forgotpw@example.com")
    r = client.post("/v1/auth/forgot-password", json={
        "email": "forgotpw@example.com",
    })
    assert r.status_code == 200
    assert r.json()["status"] == "sent"


def test_forgot_password_nonexistent(client):
    """Антиперечисление: всегда отвечает «sent»."""
    r = client.post("/v1/auth/forgot-password", json={
        "email": "nobody@example.com",
    })
    assert r.status_code == 200
    assert r.json()["status"] == "sent"


def test_reset_password(client):
    token, uid = create_user(client, "resetpw", "resetpw@example.com")

    # Запрашиваем код сброса
    client.post("/v1/auth/forgot-password", json={"email": "resetpw@example.com"})

    # Получаем код из БД
    db = next(client.app.dependency_overrides[get_db]())
    code_row = (
        db.query(PasswordResetCode)
        .filter(PasswordResetCode.user_id == uid)
        .order_by(PasswordResetCode.id.desc())
        .first()
    )
    assert code_row is not None

    # Сбрасываем пароль
    r = client.post("/v1/auth/reset-password", json={
        "email": "resetpw@example.com",
        "code": code_row.code,
        "new_password": "NewPass12345",
    })
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    # Логинимся с новым паро��ем
    r = client.post("/v1/auth/login", json={
        "login": "resetpw",
        "password": "NewPass12345",
    })
    assert r.status_code == 200
    assert "access_token" in r.json()


# ---------- Повторная отправка кода ----------

def test_resend_code(client):
    """Повторная отправка кода верификации."""
    client.post("/v1/auth/register", json={
        "login": "resenduser",
        "email": "resend@example.com",
        "password": "TestPass123",
    })
    r = client.post("/v1/auth/resend-code", json={
        "email": "resend@example.com",
    })
    assert r.status_code == 200
    assert r.json()["status"] == "sent"


def test_resend_code_already_verified(client):
    """Повторная отправка кода для уже подтверждённого email."""
    create_user(client, "resendverified", "resendv@example.com")
    r = client.post("/v1/auth/resend-code", json={
        "email": "resendv@example.com",
    })
    assert r.status_code == 200
    assert r.json()["status"] == "already_verified"


def test_resend_code_nonexistent(client):
    """Повторная отправка кода для несуществующего email."""
    r = client.post("/v1/auth/resend-code", json={
        "email": "nobody@example.com",
    })
    assert r.status_code == 404
    assert r.json()["detail"] == "user_not_found"


# ---------- Healthz ----------

def test_healthz(client):
    """Health check endpoint."""
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ---------- Сброс пароля: error cases ----------

def test_reset_password_wrong_code(client):
    """Сброс пароля с неверным кодом."""
    create_user(client, "resetwrong", "resetwrong@example.com")
    client.post("/v1/auth/forgot-password", json={"email": "resetwrong@example.com"})

    r = client.post("/v1/auth/reset-password", json={
        "email": "resetwrong@example.com",
        "code": "000000",
        "new_password": "NewPass12345",
    })
    assert r.status_code == 400
    assert r.json()["detail"] == "wrong_code"
