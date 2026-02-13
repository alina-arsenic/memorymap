import uuid
from typing import Optional, List, Dict

from sqlalchemy.orm import Session
from sqlalchemy import or_

from app.models.models import User
from app.services.friends import FriendsService


class UserService:
    @staticmethod
    def ensure_user(
        db: Session,
        user_id: Optional[int],
        tg_id: Optional[int],
        username: Optional[str],
    ) -> Optional[int]:
        # This function is used by the bot integration.
        if tg_id:
            user = db.query(User).filter(User.tg_id == tg_id).one_or_none()
            if user:
                return user.id
            user = User(tg_id=tg_id, username=username)
            db.add(user)
            db.commit()
            db.refresh(user)
            return user.id

        if user_id:
            user = db.query(User).filter(User.id == user_id).one_or_none()
            if user:
                return user_id
            user = User(username=username or f"auto_{uuid.uuid4().hex[:8]}")
            db.add(user)
            db.commit()
            db.refresh(user)
            return user.id

        return None

    @staticmethod
    def search_users(db: Session, q: str, limit: int = 20) -> List[Dict]:
        q = (q or "").strip()
        if not q:
            return []

        conditions = []
        # string match
        like = f"%{q}%"
        conditions.append(User.login.ilike(like))
        conditions.append(User.username.ilike(like))

        # tg_id exact match if numeric
        if q.isdigit():
            conditions.append(User.tg_id == int(q))

        users = (
            db.query(User)
            .filter(or_(*conditions))
            .order_by(User.id.asc())
            .limit(max(1, min(limit, 50)))
            .all()
        )

        return [
            {"id": u.id, "tg_id": u.tg_id, "username": u.username, "login": u.login}
            for u in users
        ]

    @staticmethod
    def list_friends(db: Session, user: User) -> List[Dict]:
        return FriendsService.list_friends(db, user)

    @staticmethod
    def add_friend_by_tg_id_as_request(db: Session, user: User, friend_tg_id: int) -> Dict:
        # Legacy endpoint support: send friend request by tg_id without auto-creating "ghost" users.
        friend = db.query(User).filter(User.tg_id == friend_tg_id).one_or_none()
        if not friend:
            raise ValueError("User with this tg_id not found")
        return FriendsService.send_request(db, user, friend.id)
