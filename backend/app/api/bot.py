import uuid
from datetime import datetime, timezone

from app.core.config import (
    ALLOWED_IMAGE_EXTENSIONS,
    ALLOWED_IMAGE_MIMES,
    BOT_API_SECRET,
    MEDIA_LIMIT_PER_PLACE,
)
from app.core.deps import get_db
from app.models.models import Media, Place, TelegramLinkCode, User
from app.services.groups import GroupService
from app.storage import presign_put
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

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
    return {"status": "ok", "user_id": user.id, "tg_id": user.tg_id}

@router.get("/bot/groups")
def bot_list_groups(
    tg_id: int = Query(...),
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    """Список групп, в которые пользователь может добавлять точки (для бота)."""
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    user = db.query(User).filter(User.tg_id == tg_id).one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="telegram_not_linked")

    all_groups = GroupService.list_groups(db, user)

    # Оставляем только группы, куда пользователь может добавлять точки:
    # - те, где юзер участник (owner/editor)
    # - общий публичный слой "Public map" (id=1) — всегда доступен всем
    items = []
    for g in all_groups:
        role = g.get("my_role")
        if role in ("owner", "editor") or g["id"] == 1:
            items.append({
                "id": g["id"],
                "name": g["name"],
                "is_personal": g.get("is_personal", False),
            })

    # Автосоздание личного слоя, если у пользователя нет ни одной группы
    if not items:
        GroupService.ensure_personal_group(db, user)
        # Повторяем запрос после создания
        all_groups = GroupService.list_groups(db, user)
        for g in all_groups:
            role = g.get("my_role")
            if role in ("owner", "editor") or g["id"] == 1:
                items.append({
                    "id": g["id"],
                    "name": g["name"],
                    "is_personal": g.get("is_personal", False),
                })

    return {"items": items}


@router.post("/bot/media/presign-upload")
def bot_presign_upload(
    req: BotPresignUploadReq,
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    # Валидация расширения
    ext = (req.ext or "").strip(".").lower()
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="invalid_extension")

    # Валидация MIME-типа
    if req.mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(status_code=400, detail="invalid_mime")

    # Проверяем, что точка существует, и получаем user_id владельца
    place = db.query(Place).filter(Place.id == req.place_id).one_or_none()
    if not place:
        raise HTTPException(status_code=404, detail="not_found")

    # лимит фото на точку
    count = db.query(Media).filter(Media.place_id == req.place_id).count()
    if count >= MEDIA_LIMIT_PER_PLACE:
        raise HTTPException(status_code=400, detail="media_limit")

    fname = f"uploads/{place.user_id}/{uuid.uuid4()}.{ext}"
    url = presign_put(fname, req.mime)
    return {"key": fname, "url": url, "expires_in": 600}


# ---------- POST /bot/groups — создание слоя из бота ----------

class BotCreateGroupReq(BaseModel):
    tg_id: int
    name: str
    visibility: str = "private"


@router.post("/bot/groups")
def bot_create_group(
    req: BotCreateGroupReq,
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    """Создание нового слоя из Telegram-бота."""
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    user = db.query(User).filter(User.tg_id == req.tg_id).one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="telegram_not_linked")

    name = (req.name or "").strip()
    if not name or len(name) > 100:
        raise HTTPException(status_code=400, detail="invalid_name")

    if req.visibility not in ("private", "public"):
        raise HTTPException(status_code=400, detail="invalid_visibility")

    gid = GroupService.create_group(db, user, name, req.visibility)
    return {"id": gid, "name": name}


# ---------- DELETE /bot/unlink-telegram ----------

@router.delete("/bot/unlink-telegram")
def bot_unlink_telegram(
    tg_id: int = Query(...),
    x_bot_secret: str | None = Header(default=None, alias="X-Bot-Secret"),
    db: Session = Depends(get_db),
):
    """Отвязка Telegram через бота."""
    if not BOT_API_SECRET or x_bot_secret != BOT_API_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    user = db.query(User).filter(User.tg_id == tg_id).one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="telegram_not_linked")

    # Защита: нельзя отвязать если нет пароля (иначе пользователь не войдёт)
    if not user.password_hash:
        raise HTTPException(status_code=400, detail="set_password_first")

    user.tg_id = None
    user.username = None
    db.commit()
    return {"status": "ok"}
