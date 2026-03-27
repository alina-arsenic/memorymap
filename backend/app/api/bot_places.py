import logging

from app.core.config import BOT_API_SECRET, MEDIA_LIMIT_PER_PLACE
from app.core.deps import get_db
from app.models.models import Group, Media, Place, User
from app.services.groups import GroupService
from app.services.places import PlaceService
from app.storage import (
    delete_object,
    detect_mime,
    generate_thumbnail,
    move_to_place_folder,
    presign_get,
    validate_temp_key,
)
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bot", tags=["bot"])


class BotPlacePatch(BaseModel):
    title: str | None = Field(None, max_length=200)
    note: str | None = Field(None, max_length=5000)
    group_id: int | None = None
    lat: float | None = None
    lon: float | None = None
    tg_id: int


class BotLinkMedia(BaseModel):
    temp_key: str
    tg_id: int


def _check_bot_secret(x_bot_secret: str | None):
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")


def _resolve_user(db: Session, tg_id: int) -> User:
    """Резолвит tg_id → User, кидает 400 если не привязан."""
    user = db.query(User).filter(User.tg_id == tg_id).one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="telegram_not_linked")
    return user


def _check_ownership(db: Session, place: Place, tg_id: int) -> User:
    """Проверяет, что tg_id соответствует владельцу точки. Возвращает User."""
    user = db.query(User).filter(User.tg_id == tg_id).one_or_none()
    if not user or place.user_id != user.id:
        raise HTTPException(status_code=403, detail="forbidden")
    return user


# ---------- GET /bot/places — последние 5 точек пользователя ----------

@router.get("/places")
def bot_list_places(
    tg_id: int = Query(...),
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    """Последние 5 точек пользователя (для /mypoints в боте)."""
    _check_bot_secret(x_bot_secret)
    user = _resolve_user(db, tg_id)

    # Подзапрос: количество медиа на точку
    media_count = (
        db.query(Media.place_id, func.count(Media.id).label("cnt"))
        .group_by(Media.place_id)
        .subquery()
    )

    rows = (
        db.query(Place, Group.name, media_count.c.cnt)
        .join(Group, Place.group_id == Group.id)
        .outerjoin(media_count, Place.id == media_count.c.place_id)
        .filter(Place.user_id == user.id)
        .order_by(Place.id.desc())
        .limit(5)
        .all()
    )

    items = []
    for place, group_name, photo_count in rows:
        items.append({
            "id": place.id,
            "title": place.title,
            "note": place.note,
            "lat": place.lat,
            "lon": place.lon,
            "group_name": group_name,
            "photo_count": photo_count or 0,
        })

    return {"items": items}


# ---------- PATCH /bot/places/{place_id} ----------

@router.patch("/places/{place_id}")
def bot_patch_place(
    place_id: int,
    payload: BotPlacePatch,
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    _check_bot_secret(x_bot_secret)

    place = db.query(Place).filter(Place.id == place_id).one_or_none()
    if not place:
        raise HTTPException(status_code=404, detail="not_found")

    user = _check_ownership(db, place, payload.tg_id)

    if payload.title is not None:
        # пустое, значит координаты
        t = (payload.title or "").strip()
        place.title = t if t else f"{place.lat:.5f}, {place.lon:.5f}"

    if payload.note is not None:
        place.note = payload.note

    # Смена слоя
    if payload.group_id is not None:
        new_group = db.query(Group).filter(Group.id == payload.group_id).one_or_none()
        if not new_group:
            raise HTTPException(status_code=404, detail="group_not_found")
        try:
            GroupService.require_can_add_place(db, user, new_group)
        except PermissionError:
            raise HTTPException(status_code=403, detail="no_write_access")
        place.group_id = payload.group_id
        # Обновляем статус модерации при смене слоя
        if new_group.visibility == "public" and user.role not in ("admin", "moderator"):
            place.moderation_status = "pending"
        elif new_group.visibility != "public":
            place.moderation_status = "approved"

    # Смена координат
    if payload.lat is not None and payload.lon is not None:
        place.lat = payload.lat
        place.lon = payload.lon

    db.commit()
    return {"ok": True}


# ---------- DELETE /bot/places/{place_id} ----------

@router.delete("/places/{place_id}")
def bot_delete_place(
    place_id: int,
    tg_id: int = Query(...),
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    _check_bot_secret(x_bot_secret)

    place = db.query(Place).filter(Place.id == place_id).one_or_none()
    if not place:
        raise HTTPException(status_code=404, detail="not_found")

    user = _check_ownership(db, place, tg_id)

    ok = PlaceService.delete_place(db, place_id, user)
    if not ok:
        raise HTTPException(status_code=500, detail="delete_failed")

    return {"ok": True}


# ---------- GET /bot/places/{place_id}/media ----------

@router.get("/places/{place_id}/media")
def bot_list_media(
    place_id: int,
    tg_id: int = Query(...),
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    """Список фото точки с presigned URL."""
    _check_bot_secret(x_bot_secret)

    place = db.query(Place).filter(Place.id == place_id).one_or_none()
    if not place:
        raise HTTPException(status_code=404, detail="not_found")

    _check_ownership(db, place, tg_id)

    media_rows = (
        db.query(Media)
        .filter(Media.place_id == place_id)
        .order_by(Media.id)
        .all()
    )

    items = []
    for m in media_rows:
        items.append({
            "id": m.id,
            "url": presign_get(m.s3_key),
        })

    return {"items": items}


# ---------- DELETE /bot/media/{media_id} ----------

@router.delete("/media/{media_id}")
def bot_delete_media(
    media_id: int,
    tg_id: int = Query(...),
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    """Удаление одного фото."""
    _check_bot_secret(x_bot_secret)

    m = db.query(Media).filter(Media.id == media_id).one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="not_found")

    place = db.query(Place).filter(Place.id == m.place_id).one_or_none()
    if not place:
        raise HTTPException(status_code=404, detail="not_found")

    _check_ownership(db, place, tg_id)

    try:
        delete_object(m.s3_key)
        if m.thumb_key:
            delete_object(m.thumb_key)
    except Exception:
        logger.warning("S3: не удалось удалить %s", m.s3_key, exc_info=True)

    db.delete(m)
    db.commit()
    return {"ok": True}


# ---------- POST /bot/places/{place_id}/media (привязка фото) ----------

@router.post("/places/{place_id}/media")
def bot_link_media(
    place_id: int,
    payload: BotLinkMedia,
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    _check_bot_secret(x_bot_secret)

    place = db.query(Place).filter(Place.id == place_id).one_or_none()
    if not place:
        raise HTTPException(status_code=404, detail="not_found")

    _check_ownership(db, place, payload.tg_id)

    validate_temp_key(payload.temp_key, place.user_id)

    # лимит фото на точку
    cnt = db.query(Media).filter(Media.place_id == place_id).count()
    if cnt >= MEDIA_LIMIT_PER_PLACE:
        raise HTTPException(status_code=400, detail="media_limit")

    # перемещаем из uploads/ в places/{place_id}/
    new_key = move_to_place_folder(payload.temp_key, place_id)
    thumb_key = generate_thumbnail(new_key)

    m = Media(
        place_id=place_id,
        user_id=place.user_id,
        s3_key=new_key,
        thumb_key=thumb_key,
        mime=detect_mime(payload.temp_key),
        status="ready",
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return {"id": m.id}
