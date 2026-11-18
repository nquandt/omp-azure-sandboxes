#!/usr/bin/env python3

import hashlib
import hmac
import json
import os
import secrets
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

STATE = Path("/state")
JOBS = STATE / "jobs"
CLIENTS = STATE / "gateway-clients.json"
LOCK = threading.Lock()
MAX_BODY = 256 * 1024
JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


SUBSCRIPTION = required("SAND_SUBSCRIPTION_ID")
RESOURCE_GROUP = required("SAND_RESOURCE_GROUP")
REGION = required("SAND_REGION")
SANDBOX_GROUP = required("SAND_SANDBOX_GROUP")
WORKER_DISK_ID = required("SAND_WORKER_DISK_ID")
GATEWAY_URL = required("SAND_GATEWAY_URL")
DISPATCHER_TOKEN = required("SAND_DISPATCHER_TOKEN")
CPU = os.environ.get("SAND_CHILD_CPU", "2500m")
MEMORY = os.environ.get("SAND_CHILD_MEMORY", "4096Mi")


def run(*arguments: str, input_text: str | None = None) -> str:
    command = [
        "aca",
        *arguments,
        "--subscription",
        SUBSCRIPTION,
        "--resource-group",
        RESOURCE_GROUP,
        "--region",
        REGION,
        "--managed-identity",
        "system",
        "--output",
        "json",
    ]
    result = subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"{' '.join(command[:3])} failed: {detail}")
    return result.stdout.strip()


def parse_json(output: str):
    starts = [position for position in (output.find("{"), output.find("[")) if position >= 0]
    if not starts:
        raise RuntimeError("ACA returned no JSON")
    return json.loads(output[min(starts) :])


def command_stdout(output: str) -> str:
    try:
        value = parse_json(output)
    except (RuntimeError, json.JSONDecodeError):
        return output
    if isinstance(value, dict) and isinstance(value.get("stdout"), str):
        return value["stdout"]
    return output


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def job_path(job_id: str) -> Path:
    try:
        uuid.UUID(job_id)
    except ValueError as error:
        raise KeyError(job_id) from error
    return JOBS / f"{job_id}.json"


def read_job(job_id: str) -> dict:
    path = job_path(job_id)
    if not path.exists():
        raise KeyError(job_id)
    return json.loads(path.read_text())


def write_job(job: dict) -> None:
    atomic_json(job_path(job["id"]), job)


def update_clients(mutator) -> None:
    with LOCK:
        clients = json.loads(CLIENTS.read_text()) if CLIENTS.exists() else {}
        mutator(clients)
        atomic_json(CLIENTS, clients)


def await_gateway_client(token: str, attempts: int = 20) -> None:
    request = Request(
        f"{GATEWAY_URL.rstrip('/')}/v1/models",
        headers={"Authorization": f"Bearer {token}"},
    )
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=5) as response:
                if response.status == 200:
                    return
        except (HTTPError, URLError, TimeoutError):
            pass
        if attempt + 1 < attempts:
            time.sleep(1)
    raise RuntimeError("gateway did not load the child credential")


def find_sandbox(job_id: str, attempts: int = 15) -> str | None:
    for attempt in range(attempts):
        output = run(
            "sandbox",
            "list",
            "--group",
            SANDBOX_GROUP,
            "--selector",
            f"job={job_id}",
        )
        if output:
            listed = parse_json(output)
            sandbox_id = listed[0].get("id") if listed else None
            if sandbox_id:
                return sandbox_id
        if attempt + 1 < attempts:
            time.sleep(1)
    return None


def revoke(job: dict) -> None:
    update_clients(lambda clients: clients.pop(job["id"], None))
    if not job.get("revoked"):
        job["revoked"] = True
        write_job(job)


def sandbox_status(job: dict) -> dict:
    if job.get("resourcesDeleted") or "result" in job:
        return job
    output = run(
        "sandbox",
        "exec",
        "--group",
        SANDBOX_GROUP,
        "--id",
        job["sandboxId"],
        "--command",
        "if [ -f /state/status.json ]; then cat /state/status.json; "
        "else printf '{\"state\":\"starting\"}\\n'; fi",
    )
    stdout = command_stdout(output)
    try:
        status = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        status = {"state": "starting"}
    return {**job, **status}


