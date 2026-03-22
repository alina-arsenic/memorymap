from app.core.config import BOT_API_SECRET, MEDIA_LIMIT_PER_PLACE
from app.core.deps import get_db
from app.models.models import Media, Place, User
from app.storage import detect_mime, move_to_place_folder, validate_temp_key
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter(prefix="/bot", tags=["bot"])

class BotPlacePatch(BaseModel):
    title: str | None = None
    note: str | None = None
    tg_id: int

class BotLinkMedia(BaseModel):
    temp_key: str
    tg_id: int

def _check_bot_secret(x_bot_secret: str | None):
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

def _check_ownership(db: Session, place: Place, tg_id: int):
    """Проверяет, что tg_id соответствует владельцу точки."""
    user = db.query(User).filter(User.tg_id == tg_id).one_or_none()
    if not user or place.user_id != user.id:
        raise HTTPException(status_code=403, detail="forbidden")

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

    _check_ownership(db, place, payload.tg_id)

    if payload.title is not None:
        # пустое, значит координаты
        t = (payload.title or "").strip()
        place.title = t if t else f"{place.lat:.5f}, {place.lon:.5f}"

    if payload.note is not None:
        place.note = payload.note

    db.commit()
    return {"ok": True}

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

    m = Media(
        place_id=place_id,
        user_id=place.user_id,
        s3_key=new_key,
        mime=detect_mime(payload.temp_key),
        status="ready",
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return {"id": m.id}
