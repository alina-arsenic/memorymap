"""API: модерация точек (для admin и moderator)."""

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import Media, Place, Report, User
from app.services.reports import CATEGORY_LABELS, ReportService
from app.storage import presign_get
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, exists, or_
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
    """Получить точки с заданным статусом модерации.

    При status=pending возвращает как новые pending-точки, так и
    approved-точки с pending-жалобами (чтобы модератор видел их).
    """
    _require_moderator(current_user)

    # Расширенный запрос: pending-точки + approved-точки с pending-жалобами
    if status == "pending":
        has_pending_reports = exists().where(
            and_(Report.place_id == Place.id, Report.status == "pending")
        )
        q = (
            db.query(Place, User)
            .outerjoin(User, Place.user_id == User.id)
            .filter(or_(
                Place.moderation_status == "pending",
                and_(Place.moderation_status == "approved", has_pending_reports),
            ))
            .order_by(Place.id.asc())
            .limit(200)
        )
    else:
        q = (
            db.query(Place, User)
            .outerjoin(User, Place.user_id == User.id)
            .filter(Place.moderation_status == status)
            .order_by(Place.id.asc())
            .limit(200)
        )

    rows = q.all()
    place_ids = [p.id for p, _u in rows]

    # Batch-загрузка медиа (вместо N+1)
    all_media = (
        db.query(Media).filter(Media.place_id.in_(place_ids)).all()
        if place_ids else []
    )
    media_by_place: dict[int, list] = {}
    for m in all_media:
        media_by_place.setdefault(m.place_id, []).append(m)

    # Batch-загрузка pending-жалоб с авторами (вместо N+1)
    report_rows = (
        db.query(Report, User)
        .outerjoin(User, Report.user_id == User.id)
        .filter(Report.place_id.in_(place_ids), Report.status == "pending")
        .order_by(Report.created_at.asc())
        .all()
    ) if place_ids else []
    reports_by_place: dict[int, list] = {}
    for r, u in report_rows:
        reports_by_place.setdefault(r.place_id, []).append({
            "id": r.id,
            "user_id": r.user_id,
            "user_login": u.login if u else None,
            "username": u.username if u else None,
            "category": r.category,
            "category_label": CATEGORY_LABELS.get(r.category, r.category),
            "comment": r.comment,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })

    # Сборка ответа
    items = []
    for place, user in rows:
        media_list = [
            {"id": m.id, "key": m.s3_key, "url": presign_get(m.s3_key)}
            for m in media_by_place.get(place.id, [])[:3]
        ]
        items.append({
            "id": place.id,
            "group_id": place.group_id,
            "title": place.title,
            "note": place.note,
            "lat": place.lat,
            "lon": place.lon,
            "moderation_status": place.moderation_status,
            "user_id": place.user_id,
            "user_login": user.login if user else None,
            "username": user.username if user else None,
            "media": media_list,
            "reports": reports_by_place.get(place.id, []),
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

    # Резолвим связанные жалобы: approve → dismissed, reject → upheld
    if req.status == "approved":
        ReportService.resolve_reports_for_place(db, place_id, "dismissed", current_user.id)
    elif req.status == "rejected":
        ReportService.resolve_reports_for_place(db, place_id, "upheld", current_user.id)

    return {"status": "ok", "place_id": place.id, "moderation_status": place.moderation_status}
