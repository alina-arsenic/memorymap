import os

# PostgreSQL
PG_HOST = os.getenv("POSTGRES_HOST", "db")
PG_PORT = os.getenv("POSTGRES_PORT", "5432")
PG_DB   = os.getenv("POSTGRES_DB", "memorymap")
PG_USER = os.getenv("POSTGRES_USER", "mmuser")
PG_PASS = os.getenv("POSTGRES_PASSWORD", "mmsecret")

DATABASE_URL = (
    f"postgresql+psycopg2://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{PG_DB}"
)

# App
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://api:8000")

# Media limits
MEDIA_LIMIT_PER_PLACE = int(os.getenv("MEDIA_LIMIT_PER_PLACE", "12"))

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALG = os.getenv("JWT_ALG", "HS256")
JWT_EXPIRES_MINUTES = int(os.getenv("JWT_EXPIRES_MINUTES", "30"))

BOT_API_SECRET = os.getenv("BOT_API_SECRET", "")
TELEGRAM_LINK_CODE_TTL_MINUTES = int(os.getenv("TELEGRAM_LINK_CODE_TTL_MINUTES", "10"))
