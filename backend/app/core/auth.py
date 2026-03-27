from datetime import datetime, timedelta, timezone
from typing import Optional

from app.core.deps import get_db
from app.core.jwt import decode_access_token
from app.models.models import User
from fastapi import Depends, Header
from sqlalchemy import text
from sqlalchemy.orm import Session


def get_current_user(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> Optional[User]:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_access_token(token)
        uid = int(payload.get("sub"))
    except Exception:
        return None

    user = db.query(User).filter(User.id == uid).one_or_none()
    if not user:
        return None

    # проверяем что токен выпущен после последней инвалидации
    # iat в JWT — целые секунды, tokens_valid_after — с микросекундами,
    # приводим обе стороны к int для корректного сравнения
    iat = payload.get("iat", 0)
    if user.tokens_valid_after and iat < int(user.tokens_valid_after.timestamp()):
        return None

    # Обновляем last_active_at не чаще раза в 5 минут (raw SQL — колонка может отсутствовать)
    try:
        _now = datetime.now(timezone.utc)
        db.execute(
            text(
                "UPDATE users SET last_active_at = :now WHERE id = :uid "
                "AND (last_active_at IS NULL OR last_active_at < :thr)"
            ),
            {"now": _now, "uid": user.id, "thr": _now - timedelta(minutes=5)},
        )
        db.commit()
    except Exception:
        db.rollback()

    db.refresh(user)
    db.expunge(user)
    return user
