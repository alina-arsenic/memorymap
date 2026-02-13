from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.core.auth import get_current_user
from app.models.models import User
from app.services.groups import GroupService

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
