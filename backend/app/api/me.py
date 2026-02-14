import secrets
from datetime import datetime, timedelta, timezone

from app.core.auth import get_current_user
from app.core.config import TELEGRAM_LINK_CODE_TTL_MINUTES
from app.core.deps import get_db
from app.core.telegram import get_bot_username
from app.models.models import (
    EmailVerificationCode,
    Friend,
    FriendRequest,
    Friendship,
    Group,
    Media,
    Place,
    TelegramLinkCode,
    User,
)
from app.services.friends import FriendsService
from app.services.groups import GroupService
from app.services.users import UserService
from app.storage import delete_place_folder
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

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

    # Ensure personal private layer exists
    GroupService.ensure_personal_group(db, current_user)

    groups = GroupService.list_groups(db, current_user)
    friends = UserService.list_friends(db, current_user)
    inbox_count = FriendsService.inbox_count(db, current_user)

    return {
        "id": current_user.id,
        "tg_id": current_user.tg_id,
        "login": current_user.login,
        "username": current_user.username,
        "role": current_user.role,
        "groups": groups,
        "friends": friends,
        "friend_requests_inbox_count": inbox_count,
    }

# Legacy endpoint: keep path for compatibility, but now it creates a friend REQUEST by tg_id.
@router.post("/friends")
def add_friend(
    req: AddFriendReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return UserService.add_friend_by_tg_id_as_request(db, current_user, req.friend_tg_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

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


@router.delete("/me")
def delete_account(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Удаление аккаунта текущего пользователя и всех связанных данных."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    uid = current_user.id

    # 1. Удаляем файлы из MinIO для каждой точки пользователя
    user_places = db.query(Place).filter(Place.user_id == uid).all()
    for place in user_places:
        delete_place_folder(place.id)

    # 2. Удаляем медиа-записи точек пользователя
    place_ids = [p.id for p in user_places]
    if place_ids:
        db.query(Media).filter(Media.place_id.in_(place_ids)).delete(synchronize_session=False)

    # 3. Удаляем точки пользователя
    db.query(Place).filter(Place.user_id == uid).delete(synchronize_session=False)

    # 4. Удаляем дружбы и запросы дружбы
    db.query(Friendship).filter(
        (Friendship.user1_id == uid) | (Friendship.user2_id == uid)
    ).delete(synchronize_session=False)
    db.query(FriendRequest).filter(
        (FriendRequest.from_user_id == uid) | (FriendRequest.to_user_id == uid)
    ).delete(synchronize_session=False)
    db.query(Friend).filter(
        (Friend.user_id == uid) | (Friend.friend_id == uid)
    ).delete(synchronize_session=False)

    # 5. Удаляем личные группы пользователя (и их точки через CASCADE в БД)
    db.query(Group).filter(Group.owner_id == uid, Group.is_personal.is_(True)).delete(
        synchronize_session=False
    )

    # 6. Удаляем коды верификации и привязки Telegram
    db.query(EmailVerificationCode).filter(EmailVerificationCode.user_id == uid).delete(
        synchronize_session=False
    )
    db.query(TelegramLinkCode).filter(TelegramLinkCode.user_id == uid).delete(
        synchronize_session=False
    )

    # 7. Удаляем самого пользователя
    db.delete(current_user)
    db.commit()

    return {"detail": "account_deleted"}
