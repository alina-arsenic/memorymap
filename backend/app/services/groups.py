from typing import Dict, List, Literal, Optional

from app.models.models import Group, User
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


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
        """List groups accessible to user.

        For authenticated users also returns my_role (owner|editor|viewer) when available.
        """
        params = {}
        if user is None:
            rows = db.execute(
                text(
                    """
                    SELECT g.id, g.name, g.visibility, g.is_personal, NULL::text AS my_role
                    FROM groups g
                    WHERE g.visibility='public'
                    ORDER BY g.id
                    """
                )
            ).fetchall()
            return [{"id": r[0], "name": r[1], "visibility": r[2], "is_personal": r[3], "my_role": r[4]} for r in rows]

        params["uid"] = user.id
        rows = db.execute(
            text(
                """
                SELECT DISTINCT g.id, g.name, g.visibility, g.is_personal,
                    (SELECT role FROM membership WHERE user_id=:uid AND group_id=g.id LIMIT 1) AS my_role
                FROM groups g
                LEFT JOIN membership m ON m.group_id = g.id
                WHERE g.visibility='public' OR m.user_id=:uid
                ORDER BY g.id
                """
            ),
            params,
        ).fetchall()
        return [{"id": r[0], "name": r[1], "visibility": r[2], "is_personal": r[3], "my_role": r[4]} for r in rows]

    @staticmethod
    def get_group_details(db: Session, user: User, group_id: int) -> Dict:
        g = db.query(Group).filter(Group.id == group_id).first()
        if not g:
            raise ValueError("group_not_found")
        GroupService.require_can_view(db, user, g)
        my_role = GroupService._get_membership_role(db, user.id, group_id)
        # public group: for non-members my_role can be None
        rows = db.execute(
            text(
                """
                SELECT u.id, u.login, u.username, u.tg_id, m.role
                FROM membership m
                JOIN users u ON u.id = m.user_id
                WHERE m.group_id=:gid
                ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END, u.id
                """
            ),
            {"gid": group_id},
        ).fetchall()
        members = [
            {"id": r[0], "login": r[1], "username": r[2], "tg_id": r[3], "role": r[4]} for r in rows
        ]
        return {"id": g.id, "name": g.name, "visibility": g.visibility, "is_personal": getattr(g, "is_personal", False), "owner_id": getattr(g, "owner_id", None), "my_role": my_role, "members": members}

    @staticmethod
    def rename_group(db: Session, owner: User, group_id: int, name: str) -> None:
        GroupService.require_is_owner(db, owner, group_id)
        db.execute(text("UPDATE groups SET name=:name WHERE id=:gid"), {"name": name, "gid": group_id})
        db.commit()

    @staticmethod
    def create_group(db: Session, owner: User, name: str, visibility: str, add_friends: bool = False) -> int:
        g = Group(name=name, visibility=visibility, owner_id=owner.id, is_personal=False)
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
        """Ensure there is exactly one personal private group for user.

        Uses groups.is_personal + groups.owner_id to make it idempotent.
        """
        row = db.execute(
            text(
                """
                SELECT id FROM groups
                WHERE owner_id=:uid AND is_personal=TRUE
                LIMIT 1
                """
            ),
            {"uid": user.id},
        ).fetchone()
        if row:
            return int(row[0])

        # Create; handle race by catching unique index violation (if two /me hit at once)
        name = f"Личная карта {user.id}"
        g = Group(name=name, visibility="private", owner_id=user.id, is_personal=True)
        db.add(g)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            row2 = db.execute(
                text("SELECT id FROM groups WHERE owner_id=:uid AND is_personal=TRUE LIMIT 1"),
                {"uid": user.id},
            ).fetchone()
            if row2:
                return int(row2[0])
            raise
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
        # проверяем что пользователь существует
        if not db.query(User).filter(User.id == user_id).one_or_none():
            raise ValueError("user_not_found")
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


    @staticmethod
    def leave_group(db: Session, user: User, group_id: int) -> None:
        """Leave a group (for non-owners)."""
        role = GroupService._get_membership_role(db, user.id, group_id)
        if role is None:
            raise ValueError("not_a_member")
        if role == "owner":
            raise ValueError("owner_cannot_leave")
        db.execute(text("DELETE FROM membership WHERE user_id=:uid AND group_id=:gid"), {"uid": user.id, "gid": group_id})
        db.commit()

    @staticmethod
    def delete_group(db: Session, owner: User, group_id: int) -> None:
        """Delete a group and all its places. Only group owner (or admin) can delete.
        Public groups cannot be deleted via this endpoint.
        """
        g = db.query(Group).filter(Group.id == group_id).one_or_none()
        if not g:
            raise ValueError("group_not_found")
        if g.visibility == "public":
            raise ValueError("cannot_delete_public_group")
        # permission: owner or admin
        GroupService.require_is_owner(db, owner, group_id)

        # Gather place ids for S3 cleanup
        place_rows = db.execute(text("SELECT id FROM places WHERE group_id=:gid"), {"gid": group_id}).fetchall()
        place_ids = [int(r[0]) for r in place_rows]

        # Delete media rows (db cascades via place_id on media, but explicit ok)
        db.execute(text("DELETE FROM media WHERE place_id IN (SELECT id FROM places WHERE group_id=:gid)"), {"gid": group_id})
        db.execute(text("DELETE FROM places WHERE group_id=:gid"), {"gid": group_id})
        db.execute(text("DELETE FROM membership WHERE group_id=:gid"), {"gid": group_id})
        db.execute(text("DELETE FROM groups WHERE id=:gid"), {"gid": group_id})
        db.commit()

        # S3 cleanup done by API layer (needs storage functions)
        # Return place_ids so caller can delete folders.
        return place_ids
