import boto3, os

def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.getenv("S3_ENDPOINT","http://minio:9000"),
        aws_access_key_id=os.getenv("S3_ACCESS_KEY","minioadmin"),
        aws_secret_access_key=os.getenv("S3_SECRET_KEY","minioadmin"),
        region_name=os.getenv("S3_REGION","us-east-1"),
        use_ssl=os.getenv("S3_USE_SSL","false").lower()=="true"
    )

def presign_put(key: str, content_type: str, expires: int = 600) -> str:
    s3 = s3_client()
    return s3.generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": os.getenv("S3_BUCKET","memorymap-media"), "Key": key, "ContentType": content_type},
        ExpiresIn=expires,
        HttpMethod="PUT",
    )

def presign_get(key: str, expires: int = 300) -> str:
    s3 = s3_client()
    return s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": os.getenv("S3_BUCKET","memorymap-media"), "Key": key},
        ExpiresIn=expires,
        HttpMethod="GET",
    )
