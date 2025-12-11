import boto3, os
from botocore.exceptions import ClientError
from urllib.parse import urlparse, urlunparse

BUCKET = os.getenv("S3_BUCKET", "memorymap-media")
S3_ENDPOINT = os.getenv("S3_ENDPOINT", "http://minio:9000")
S3_PUBLIC_ENDPOINT = os.getenv("S3_PUBLIC_ENDPOINT")  # например http://localhost:9000

def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=os.getenv("S3_ACCESS_KEY", "minioadmin"),
        aws_secret_access_key=os.getenv("S3_SECRET_KEY", "minioadmin"),
        region_name=os.getenv("S3_REGION", "us-east-1"),
        use_ssl=os.getenv("S3_USE_SSL", "false").lower() == "true",
    )

def ensure_bucket(s3):
    try:
        s3.head_bucket(Bucket=BUCKET)
    except ClientError:
        try:
            s3.create_bucket(Bucket=BUCKET)
        except ClientError:
            pass

def _apply_public_endpoint(url: str) -> str:
    """Меняем host в presigned-URL на тот, что доступен браузеру."""
    if not S3_PUBLIC_ENDPOINT:
        return url
    u = urlparse(url)
    pu = urlparse(S3_PUBLIC_ENDPOINT)
    return urlunparse((pu.scheme, pu.netloc, u.path, u.params, u.query, u.fragment))

def presign_put(key: str, content_type: str, expires: int = 600) -> str:
    s3 = s3_client()
    ensure_bucket(s3)
    url = s3.generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=expires,
        HttpMethod="PUT",
    )
    return _apply_public_endpoint(url)

def presign_get(key: str, expires: int = 300) -> str:
    s3 = s3_client()
    ensure_bucket(s3)
    url = s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=expires,
        HttpMethod="GET",
    )
    return _apply_public_endpoint(url)
