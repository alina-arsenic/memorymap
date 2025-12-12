from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from sqlalchemy.orm import Session
import uuid

from app.storage import presign_put
from app.core.deps import get_db
from app.core.config import BOT_API_SECRET, MEDIA_LIMIT_PER_PLACE
from app.models.models import User, TelegramLinkCode, Media
from app.core.auth import _ensure_personal_group  # чтобы сразу завести личную группу

router = APIRouter()

class BotLinkReq(BaseModel):
    code: str
    tg_id: int

class BotPresignUploadReq(BaseModel):
    mime: str
    ext: str | None = None
    place_id: int

@router.post("/bot/link-telegram")
def bot_link_telegram(
    req: BotLinkReq,
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    row = db.query(TelegramLinkCode).filter(TelegramLinkCode.code == req.code).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="code_not_found")

    now = datetime.now(timezone.utc)
    if row.used_at is not None:
        raise HTTPException(status_code=409, detail="code_used")
    if row.expires_at < now:
        raise HTTPException(status_code=400, detail="code_expired")

    # tg_id уже привязан к другому пользователю?
    other = db.query(User).filter(User.tg_id == req.tg_id, User.id != row.user_id).one_or_none()
    if other:
        raise HTTPException(status_code=409, detail="tg_id_taken")

    user = db.query(User).filter(User.id == row.user_id).one()
    user.tg_id = req.tg_id

    row.used_at = now
    db.commit()

    # личная группа (чтобы логика была одинаковой как в tg-флоу)
    _ensure_personal_group(db, user)
    db.commit()

    return {"status": "ok", "user_id": user.id, "tg_id": user.tg_id}

@router.post("/bot/media/presign-upload")
def bot_presign_upload(
    req: BotPresignUploadReq,
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    # лимит фото на точку
    count = db.query(Media).filter(Media.place_id == req.place_id).count()
    if count >= MEDIA_LIMIT_PER_PLACE:
        raise HTTPException(status_code=400, detail="media_limit")

    ext = (req.ext or "").strip(".")
    fname = f"uploads/{uuid.uuid4()}" + (f".{ext}" if ext else "")
    url = presign_put(fname, req.mime)
    return {"key": fname, "url": url, "expires_in": 600}
