"""API: регистрация, подтверждение email, логин."""

import re
import random
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.core.config import EMAIL_CODE_TTL_MINUTES
from app.core.security import hash_password, verify_password
from app.core.jwt import create_access_token
from app.models.models import User, EmailVerificationCode
from app.services.email import send_verification_email

router = APIRouter()

# ---------- Вспомогательные ----------

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(raw: str) -> str:
    """Нормализация и базовая проверка формата email."""
    email = raw.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="invalid_email")
    return email


def _generate_code() -> str:
    """Генерация 6-значного цифрового кода."""
    return f"{random.randint(0, 999999):06d}"


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

    # проверяем пароль
    password = req.password or ""
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="password_too_short")

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

    # генерируем код и отправляем письмо
    code = _generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=EMAIL_CODE_TTL_MINUTES)

    db.add(EmailVerificationCode(user_id=user.id, code=code, expires_at=expires_at))
    db.commit()

    send_verification_email(email, code)

    return {"id": user.id, "email_verification_required": True}


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

    send_verification_email(email, code)

    return {"status": "sent"}


# ---------- Логин ----------

class LoginReq(BaseModel):
    login: str
    password: str


@router.post("/auth/login")
def login(req: LoginReq, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.login == req.login).one_or_none()
    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="bad_credentials")

    if not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="bad_credentials")

    # email должен быть подтверждён
    if not user.email_verified:
        raise HTTPException(status_code=403, detail="email_not_verified")

    token = create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer", "expires_minutes": 30}
