from app.core.db import Base
from sqlalchemy import BigInteger, Boolean, Column, DateTime, Float, ForeignKey, Integer, Text
from sqlalchemy.orm import relationship


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    tg_id = Column(BigInteger, unique=True)
    username = Column(Text)

    login = Column(Text, unique=True, nullable=True)
    password_hash = Column(Text, nullable=True)
    email = Column(Text, unique=True, nullable=True)
    email_verified = Column(Boolean, nullable=False, default=False)
    role = Column(Text, nullable=False, default="user")  # admin | moderator | user

    places = relationship("Place", back_populates="user")

class Group(Base):
    __tablename__ = "groups"
    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False)
    visibility = Column(Text, nullable=False, default="private")  # private|friends|public
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    is_personal = Column(Boolean, nullable=False, default=False)

    places = relationship("Place", back_populates="group")

class Place(Base):
    __tablename__ = "places"
    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("groups.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    title = Column(Text)
    note = Column(Text)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    moderation_status = Column(Text, nullable=False, default="approved")  # pending | approved | rejected

    user = relationship("User", back_populates="places")
    group = relationship("Group", back_populates="places")
    media = relationship("Media", back_populates="place")

class Media(Base):
    __tablename__ = "media"
    id = Column(Integer, primary_key=True)
    place_id = Column(Integer, ForeignKey("places.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    s3_key = Column(Text, nullable=False)
    mime = Column(Text)
    status = Column(Text, nullable=False, default="ready")  # pending|processing|ready|failed

    place = relationship("Place", back_populates="media")
    user = relationship("User")

class Friend(Base):
    """Legacy one-way friends table (deprecated)."""

    __tablename__ = "friends"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    friend_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    status = Column(Text, nullable=False, default="accepted")

class EmailVerificationCode(Base):
    """Одноразовый код подтверждения email (6 цифр, TTL из конфига)."""
    __tablename__ = "email_verification_codes"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    code = Column(Text, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User")


class TelegramLinkCode(Base):
    __tablename__ = "telegram_link_codes"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    code = Column(Text, nullable=False, unique=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User")


class Friendship(Base):
    __tablename__ = "friendships"
    user1_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    user2_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    created_at = Column(DateTime(timezone=True))

class FriendRequest(Base):
    __tablename__ = "friend_requests"
    id = Column(Integer, primary_key=True)
    from_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    to_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(Text, nullable=False, default="pending")  # pending|accepted|declined|canceled
    created_at = Column(DateTime(timezone=True))
    responded_at = Column(DateTime(timezone=True))


class GroupInvite(Base):
    """Приглашение в группу (слой)."""
    __tablename__ = "group_invites"

    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False)
    from_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    to_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(Text, nullable=False, default="viewer")  # editor | viewer
    status = Column(Text, nullable=False, default="pending")  # pending|accepted|declined|canceled
    created_at = Column(DateTime(timezone=True))
    responded_at = Column(DateTime(timezone=True))

    group = relationship("Group")
    from_user = relationship("User", foreign_keys=[from_user_id])
    to_user = relationship("User", foreign_keys=[to_user_id])


class UserBlock(Base):
    """Блокировка пользователя (blocker блокирует blocked)."""
    __tablename__ = "user_blocks"

    id = Column(Integer, primary_key=True)
    blocker_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    blocked_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True))

    blocker = relationship("User", foreign_keys=[blocker_id])
    blocked = relationship("User", foreign_keys=[blocked_id])


class Report(Base):
    """Жалоба на точку (постмодерация)."""
    __tablename__ = "reports"

    id = Column(Integer, primary_key=True)
    place_id = Column(Integer, ForeignKey("places.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    category = Column(Text, nullable=False)
    comment = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")  # pending | dismissed | upheld
    created_at = Column(DateTime(timezone=True))
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    resolved_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    place = relationship("Place")
    reporter = relationship("User", foreign_keys=[user_id])
    resolver = relationship("User", foreign_keys=[resolved_by])
