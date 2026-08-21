from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import threading
import webbrowser
from dataclasses import asdict, dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

SUPPORTED_GROUPS = frozenset({"commodity", "partner", "province", "trade_mode"})
SUPPORTED_CURRENCIES = frozenset({"rmb", "usd"})
SUPPORTED_IE_TYPES = frozenset({"export", "import", "import-export"})
IE_TYPE_VALUES = {"export": "0", "import": "1", "import-export": "10"}


@dataclass(frozen=True)
class CustomsQuery:
    code: str
    label: str
    start_year: int
    end_year: int
    start_month: int
    end_month: int
    months_per_job: int
    currency: str
    ie_type: str
    groups: tuple[str, ...]


@dataclass(frozen=True)
class CustomsJob:
    job_id: str
    code: str
    label: str
    year: int
    start_month: int
    end_month: int
    currency: str
    ie_type: str
    ie_type_value: str
    groups: tuple[str, ...]
    output_relative: str

    def payload(self) -> dict[str, object]:
        result = asdict(self)
        result["groups"] = list(self.groups)
        return result


def load_queries(path: Path) -> list[CustomsQuery]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    defaults = payload.get("defaults", {})
    queries: list[CustomsQuery] = []
    for product in payload.get("products", []):
        if not product.get("enabled", False):
            continue
        item = {**defaults, **product}
        ie_types = item.get("ie_types")
        if ie_types is None:
            ie_types = [item.get("ie_type", "export")]
        for ie_type in ie_types:
            queries.append(_query_from_mapping({**item, "ie_type": ie_type}))
    if not queries:
        raise ValueError(f"No enabled customs products in {path}")
    return queries


def _query_from_mapping(item: dict[str, Any]) -> CustomsQuery:
    code = str(item["code"]).strip()
    if len(code) != 8 or not code.isdigit():
        raise ValueError(f"Customs product code must contain 8 digits: {code!r}")
    start_year = int(item["start_year"])
    end_year = int(item["end_year"])
    start_month = int(item.get("start_month", 1))
    end_month = int(item.get("end_month", 12))
    if not 1 <= start_month <= 12 or not 1 <= end_month <= 12:
        raise ValueError(f"Customs query months must be between 1 and 12: {code}")
    if (start_year, start_month) > (end_year, end_month):
        raise ValueError(f"Customs query start date is after end date: {code}")
    months_per_job = int(item.get("months_per_job", 3))
    if not 1 <= months_per_job <= 12:
        raise ValueError(f"Customs months_per_job must be between 1 and 12: {code}")
    currency = str(item.get("currency", "rmb"))
    if currency not in SUPPORTED_CURRENCIES:
        raise ValueError(f"Unsupported customs currency: {currency}")
    ie_type = str(item.get("ie_type", "export"))
    if ie_type not in SUPPORTED_IE_TYPES:
        raise ValueError(f"Unsupported customs trade type: {ie_type}")
    groups = tuple(item.get("groups", ("commodity", "partner", "province", "trade_mode")))
    unknown = set(groups) - SUPPORTED_GROUPS
    if unknown or "commodity" not in groups or len(groups) > 4:
        raise ValueError(f"Unsupported customs output groups: {sorted(unknown)}")
    return CustomsQuery(
        code=code,
        label=str(item.get("label", "")).strip(),
        start_year=start_year,
        end_year=end_year,
        start_month=start_month,
        end_month=end_month,
        months_per_job=months_per_job,
        currency=currency,
        ie_type=ie_type,
        groups=groups,
    )


def expand_jobs(queries: list[CustomsQuery]) -> list[CustomsJob]:
    jobs: list[CustomsJob] = []
    for query in queries:
        for year in range(query.start_year, query.end_year + 1):
            first = query.start_month if year == query.start_year else 1
            last = query.end_month if year == query.end_year else 12
            for start in range(first, last + 1, query.months_per_job):
                end = min(start + query.months_per_job - 1, last)
                group_label = "_".join(query.groups)
                period = f"{year}_{start:02d}-{end:02d}"
                filename = f"{period}_{query.ie_type}_{query.currency}_{group_label}.csv"
                identity = f"{query.code}|{year}|{start}|{end}|{query.ie_type}|{query.currency}|{group_label}"
                job_id = hashlib.sha256(identity.encode()).hexdigest()[:16]
                jobs.append(
                    CustomsJob(
                        job_id=job_id,
                        code=query.code,
                        label=query.label,
                        year=year,
                        start_month=start,
                        end_month=end,
                        currency=query.currency,
                        ie_type=query.ie_type,
                        ie_type_value=IE_TYPE_VALUES[query.ie_type],
                        groups=query.groups,
                        output_relative=f"{query.code}/{year}/{filename}",
                    )
                )
    return jobs


