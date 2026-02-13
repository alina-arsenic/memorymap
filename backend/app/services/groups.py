from typing import Optional, List, Dict, Literal
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.models.models import User, Group

class GroupService:
    @staticmethod
    def _get_membership_role(db: Session, user_id: int, group_id: int) -> Optional[str]:
        row = db.execute(
            text("SELECT role FROM membership WHERE user_id=:uid AND group_id=:gid"),
            {"uid": user_id, "gid": group_id},
        ).fetchone()
        return row[0] if row else None

    @staticmethod
    def require_can_view(db: Session, user: Optional[User], group: Group) -> None:
        """Raise PermissionError if user cannot view group."""
        if group.visibility == "public":
            return
        if user is None:
            raise PermissionError("Not authenticated")
        if user.role in ("admin", "moderator"):
            return
        role = GroupService._get_membership_role(db, user.id, group.id)
        if role not in ("owner", "editor", "viewer"):
            raise PermissionError("No access")

    @staticmethod
    def require_can_add_place(db: Session, user: User, group: Group) -> None:
        """Raise PermissionError if user cannot add points to group."""
        if group.visibility == "public":
            return
        if user.role in ("admin", "moderator"):
            return
        role = GroupService._get_membership_role(db, user.id, group.id)
        if role not in ("owner", "editor"):
            raise PermissionError("No write access")

    @staticmethod
    def require_is_owner(db: Session, user: User, group_id: int) -> None:
        if user.role == "admin":
            return
        role = GroupService._get_membership_role(db, user.id, group_id)
        if role != "owner":
            raise PermissionError("Only owner can manage members")

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
            # Use mutual friendships table (friendships)
            rows = db.execute(
                text(
                    """
                    SELECT CASE WHEN user1_id=:uid THEN user2_id ELSE user1_id END AS fid
                    FROM friendships
                    WHERE user1_id=:uid OR user2_id=:uid
                    """
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

    @staticmethod
    def ensure_personal_group(db: Session, user: User) -> int:
        """Create personal private group for user if it does not exist."""
        name = f"Личная карта {user.id}"
        row = db.execute(
            text(
                """
                SELECT g.id
                FROM groups g
                JOIN membership m ON m.group_id=g.id
                WHERE m.user_id=:uid AND m.role='owner' AND g.visibility='private' AND g.name=:name
                LIMIT 1
                """
            ),
            {"uid": user.id, "name": name},
        ).fetchone()
        if row:
            return int(row[0])

        g = Group(name=name, visibility="private")
        db.add(g)
        db.commit()
        db.refresh(g)
        db.execute(
            text(
                "INSERT INTO membership (user_id, group_id, role) VALUES (:uid, :gid, 'owner') "
                "ON CONFLICT (user_id, group_id) DO UPDATE SET role='owner'"
            ),
            {"uid": user.id, "gid": g.id},
        )
        db.commit()
        return g.id

    @staticmethod
    def add_member(db: Session, owner: User, group_id: int, user_id: int, role: Literal["editor", "viewer"]) -> None:
        GroupService.require_is_owner(db, owner, group_id)
        # cannot add self as non-owner
        db.execute(
            text(
                "INSERT INTO membership (user_id, group_id, role) VALUES (:uid, :gid, :role) "
                "ON CONFLICT (user_id, group_id) DO UPDATE SET role=:role"
            ),
            {"uid": user_id, "gid": group_id, "role": role},
        )
        db.commit()

    @staticmethod
    def remove_member(db: Session, owner: User, group_id: int, user_id: int) -> None:
        GroupService.require_is_owner(db, owner, group_id)
        # don't allow removing owner membership
        current_role = GroupService._get_membership_role(db, user_id, group_id)
        if current_role == "owner":
            raise ValueError("Cannot remove owner")
        db.execute(
            text("DELETE FROM membership WHERE user_id=:uid AND group_id=:gid"),
            {"uid": user_id, "gid": group_id},
        )
        db.commit()

    @staticmethod
    def update_member_role(db: Session, owner: User, group_id: int, user_id: int, role: Literal["editor", "viewer"]) -> None:
        GroupService.require_is_owner(db, owner, group_id)
        current_role = GroupService._get_membership_role(db, user_id, group_id)
        if current_role == "owner":
            raise ValueError("Cannot change owner role")
        db.execute(
            text(
                "INSERT INTO membership (user_id, group_id, role) VALUES (:uid, :gid, :role) "
                "ON CONFLICT (user_id, group_id) DO UPDATE SET role=:role"
            ),
            {"uid": user_id, "gid": group_id, "role": role},
        )
        db.commit()
