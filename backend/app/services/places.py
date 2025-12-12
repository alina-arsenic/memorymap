from typing import Optional, List, Dict
from sqlalchemy.orm import Session

from app.models.models import User, Place, Media
from app.services.users import UserService
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
    def list_places(db: Session, group_id: int, bbox: str) -> List[Dict]:
        left, bottom, right, top = [float(x) for x in bbox.split(",")]

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
                "media": media_map.get(place.id, []),
            })
        return items

    @staticmethod
    def delete_place(db: Session, place_id: int, user: User) -> bool:
        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            return False
        if place.user_id != user.id:
            return False

        delete_place_folder(place.id)
        db.delete(place)
        db.commit()
        return True

    @staticmethod
    def add_media_to_place(db: Session, place_id: int) -> None:
        # хелпер на случай если будешь расширять — пока не нужен
        pass
