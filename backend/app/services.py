from sqlalchemy.orm import Session
from .db import SessionLocal
from .models import User, Place
import uuid
from typing import Optional, List, Dict
from sqlalchemy import text


class UserService:
    @staticmethod
    def ensure_user(
        db: Session,
        user_id: Optional[int],
        tg_id: Optional[int],
        username: Optional[str],
    ) -> Optional[int]:
        """
        Возвращает существующий id пользователя или создает нового.
        Если идентификаторов нет - возвращает None (аноним).
        """
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


class GroupService:
    @staticmethod
    def list_groups(db: Session, user: Optional[User]) -> List[Dict]:
        """
        Возвращает список групп, доступных пользователю:
        - публичные всегда;
        - + группы, в которых он состоит.
        """
        params = {}
        base_sql = """
            SELECT DISTINCT g.id, g.name, g.visibility
            FROM groups g
            LEFT JOIN membership m ON m.group_id = g.id
            WHERE g.visibility = 'public'
        """
        if user is not None:
            base_sql += " OR m.user_id = :uid"
            params["uid"] = user.id

        rows = db.execute(text(base_sql), params).fetchall()
        return [
            {"id": r[0], "name": r[1], "visibility": r[2]}
            for r in rows
        ]

    @staticmethod
    def create_group(db: Session, owner: User, name: str, visibility: str, add_friends: bool = False) -> int:
        g = Group(name=name, visibility=visibility)
        db.add(g)
        db.commit()
        db.refresh(g)

        # owner = owner
        db.execute(
            text(
                "INSERT INTO membership (user_id, group_id, role) "
                "VALUES (:uid, :gid, 'owner') "
                "ON CONFLICT (user_id, group_id) DO UPDATE SET role='owner'"
            ),
            {"uid": owner.id, "gid": g.id},
        )

        if add_friends:
            # всех друзей делаем редакторами
            rows = db.execute(
                text(
                    "SELECT friend_id FROM friends WHERE user_id = :uid AND status='accepted'"
                ),
                {"uid": owner.id},
            ).fetchall()
            for (fid,) in rows:
                db.execute(
                    text(
                        "INSERT INTO membership (user_id, group_id, role) "
                        "VALUES (:uid, :gid, 'editor') "
                        "ON CONFLICT (user_id, group_id) DO NOTHING"
                    ),
                    {"uid": fid, "gid": g.id},
                )

        db.commit()
        return g.id


class PlaceService:
    @staticmethod
    def create_place(
        group_id: int,
        user_id: Optional[int],
        tg_id: Optional[int],
        username: Optional[str],
        title: Optional[str],
        note: Optional[str],
        lat: float,
        lon: float,
    ) -> int:
        db = SessionLocal()
        try:
            uid = UserService.ensure_user(db, user_id, tg_id, username)

            place = Place(
                group_id=group_id,
                user_id=uid,
                title=title,
                note=note,
                lat=lat,
                lon=lon,
            )
            db.add(place)
            db.commit()
            db.refresh(place)
            return place.id
        finally:
            db.close()

    @staticmethod
    def list_places(group_id: int, bbox: str) -> List[Dict]:
        left, bottom, right, top = [float(x) for x in bbox.split(",")]
        db = SessionLocal()
        try:
            # джойн с User, чтобы достать tg_id
            q = (
                db.query(Place, User)
                .outerjoin(User, Place.user_id == User.id)
                .filter(Place.group_id == group_id)
                .filter(Place.lon >= left)
                .filter(Place.lon <= right)
                .filter(Place.lat >= bottom)
                .filter(Place.lat <= top)
                .limit(1000)
            )
            rows = q.all()
            items: List[Dict] = []
            for place, user in rows:
                items.append(
                    {
                        "id": place.id,
                        "title": place.title,
                        "note": place.note,
                        "lat": place.lat,
                        "lon": place.lon,
                        "user_id": place.user_id,
                        "user_tg_id": user.tg_id if user else None,
                        "username": user.username if user else None,
                    }
                )
            return items
        finally:
            db.close()
    
    @staticmethod
    def delete_place(db: Session, place_id: int, user: User) -> bool:
        """Удаляет точку, если она принадлежит пользователю. Возвращает True/False."""
        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            return False
        if place.user_id != user.id:
            return False
        db.delete(place)
        db.commit()
        return True