def validate_csv(payload: bytes, job: CustomsJob) -> tuple[int, list[str], list[str]]:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            text = payload.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("Downloaded CSV uses an unsupported encoding")
    reader = csv.reader(io.StringIO(text))
    header = next(reader, [])
    for field in ("数据年月", "商品编码"):
        if field not in header:
            raise ValueError(f"Downloaded CSV does not contain the {field} field")
    period_index, code_index = header.index("数据年月"), header.index("商品编码")
    periods: set[str] = set()
    codes: set[str] = set()
    rows = 0
    for row in reader:
        if not row:
            continue
        rows += 1
        if period_index < len(row) and row[period_index].strip():
            periods.add(row[period_index].strip())
        if code_index < len(row) and row[code_index].strip():
            codes.add(row[code_index].strip())
    if rows >= 10_000:
        raise ValueError("Downloaded CSV reached the platform's 10,000-row limit; reduce months_per_job")
    expected = {f"{job.year}{month:02d}" for month in range(job.start_month, job.end_month + 1)}
    unexpected = periods - expected
    if unexpected:
        raise ValueError(f"Downloaded CSV contains periods outside the query range: {sorted(unexpected)}")
    if not periods:
        raise ValueError("Downloaded CSV does not contain any data periods")
    if codes != {job.code}:
        raise ValueError(f"Downloaded CSV product mismatch: expected {job.code}, received {sorted(codes)}")
    return rows, sorted(periods), sorted(expected - periods)


class Coordinator:
    def __init__(self, raw_root: Path, jobs: list[CustomsJob], replace: bool) -> None:
        self.raw_root = raw_root
        self.jobs = {job.job_id: job for job in jobs}
        self.state_path = raw_root / "fetch_state.json"
        self.manifest_path = raw_root / "fetch_manifest.json"
        self.lock = threading.Lock()
        self.state = self._initial_state(replace)
        self.write_state()

    def _initial_state(self, replace: bool) -> dict[str, object]:
        previous = json.loads(self.state_path.read_text(encoding="utf-8")) if self.state_path.exists() else {}
        previous_jobs = previous.get("jobs", {}) if isinstance(previous, dict) else {}
        rows: dict[str, dict[str, object]] = {}
        for job in self.jobs.values():
            old = previous_jobs.get(job.job_id, {}) if isinstance(previous_jobs, dict) else {}
            output = self.raw_root / job.output_relative
            no_data = isinstance(old, dict) and old.get("status") == "completed" and old.get("no_data") is True
            done = not replace and ((output.exists() and output.stat().st_size > 0) or no_data)
            rows[job.job_id] = {
                "status": "completed" if done else "pending",
                "client": None,
                "attempts": int(old.get("attempts", 0)) if isinstance(old, dict) else 0,
                "error": None,
                "output": job.output_relative,
                "no_data": no_data if done else False,
            }
        return {"source": "中国海关统计数据在线查询平台", "updated_at": now(), "jobs": rows}

    def next_job(self, client: str) -> dict[str, object]:
        with self.lock:
            rows = self.state["jobs"]
            for job_id, row in rows.items():
                if row["status"] == "running" and row["client"] == client:
                    return {"state": "job", "job": self.jobs[job_id].payload()}
            if any(row["status"] == "running" for row in rows.values()):
                return {"state": "wait", "summary": self.summary()}
            for job_id, row in rows.items():
                if row["status"] != "pending":
                    continue
                row.update({"status": "running", "client": client, "attempts": int(row["attempts"]) + 1, "error": None})
                self.write_state()
                return {"state": "job", "job": self.jobs[job_id].payload()}
            return {"state": "done", "summary": self.summary()}

    def save_result(self, job_id: str, payload: bytes) -> dict[str, object]:
        if job_id not in self.jobs:
            raise ValueError(f"Unknown customs job: {job_id}")
        if len(payload) < 20 or b"<html" in payload[:1024].lower() or b"<!doctype" in payload[:1024].lower():
            raise ValueError("Downloaded response is empty or contains HTML instead of CSV")
        rows, periods, missing = validate_csv(payload, self.jobs[job_id])
        target = self.raw_root / self.jobs[job_id].output_relative
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".part")
        temporary.write_bytes(payload)
        os.replace(temporary, target)
        with self.lock:
            self.state["jobs"][job_id].update(
                {
                    "status": "completed",
                    "client": None,
                    "error": None,
                    "bytes": target.stat().st_size,
                    "sha256": sha256(target),
                    "rows": rows,
                    "periods": periods,
                    "missing_periods": missing,
                    "no_data": False,
                }
            )
            self.write_state()
            self.write_manifest()
        return {"saved": self.jobs[job_id].output_relative, "bytes": target.stat().st_size}

    def complete_no_data(self, job_id: str) -> dict[str, object]:
        if job_id not in self.jobs:
            raise ValueError(f"Unknown customs job: {job_id}")
        with self.lock:
            self.state["jobs"][job_id].update({"status": "completed", "client": None, "error": None, "no_data": True})
            self.write_state()
            self.write_manifest()
        return {"no_data": True}

    def fail_job(self, job_id: str, error: str) -> None:
        if job_id not in self.jobs:
            raise ValueError(f"Unknown customs job: {job_id}")
        with self.lock:
            self.state["jobs"][job_id].update({"status": "failed", "client": None, "error": error[:1000]})
            self.write_state()
            self.write_manifest()

    def summary(self) -> dict[str, int]:
        counts = {status: 0 for status in ("pending", "running", "completed", "failed")}
        for row in self.state["jobs"].values():
            counts[str(row["status"])] += 1
        counts["total"] = len(self.jobs)
        return counts

    def plan(self) -> dict[str, object]:
        return {"summary": self.summary(), "jobs": [job.payload() for job in self.jobs.values()]}

    def outputs(self) -> list[Path]:
        return [
            self.raw_root / job.output_relative
            for job_id, job in self.jobs.items()
            if self.state["jobs"][job_id]["status"] == "completed"
            and not self.state["jobs"][job_id].get("no_data", False)
        ]

    def write_state(self) -> None:
        self.state["updated_at"] = now()
        write_json(self.state_path, self.state)

    def write_manifest(self) -> None:
        files = [
            {"path": p.relative_to(self.raw_root).as_posix(), "bytes": p.stat().st_size, "sha256": sha256(p)}
            for p in self.outputs()
        ]
        write_json(
            self.manifest_path,
            {
                "source": "中国海关统计数据在线查询平台",
                "source_url": "http://stats.customs.gov.cn/",
                "retrieved_at": now(),
                "summary": self.summary(),
                "queries": [job.payload() for job in self.jobs.values()],
                "results": [{"job_id": job_id, **row} for job_id, row in self.state["jobs"].items()],
                "files": files,
            },
        )