def delete_job_resources(job: dict) -> None:
    if not job.get("sandboxDeleted"):
        sandbox_id = find_sandbox(job["id"], 1)
        if sandbox_id is not None:
            run(
                "sandbox",
                "delete",
                "--group",
                SANDBOX_GROUP,
                "--id",
                sandbox_id,
                "--yes",
            )
        job["sandboxDeleted"] = True
        write_job(job)
    if not job.get("volumeDeleted"):
        output = run(
            "sandboxgroup",
            "volume",
            "list",
            "--group",
            SANDBOX_GROUP,
            "--selector",
            f"job={job['id']}",
        )
        if parse_json(output):
            run(
                "sandboxgroup",
                "volume",
                "delete",
                "--group",
                SANDBOX_GROUP,
                "--selector",
                f"job={job['id']}",
            )
        job["volumeDeleted"] = True
        job["resourcesDeleted"] = True
        write_job(job)


def collect_job(job: dict, status: dict | None = None) -> dict:
    status = sandbox_status(job) if status is None else status
    if status.get("state") not in {"completed", "failed"}:
        return status
    output = run(
        "sandbox",
        "exec",
        "--group",
        SANDBOX_GROUP,
        "--id",
        job["sandboxId"],
        "--command",
        "cat /state/result.txt",
    )
    job.update(status)
    job["result"] = command_stdout(output)
    job["finishedAt"] = int(status.get("finishedAt", time.time()))
    revoke(job)
    delete_job_resources(job)
    return job


def stop_job(job: dict, state: str) -> None:
    job["state"] = state
    job["finishedAt"] = int(time.time())
    revoke(job)
    delete_job_resources(job)


def cleanup() -> None:
    while True:
        now = int(time.time())
        for path in JOBS.glob("*.json"):
            try:
                job = json.loads(path.read_text())
                if job.get("resourcesDeleted"):
                    if now - int(job.get("finishedAt", now)) >= JOB_RETENTION_SECONDS:
                        path.unlink(missing_ok=True)
                elif job.get("revoked"):
                    delete_job_resources(job)
                elif now >= job["expiresAt"]:
                    status = sandbox_status(job)
                    if status.get("state") in {"completed", "failed"}:
                        collect_job(job, status)
                    else:
                        stop_job(job, "expired")
            except Exception as error:
                print(f"cleanup failed for {path.name}: {error}", flush=True)
        time.sleep(30)


