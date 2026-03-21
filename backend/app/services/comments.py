"""Сервис работы с комментариями к точкам."""

from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from app.models.models import Comment, Group, Place, User
from sqlalchemy import func, text
from sqlalchemy.orm import Session


class CommentService:
    # Максимальная длина текста комментария
    MAX_TEXT_LENGTH = 1000

    @staticmethod
    def _check_place_access(db: Session, user: User, place_id: int) -> Place:
        """Проверка доступа к точке для записи (создание комментария).

        Требует авторизованного пользователя.
        """
        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            raise ValueError("place_not_found")

        group = db.query(Group).filter(Group.id == place.group_id).one_or_none()
        if not group:
            raise ValueError("group_not_found")

        # Личные группы — комментарии запрещены
        if group.is_personal:
            raise PermissionError("personal_group")

        # Проверка доступа к группе
        if group.visibility == "public":
            # Публичная — доступна всем авторизованным
            pass
        else:
            # Приватная — только участники группы (или admin/moderator)
            if user.role not in ("admin", "moderator"):
                row = db.execute(
                    text("SELECT role FROM membership WHERE user_id=:uid AND group_id=:gid"),
                    {"uid": user.id, "gid": group.id},
                ).fetchone()
                if not row:
                    raise PermissionError("no_access")

        return place

    @staticmethod
    def _check_place_read_access(db: Session, user: Optional[User], place_id: int) -> Place:
        """Проверка доступа к точке для чтения комментариев.

        Публичные группы — доступны всем (включая гостей).
        Приватные — только участникам и admin/moderator.
        Личные — запрещены.
        """
        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            raise ValueError("place_not_found")

        group = db.query(Group).filter(Group.id == place.group_id).one_or_none()
        if not group:
            raise ValueError("group_not_found")

        if group.is_personal:
            raise PermissionError("personal_group")

        if group.visibility == "public":
            # Публичные комментарии доступны всем
            pass
        else:
            # Приватная группа — требует авторизации и membership
            if not user:
                raise PermissionError("no_access")
            if user.role not in ("admin", "moderator"):
                row = db.execute(
                    text("SELECT role FROM membership WHERE user_id=:uid AND group_id=:gid"),
                    {"uid": user.id, "gid": group.id},
                ).fetchone()
                if not row:
                    raise PermissionError("no_access")

        return place

    @staticmethod
    def create_comment(
        db: Session,
        user: User,
        place_id: int,
        comment_text: str,
        parent_id: Optional[int] = None,
    ) -> Dict:
        """Создать комментарий к точке.

        Доступ:
        - публичная (approved) группа — любой авторизованный юзер
        - приватная группа — только участники (membership)
        - личная группа (is_personal) — запрещено
        """
        comment_text = (comment_text or "").strip()
        if not comment_text:
            raise ValueError("empty_text")
        if len(comment_text) > CommentService.MAX_TEXT_LENGTH:
            raise ValueError("text_too_long")

        place = CommentService._check_place_access(db, user, place_id)

        # Обработка parent_id — ответ на комментарий
        resolved_parent_id = None
        parent_comment = None
        if parent_id is not None:
            parent_comment = db.query(Comment).filter(Comment.id == parent_id).one_or_none()
            if not parent_comment:
                raise ValueError("parent_not_found")
            if parent_comment.place_id != place_id:
                raise ValueError("parent_wrong_place")
            # Один уровень: если parent — ответ → привязка к top-level parent
            if parent_comment.parent_id is not None:
                resolved_parent_id = parent_comment.parent_id
            else:
                resolved_parent_id = parent_comment.id

        comment = Comment(
            place_id=place_id,
            user_id=user.id,
            text=comment_text,
            created_at=datetime.now(timezone.utc),
            parent_id=resolved_parent_id,
            reply_to_id=parent_id,  # реальный ID комментария, на который ответили
        )
        db.add(comment)
        db.commit()
        db.refresh(comment)

        return {
            "id": comment.id,
            "place_id": comment.place_id,
            "user_id": comment.user_id,
            "user_login": user.login,
            "username": user.username,
            "text": comment.text,
            "created_at": comment.created_at.isoformat() if comment.created_at else None,
            "parent_id": comment.parent_id,
            "updated_at": None,
        }, place, parent_comment, resolved_parent_id

    @staticmethod
    def list_comments(db: Session, user: Optional[User], place_id: int) -> List[Dict]:
        """Получить список комментариев к точке (сортировка по дате ASC).

        Публичные группы — доступны всем, приватные — только участникам.
        """
        CommentService._check_place_read_access(db, user, place_id)

        rows = (
            db.query(Comment, User)
            .outerjoin(User, Comment.user_id == User.id)
            .filter(Comment.place_id == place_id)
            .order_by(Comment.created_at.asc())
            .all()
        )

        # Собираем map для lookup parent author
        comments_map = {}
        for comment, author in rows:
            comments_map[comment.id] = {
                "user_login": author.login if author else None,
                "username": author.username if author else None,
            }

        result = []
        for comment, author in rows:
            # Определяем автора комментария, на который ответили
            # reply_to_id — реальный адресат, parent_id — для группировки
            parent_author = None
            lookup_id = comment.reply_to_id or comment.parent_id
            if lookup_id and lookup_id in comments_map:
                pa = comments_map[lookup_id]
                parent_author = pa.get("user_login") or (
                    ("@" + pa["username"]) if pa.get("username") else None
                )

            result.append({
                "id": comment.id,
                "text": comment.text,
                "user_id": comment.user_id,
                "user_login": author.login if author else None,
                "username": author.username if author else None,
                "created_at": comment.created_at.isoformat() if comment.created_at else None,
                "parent_id": comment.parent_id,
                "reply_to_id": comment.reply_to_id,
                "updated_at": comment.updated_at.isoformat() if comment.updated_at else None,
                "parent_author": parent_author,
            })
        return result

    @staticmethod
    def edit_comment(db: Session, user: User, comment_id: int, new_text: str) -> Dict:
        """Редактировать комментарий (только автор)."""
        new_text = (new_text or "").strip()
        if not new_text:
            raise ValueError("empty_text")
        if len(new_text) > CommentService.MAX_TEXT_LENGTH:
            raise ValueError("text_too_long")

        comment = db.query(Comment).filter(Comment.id == comment_id).one_or_none()
        if not comment:
            raise ValueError("comment_not_found")

        # Только автор может редактировать
        if comment.user_id != user.id:
            raise PermissionError("no_permission")

        # Лимит: редактирование только в течение 1 часа
        EDIT_LIMIT = timedelta(hours=1)
        if comment.created_at and datetime.now(timezone.utc) - comment.created_at > EDIT_LIMIT:
            raise ValueError("edit_time_expired")

        comment.text = new_text
        comment.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(comment)

        return {
            "id": comment.id,
            "text": comment.text,
            "updated_at": comment.updated_at.isoformat() if comment.updated_at else None,
        }

    @staticmethod
    def delete_comment(db: Session, user: User, comment_id: int) -> None:
        """Удалить комментарий.

        Право: автор комментария, автор точки, admin или moderator.
        """
        comment = db.query(Comment).filter(Comment.id == comment_id).one_or_none()
        if not comment:
            raise ValueError("comment_not_found")

        # Проверяем права на удаление
        is_comment_author = comment.user_id == user.id
        is_admin_or_mod = user.role in ("admin", "moderator")

        # Автор точки тоже может удалять чужие комментарии
        place = db.query(Place).filter(Place.id == comment.place_id).one_or_none()
        is_place_owner = place and place.user_id == user.id

        if not (is_comment_author or is_place_owner or is_admin_or_mod):
            raise PermissionError("no_permission")

        db.delete(comment)
        db.commit()

    @staticmethod
    def count_for_places(db: Session, place_ids: List[int]) -> Dict[int, int]:
        """Batch-запрос: количество комментариев для списка точек."""
        if not place_ids:
            return {}
        rows = (
            db.query(Comment.place_id, func.count(Comment.id))
            .filter(Comment.place_id.in_(place_ids))
            .group_by(Comment.place_id)
            .all()
        )
        return {place_id: count for place_id, count in rows}
