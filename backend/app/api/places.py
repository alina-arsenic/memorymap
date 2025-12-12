from typing import Optional, List, Dict
from fastapi import APIRouter, Depends, HTTPException, Body, Header
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.core.auth import get_current_user
from app.core.config import MEDIA_LIMIT_PER_PLACE
from app.models.models import User, Place, Media
from app.services.places import PlaceService
from app.storage import move_to_place_folder
from app.core.config import BOT_API_SECRET
from app.services.users import UserService


router = APIRouter()

class PlaceCreate(BaseModel):
    group_id: int
    title: Optional[str] = None
    note: Optional[str] = None
    lat: float
    lon: float
    media_keys: List[str] = []

class BotPlaceCreate(BaseModel):
    group_id: int
    tg_id: int
    username: Optional[str] = None
    title: Optional[str] = None
    note: Optional[str] = None
    lat: float
    lon: float
    media_keys: List[str] = []

@router.post("/places")
def create_place(
    p: PlaceCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    pid = PlaceService.create_place(
        db=db,
        group_id=p.group_id,
        user_id=current_user.id,
        tg_id=None,
        username=None,
        title=p.title,
        note=p.note,
        lat=p.lat,
        lon=p.lon,
        media_keys=p.media_keys,
    )
    return {"id": pid}

@router.get("/places")
def list_places(group_id: int, bbox: str, db: Session = Depends(get_db)):
    items = PlaceService.list_places(db=db, group_id=group_id, bbox=bbox)
    return {"items": items}

@router.post("/places/bot")
def create_place_bot(
    p: BotPlaceCreate,
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    # tg_id должен быть привязан к аккаунту
    user = db.query(User).filter(User.tg_id == p.tg_id).one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="telegram_not_linked")

    # можно обновлять username, если пришёл
    if p.username and (user.username != p.username):
        user.username = p.username
        db.commit()

    try:
        pid = PlaceService.create_place(
            db=db,
            group_id=p.group_id,
            user_id=user.id,
            tg_id=None,
            username=None,
            title=p.title,
            note=p.note,
            lat=p.lat,
            lon=p.lon,
            media_keys=p.media_keys,
        )
        return {"id": pid}
    except ValueError as e:
        if str(e) == "media_limit":
            raise HTTPException(status_code=400, detail="media_limit")
        raise

@router.patch("/places/{place_id}")
def update_place(place_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    place = db.query(Place).filter(Place.id == place_id).one_or_none()
    if not place:
        raise HTTPException(404, "Not found")

    if "title" in payload:
        place.title = payload["title"]
    if "note" in payload:
        place.note = payload["note"]

    db.commit()
    return {"status": "ok"}

class AddMediaReq(BaseModel):
    temp_key: str

@router.post("/places/{place_id}/media")
def add_media(place_id: int, req: AddMediaReq, db: Session = Depends(get_db)):
    place = db.query(Place).filter(Place.id == place_id).one_or_none()
    if not place:
        raise HTTPException(404, "Not found")

    count = db.query(Media).filter(Media.place_id == place_id).count()
    if count >= MEDIA_LIMIT_PER_PLACE:
        raise HTTPException(status_code=400, detail="media_limit")

    new_key = move_to_place_folder(req.temp_key, place_id)
    db.add(Media(
        place_id=place_id,
        user_id=place.user_id,
        s3_key=new_key,
        mime="image/jpeg",
        status="ready",
    ))
    db.commit()
    return {"status": "ok"}

@router.delete("/places/{place_id}")
def delete_place(
    place_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    ok = PlaceService.delete_place(db, place_id, current_user)
    if not ok:
        raise HTTPException(status_code=403, detail="Forbidden")
    return {"status": "ok"}
