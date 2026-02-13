"""Сервис работы с точками (создание, выборка, удаление, модерация)."""

from typing import Optional, List, Dict
from sqlalchemy.orm import Session
from sqlalchemy import or_, text

from app.models.models import User, Place, Media, Group
from app.services.users import UserService
from app.services.groups import GroupService
from app.storage import presign_get, move_to_place_folder, delete_place_folder
from app.core.config import MEDIA_LIMIT_PER_PLACE


class PlaceService:
    @staticmethod
    def create_place(
        db: Session,
        group_id: int,
        user_id: Optional[int],
        tg_id: Optional[int],
        username: Optional[str],
        title: Optional[str],
        note: Optional[str],
        lat: float,
        lon: float,
        media_keys: Optional[List[str]] = None,
    ) -> int:
        if media_keys and len(media_keys) > MEDIA_LIMIT_PER_PLACE:
            raise ValueError("media_limit")

        uid = UserService.ensure_user(db, user_id, tg_id, username)

        group = db.query(Group).filter(Group.id == group_id).one_or_none()
        if not group:
            raise ValueError("group_not_found")

        # Access control: non-public groups require owner/editor to add
        user = db.query(User).filter(User.id == uid).one_or_none()
        if not user:
            raise ValueError("user_not_found")
        GroupService.require_can_add_place(db, user, group)

        # Определяем статус модерации:
        # - публичная группа + обычный user → pending
        # - admin/moderator или приватная группа → approved
        moderation_status = "approved"
        if group and group.visibility == "public":
            if user and user.role not in ("admin", "moderator"):
                moderation_status = "pending"

        place = Place(
            group_id=group_id,
            user_id=uid,
            title=title,
            note=note,
            lat=lat,
            lon=lon,
            moderation_status=moderation_status,
        )
        db.add(place)
        db.commit()
        db.refresh(place)

        for key in (media_keys or []):
            new_key = move_to_place_folder(key, place.id)
            db.add(Media(
                place_id=place.id,
                user_id=uid,
                s3_key=new_key,
                mime="image/jpeg",
                status="ready",
            ))

        if media_keys:
            db.commit()

        return place.id

    @staticmethod
    def list_places(
        db: Session,
        group_id: int,
        bbox: str,
        current_user_id: Optional[int] = None,
        current_user_role: Optional[str] = None,
    ) -> List[Dict]:
        """Получить точки в bbox.

        Для публичных групп:
        - admin/moderator видят все точки (включая чужие pending);
        - обычный пользователь — approved + свои pending;
        - гость — только approved.
        Для приватных групп: все точки (модерация не применяется).
        """
        left, bottom, right, top = [float(x) for x in bbox.split(",")]

        group = db.query(Group).filter(Group.id == group_id).one_or_none()
        if not group:
            raise ValueError("group_not_found")

        # Access control: non-public groups require membership (or admin/moderator)
        GroupService.require_can_view(db, db.query(User).filter(User.id == current_user_id).one_or_none() if current_user_id else None, group)

        q = (
            db.query(Place, User)
            .outerjoin(User, Place.user_id == User.id)
            .filter(Place.group_id == group_id)
            .filter(Place.lon >= left)
            .filter(Place.lon <= right)
            .filter(Place.lat >= bottom)
            .filter(Place.lat <= top)
        )

        # Фильтр модерации для публичных групп
        if group and group.visibility == "public":
            if current_user_role in ("admin", "moderator"):
                # admin/moderator видят все точки, включая чужие pending
                q = q.filter(Place.moderation_status.in_(["approved", "pending"]))
            elif current_user_id is not None:
                # обычный пользователь — approved + свои pending
                q = q.filter(
                    or_(
                        Place.moderation_status == "approved",
                        (Place.user_id == current_user_id) & (Place.moderation_status == "pending"),
                    )
                )
            else:
                # гость — только approved
                q = q.filter(Place.moderation_status == "approved")

        rows = q.limit(1000).all()

        place_ids = [place.id for place, _ in rows]
        media_map: Dict[int, List[Dict]] = {}

        if place_ids:
            media_rows = db.query(Media).filter(Media.place_id.in_(place_ids)).all()
            for m in media_rows:
                media_map.setdefault(m.place_id, []).append({
                    "id": m.id,
                    "key": m.s3_key,
                    "url": presign_get(m.s3_key),
                })

        items: List[Dict] = []
        for place, user in rows:
            items.append({
                "id": place.id,
                "title": place.title,
                "note": place.note,
                "lat": place.lat,
                "lon": place.lon,
                "user_id": place.user_id,
                "user_tg_id": user.tg_id if user else None,
                "username": user.username if user else None,
                "user_login": user.login if user else None,
                "moderation_status": place.moderation_status,
                "media": media_map.get(place.id, []),
            })
        return items

    @staticmethod
    def list_places_feed(
        db: Session,
        bbox: str,
        scope: str = "all",
        group_ids: Optional[List[int]] = None,
        current_user_id: Optional[int] = None,
        current_user_role: Optional[str] = None,
    ) -> List[Dict]:
        """Fetch places across accessible groups in bbox.

        scope:
          - all: all visible places in accessible groups
          - mine: only places where place.user_id == current_user_id

        group_ids (optional) further restricts to a subset of accessible groups.
        """
        left, bottom, right, top = [float(x) for x in bbox.split(",")]

        # Determine accessible group ids
        if current_user_id is None:
            rows = db.query(Group.id).filter(Group.visibility == "public").all()
            accessible = {int(r[0]) for r in rows}
        else:
            # public + membership
            rows = db.execute(
                text(
                    """
                    SELECT DISTINCT g.id
                    FROM groups g
                    LEFT JOIN membership m ON m.group_id = g.id
                    WHERE g.visibility='public' OR m.user_id = :uid
                    """
                ),
                {"uid": current_user_id},
            ).fetchall()
            accessible = {int(r[0]) for r in rows}

        if group_ids is not None:
            requested = set(group_ids)
            if not requested.issubset(accessible):
                raise PermissionError("No access")
            accessible = requested

        if scope not in ("all", "mine"):
            raise ValueError("bad_scope")
        if scope == "mine" and current_user_id is None:
            raise PermissionError("Not authenticated")

        q = (
            db.query(Place, User, Group)
            .join(Group, Place.group_id == Group.id)
            .outerjoin(User, Place.user_id == User.id)
            .filter(Place.group_id.in_(list(accessible)))
            .filter(Place.lon >= left)
            .filter(Place.lon <= right)
            .filter(Place.lat >= bottom)
            .filter(Place.lat <= top)
        )

        if scope == "mine":
            q = q.filter(Place.user_id == current_user_id)

        # Moderation filters apply only to public groups
        if current_user_role in ("admin", "moderator"):
            q = q.filter(
                or_(
                    Group.visibility != "public",
                    Place.moderation_status.in_(["approved", "pending"]),
                )
            )
        elif current_user_id is not None:
            q = q.filter(
                or_(
                    Group.visibility != "public",
                    Place.moderation_status == "approved",
                    (Place.user_id == current_user_id) & (Place.moderation_status == "pending"),
                )
            )
        else:
            # guest: only approved from public groups (accessible already public)
            q = q.filter(Place.moderation_status == "approved")

        rows = q.limit(2000).all()

        place_ids = [place.id for place, _, _ in rows]
        media_map: Dict[int, List[Dict]] = {}
        if place_ids:
            media_rows = db.query(Media).filter(Media.place_id.in_(place_ids)).all()
            for m in media_rows:
                media_map.setdefault(m.place_id, []).append(
                    {"id": m.id, "key": m.s3_key, "url": presign_get(m.s3_key)}
                )

        items: List[Dict] = []
        for place, user, group in rows:
            items.append(
                {
                    "id": place.id,
                    "group_id": place.group_id,
                    "title": place.title,
                    "note": place.note,
                    "lat": place.lat,
                    "lon": place.lon,
                    "user_id": place.user_id,
                    "user_tg_id": user.tg_id if user else None,
                    "username": user.username if user else None,
                    "user_login": user.login if user else None,
                    "moderation_status": place.moderation_status,
                    "media": media_map.get(place.id, []),
                    "group_visibility": group.visibility,
                }
            )
        return items

    @staticmethod
    def delete_place(db: Session, place_id: int, user: User) -> bool:
        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            return False
        # владелец, модератор или админ могут удалять
        if place.user_id != user.id and user.role not in ("admin", "moderator"):
            return False

        delete_place_folder(place.id)
        db.delete(place)
        db.commit()
        return True

    @staticmethod
    def add_media_to_place(db: Session, place_id: int) -> None:
        pass
