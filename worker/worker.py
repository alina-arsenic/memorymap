import os, time
from redis import Redis
from rq import Queue, Worker, Connection

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

def process_media_task(s3_key: str):
    print(f"[worker] processing {s3_key}")
    time.sleep(1)
    print(f"[worker] done {s3_key}")

if __name__ == "__main__":
    redis_conn = Redis.from_url(REDIS_URL)
    with Connection(redis_conn):
        q = Queue("media")
        worker = Worker([q])
        worker.work(with_scheduler=True)
