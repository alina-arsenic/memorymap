"""API: регистрация, подтверждение email, логин."""

import re
import secrets
from datetime import datetime, timedelta, timezone

from app.core.config import EMAIL_CODE_TTL_MINUTES, JWT_EXPIRES_MINUTES
from app.core.deps import get_db
from app.core.jwt import create_access_token
from app.core.security import hash_password, verify_password
from app.models.models import EmailVerificationCode, PasswordResetCode, User
from app.services.email import send_password_reset_email, send_verification_email
from app.services.groups import GroupService
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()

# ---------- Вспомогательные ----------

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_LOGIN_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_email(raw: str) -> str:
    """Нормализация и базовая проверка формата email."""
    email = raw.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="invalid_email")
    return email


def _generate_code() -> str:
    """Генерация 6-значного цифрового кода (криптостойкий)."""
    return f"{secrets.randbelow(1000000):06d}"


# ---------- Регистрация ----------

class RegisterReq(BaseModel):
    login: str
    password: str
    email: str


@router.post("/auth/register")
def register(req: RegisterReq, db: Session = Depends(get_db)):
    # нормализуем логин
    login = (req.login or "").strip()
    if not login:
        raise HTTPException(status_code=400, detail="empty_login")
    if len(login) < 3 or len(login) > 64:
        raise HTTPException(status_code=400, detail="login_invalid_length")
    if not _LOGIN_RE.match(login):
        raise HTTPException(status_code=400, detail="login_invalid_chars")

    # проверяем пароль
    password = req.password or ""
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="password_too_short")
    if len(password) > 128:
        raise HTTPException(status_code=400, detail="password_too_long")

    # валидация email
    email = _validate_email(req.email)

    # проверка уникальности логина
    if db.query(User).filter(User.login == login).first():
        raise HTTPException(status_code=409, detail="login_taken")

    # проверка уникальности email
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="email_taken")

    # первый зарегистрированный пользователь становится admin
    is_first = db.query(User).first() is None
    role = "admin" if is_first else "user"

    # создаём пользователя (email ещё не подтверждён)
    user = User(
        login=login,
        password_hash=hash_password(password),
        email=email,
        email_verified=False,
        role=role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # создаём личный слой
    GroupService.ensure_personal_group(db, user)

    # генерируем код и отправляем письмо
    code = _generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=EMAIL_CODE_TTL_MINUTES)

    db.add(EmailVerificationCode(user_id=user.id, code=code, expires_at=expires_at))
    db.commit()

    email_sent = send_verification_email(email, code)

    return {"id": user.id, "email_verification_required": True, "email_sent": email_sent}


# ---------- Подтверждение email ----------

class VerifyEmailReq(BaseModel):
    email: str
    code: str


@router.post("/auth/verify-email")
def verify_email(req: VerifyEmailReq, db: Session = Depends(get_db)):
    email = _validate_email(req.email)
    code = (req.code or "").strip()

    user = db.query(User).filter(User.email == email).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="user_not_found")

    if user.email_verified:
        return {"status": "already_verified"}

    # ищем последний неиспользованный код
    row = (
        db.query(EmailVerificationCode)
        .filter(
            EmailVerificationCode.user_id == user.id,
            EmailVerificationCode.used_at.is_(None),
        )
        .order_by(EmailVerificationCode.id.desc())
        .first()
    )

    if not row:
        raise HTTPException(status_code=400, detail="no_active_code")

    now = datetime.now(timezone.utc)
    if row.expires_at < now:
        raise HTTPException(status_code=400, detail="code_expired")

    if row.code != code:
        raise HTTPException(status_code=400, detail="wrong_code")

    # подтверждаем
    row.used_at = now
    user.email_verified = True
    db.commit()

    return {"status": "ok"}


# ---------- Повторная отправка кода ----------

class ResendCodeReq(BaseModel):
    email: str


@router.post("/auth/resend-code")
def resend_code(req: ResendCodeReq, db: Session = Depends(get_db)):
    email = _validate_email(req.email)

    user = db.query(User).filter(User.email == email).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="user_not_found")

    if user.email_verified:
        return {"status": "already_verified"}

    code = _generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=EMAIL_CODE_TTL_MINUTES)

    db.add(EmailVerificationCode(user_id=user.id, code=code, expires_at=expires_at))
    db.commit()

    if not send_verification_email(email, code):
        raise HTTPException(status_code=503, detail="email_send_failed")

    return {"status": "sent"}


# ---------- Логин ----------

class LoginReq(BaseModel):
    login: str
    password: str


@router.post("/auth/login")
def login(req: LoginReq, db: Session = Depends(get_db)):
    # защита от DoS: bcrypt медленный на длинных строках
    if len(req.password or "") > 128:
        raise HTTPException(status_code=400, detail="password_too_long")

    user = db.query(User).filter(User.login == req.login).one_or_none()
    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="bad_credentials")

    if not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="bad_credentials")

    # email должен быть подтверждён
    if not user.email_verified:
        # авто-отправка нового кода подтверждения
        code = _generate_code()
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=EMAIL_CODE_TTL_MINUTES)
        db.add(EmailVerificationCode(user_id=user.id, code=code, expires_at=expires_at))
        db.commit()
        email_sent = send_verification_email(user.email, code)

        return JSONResponse(
            status_code=403,
            content={
                "detail": "email_not_verified",
                "email": user.email,
                "email_sent": email_sent,
            },
        )

    token = create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer", "expires_minutes": JWT_EXPIRES_MINUTES}


# ---------- Забыл пароль ----------

class ForgotPasswordReq(BaseModel):
    email: str


@router.post("/auth/forgot-password")
def forgot_password(req: ForgotPasswordReq, db: Session = Depends(get_db)):
    email = _validate_email(req.email)

    # антиперечисление: всегда возвращаем одинаковый ответ
    user = db.query(User).filter(User.email == email, User.email_verified.is_(True)).one_or_none()
    if not user:
        return {"status": "sent"}

    code = _generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=EMAIL_CODE_TTL_MINUTES)

    db.add(PasswordResetCode(user_id=user.id, code=code, expires_at=expires_at))
    db.commit()

    send_password_reset_email(email, code)
    return {"status": "sent"}


# ---------- Сброс пароля ----------

class ResetPasswordReq(BaseModel):
    email: str
    code: str
    new_password: str


@router.post("/auth/reset-password")
def reset_password(req: ResetPasswordReq, db: Session = Depends(get_db)):
    email = _validate_email(req.email)

    user = db.query(User).filter(User.email == email).one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="invalid_request")

    # валидация пароля
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="password_too_short")
    if len(req.new_password) > 128:
        raise HTTPException(status_code=400, detail="password_too_long")

    # ищем последний неиспользованный код
    row = (
        db.query(PasswordResetCode)
        .filter(
            PasswordResetCode.user_id == user.id,
            PasswordResetCode.used_at.is_(None),
        )
        .order_by(PasswordResetCode.id.desc())
        .first()
    )

    if not row:
        raise HTTPException(status_code=400, detail="no_active_code")

    now = datetime.now(timezone.utc)
    if row.expires_at < now:
        raise HTTPException(status_code=400, detail="code_expired")

    if row.code != req.code.strip():
        raise HTTPException(status_code=400, detail="wrong_code")

    # сброс пароля
    row.used_at = now
    user.password_hash = hash_password(req.new_password)
    user.tokens_valid_after = now  # инвалидируем все старые JWT
    db.commit()

    return {"status": "ok"}
