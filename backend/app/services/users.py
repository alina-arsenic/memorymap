import uuid
from typing import Optional, List, Dict
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.models.models import User, Friend

class UserService:
    @staticmethod
    def ensure_user(
        db: Session,
        user_id: Optional[int],
        tg_id: Optional[int],
        username: Optional[str],
    ) -> Optional[int]:
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
    def add_friend(db: Session, user: User, friend_tg_id: int) -> Dict:
        friend = db.query(User).filter(User.tg_id == friend_tg_id).one_or_none()
        if not friend:
            friend = User(tg_id=friend_tg_id, username=None)
            db.add(friend)
            db.commit()
            db.refresh(friend)

        row = db.query(Friend).filter(
            Friend.user_id == user.id,
            Friend.friend_id == friend.id
        ).one_or_none()
        if not row:
            db.add(Friend(user_id=user.id, friend_id=friend.id, status="accepted"))
            db.commit()

        return {"id": friend.id, "tg_id": friend.tg_id, "username": friend.username}

    @staticmethod
    def list_friends(db: Session, user: User) -> List[Dict]:
        sql = """
        SELECT u.id, u.tg_id, u.username
        FROM friends f
        JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = :uid AND f.status = 'accepted'
        ORDER BY u.id
        """
        rows = db.execute(text(sql), {"uid": user.id}).fetchall()
        return [{"id": r[0], "tg_id": r[1], "username": r[2]} for r in rows]
