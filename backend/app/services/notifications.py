"""Сервис уведомлений пользователей."""

from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.models.models import Comment, Notification, Place, User
from sqlalchemy import func
from sqlalchemy.orm import Session


class NotificationService:

    @staticmethod
    def create_comment_notification(
        db: Session,
        actor: User,
        place: Place,
        comment: Comment,
        parent_comment: Optional[Comment],
    ) -> None:
        """Создать уведомление о новом комментарии/ответе.

        - Ответ на комментарий → reply_to_comment → notify parent_comment.user_id
        - Комментарий к точке → comment_on_place → notify place.user_id
        - Не создаём, если actor == получатель
        """
        now = datetime.now(timezone.utc)
        notified_ids = set()  # не дублировать уведомления одному юзеру

        if parent_comment is not None:
            # Ответ на комментарий → уведомляем автора родительского комментария
            recipient_id = parent_comment.user_id
            if recipient_id and recipient_id != actor.id:
                db.add(Notification(
                    user_id=recipient_id,
                    type="reply_to_comment",
                    actor_id=actor.id,
                    place_id=place.id,
                    comment_id=comment.id,
                    is_read=False,
                    created_at=now,
                ))
                notified_ids.add(recipient_id)

        # Комментарий/ответ к чужой точке → уведомляем владельца точки
        owner_id = place.user_id
        if owner_id and owner_id != actor.id and owner_id not in notified_ids:
            db.add(Notification(
                user_id=owner_id,
                type="comment_on_place",
                actor_id=actor.id,
                place_id=place.id,
                comment_id=comment.id,
                is_read=False,
                created_at=now,
            ))

        db.commit()

    @staticmethod
    def list_notifications(db: Session, user_id: int, limit: int = 50) -> List[Dict]:
        """Список уведомлений пользователя (новые первые)."""
        rows = (
            db.query(Notification, User, Place)
            .outerjoin(User, Notification.actor_id == User.id)
            .outerjoin(Place, Notification.place_id == Place.id)
            .filter(Notification.user_id == user_id)
            .order_by(Notification.created_at.desc())
            .limit(limit)
            .all()
        )

        result = []
        for notif, actor, place in rows:
            result.append({
                "id": notif.id,
                "type": notif.type,
                "actor_login": actor.login if actor else None,
                "actor_username": actor.username if actor else None,
                "place_title": place.title if place else None,
                "place_id": notif.place_id,
                "place_group_id": place.group_id if place else None,
                "place_lat": float(place.lat) if place else None,
                "place_lon": float(place.lon) if place else None,
                "comment_id": notif.comment_id,
                "is_read": notif.is_read,
                "created_at": notif.created_at.isoformat() if notif.created_at else None,
            })
        return result

    @staticmethod
    def count_unread(db: Session, user_id: int) -> int:
        """Количество непрочитанных уведомлений."""
        return (
            db.query(func.count(Notification.id))
            .filter(Notification.user_id == user_id, Notification.is_read.is_(False))
            .scalar()
        ) or 0

    @staticmethod
    def mark_as_read(db: Session, user_id: int, notification_id: int) -> bool:
        """Пометить уведомление прочитанным. Возвращает True если найдено."""
        notif = (
            db.query(Notification)
            .filter(Notification.id == notification_id, Notification.user_id == user_id)
            .one_or_none()
        )
        if not notif:
            return False
        notif.is_read = True
        db.commit()
        return True

    @staticmethod
    def mark_all_as_read(db: Session, user_id: int) -> int:
        """Пометить все уведомления прочитанными. Возвращает количество обновлённых."""
        count = (
            db.query(Notification)
            .filter(Notification.user_id == user_id, Notification.is_read.is_(False))
            .update({"is_read": True}, synchronize_session=False)
        )
        db.commit()
        return count
