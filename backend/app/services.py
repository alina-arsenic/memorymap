from sqlalchemy.orm import Session
from .db import SessionLocal
from .models import User, Place, Media
import uuid
from typing import Optional, List, Dict
from sqlalchemy import text
from .storage import presign_get, move_to_place_folder, delete_place_folder

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
        media_keys: Optional[List[str]] = None,
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

            # медиа к точке
            for key in (media_keys or []):
                # переносим в папку конкретной точки
                new_key = move_to_place_folder(key, place.id)

                m = Media(
                    place_id=place.id,
                    user_id=uid,
                    s3_key=new_key,
                    mime="image/jpeg",  # пока считаем, что только фото
                    status="ready",
                )
                db.add(m)

            if media_keys:
                db.commit()

            return place.id
        finally:
            db.close()

    @staticmethod
    def list_places(group_id: int, bbox: str) -> List[Dict]:
        left, bottom, right, top = [float(x) for x in bbox.split(",")]
        db = SessionLocal()
        try:
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

            # заранее собираем id точек
            place_ids = [place.id for place, _ in rows]
            media_map: Dict[int, List[Dict]] = {}
            if place_ids:
                media_rows = db.query(Media).filter(Media.place_id.in_(place_ids)).all()
                for m in media_rows:
                    media_map.setdefault(m.place_id, []).append(
                        {
                            "id": m.id,
                            "key": m.s3_key,
                            # пока один и тот же URL для превью и полноразмерного
                            "url": presign_get(m.s3_key),
                        }
                    )

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
                        "media": media_map.get(place.id, []),
                    }
                )
            return items
        finally:
            db.close()
    
    @staticmethod
    def delete_place(db: Session, place_id: int, user: User) -> bool:
        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            return False
        if place.user_id != user.id:
            return False

        # сначала удаляем файлы из MinIO
        delete_place_folder(place.id)

        # потом удаляем запись из БД (media удалятся каскадом)
        db.delete(place)
        db.commit()
        return True
