from typing import List, Dict
from sqlalchemy.orm import Session
from .db import SessionLocal
from .models import Group


class GroupService:
    @staticmethod
    def list_groups() -> List[Dict]:
        db: Session = SessionLocal()
        try:
            groups = db.query(Group).order_by(Group.id).all()
            return [
                {"id": g.id, "name": g.name, "visibility": g.visibility}
                for g in groups
            ]
        finally:
            db.close()

    @staticmethod
    def create_group(name: str, visibility: str = "private") -> int:
        db: Session = SessionLocal()
        try:
            g = Group(name=name, visibility=visibility)
            db.add(g)
            db.commit()
            db.refresh(g)
            return g.id
        finally:
            db.close()
