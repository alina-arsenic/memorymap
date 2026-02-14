"""API: модерация точек (для admin и moderator)."""

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import Place, User
from app.storage import presign_get
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()

_ALLOWED_STATUSES = {"approved", "rejected"}


def _require_moderator(user: User | None) -> User:
    """Проверка, что пользователь — admin или moderator."""
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.role not in ("admin", "moderator"):
        raise HTTPException(status_code=403, detail="insufficient_role")
    return user


# ---------- Список точек на модерацию ----------

@router.get("/moderation/places")
def list_moderation_places(
    status: str = "pending",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Получить точки с заданным статусом модерации."""
    _require_moderator(current_user)

    q = (
        db.query(Place, User)
        .outerjoin(User, Place.user_id == User.id)
        .filter(Place.moderation_status == status)
        .order_by(Place.id.desc())
        .limit(200)
    )

    items = []
    for place, user in q.all():
        # подтягиваем первое фото для превью (если есть)
        from app.models.models import Media
        media_rows = db.query(Media).filter(Media.place_id == place.id).limit(3).all()
        media_list = [
            {"id": m.id, "key": m.s3_key, "url": presign_get(m.s3_key)}
            for m in media_rows
        ]

        items.append({
            "id": place.id,
            "title": place.title,
            "note": place.note,
            "lat": place.lat,
            "lon": place.lon,
            "moderation_status": place.moderation_status,
            "user_id": place.user_id,
            "user_login": user.login if user else None,
            "username": user.username if user else None,
            "media": media_list,
        })

    return {"items": items}


# ---------- Одобрить / отклонить ----------

class ModerationDecisionReq(BaseModel):
    status: str  # approved | rejected


@router.patch("/moderation/places/{place_id}")
def moderate_place(
    place_id: int,
    req: ModerationDecisionReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Изменить статус модерации точки."""
    _require_moderator(current_user)

    if req.status not in _ALLOWED_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"invalid_status (допустимые: {', '.join(sorted(_ALLOWED_STATUSES))})",
        )

    place = db.query(Place).filter(Place.id == place_id).one_or_none()
    if not place:
        raise HTTPException(status_code=404, detail="place_not_found")

    place.moderation_status = req.status
    db.commit()

    return {"status": "ok", "place_id": place.id, "moderation_status": place.moderation_status}
