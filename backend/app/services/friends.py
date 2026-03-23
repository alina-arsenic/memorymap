from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.models.models import FriendRequest, Friendship, GroupInvite, User
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


class FriendsService:
    @staticmethod
    def are_friends(db: Session, a_id: int, b_id: int) -> bool:
        u1, u2 = _pair(a_id, b_id)
        return db.query(Friendship).filter(
            Friendship.user1_id == u1,
            Friendship.user2_id == u2,
        ).one_or_none() is not None

    @staticmethod
    def list_friends(db: Session, user: User) -> List[Dict]:
        # Join via friendships pair table.
        rows = (
            db.query(Friendship)
            .filter(or_(Friendship.user1_id == user.id, Friendship.user2_id == user.id))
            .all()
        )
        friend_ids: List[int] = []
        for r in rows:
            friend_ids.append(r.user2_id if r.user1_id == user.id else r.user1_id)

        if not friend_ids:
            return []

        users = (
            db.query(User)
            .filter(User.id.in_(friend_ids))
            .order_by(User.id.asc())
            .all()
        )
        return [{"id": u.id, "username": u.username, "login": u.login} for u in users]

    @staticmethod
    def inbox_count(db: Session, user: User) -> int:
        return (
            db.query(FriendRequest)
            .filter(
                FriendRequest.to_user_id == user.id,
                FriendRequest.status == "pending",
            )
            .count()
        )

    @staticmethod
    def send_request(db: Session, from_user: User, to_user_id: int) -> Dict:
        if from_user.id == to_user_id:
            raise ValueError("Cannot send friend request to yourself")

        to_user = db.query(User).filter(User.id == to_user_id).one_or_none()
        if not to_user:
            raise ValueError("User not found")

        # Проверка блокировки (в любом направлении)
        from app.services.blocks import BlockService
        if BlockService.is_either_blocked(db, from_user.id, to_user_id):
            raise ValueError("Cannot send friend request to this user")

        # Already friends?
        if FriendsService.are_friends(db, from_user.id, to_user_id):
            return {"status": "already_friends"}

        # If there is an incoming pending request (to -> from), accept it automatically.
        incoming = (
            db.query(FriendRequest)
            .filter(
                FriendRequest.from_user_id == to_user_id,
                FriendRequest.to_user_id == from_user.id,
                FriendRequest.status == "pending",
            )
            .one_or_none()
        )
        if incoming:
            FriendsService._accept_request_row(db, incoming)
            return {"status": "accepted_by_reverse_request", "request_id": incoming.id}

        # Existing outgoing pending?
        outgoing = (
            db.query(FriendRequest)
            .filter(
                FriendRequest.from_user_id == from_user.id,
                FriendRequest.to_user_id == to_user_id,
                FriendRequest.status == "pending",
            )
            .one_or_none()
        )
        if outgoing:
            return {"status": "already_pending", "request_id": outgoing.id}

        req = FriendRequest(
            from_user_id=from_user.id,
            to_user_id=to_user_id,
            status="pending",
            created_at=datetime.now(timezone.utc),
            responded_at=None,
        )
        db.add(req)
        db.commit()
        db.refresh(req)
        return {"status": "pending", "request_id": req.id}

    @staticmethod
    def remove_friendship(db: Session, current_user: User, other_user_id: int) -> Dict:
        """Remove mutual friendship and cancel any pending requests between users."""
        if current_user.id == other_user_id:
            raise ValueError("Cannot remove yourself")

        other = db.query(User).filter(User.id == other_user_id).one_or_none()
        if not other:
            raise ValueError("User not found")

        u1, u2 = _pair(current_user.id, other_user_id)
        fr = db.query(Friendship).filter(
            Friendship.user1_id == u1,
            Friendship.user2_id == u2,
        ).one_or_none()
        if fr:
            db.delete(fr)

        # Cancel any pending requests between the pair
        reqs = db.query(FriendRequest).filter(
            or_(
                and_(FriendRequest.from_user_id == current_user.id, FriendRequest.to_user_id == other_user_id),
                and_(FriendRequest.from_user_id == other_user_id, FriendRequest.to_user_id == current_user.id),
            )
        ).all()
        now = datetime.now(timezone.utc)
        for r in reqs:
            if r.status == "pending":
                r.status = "canceled"
                r.responded_at = now
                db.add(r)

        # Отменяем pending-инвайты в группы между этой парой
        group_invites = db.query(GroupInvite).filter(
            GroupInvite.status == "pending",
            or_(
                and_(GroupInvite.from_user_id == current_user.id, GroupInvite.to_user_id == other_user_id),
                and_(GroupInvite.from_user_id == other_user_id, GroupInvite.to_user_id == current_user.id),
            )
        ).all()
        for gi in group_invites:
            gi.status = "canceled"
            gi.responded_at = now
            db.add(gi)

        db.commit()
        return {"status": "removed"}

    @staticmethod
    def list_requests(
        db: Session,
        user: User,
        inbox: bool = False,
        outbox: bool = False,
        status: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict]:
        q = db.query(FriendRequest)

        clauses = []
        if inbox:
            clauses.append(FriendRequest.to_user_id == user.id)
        if outbox:
            clauses.append(FriendRequest.from_user_id == user.id)

        if not clauses:
            # default: inbox
            clauses.append(FriendRequest.to_user_id == user.id)

        q = q.filter(or_(*clauses))

        if status:
            q = q.filter(FriendRequest.status == status)

        q = q.order_by(FriendRequest.created_at.desc()).limit(limit)

        rows = q.all()

        # preload users
        user_ids = set()
        for r in rows:
            user_ids.add(r.from_user_id)
            user_ids.add(r.to_user_id)
        users = db.query(User).filter(User.id.in_(list(user_ids))).all()
        by_id = {u.id: u for u in users}

        items = []
        for r in rows:
            fu = by_id.get(r.from_user_id)
            tu = by_id.get(r.to_user_id)
            items.append({
                "id": r.id,
                "status": r.status,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "responded_at": r.responded_at.isoformat() if r.responded_at else None,
                "from_user": {"id": fu.id, "login": fu.login, "username": fu.username} if fu else {"id": r.from_user_id},
                "to_user": {"id": tu.id, "login": tu.login, "username": tu.username} if tu else {"id": r.to_user_id},
            })
        return items

    @staticmethod
    def accept_request(db: Session, current_user: User, request_id: int) -> Dict:
        req = db.query(FriendRequest).filter(FriendRequest.id == request_id).one_or_none()
        if not req:
            raise ValueError("Request not found")
        if req.to_user_id != current_user.id:
            raise PermissionError("Not your request")
        if req.status != "pending":
            return {"status": req.status}

        FriendsService._accept_request_row(db, req)
        return {"status": "accepted"}

    @staticmethod
    def decline_request(db: Session, current_user: User, request_id: int) -> Dict:
        req = db.query(FriendRequest).filter(FriendRequest.id == request_id).one_or_none()
        if not req:
            raise ValueError("Request not found")
        if req.to_user_id != current_user.id:
            raise PermissionError("Not your request")
        if req.status != "pending":
            return {"status": req.status}

        req.status = "declined"
        req.responded_at = datetime.now(timezone.utc)
        db.add(req)
        db.commit()
        return {"status": "declined"}

    @staticmethod
    def _accept_request_row(db: Session, req: FriendRequest) -> None:
        # Create friendship
        u1, u2 = _pair(req.from_user_id, req.to_user_id)
        exists = db.query(Friendship).filter(
            Friendship.user1_id == u1,
            Friendship.user2_id == u2
        ).one_or_none()
        # SAVEPOINT: защита от race condition при concurrent accept
        if not exists:
            try:
                nested = db.begin_nested()
                db.add(Friendship(user1_id=u1, user2_id=u2, created_at=datetime.now(timezone.utc)))
                nested.commit()
            except IntegrityError:
                # Дружба уже создана другим потоком — продолжаем
                logger.debug("Friendship %d↔%d already exists (concurrent accept)", u1, u2)

        req.status = "accepted"
        req.responded_at = datetime.now(timezone.utc)
        db.add(req)

        # If there is a reverse pending request, cancel it (rare, but possible with races)
        rev = db.query(FriendRequest).filter(
            FriendRequest.from_user_id == req.to_user_id,
            FriendRequest.to_user_id == req.from_user_id,
            FriendRequest.status == "pending",
        ).one_or_none()
        if rev:
            rev.status = "canceled"
            rev.responded_at = datetime.now(timezone.utc)
            db.add(rev)

        db.commit()
