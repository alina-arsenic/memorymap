import re
import secrets
from datetime import datetime, timedelta, timezone

from app.api.auth import _generate_code, _validate_email
from app.core.auth import get_current_user
from app.core.config import EMAIL_CODE_TTL_MINUTES, JWT_EXPIRES_MINUTES, TELEGRAM_LINK_CODE_TTL_MINUTES
from app.core.deps import get_db
from app.core.jwt import create_access_token
from app.core.security import hash_password, verify_password
from app.core.telegram import get_bot_username
from app.models.models import (
    EmailVerificationCode,
    Friend,
    FriendRequest,
    Friendship,
    Group,
    GroupInvite,
    Media,
    PasswordResetCode,
    Place,
    TelegramLinkCode,
    User,
    UserBlock,
)
from app.services.blocks import BlockService
from app.services.email import send_email_change_email
from app.services.friends import FriendsService
from app.services.group_invites import GroupInviteService
from app.services.groups import GroupService
from app.services.notifications import NotificationService
from app.services.users import UserService
from app.storage import delete_place_folder
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

_LOGIN_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

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
    inbox_count = FriendsService.inbox_count(db, current_user)
    group_invites_count = GroupInviteService.inbox_count(db, current_user.id)
    blocked_users = BlockService.list_blocked(db, current_user)
    notifications_count = NotificationService.count_unread(db, current_user.id)

    return {
        "id": current_user.id,
        "tg_id": current_user.tg_id,
        "login": current_user.login,
        "email": current_user.email,
        "username": current_user.username,
        "role": current_user.role,
        "groups": groups,
        "friends": friends,
        "friend_requests_inbox_count": inbox_count,
        "group_invites_inbox_count": group_invites_count,
        "blocked_users": blocked_users,
        "notifications_count": notifications_count,
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

    # 4. Удаляем дружбы, запросы дружбы и инвайты в группы
    db.query(GroupInvite).filter(
        (GroupInvite.from_user_id == uid) | (GroupInvite.to_user_id == uid)
    ).delete(synchronize_session=False)
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

    # 6. Удаляем блокировки пользователя
    db.query(UserBlock).filter(
        (UserBlock.blocker_id == uid) | (UserBlock.blocked_id == uid)
    ).delete(synchronize_session=False)

    # 7. Удаляем коды верификации, сброса пароля и привязки Telegram
    db.query(EmailVerificationCode).filter(EmailVerificationCode.user_id == uid).delete(
        synchronize_session=False
    )
    db.query(PasswordResetCode).filter(PasswordResetCode.user_id == uid).delete(
        synchronize_session=False
    )
    db.query(TelegramLinkCode).filter(TelegramLinkCode.user_id == uid).delete(
        synchronize_session=False
    )

    # 8. Удаляем самого пользователя
    db.delete(current_user)
    db.commit()

    return {"detail": "account_deleted"}


# ---------- F3: Сменить пароль ----------

class ChangePasswordReq(BaseModel):
    old_password: str
    new_password: str


@router.post("/me/change-password")
def change_password(
    req: ChangePasswordReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # защита от bcrypt DoS
    if len(req.old_password) > 128:
        raise HTTPException(status_code=400, detail="password_too_long")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="password_too_short")
    if len(req.new_password) > 128:
        raise HTTPException(status_code=400, detail="password_too_long")

    # re-query (current_user expunged)
    user = db.query(User).filter(User.id == current_user.id).one()

    # Telegram-only юзер без пароля
    if not user.password_hash:
        raise HTTPException(status_code=400, detail="no_password_set")

    if not verify_password(req.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="wrong_password")

    now = datetime.now(timezone.utc)
    user.password_hash = hash_password(req.new_password)
    user.tokens_valid_after = now  # инвалидируем все старые JWT
    db.commit()

    # выдаём новый токен для текущей сессии
    token = create_access_token(user.id)
    return {"status": "ok", "access_token": token, "expires_minutes": JWT_EXPIRES_MINUTES}


# ---------- F4: Сменить логин ----------

class ChangeLoginReq(BaseModel):
    new_login: str


@router.post("/me/change-login")
def change_login(
    req: ChangeLoginReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    new_login = (req.new_login or "").strip()
    if len(new_login) < 3 or len(new_login) > 64:
        raise HTTPException(status_code=400, detail="login_invalid_length")
    if not _LOGIN_RE.match(new_login):
        raise HTTPException(status_code=400, detail="login_invalid_chars")

    # re-query (current_user expunged)
    user = db.query(User).filter(User.id == current_user.id).one()

    if user.login == new_login:
        raise HTTPException(status_code=400, detail="login_same")

    # проверка уникальности
    existing = db.query(User).filter(User.login == new_login).first()
    if existing:
        raise HTTPException(status_code=409, detail="login_taken")

    user.login = new_login
    db.commit()

    return {"status": "ok", "login": new_login}


# ---------- F5: Сменить email (шаг 1 — отправка кода) ----------

class ChangeEmailReq(BaseModel):
    new_email: str


@router.post("/me/change-email")
def change_email(
    req: ChangeEmailReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    new_email = _validate_email(req.new_email)

    # re-query (current_user expunged)
    user = db.query(User).filter(User.id == current_user.id).one()

    if user.email and user.email == new_email:
        raise HTTPException(status_code=400, detail="email_same")

    # проверка уникальности
    existing = db.query(User).filter(User.email == new_email, User.id != user.id).first()
    if existing:
        raise HTTPException(status_code=409, detail="email_taken")

    # генерируем код и отправляем на НОВЫЙ email
    code = _generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=EMAIL_CODE_TTL_MINUTES)
    db.add(EmailVerificationCode(user_id=user.id, code=code, expires_at=expires_at))
    db.commit()

    if not send_email_change_email(new_email, code):
        raise HTTPException(status_code=503, detail="email_send_failed")

    return {"status": "sent"}


# ---------- F5: Подтвердить смену email (шаг 2) ----------

class ConfirmEmailReq(BaseModel):
    new_email: str
    code: str


@router.post("/me/confirm-email")
def confirm_email(
    req: ConfirmEmailReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    new_email = _validate_email(req.new_email)

    # re-query (current_user expunged)
    user = db.query(User).filter(User.id == current_user.id).one()

    # повторная проверка уникальности (race condition protection)
    existing = db.query(User).filter(User.email == new_email, User.id != user.id).first()
    if existing:
        raise HTTPException(status_code=409, detail="email_taken")

    # ищем последний неиспользованный код
    row = (
        db.query(EmailVerificationCode)
        .filter(
            EmailVerificationCode.user_id == user.id,
            EmailVerificationCode.used_at.is_(None),
        )
        .order_by(EmailVerificationCode.id.desc())
        .first()
    )

    if not row:
        raise HTTPException(status_code=400, detail="no_active_code")

    now = datetime.now(timezone.utc)
    if row.expires_at < now:
        raise HTTPException(status_code=400, detail="code_expired")

    if row.code != req.code.strip():
        raise HTTPException(status_code=400, detail="wrong_code")

    # применяем смену email
    row.used_at = now
    user.email = new_email
    user.email_verified = True
    user.tokens_valid_after = now  # инвалидируем все старые JWT
    db.commit()

    # выдаём новый токен для текущей сессии
    token = create_access_token(user.id)
    return {"status": "ok", "access_token": token, "expires_minutes": JWT_EXPIRES_MINUTES}
