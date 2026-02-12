from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone
import secrets

from app.core.deps import get_db
from app.core.auth import get_current_user
from app.models.models import User
from app.services.groups import GroupService
from app.services.users import UserService
from app.models.models import TelegramLinkCode
from app.core.config import TELEGRAM_LINK_CODE_TTL_MINUTES
from app.core.telegram import get_bot_username

router = APIRouter()

class AddFriendReq(BaseModel):
    friend_tg_id: int

@router.get("/me")
def me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    groups = GroupService.list_groups(db, current_user)
    friends = UserService.list_friends(db, current_user)
    return {
        "id": current_user.id,
        "tg_id": current_user.tg_id,
        "login": current_user.login,
        "username": current_user.username,
        "role": current_user.role,
        "groups": groups,
        "friends": friends,
    }

@router.post("/friends")
def add_friend(
    req: AddFriendReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return UserService.add_friend(db, current_user, req.friend_tg_id)

@router.post("/me/telegram-link/start")
def telegram_link_start(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    code = secrets.token_urlsafe(8)  # короткий код
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=TELEGRAM_LINK_CODE_TTL_MINUTES)

    row = TelegramLinkCode(user_id=current_user.id, code=code, expires_at=expires_at, used_at=None)
    db.add(row)
    db.commit()

    # формируем deep link, если известен username бота
    bot_username = get_bot_username()
    bot_link = f"https://t.me/{bot_username}?start={code}" if bot_username else None

    return {
        "code": code,
        "bot_link": bot_link,
        "expires_in_minutes": TELEGRAM_LINK_CODE_TTL_MINUTES,
    }
