"""API: управление пользователями (только для admin)."""

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import Place, User
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()

# Допустимые роли, которые может назначить админ
_ASSIGNABLE_ROLES = {"moderator", "user"}


def _require_admin(user: User | None) -> User:
    """Проверка, что текущий пользователь — администратор."""
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin_only")
    return user


# ---------- Список пользователей ----------

@router.get("/admin/users")
def list_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Список всех пользователей. Доступен admin и moderator."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if current_user.role not in ("admin", "moderator"):
        raise HTTPException(status_code=403, detail="insufficient_role")

    users = db.query(User).order_by(User.id).all()
    is_admin = current_user.role == "admin"
    items = []
    for u in users:
        item = {
            "id": u.id,
            "login": u.login,
            "role": u.role,
        }
        # PII (email, tg_id) — только для админа
        if is_admin:
            item["email"] = u.email
            item["tg_id"] = u.tg_id
            item["email_verified"] = u.email_verified
        items.append(item)
    return {"items": items}


# ---------- Назначение роли ----------

class SetRoleReq(BaseModel):
    role: str


@router.patch("/admin/users/{user_id}/role")
def set_user_role(
    user_id: int,
    req: SetRoleReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Назначить роль пользователю. Только admin."""
    _require_admin(current_user)

    if req.role not in _ASSIGNABLE_ROLES:
        raise HTTPException(
            status_code=400,
            detail=f"invalid_role (допустимые: {', '.join(sorted(_ASSIGNABLE_ROLES))})",
        )

    target = db.query(User).filter(User.id == user_id).one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="user_not_found")

    # нельзя менять роль самому себе
    if target.id == current_user.id:
        raise HTTPException(status_code=400, detail="cannot_change_own_role")

    # нельзя понизить другого админа
    if target.role == "admin":
        raise HTTPException(status_code=400, detail="cannot_change_admin")

    target.role = req.role

    # при повышении до moderator — автоматически одобряем все pending-точки пользователя
    if req.role == "moderator":
        db.query(Place).filter(
            Place.user_id == target.id,
            Place.moderation_status == "pending",
        ).update({"moderation_status": "approved"})

    db.commit()

    return {"status": "ok", "user_id": target.id, "role": target.role}
