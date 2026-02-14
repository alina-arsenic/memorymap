from app.core.config import BOT_API_SECRET, MEDIA_LIMIT_PER_PLACE
from app.core.deps import get_db
from app.models.models import Media, Place
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter(prefix="/bot", tags=["bot"])

class BotPlacePatch(BaseModel):
    title: str | None = None
    note: str | None = None

class BotLinkMedia(BaseModel):
    temp_key: str

def _check_bot_secret(x_bot_secret: str | None):
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
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

    # лимит фото на точку
    cnt = db.query(Media).filter(Media.place_id == place_id).count()
    if cnt >= MEDIA_LIMIT_PER_PLACE:
        raise HTTPException(status_code=400, detail="media_limit")

    m = Media(
        place_id=place_id,
        user_id=place.user_id,
        s3_key=payload.temp_key,
        mime="image/jpeg",
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return {"id": m.id}
