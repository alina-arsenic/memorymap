from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.core.auth import get_current_user
from app.models.models import User
from app.services.groups import GroupService
from app.services.users import UserService

router = APIRouter()

class AddFriendReq(BaseModel):
    friend_tg_id: int

@router.get("/me")
def me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    groups = GroupService.list_groups(db, current_user)
    friends = UserService.list_friends(db, current_user)
    return {
        "id": current_user.id,
        "tg_id": current_user.tg_id,
        "username": current_user.username,
        "groups": groups,
        "friends": friends,
    }

@router.post("/friends")
def add_friend(
    req: AddFriendReq,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return UserService.add_friend(db, current_user, req.friend_tg_id)
