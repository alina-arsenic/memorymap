from typing import Optional

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.groups import GroupService
from app.storage import delete_place_folder
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()

class GroupCreate(BaseModel):
    name: str
    visibility: str = "private"  # private|friends|public
    add_friends: bool = False


class GroupMemberAdd(BaseModel):
    user_id: int
    role: str = "editor"  # editor|viewer


class GroupMemberRoleUpdate(BaseModel):
    role: str  # editor|viewer


class GroupRename(BaseModel):
    name: str

@router.get("/groups")
def list_groups(
    current_user: Optional[User] = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    items = GroupService.list_groups(db, current_user)
    return {"items": items}

@router.post("/groups")
def create_group(
    g: GroupCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    gid = GroupService.create_group(
        db, owner=current_user, name=g.name, visibility=g.visibility, add_friends=g.add_friends
    )
    return {"id": gid}


@router.get("/groups/{group_id}")
def get_group(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return GroupService.get_group_details(db, current_user, group_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/groups/{group_id}")
def rename_group(
    group_id: int,
    req: GroupRename,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="empty_name")
    try:
        GroupService.rename_group(db, current_user, group_id, name)
        return {"status": "ok"}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


@router.post("/groups/{group_id}/members")
def add_member(
    group_id: int,
    req: GroupMemberAdd,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    role = req.role
    if role not in ("editor", "viewer"):
        raise HTTPException(status_code=400, detail="invalid_role")
    try:
        GroupService.add_member(db, current_user, group_id, req.user_id, role)  # type: ignore
        return {"status": "ok"}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


@router.delete("/groups/{group_id}/members/{user_id}")
def remove_member(
    group_id: int,
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        GroupService.remove_member(db, current_user, group_id, user_id)
        return {"status": "ok"}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/groups/{group_id}/members/{user_id}")
def update_member_role(
    group_id: int,
    user_id: int,
    req: GroupMemberRoleUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    role = req.role
    if role not in ("editor", "viewer"):
        raise HTTPException(status_code=400, detail="invalid_role")
    try:
        GroupService.update_member_role(db, current_user, group_id, user_id, role)  # type: ignore
        return {"status": "ok"}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/groups/{group_id}/leave")
def leave_group(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        GroupService.leave_group(db, current_user, group_id)
        return {"status": "ok"}
    except ValueError as e:
        msg = str(e)
        if msg == "not_a_member":
            raise HTTPException(status_code=400, detail=msg)
        if msg == "owner_cannot_leave":
            raise HTTPException(status_code=400, detail=msg)
        raise HTTPException(status_code=400, detail=msg)

@router.delete("/groups/{group_id}")
def delete_group(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        place_ids = GroupService.delete_group(db, current_user, group_id)
        # delete S3 folders for all places in the group
        for pid in place_ids:
            try:
                delete_place_folder(pid)
            except Exception:
                # best-effort; db already cleaned up
                pass
        return {"status": "ok", "deleted_places": len(place_ids)}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        msg = str(e)
        if msg == "group_not_found":
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=400, detail=msg)
