"""Сервис работы с жалобами на точки (постмодерация)."""

from datetime import datetime, timezone
from typing import Dict, List

from app.models.models import Place, Report, User
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

# Маппинг код категории → русское название
CATEGORY_LABELS: Dict[str, str] = {
    "spam": "Спам/реклама",
    "offensive": "Оскорбительный контент",
    "wrong_location": "Неверная локация",
    "privacy": "Нарушение приватности",
    "other": "Другое",
}

VALID_CATEGORIES = set(CATEGORY_LABELS.keys())


class ReportService:
    @staticmethod
    def create_report(
        db: Session,
        user: User,
        place_id: int,
        category: str,
        comment: str | None = None,
    ) -> Report:
        """Создать жалобу на точку.

        Проверки:
        - категория валидна
        - точка существует
        - не своя точка
        - точка approved (жаловаться можно только на одобренные)
        - нет dismissed-жалобы от этого юзера (повторная жалоба после отклонения запрещена)
        - нет pending-жалобы от этого юзера
        """
        if category not in VALID_CATEGORIES:
            raise ValueError("invalid_category")

        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            raise ValueError("place_not_found")

        if place.user_id == user.id:
            raise ValueError("cannot_report_own_place")

        if place.moderation_status != "approved":
            raise ValueError("place_not_approved")

        # Проверяем, нет ли dismissed-жалобы от этого юзера
        dismissed = (
            db.query(Report)
            .filter(
                Report.place_id == place_id,
                Report.user_id == user.id,
                Report.status == "dismissed",
            )
            .first()
        )
        if dismissed:
            raise ValueError("already_dismissed")

        # Проверяем pending (уникальный индекс тоже защищает, но лучше явно)
        existing = (
            db.query(Report)
            .filter(
                Report.place_id == place_id,
                Report.user_id == user.id,
                Report.status == "pending",
            )
            .first()
        )
        if existing:
            raise ValueError("already_reported")

        report = Report(
            place_id=place_id,
            user_id=user.id,
            category=category,
            comment=comment,
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(report)

        # Точка уходит на модерацию
        place.moderation_status = "pending"

        try:
            db.commit()
            db.refresh(report)
        except IntegrityError:
            db.rollback()
            raise ValueError("already_reported")

        return report

    @staticmethod
    def get_pending_reports_for_place(db: Session, place_id: int) -> List[Dict]:
        """Получить список pending-жалоб для точки (для панели модерации)."""
        rows = (
            db.query(Report, User)
            .outerjoin(User, Report.user_id == User.id)
            .filter(Report.place_id == place_id, Report.status == "pending")
            .order_by(Report.created_at.asc())
            .all()
        )
        result = []
        for report, reporter in rows:
            result.append({
                "id": report.id,
                "user_id": report.user_id,
                "user_login": reporter.login if reporter else None,
                "username": reporter.username if reporter else None,
                "category": report.category,
                "category_label": CATEGORY_LABELS.get(report.category, report.category),
                "comment": report.comment,
                "created_at": report.created_at.isoformat() if report.created_at else None,
            })
        return result

    @staticmethod
    def resolve_reports_for_place(
        db: Session,
        place_id: int,
        new_status: str,
        moderator_id: int,
    ) -> int:
        """Массово обновить pending-жалобы для точки → dismissed или upheld.

        Возвращает количество обновлённых записей.
        """
        now = datetime.now(timezone.utc)
        count = (
            db.query(Report)
            .filter(Report.place_id == place_id, Report.status == "pending")
            .update(
                {
                    Report.status: new_status,
                    Report.resolved_at: now,
                    Report.resolved_by: moderator_id,
                },
                synchronize_session="fetch",
            )
        )
        db.commit()
        return count

    @staticmethod
    def has_pending_report(db: Session, place_id: int) -> bool:
        """Есть ли хотя бы одна pending-жалоба на точку."""
        return (
            db.query(Report)
            .filter(Report.place_id == place_id, Report.status == "pending")
            .first()
        ) is not None

    @staticmethod
    def get_reported_place_ids(db: Session, place_ids: List[int]) -> set:
        """Batch-запрос: какие из переданных place_ids имеют pending-жалобы."""
        if not place_ids:
            return set()
        rows = (
            db.query(Report.place_id)
            .filter(Report.place_id.in_(place_ids), Report.status == "pending")
            .distinct()
            .all()
        )
        return {r[0] for r in rows}
