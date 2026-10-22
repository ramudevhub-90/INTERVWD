"""Storage: JSON documents in one DynamoDB table, plus files (CVs, snapshots) in S3.

Every document has a kind and an id (pk = "<kind>#<id>", sk = "doc"). A document can also be listed
under one secondary key (gsi1pk), e.g. all jobs of an org ("org#<id>#jobs") or the round behind an
invite code ("invite#<code>"); gsi1sk orders that list. Short-lived documents (sign-in codes, OAuth
codes) carry `expires`, a Unix time after which DynamoDB deletes them and reads ignore them.
"""

from __future__ import annotations

import json
import os
import threading
import time
from decimal import Decimal
from typing import Any, Protocol


class Store(Protocol):
    def get(self, kind: str, id: str) -> dict[str, Any] | None: ...
    def put(self, kind: str, id: str, doc: dict[str, Any], index: tuple[str, str] | None = None, expires: int | None = None) -> None: ...
    def delete(self, kind: str, id: str) -> None: ...
    def listed(self, index: str) -> list[dict[str, Any]]: ...
    def create(self, kind: str, id: str, doc: dict[str, Any], expires: int | None = None) -> bool: ...


class Blobs(Protocol):
    def save(self, key: str, data: bytes, content_type: str) -> None: ...
    def load(self, key: str) -> tuple[bytes, str] | None: ...


def _live(item: dict[str, Any] | None) -> bool:
    return bool(item) and (not item.get("expires") or int(item["expires"]) > time.time())


class MemoryStore:
    """For tests and local development. Keeps the same rules as DynamoStore."""

    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def get(self, kind: str, id: str) -> dict[str, Any] | None:
        item = self._items.get(f"{kind}#{id}")
        return json.loads(item["doc"]) if _live(item) else None

    def put(self, kind, id, doc, index=None, expires=None) -> None:
        with self._lock:
            self._items[f"{kind}#{id}"] = {
                "doc": json.dumps(doc), "index": index, "expires": expires,
            }

    def create(self, kind, id, doc, expires=None) -> bool:
        with self._lock:
            if _live(self._items.get(f"{kind}#{id}")):
                return False
            self._items[f"{kind}#{id}"] = {"doc": json.dumps(doc), "index": None, "expires": expires}
            return True

    def delete(self, kind: str, id: str) -> None:
        with self._lock:
            self._items.pop(f"{kind}#{id}", None)

    def listed(self, index: str) -> list[dict[str, Any]]:
        rows = [(i["index"][1], json.loads(i["doc"])) for i in list(self._items.values()) if i["index"] and i["index"][0] == index and _live(i)]
        return [doc for _, doc in sorted(rows, key=lambda r: r[0])]


def _plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    return value


class DynamoStore:
    def __init__(self, table_name: str, client: Any = None) -> None:
        import boto3

        self.table = table_name
        self.db = client or boto3.client("dynamodb")

    def get(self, kind: str, id: str) -> dict[str, Any] | None:
        res = self.db.get_item(TableName=self.table, Key={"pk": {"S": f"{kind}#{id}"}, "sk": {"S": "doc"}}, ConsistentRead=True)
        item = res.get("Item")
        if not item or ("expires" in item and int(item["expires"]["N"]) <= time.time()):
            return None
        return json.loads(item["doc"]["S"])

    def _item(self, kind: str, id: str, doc: dict[str, Any], index: tuple[str, str] | None, expires: int | None) -> dict[str, Any]:
        item: dict[str, Any] = {"pk": {"S": f"{kind}#{id}"}, "sk": {"S": "doc"}, "doc": {"S": json.dumps(doc)}}
        if index:
            item["gsi1pk"] = {"S": index[0]}
            item["gsi1sk"] = {"S": index[1]}
        if expires:
            item["expires"] = {"N": str(int(expires))}
        return item

    def put(self, kind, id, doc, index=None, expires=None) -> None:
        self.db.put_item(TableName=self.table, Item=self._item(kind, id, doc, index, expires))

    def create(self, kind, id, doc, expires=None) -> bool:
        try:
            self.db.put_item(
                TableName=self.table,
                Item=self._item(kind, id, doc, None, expires),
                ConditionExpression="attribute_not_exists(pk) OR expires < :now",
                ExpressionAttributeValues={":now": {"N": str(int(time.time()))}},
            )
            return True
        except self.db.exceptions.ConditionalCheckFailedException:
            return False

    def delete(self, kind: str, id: str) -> None:
        self.db.delete_item(TableName=self.table, Key={"pk": {"S": f"{kind}#{id}"}, "sk": {"S": "doc"}})

    def listed(self, index: str) -> list[dict[str, Any]]:
        docs: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "TableName": self.table, "IndexName": "gsi1",
            "KeyConditionExpression": "gsi1pk = :k", "ExpressionAttributeValues": {":k": {"S": index}},
        }
        while True:
            res = self.db.query(**kwargs)
            for item in res.get("Items", []):
                if "expires" in item and int(item["expires"]["N"]) <= time.time():
                    continue
                docs.append(json.loads(item["doc"]["S"]))
            if "LastEvaluatedKey" not in res:
                return docs
            kwargs["ExclusiveStartKey"] = res["LastEvaluatedKey"]


class MemoryBlobs:
    def __init__(self) -> None:
        self._files: dict[str, tuple[bytes, str]] = {}

    def save(self, key: str, data: bytes, content_type: str) -> None:
        self._files[key] = (data, content_type)

    def load(self, key: str) -> tuple[bytes, str] | None:
        return self._files.get(key)


class S3Blobs:
    def __init__(self, bucket: str, client: Any = None) -> None:
        import boto3

        self.bucket = bucket
        self.s3 = client or boto3.client("s3")

    def save(self, key: str, data: bytes, content_type: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def load(self, key: str) -> tuple[bytes, str] | None:
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
        except self.s3.exceptions.NoSuchKey:
            return None
        return obj["Body"].read(), obj.get("ContentType", "application/octet-stream")


def from_env() -> tuple[Store, Blobs]:
    table = os.environ.get("INTERVWD_TABLE")
    bucket = os.environ.get("UPLOADS_BUCKET")
    return (DynamoStore(table) if table else MemoryStore()), (S3Blobs(bucket) if bucket else MemoryBlobs())