def create_job(request: dict) -> dict:
    task = request.get("task")
    model = request.get("model")
    repository = request.get("repository")
    max_cost = request.get("maxCost", 5)
    max_time = request.get("maxTimeSeconds", 1800)
    if not isinstance(task, str) or not task.strip() or len(task) > 200_000:
        raise ValueError("task must be a non-empty string no longer than 200000 characters")
    if not isinstance(model, str) or "/" not in model or len(model) > 200:
        raise ValueError("model must be a provider-qualified model ID")
    if repository is not None and (not isinstance(repository, str) or len(repository) > 2048):
        raise ValueError("repository must be a URL string")
    if not isinstance(max_cost, (int, float)) or not 0 < max_cost <= 100:
        raise ValueError("maxCost must be greater than 0 and no more than 100")
    if not isinstance(max_time, int) or not 60 <= max_time <= 14400:
        raise ValueError("maxTimeSeconds must be between 60 and 14400")

    job_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    volume_name = f"state-{session_id[:12]}"
    gateway_token = secrets.token_urlsafe(32)
    token_digest = hashlib.sha256(gateway_token.encode()).hexdigest()
    now = int(time.time())
    job = {
        "id": job_id,
        "sessionId": session_id,
        "state": "creating",
        "model": model,
        "createdAt": now,
        "expiresAt": now + max_time + 120,
        "revoked": False,
    }
    write_job(job)
    update_clients(
        lambda clients: clients.update(
            {job_id: {"tokenSha256": token_digest, "models": [model]}}
        )
    )

    sandbox_id = None
    try:
        await_gateway_client(gateway_token)
        run(
            "sandboxgroup",
            "volume",
            "create",
            "--group",
            SANDBOX_GROUP,
            "--name",
            volume_name,
            "--type",
            "DataDisk",
            "--size",
            "10Gi",
            "--label",
            f"job={job_id}",
        )
        environment = {
            "HOME": "/state/home",
            "SAND_CHILD": "1",
            "SAND_JOB_ID": job_id,
            "SAND_MODEL": model,
            "SAND_GATEWAY_URL": GATEWAY_URL,
            "SAND_GATEWAY_TOKEN": gateway_token,
            "SAND_MAX_COST": str(max_cost),
            "SAND_MAX_TIME": str(max_time),
        }
        if repository is not None:
            environment["SAND_REPOSITORY"] = repository
        manifest = {
            "diskId": WORKER_DISK_ID,
            "resources": {"cpu": CPU, "memory": MEMORY, "disk": "20480Mi"},
            "lifecycle": {
                "autoSuspendPolicy": {"enabled": True, "interval": 300, "mode": "Disk"}
            },
            "environment": environment,
            "labels": {"job": job_id, "runtime": "omp-child", "depth": "1"},
            "volumes": [
                {"volumeName": volume_name, "mountpoint": "/state", "readOnly": False}
            ],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json") as manifest_file:
            json.dump(manifest, manifest_file)
            manifest_file.flush()
            run(
                "sandbox",
                "apply",
                "--group",
                SANDBOX_GROUP,
                "--file",
                manifest_file.name,
            )
        sandbox_id = find_sandbox(job_id)
        if not sandbox_id:
            raise RuntimeError("sandbox creation returned no id")
        job.update({"sandboxId": sandbox_id, "volumeName": volume_name, "state": "starting"})
        write_job(job)

        with tempfile.NamedTemporaryFile("w") as task_file:
            task_file.write(task)
            task_file.flush()
            run(
                "sandbox",
                "fs",
                "write",
                "--group",
                SANDBOX_GROUP,
                "--id",
                sandbox_id,
                "--path",
                "/state/task.txt",
                "--file",
                task_file.name,
            )
        run(
            "sandbox",
            "exec",
            "--group",
            SANDBOX_GROUP,
            "--id",
            sandbox_id,
            "--command",
            "tmux new-session -d -s child /usr/local/bin/sand-child-session",
        )
        return job
    except Exception:
        revoke(job)
        try:
            if sandbox_id is None:
                sandbox_id = find_sandbox(job_id, 3)
            if sandbox_id is not None:
                run(
                    "sandbox",
                    "delete",
                    "--group",
                    SANDBOX_GROUP,
                    "--id",
                    sandbox_id,
                    "--yes",
                )
            run(
                "sandboxgroup",
                "volume",
                "delete",
                "--group",
                SANDBOX_GROUP,
                "--name",
                volume_name,
            )
        except Exception as cleanup_error:
            print(f"job cleanup failed for {job_id}: {cleanup_error}", flush=True)
        raise


class Handler(BaseHTTPRequestHandler):
    server_version = "sand-dispatcher/1"

    def respond(self, status: int, value) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        expected = f"Bearer {DISPATCHER_TOKEN}"
        return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def route(self) -> list[str]:
        return [part for part in urlparse(self.path).path.split("/") if part]

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self.respond(200, {"status": "ok"})
            return
        if not self.authorized():
            self.respond(401, {"error": "unauthorized"})
            return
        parts = self.route()
        try:
            if len(parts) in (3, 4) and parts[:2] == ["v1", "jobs"]:
                job = read_job(parts[2])
                status = sandbox_status(job)
                if (
                    status.get("state") in {"completed", "failed"}
                    and "result" not in job
                ):
                    status = collect_job(job, status)
                if len(parts) == 4:
                    if parts[3] != "result":
                        raise KeyError(parts[3])
                    if status.get("state") not in {"completed", "failed"}:
                        self.respond(
                            409,
                            {"error": "job is not complete", "state": status.get("state")},
                        )
                        return
                    self.respond(200, status)
                    return
                public_status = {key: value for key, value in status.items() if key != "result"}
                self.respond(200, public_status)
                return
            raise KeyError(self.path)
        except KeyError:
            self.respond(404, {"error": "not found"})
        except Exception as error:
            self.respond(502, {"error": str(error)})

    def do_POST(self) -> None:
        if not self.authorized():
            self.respond(401, {"error": "unauthorized"})
            return
        if self.path != "/v1/jobs":
            self.respond(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("invalid request size")
            request = json.loads(self.rfile.read(length))
            self.respond(202, create_job(request))
        except (ValueError, json.JSONDecodeError) as error:
            self.respond(400, {"error": str(error)})
        except Exception as error:
            self.respond(502, {"error": str(error)})

    def do_DELETE(self) -> None:
        if not self.authorized():
            self.respond(401, {"error": "unauthorized"})
            return
        parts = self.route()
        try:
            if len(parts) != 3 or parts[:2] != ["v1", "jobs"]:
                raise KeyError(self.path)
            job = read_job(parts[2])
            stop_job(job, "cancelled")
            self.respond(200, job)
        except KeyError:
            self.respond(404, {"error": "not found"})
        except Exception as error:
            self.respond(502, {"error": str(error)})

    def log_message(self, format: str, *args) -> None:
        print(f"{self.client_address[0]} {format % args}", flush=True)


if __name__ == "__main__":
    JOBS.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=cleanup, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    print("sand dispatcher listening on :8080", flush=True)
    server.serve_forever()
