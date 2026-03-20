from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Set

from app.models.models import User, UserBlock
from sqlalchemy import or_
from sqlalchemy.orm import Session


class BlockService:
    """Сервис блокировки пользователей."""

    @staticmethod
    def block_user(db: Session, blocker: User, blocked_id: int) -> Dict:
        """Заблокировать пользователя. Удаляет дружбу и отменяет pending-запросы."""
        if blocker.id == blocked_id:
            raise ValueError("Нельзя заблокировать самого себя")

        blocked = db.query(User).filter(User.id == blocked_id).one_or_none()
        if not blocked:
            raise ValueError("Пользователь не найден")

        # Проверяем, не заблокирован ли уже
        existing = (
            db.query(UserBlock)
            .filter(UserBlock.blocker_id == blocker.id, UserBlock.blocked_id == blocked_id)
            .one_or_none()
        )
        if existing:
            return {"status": "already_blocked"}

        # Создаём запись блокировки
        block = UserBlock(
            blocker_id=blocker.id,
            blocked_id=blocked_id,
            created_at=datetime.now(timezone.utc),
        )
        db.add(block)
        db.flush()

        # Удаляем дружбу и отменяем pending-запросы/инвайты
        from app.services.friends import FriendsService
        FriendsService.remove_friendship(db, blocker, blocked_id)

        return {"status": "blocked"}

    @staticmethod
    def unblock_user(db: Session, blocker: User, blocked_id: int) -> Dict:
        """Разблокировать пользователя."""
        block = (
            db.query(UserBlock)
            .filter(UserBlock.blocker_id == blocker.id, UserBlock.blocked_id == blocked_id)
            .one_or_none()
        )
        if not block:
            raise ValueError("Пользователь не заблокирован")

        db.delete(block)
        db.commit()
        return {"status": "unblocked"}

    @staticmethod
    def list_blocked(db: Session, user: User) -> List[Dict]:
        """Список заблокированных пользователей."""
        blocks = (
            db.query(UserBlock)
            .filter(UserBlock.blocker_id == user.id)
            .order_by(UserBlock.created_at.desc())
            .all()
        )

        if not blocks:
            return []

        blocked_ids = [b.blocked_id for b in blocks]
        users = db.query(User).filter(User.id.in_(blocked_ids)).all()
        users_by_id = {u.id: u for u in users}

        # Сохраняем порядок из blocks (по дате блокировки)
        created_map = {b.blocked_id: b.created_at for b in blocks}

        result = []
        for bid in blocked_ids:
            u = users_by_id.get(bid)
            if u:
                result.append({
                    "id": u.id,
                    "login": u.login,
                    "username": u.username,
                    "blocked_at": created_map[bid].isoformat() if created_map.get(bid) else None,
                })
        return result

    @staticmethod
    def is_either_blocked(db: Session, user_a_id: int, user_b_id: int) -> bool:
        """Проверить, есть ли блокировка в любом направлении между двумя пользователями."""
        return (
            db.query(UserBlock)
            .filter(
                or_(
                    (UserBlock.blocker_id == user_a_id) & (UserBlock.blocked_id == user_b_id),
                    (UserBlock.blocker_id == user_b_id) & (UserBlock.blocked_id == user_a_id),
                )
            )
            .first()
        ) is not None

    @staticmethod
    def get_blocked_ids(db: Session, user_id: int) -> Set[int]:
        """Множество ID пользователей, которых заблокировал user_id."""
        rows = db.query(UserBlock.blocked_id).filter(UserBlock.blocker_id == user_id).all()
        return {r[0] for r in rows}

    @staticmethod
    def get_blocked_by_ids(db: Session, user_id: int) -> Set[int]:
        """Множество ID пользователей, которые заблокировали user_id."""
        rows = db.query(UserBlock.blocker_id).filter(UserBlock.blocked_id == user_id).all()
        return {r[0] for r in rows}
