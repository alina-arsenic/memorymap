from typing import Optional
from fastapi import Header
from sqlalchemy.orm import Session
from .db import SessionLocal
from .models import User, Group
import uuid


def _ensure_personal_group(db: Session, user: User) -> None:
    """
    Создает личную приватную группу пользователя, если её ещё нет.
    """
    from sqlalchemy import text

    # имя = 'personal::<user_id>'
    name = f"Личная карта {user.tg_id or user.id}"
    from .models import Group  # локальный импорт, чтобы не зациклить

    existing = (
        db.query(Group)
        .filter(Group.visibility == "private", Group.name == name)
        .one_or_none()
    )
    if existing:
        return

    g = Group(name=name, visibility="private")
    db.add(g)
    db.commit()
    db.refresh(g)

    # membership в ORM мы её не описывали
    db.execute(
        text(
            "INSERT INTO membership (user_id, group_id, role) "
            "VALUES (:uid, :gid, 'owner') "
            "ON CONFLICT (user_id, group_id) DO UPDATE SET role='owner'"
        ),
        {"uid": user.id, "gid": g.id},
    )
    db.commit()


def get_current_user(
    x_user_tg: Optional[int] = Header(default=None, alias="X-User-Tg"),
) -> Optional[User]:
    """
    Авторизация через заголовок X-User-Tg (Telegram ID).
    """
    if x_user_tg is None:
        return None

    db: Session = SessionLocal()
    try:
        user = db.query(User).filter(User.tg_id == x_user_tg).one_or_none()
        if not user:
            user = User(tg_id=x_user_tg, username=None)
            db.add(user)
            db.commit()
            db.refresh(user)

        _ensure_personal_group(db, user)
        return user
    finally:
        db.close()