def now() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class Server(ThreadingHTTPServer):
    coordinator: Coordinator


class Handler(BaseHTTPRequestHandler):
    server: Server

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/next":
            client = parse_qs(parsed.query).get("client", [""])[0]
            if not client:
                self.json_response(HTTPStatus.BAD_REQUEST, {"error": "client is required"})
                return
            payload = self.server.coordinator.next_job(client)
            self.json_response(HTTPStatus.OK, payload)
            if payload["state"] == "done":
                threading.Timer(0.5, self.server.shutdown).start()
            return
        if parsed.path == "/api/summary":
            self.json_response(HTTPStatus.OK, self.server.coordinator.summary())
            return
        if parsed.path == "/api/plan":
            self.json_response(HTTPStatus.OK, self.server.coordinator.plan())
            return
        self.json_response(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        payload = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            job_id = path.rsplit("/", 1)[-1]
            if path.startswith("/api/result/"):
                result = self.server.coordinator.save_result(job_id, payload)
            elif path.startswith("/api/no-data/"):
                result = self.server.coordinator.complete_no_data(job_id)
            elif path.startswith("/api/fail/"):
                body = json.loads(payload.decode("utf-8"))
                self.server.coordinator.fail_job(job_id, str(body.get("error", "unknown error")))
                result = {"saved": True}
            else:
                self.json_response(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            self.json_response(HTTPStatus.OK, result)
            if self.server.coordinator.summary()["pending"] == 0:
                threading.Timer(0.5, self.server.shutdown).start()
        except (ValueError, json.JSONDecodeError) as error:
            print(f"[customs-crawl] rejected {path}: {error}")
            self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"[customs-crawl] {format % args}")

    def json_response(self, status: HTTPStatus, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server(
    raw_root: Path, jobs: list[CustomsJob], replace: bool, host: str, port: int, open_browser: bool
) -> Coordinator:
    raw_root.mkdir(parents=True, exist_ok=True)
    coordinator = Coordinator(raw_root, jobs, replace)
    server = Server((host, port), Handler)
    server.coordinator = coordinator
    if open_browser:
        webbrowser.open(f"http://stats.customs.gov.cn/#customs-crawl-port={port}")
    print(f"Customs crawl coordinator: http://{host}:{port}")
    print(f"Output root: {raw_root}")
    print(f"Jobs: {coordinator.summary()}")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("Customs crawl stopped.")
    finally:
        server.server_close()
        coordinator.write_manifest()
    return coordinator
