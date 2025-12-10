from sqlalchemy import Column, Integer, BigInteger, Text, Float, ForeignKey
from sqlalchemy.orm import relationship
from .db import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    tg_id = Column(BigInteger, unique=True)
    username = Column(Text)

    places = relationship("Place", back_populates="user")


class Group(Base):
    __tablename__ = "groups"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False)
    visibility = Column(Text, nullable=False, default="private")  # private | friends | public

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

    user = relationship("User", back_populates="places")
    group = relationship("Group", back_populates="places")


class Friend(Base):
    __tablename__ = "friends"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    friend_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    status = Column(Text, nullable=False, default="accepted")
