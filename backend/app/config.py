import os

APP_BASE_URL = os.getenv('APP_BASE_URL', 'http://api:8000')

PG_HOST = os.getenv('POSTGRES_HOST','db')
PG_PORT = int(os.getenv('POSTGRES_PORT','5432'))
PG_DB   = os.getenv('POSTGRES_DB','memorymap')
PG_USER = os.getenv('POSTGRES_USER','mmuser')
PG_PASS = os.getenv('POSTGRES_PASSWORD','mmsecret')

S3_ENDPOINT   = os.getenv('S3_ENDPOINT','http://minio:9000')
S3_BUCKET     = os.getenv('S3_BUCKET','memorymap-media')
S3_ACCESS_KEY = os.getenv('S3_ACCESS_KEY','minioadmin')
S3_SECRET_KEY = os.getenv('S3_SECRET_KEY','minioadmin')
S3_REGION     = os.getenv('S3_REGION','us-east-1')
S3_USE_SSL    = os.getenv('S3_USE_SSL','false').lower() == 'true'
