from typing import Optional, List, Dict
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.models.models import User, Group

class GroupService:
    @staticmethod
    def list_groups(db: Session, user: Optional[User]) -> List[Dict]:
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
        return [{"id": r[0], "name": r[1], "visibility": r[2]} for r in rows]

    @staticmethod
    def create_group(db: Session, owner: User, name: str, visibility: str, add_friends: bool = False) -> int:
        g = Group(name=name, visibility=visibility)
        db.add(g)
        db.commit()
        db.refresh(g)

        db.execute(
            text(
                "INSERT INTO membership (user_id, group_id, role) "
                "VALUES (:uid, :gid, 'owner') "
                "ON CONFLICT (user_id, group_id) DO UPDATE SET role='owner'"
            ),
            {"uid": owner.id, "gid": g.id},
        )

        if add_friends:
            rows = db.execute(
                text("SELECT friend_id FROM friends WHERE user_id = :uid AND status='accepted'"),
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
