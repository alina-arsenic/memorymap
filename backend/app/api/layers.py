from typing import Dict, List

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.groups import GroupService
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

router = APIRouter()


@router.get("/layers")
def list_layers(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return layers (groups) accessible to the current user.

    type:
      - public: visibility == public
      - personal: is_personal == true
      - shared: other non-public groups
    """
    groups = GroupService.list_groups(db, current_user)
    items: List[Dict] = []
    for g in groups:
        if g.get("visibility") == "public":
            t = "public"
        elif g.get("is_personal"):
            t = "personal"
        else:
            t = "shared"
        items.append(
            {
                "id": g["id"],
                "name": g["name"],
                "visibility": g["visibility"],
                "type": t,
                "my_role": g.get("my_role"),
            }
        )
    return {"items": items}
