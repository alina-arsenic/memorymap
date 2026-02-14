from typing import Optional

from app.core.deps import get_db
from app.core.jwt import decode_access_token
from app.models.models import User
from fastapi import Depends, Header
from sqlalchemy import text
from sqlalchemy.orm import Session


def _ensure_personal_group(db: Session, user: User) -> None:
    name = f"Личная карта {user.tg_id or user.id}"

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

    db.refresh(user)
    db.expunge(user)
    return user
