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
