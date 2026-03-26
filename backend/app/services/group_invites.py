from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.models.models import GroupInvite, User
from app.services.friends import FriendsService
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


class GroupInviteService:
    """Сервис инвайтов в группы (слои)."""

    @staticmethod
    def inbox_count(db: Session, user_id: int) -> int:
        """Количество pending-инвайтов для бейджа."""
        return (
            db.query(GroupInvite)
            .filter(GroupInvite.to_user_id == user_id, GroupInvite.status == "pending")
            .count()
        )

    @staticmethod
    def send_invite(db: Session, owner: User, group_id: int, to_user_id: int, role: str = "viewer") -> Dict:
        """Отправить инвайт в группу. Только owner группы может приглашать, только друзей."""
        if owner.id == to_user_id:
            raise ValueError("Нельзя пригласить самого себя")

        if role not in ("editor", "viewer"):
            raise ValueError("Роль должна быть editor или viewer")

        # Проверка: отправитель — owner группы
        membership = db.execute(
            text("SELECT role FROM membership WHERE user_id=:uid AND group_id=:gid"),
            {"uid": owner.id, "gid": group_id},
        ).fetchone()
        if not membership or (membership[0] != "owner" and owner.role != "admin"):
            raise PermissionError("Только владелец слоя может приглашать участников")

        # Проверка: получатель существует
        to_user = db.query(User).filter(User.id == to_user_id).one_or_none()
        if not to_user:
            raise ValueError("Пользователь не найден")

        # Проверка блокировки (в любом направлении)
        from app.services.blocks import BlockService
        if BlockService.is_either_blocked(db, owner.id, to_user_id):
            raise ValueError("Невозможно отправить приглашение этому пользователю")

        # Проверка: получатель — друг отправителя
        if not FriendsService.are_friends(db, owner.id, to_user_id):
            raise ValueError("Приглашать можно только друзей")

        # Проверка: получатель ещё не участник группы
        existing_member = db.execute(
            text("SELECT 1 FROM membership WHERE user_id=:uid AND group_id=:gid"),
            {"uid": to_user_id, "gid": group_id},
        ).fetchone()
        if existing_member:
            raise ValueError("Пользователь уже участник слоя")

        # Проверка: нет pending-инвайта (unique index, но лучше вернуть понятную ошибку)
        existing_invite = (
            db.query(GroupInvite)
            .filter(
                GroupInvite.group_id == group_id,
                GroupInvite.to_user_id == to_user_id,
                GroupInvite.status == "pending",
            )
            .one_or_none()
        )
        if existing_invite:
            return {"status": "already_pending", "invite_id": existing_invite.id}

        invite = GroupInvite(
            group_id=group_id,
            from_user_id=owner.id,
            to_user_id=to_user_id,
            role=role,
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(invite)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            # Гонка: параллельный запрос уже создал pending-инвайт
            existing = (
                db.query(GroupInvite)
                .filter(GroupInvite.group_id == group_id, GroupInvite.to_user_id == to_user_id, GroupInvite.status == "pending")
                .one_or_none()
            )
            if existing:
                return {"status": "already_pending", "invite_id": existing.id}
            raise ValueError("Не удалось создать приглашение")
        db.refresh(invite)
        return {"status": "pending", "invite_id": invite.id}

    @staticmethod
    def accept_invite(db: Session, user: User, invite_id: int) -> Dict:
        """Принять инвайт — добавить пользователя в membership."""
        invite = db.query(GroupInvite).filter(GroupInvite.id == invite_id).one_or_none()
        if not invite:
            raise ValueError("Приглашение не найдено")
        if invite.to_user_id != user.id:
            raise PermissionError("Это не ваше приглашение")
        if invite.status != "pending":
            return {"status": invite.status}

        # Проверка блокировки (в любом направлении)
        from app.services.blocks import BlockService
        if BlockService.is_either_blocked(db, invite.from_user_id, user.id):
            raise ValueError("Приглашение недействительно: пользователь заблокирован")

        # Проверка: отправитель ещё друг (дружба могла быть удалена)
        if not FriendsService.are_friends(db, invite.from_user_id, user.id):
            raise ValueError("Приглашение недействительно: вы больше не друзья с отправителем")

        # Добавить в membership
        db.execute(
            text(
                "INSERT INTO membership (user_id, group_id, role) VALUES (:uid, :gid, :role) "
                "ON CONFLICT (user_id, group_id) DO UPDATE SET role=:role"
            ),
            {"uid": user.id, "gid": invite.group_id, "role": invite.role},
        )

        invite.status = "accepted"
        invite.responded_at = datetime.now(timezone.utc)
        db.add(invite)
        db.commit()
        return {"status": "accepted"}

    @staticmethod
    def decline_invite(db: Session, user: User, invite_id: int) -> Dict:
        """Отклонить инвайт."""
        invite = db.query(GroupInvite).filter(GroupInvite.id == invite_id).one_or_none()
        if not invite:
            raise ValueError("Приглашение не найдено")
        if invite.to_user_id != user.id:
            raise PermissionError("Это не ваше приглашение")
        if invite.status != "pending":
            return {"status": invite.status}

        invite.status = "declined"
        invite.responded_at = datetime.now(timezone.utc)
        db.add(invite)
        db.commit()
        return {"status": "declined"}

    @staticmethod
    def cancel_invite(db: Session, owner: User, invite_id: int) -> Dict:
        """Отмена инвайта владельцем группы."""
        invite = db.query(GroupInvite).filter(GroupInvite.id == invite_id).one_or_none()
        if not invite:
            raise ValueError("Приглашение не найдено")

        # Проверка: текущий пользователь — owner группы (или admin)
        membership = db.execute(
            text("SELECT role FROM membership WHERE user_id=:uid AND group_id=:gid"),
            {"uid": owner.id, "gid": invite.group_id},
        ).fetchone()
        if not membership or (membership[0] != "owner" and owner.role != "admin"):
            raise PermissionError("Только владелец слоя может отменять приглашения")

        if invite.status != "pending":
            return {"status": invite.status}

        invite.status = "canceled"
        invite.responded_at = datetime.now(timezone.utc)
        db.add(invite)
        db.commit()
        return {"status": "canceled"}

    @staticmethod
    def list_invites(
        db: Session,
        user: User,
        inbox: bool = False,
        outbox: bool = False,
        status: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict]:
        """Список инвайтов (входящие/исходящие)."""
        from sqlalchemy import or_

        q = db.query(GroupInvite)

        clauses = []
        if inbox:
            clauses.append(GroupInvite.to_user_id == user.id)
        if outbox:
            clauses.append(GroupInvite.from_user_id == user.id)
        if not clauses:
            clauses.append(GroupInvite.to_user_id == user.id)

        q = q.filter(or_(*clauses))

        if status:
            q = q.filter(GroupInvite.status == status)

        q = q.order_by(GroupInvite.created_at.desc()).limit(limit)
        rows = q.all()

        # Предзагрузка пользователей и групп
        user_ids = set()
        group_ids = set()
        for r in rows:
            user_ids.add(r.from_user_id)
            user_ids.add(r.to_user_id)
            group_ids.add(r.group_id)

        from app.models.models import Group
        users = db.query(User).filter(User.id.in_(list(user_ids))).all() if user_ids else []
        groups = db.query(Group).filter(Group.id.in_(list(group_ids))).all() if group_ids else []
        users_by_id = {u.id: u for u in users}
        groups_by_id = {g.id: g for g in groups}

        items = []
        for r in rows:
            fu = users_by_id.get(r.from_user_id)
            tu = users_by_id.get(r.to_user_id)
            gr = groups_by_id.get(r.group_id)
            items.append({
                "id": r.id,
                "status": r.status,
                "role": r.role,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "responded_at": r.responded_at.isoformat() if r.responded_at else None,
                "group": {"id": gr.id, "name": gr.name} if gr else {"id": r.group_id},
                "from_user": {"id": fu.id, "login": fu.login, "username": fu.username} if fu else {"id": r.from_user_id},
                "to_user": {"id": tu.id, "login": tu.login, "username": tu.username} if tu else {"id": r.to_user_id},
            })
        return items
