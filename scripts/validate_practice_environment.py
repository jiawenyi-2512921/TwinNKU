"""Explicit, bounded Linux acceptance of a disposable, isolated practice stack.

Requires three reviewed local immutable image IDs. Refuses any existing practice
Docker object; it never adopts a team's training stack or reads production env.
Credentials are generated in memory, sent through stdin/HTTP, and never reported.
This is an executable acceptance tool, not evidence until it has actually passed.
"""

import argparse
import http.cookiejar
import importlib.util
import json
import os
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

SPEC = importlib.util.spec_from_file_location(
    "practice_environment", Path(__file__).with_name("practice_environment.py")
)
practice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(practice)
MAX_OUTPUT = 2 * 1024 * 1024
PRODUCTION_NAMES = {name: f"twinnku-{name}-1" for name in ("api", "web", "db")}
COOKIE = "twinnku_practice_staff"

STARTUP_HTTP_PROBE = """
import json,urllib.request,urllib.error
from types import SimpleNamespace
from uuid import uuid4
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
rows={}
for name,url in [('api','http://localhost:8000/api/v1/system/status'),('web','http://web:8080/api/v1/system/status')]:
 try:
  request=urllib.request.Request(url,headers={'Host':'localhost','Accept':'application/json'})
  try: response=opener.open(request,timeout=5)
  except urllib.error.HTTPError as error: response=error
  with response: rows[name]={'status':response.status}
 except Exception as error: rows[name]={'error_type':type(error).__name__}
try:
 from app.api import system_status
 from app.core.config import get_settings
 from app.database import SessionLocal
 request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=get_settings())),state=SimpleNamespace(request_id=uuid4()))
 with SessionLocal() as db: system_status(request,db)
 rows['direct_read']={'returned':True}
except Exception as error:
 code=getattr(getattr(error,'orig',None),'sqlstate',None)
 rows['direct_read']={'error_type':type(error).__name__,'sqlstate':code if isinstance(code,str) and len(code)==5 and code.isalnum() else None}
print(json.dumps(rows))
"""


class ValidationFailure(Exception):
    """Deliberately carries no response, command output, credential or DB error."""


def require(condition):
    if not condition:
        raise ValidationFailure()


class Commands:
    def __init__(self):
        self.last_failure = None

    def __call__(self, arguments, *, input_text=None, timeout=45):
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("COMPOSE_", "PRACTICE_"))
        }
        started = time.monotonic()
        operation = "docker"
        if arguments[:2] == ["docker", "compose"]:
            operation = next(("compose_" + verb for verb in ("up", "down", "exec", "config")
                              if verb in arguments), "compose")
        try:
            result = subprocess.run(
                arguments, input=input_text, env=env, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired:
            self.last_failure = {"operation": operation, "reason": "timeout", "limit_seconds": timeout,
                                 "elapsed_seconds": round(time.monotonic() - started, 2)}
            raise ValidationFailure() from None
        if result.returncode != 0 or len(result.stdout.encode()) > MAX_OUTPUT:
            self.last_failure = {"operation": operation, "reason": "exit" if result.returncode else "output_limit",
                                 "return_code": result.returncode,
                                 "elapsed_seconds": round(time.monotonic() - started, 2)}
            raise ValidationFailure()
        return result.stdout


def startup_diagnostics(command):
    """Read only fixed training identities and state, never config, commands or log bodies."""
    template = ('{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                '"purpose":{{json (index .Config.Labels "org.twinnku.purpose")}},'
                '"state":{{json .State.Status}},"exit_code":{{json .State.ExitCode}},'
                '"oom_killed":{{json .State.OOMKilled}},"pid":{{json .State.Pid}},'
                '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}')
    names = [f"{practice.PROJECT}-{service}-1" for service in sorted(practice.SERVICES)]
    rows = [json.loads(line) for line in command([
        "docker", "container", "inspect", "--format", template, *names,
    ]).splitlines() if line.strip()]
    require(len(rows) == len(names))
    for row in rows:
        require(row["name"].lstrip("/") in names and row["project"] == practice.PROJECT
                and row["purpose"] == "practice")
    return rows


def existing_practice_objects(command):
    found = {}
    for kind in ("container", "network", "volume"):
        listing = ["docker", kind, "ls", "-aq" if kind == "container" else "-q"]
        keys = set()
        for condition in (
            f"label=com.docker.compose.project={practice.PROJECT}",
            f"name={practice.PROJECT}",
        ):
            keys.update(command([*listing, "--filter", condition]).split())
        found[kind] = sorted(keys)
    return found


def require_no_practice_objects(command):
    require(not any(existing_practice_objects(command).values()))


def production_snapshot(command):
    # Narrow Go template: production environment, command, mounts and keys are
    # never retrieved, even into this maintenance process's memory.
    template = ('{"Id":{{json .Id}},"Name":{{json .Name}},'
                '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                '"state":{{json .State.Status}},"health":{{json .State.Health.Status}}}')
    raw = command(["docker", "container", "inspect", "--format", template, *PRODUCTION_NAMES.values()])
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    require(len(rows) == 3)
    result = {}
    for row in rows:
        role = row.get("service")
        require(role in PRODUCTION_NAMES)
        require(row.get("Name", "").removeprefix("/") == PRODUCTION_NAMES[role])
        require(row.get("project") == "twinnku")
        require(row["state"] == "running" and row["health"] == "healthy")
        result[role] = {"id": row["Id"], "state": row["state"], "health": "healthy"}
    require(set(result) == set(PRODUCTION_NAMES))
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValidationFailure()


class Browser:
    def __init__(self, port):
        require(1024 <= port <= 65535)
        self.origin = f"http://localhost:{port}"
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar), NoRedirect()
        )
        self.csrf = None
        self.last_failure = None

    def request(self, method, path, body=None, *, expected=200, csrf=True, origin=True, cookie=None):
        require(path.startswith(("/api/v1/", "/health/")) and ".." not in path)
        headers = {"Accept": "application/json"}
        if method not in {"GET", "HEAD"}:
            headers["Content-Type"] = "application/json"
            if origin:
                headers["Origin"] = self.origin if origin is True else origin
            if csrf and self.csrf:
                headers["X-CSRF-Token"] = self.csrf
        if cookie:
            headers["Cookie"] = cookie
        payload = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.origin + path, payload, headers, method=method)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        except OSError as error:
            self.last_failure = {"reason": "transport", "error_type": type(error).__name__}
            raise ValidationFailure() from None
        with response:
            if response.status != expected:
                self.last_failure = {"reason": "http_status", "status": response.status, "expected": expected}
                raise ValidationFailure()
            raw = response.read(MAX_OUTPUT + 1)
            if len(raw) > MAX_OUTPUT:
                self.last_failure = {"reason": "response_size"}
                raise ValidationFailure()
            try:
                data = json.loads(raw)
            except ValueError:
                self.last_failure = {"reason": "json_decode", "status": response.status}
                raise ValidationFailure() from None
            self.last_failure = None
            return data, response.headers

    def data(self, method, path, body=None, **kwargs):
        document, _ = self.request(method, path, body, **kwargs)
        if not isinstance(document, dict) or "data" not in document:
            self.last_failure = {"reason": "missing_envelope"}
            raise ValidationFailure()
        return document["data"]

    def login(self, username, password):
        data, headers = self.request("POST", "/api/v1/admin/auth/login", {
            "username": username, "password": password,
        })
        require("data" in data and "csrf_token" in data["data"])
        self.csrf = data["data"]["csrf_token"]
        require(data["data"]["mfa_enforced"] is False)
        cookies = list(self.jar)
        require(len(cookies) == 1 and cookies[0].name == COOKIE)
        attributes = headers.get("Set-Cookie", "").lower()
        require("httponly" in attributes and "samesite=strict" in attributes)
        require("path=/api/v1/admin" in attributes)
        return data["data"]

    def token(self):
        tokens = [cookie.value for cookie in self.jar if cookie.name == COOKIE]
        require(len(tokens) == 1)
        return tokens[0]


BOOTSTRAP = """
import getpass,sys
from app.modules.admin import bootstrap
getpass.getpass=lambda *args,**kwargs: sys.stdin.readline().rstrip('\\n')
sys.argv=['bootstrap','--username','practice-owner','--name','Practice validation owner']
bootstrap.main()
"""

DATABASE_PROBE = """
import hashlib,json
from uuid import UUID,uuid5
from app.database import engine
connection=engine.raw_connection()
try:
 raw=connection.driver_connection
 with raw.cursor() as cursor:
  cursor.execute('SELECT current_user,current_database()')
  user,database=cursor.fetchone()
  cursor.execute('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user')
  flags=cursor.fetchone()
  cursor.execute('SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')
  memberships=cursor.fetchone()[0]
  cursor.execute("SELECT has_schema_privilege(current_user,'public','CREATE'),has_database_privilege(current_user,current_database(),'CREATE'),has_table_privilege(current_user,'alembic_version','INSERT,UPDATE,DELETE')")
  privileges=cursor.fetchone()
  cursor.execute('SELECT count(*) FROM staff_users'); users=cursor.fetchone()[0]
  cursor.execute('SELECT count(*) FROM configurations'); configurations=cursor.fetchone()[0]
  cursor.execute('SELECT (SELECT count(*) FROM points)+(SELECT count(*) FROM maps)+(SELECT count(*) FROM floors)+(SELECT count(*) FROM panoramas)+(SELECT count(*) FROM experiences)'); business=cursor.fetchone()[0]
  cursor.execute("SELECT id,kind,scope,schema_version,revision,published_revision,state,draft,published,contributor_ids,submitted_by,submitted_sha256,resume_services,resume_stop_revisions FROM configurations WHERE kind='runtime'")
  baseline_rows=cursor.fetchall()
  baseline_valid=False; baseline=None
  if len(baseline_rows)==1:
   row=baseline_rows[0]
   expected_id=str(uuid5(UUID('176bca2c-678d-4e3c-98fd-aa66f32124ad'),'runtime-global'))
   encoded=json.dumps(row,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
   baseline={'id':row[0],'sha256':hashlib.sha256(encoded).hexdigest()}
   payload={'kind':'runtime'}
   digest=hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
   cursor.execute('SELECT event,revision,published_revision,content,content_sha256,actor_id,contributor_ids FROM configuration_versions WHERE configuration_id=%s',(expected_id,))
   history=cursor.fetchall()
   baseline_valid=(row==(expected_id,'runtime','global',1,1,1,'published',payload,payload,[],None,None,[],{}) and history==[('migration',1,1,payload,digest,None,[])])
  cursor.execute('SELECT COALESCE(sum(amount),0) FROM public_agent_counters'); counters=cursor.fetchone()[0]
  cursor.execute('SELECT COALESCE(sum(attempts),0) FROM narration_jobs'); attempts=cursor.fetchone()[0]
  cursor.execute('SELECT version_num FROM alembic_version'); heads=[row[0] for row in cursor.fetchall()]
 raw.rollback()
 denied=False
 try:
  with raw.cursor() as cursor: cursor.execute('CREATE TABLE public.practice_validation_forbidden (id integer)')
 except Exception as error:
  denied=getattr(error,'sqlstate',None)=='42501'
 finally: raw.rollback()
 print(json.dumps({'runtime_identity':user=='practice_runtime' and database=='twinnku_practice','role_minimal':not any(flags) and memberships==0 and not any(privileges),'ddl_denied':denied,'staff_count':users,'configuration_count':configurations,'business_row_count':business,'baseline_valid':baseline_valid,'migration_baseline':baseline,'supplier_counters':counters,'narration_attempts':attempts,'migration_heads':heads}))
finally: connection.close()
"""


class Acceptance:
    def __init__(self, directory, images, port, command=None):
        self.directory, self.images, self.port = directory, images, port
        self.command = command or Commands()
        self.root = None
        self.phase = "preflight"
        self.checks = {}
        self.before = None
        self.baseline = None
        self.startup_step = None
        self.startup_http_failure = None

    def compose(self, *arguments, input_text=None, timeout=45):
        return self.command([*practice.compose_command(self.root), *arguments],
                            input_text=input_text, timeout=timeout)

    def verify(self):
        practice.verify(self.root)

    def database(self, *, empty=False):
        self.verify()
        data = json.loads(self.compose("exec", "-T", "api", "python", "-c", DATABASE_PROBE))
        require(data["runtime_identity"] and data["role_minimal"] and data["ddl_denied"])
        require(data["supplier_counters"] == 0 and data["narration_attempts"] == 0)
        require(len(data["migration_heads"]) == 1)
        require(data["baseline_valid"] and data["business_row_count"] == 0)
        if self.baseline is None:
            self.baseline = data["migration_baseline"]
        require(data["migration_baseline"] == self.baseline)
        if empty:
            # 0013 always creates the deterministic historical runtime policy.
            # Empty training means no employees/presentation/business data, not
            # an absent migration baseline. Its identity/content must survive.
            require(data["staff_count"] == 0 and data["configuration_count"] == 1)
        return data

    def start(self):
        self.startup_step = "ownership-before-start"
        self.verify()
        self.startup_step = "compose-start"
        self.compose("up", "-d", "--wait", "--wait-timeout", "150", timeout=210)
        self.startup_step = "ownership-after-start"
        self.verify()
        browser = Browser(self.port)
        self.startup_step = "public-status"
        deadline = time.monotonic() + 45
        while True:
            try:
                status = browser.data("GET", "/api/v1/system/status")
                break
            except (OSError, ValidationFailure):
                self.startup_http_failure = getattr(browser, "last_failure", None)
                if time.monotonic() >= deadline:
                    raise ValidationFailure() from None
                time.sleep(1)
        self.startup_step = "fresh-status-contract"
        # Both starts have a fresh database. The public status intentionally
        # withholds the admin entry until bootstrap creates an active admin.
        require(status["environment"] == "practice" and status["capabilities"]["admin"] is False)
        require(status["capabilities"]["chat"] is False and status["capabilities"]["chat_embed"] is False)
        self.startup_step = "readiness"
        health, _ = browser.request("GET", "/health/ready")
        require(health["status"] == "ok")
        self.startup_step = "voice-disabled"
        voice, _ = browser.request("GET", "/api/v1/voice/status")
        require(voice["enabled"] is False)
        self.startup_step = "guest-disabled"
        browser.request("POST", "/api/v1/agent/guest", expected=503)
        self.checks["fresh_admin_entry_disabled"] = True
        self.startup_step = None
        return browser

    def reset(self):
        self.verify()
        self.compose("down", "--volumes", timeout=120)
        require_no_practice_objects(self.command)

    def accounts(self):
        owner_password = secrets.token_urlsafe(36)
        self.compose("exec", "-T", "api", "python", "-c", BOOTSTRAP,
                     input_text=owner_password + "\n" + owner_password + "\n", timeout=60)
        owner = Browser(self.port)
        require(owner.login("practice-owner", owner_password)["user"]["must_change_password"] is False)
        require(owner.data("GET", "/api/v1/system/status")["capabilities"]["admin"] is True)
        self.checks["bootstrapped_admin_entry_enabled"] = True
        created = {}
        for name in ("editor", "reviewer"):
            temporary, password = secrets.token_urlsafe(36), secrets.token_urlsafe(36)
            user = owner.data("POST", "/api/v1/admin/users", {
                "username": "practice-" + name, "display_name": "Practice validation " + name,
                "role": "admin", "campus_ids": [], "point_ids": [], "password": temporary,
            }, expected=201)
            browser = Browser(self.port)
            require(browser.login("practice-" + name, temporary)["user"]["must_change_password"] is True)
            browser.data("POST", "/api/v1/admin/auth/password", {
                "current_password": temporary, "new_password": password,
            })
            browser.request("GET", "/api/v1/admin/session", expected=401)
            require(browser.login("practice-" + name, password)["user"]["must_change_password"] is False)
            created[name] = (browser, user["id"])
        return owner, created

    def workflow(self, owner, accounts):
        editor, editor_id = accounts["editor"]
        reviewer, reviewer_id = accounts["reviewer"]
        anonymous = Browser(self.port)
        anonymous.request("GET", "/api/v1/admin/configurations", expected=401)
        for wrong_name in ("twinnku_staff", "__Secure-twinnku_staff"):
            anonymous.request("GET", "/api/v1/admin/session", expected=401,
                              cookie=f"{wrong_name}={editor.token()}")
        editor.request("POST", "/api/v1/admin/auth/logout", expected=403, csrf=False)
        editor.request("POST", "/api/v1/admin/auth/logout", expected=403, origin="https://2512921.cn")
        draft = {"kind": "presentation", "scope": "global", "operation_id": str(uuid4()),
                 "content": {"kind": "presentation", "site_name": "Disposable practice acceptance"}}
        editor.request("POST", "/api/v1/admin/configurations", draft, expected=403)
        for user_id, permissions in ((editor_id, ("configurations.edit", "configurations.review")),
                                     (reviewer_id, ("configurations.review",))):
            for permission in permissions:
                owner.data("PUT", f"/api/v1/admin/configuration-permissions/{user_id}/{permission}",
                           {"scope": "global", "enabled": True, "note": "Disposable validation grant"})
        item = editor.data("POST", "/api/v1/admin/configurations", draft)
        require(item["state"] == "draft" and item["published_revision"] == 0)
        require(item["published"] is None)

        def action(row):
            return {"expected_revision": row["revision"],
                    "expected_published_revision": row["published_revision"],
                    "operation_id": str(uuid4()), "note": "Disposable validation review"}

        submitted = editor.data("POST", f"/api/v1/admin/configurations/{item['id']}/submit", action(item))
        require(submitted["state"] == "in_review")
        denied, _ = editor.request("POST", f"/api/v1/admin/configurations/{item['id']}/publish",
                                   action(submitted), expected=403)
        require(denied["error"]["code"] == "SELF_REVIEW_DENIED")
        published = reviewer.data("POST", f"/api/v1/admin/configurations/{item['id']}/publish", action(submitted))
        require(published["state"] == "published" and published["published_revision"] == 1)
        require(published["published"]["site_name"] == draft["content"]["site_name"])
        controls = owner.data("GET", "/api/v1/admin/service-controls")
        for service in ("chat", "voice", "narration_generation"):
            require(controls["deployment_allowed"][service] is False)
        for field in ("chat_enabled", "voice_enabled", "narration_generation_enabled"):
            require(controls["effective"][field] is False)
        self.checks.update(real_bootstrap=True, people_api_and_password_change=True,
                           separate_cookie=True, wrong_cookie_rejected=True, origin_csrf_enforced=True,
                           anonymous_draft_rejected=True, no_implicit_configuration_grant=True,
                           self_review_rejected=True, independent_configuration_publish=True,
                           paid_services_disabled=True)
        return editor.token()

    def run(self):
        require(os.name == "posix")
        require(not any(os.environ.get(key) for key in ("DOCKER_HOST", "DOCKER_CONTEXT")))
        require(set(self.images) == {"API", "WEB", "DB"})
        require(all(re.fullmatch(r"sha256:[0-9a-f]{64}", value) for value in self.images.values()))
        original_command = practice.command
        practice.command = self.command
        passed = cleanup = preserved = False
        failure_phase = None
        failure_command = None
        failure_startup_step = None
        startup_http_probes = {}
        startup_services = []
        data = {}
        try:
            require_no_practice_objects(self.command)
            self.before = production_snapshot(self.command)
            self.phase = "initialize"
            self.root = practice.initialize(self.directory, self.images, self.port)
            self.phase = "initial-start"
            self.start()
            self.phase = "initial-database"
            self.database(empty=True)
            self.phase = "bootstrap-and-people-api"
            owner, accounts = self.accounts()
            self.phase = "configuration-review"
            old_token = self.workflow(owner, accounts)
            self.phase = "runtime-and-attempts"
            data = self.database()
            require(data["staff_count"] == 3 and data["configuration_count"] == 2)
            self.checks.update(runtime_role_minimal=True, runtime_ddl_denied=True, supplier_attempts_zero=True)
            self.phase = "reset"
            self.reset()
            self.phase = "fresh-start-after-reset"
            browser = self.start()
            self.phase = "empty-data-and-revoked-cookie"
            self.database(empty=True)
            browser.request("GET", "/api/v1/admin/session", expected=401, cookie=f"{COOKIE}={old_token}")
            self.checks.update(reset_removes_training_data=True, fresh_up_no_training_content=True,
                               migration_baseline_unchanged=True, old_session_rejected=True)
            passed = True
        except Exception:
            failure_phase = self.phase
            failure_command = getattr(self.command, "last_failure", None)
            if self.phase in {"initial-start", "fresh-start-after-reset"}:
                failure_startup_step = self.startup_step
                try:
                    startup_services = startup_diagnostics(self.command)
                    if any(row["name"] == "/twinnku-practice-api-1" and row["state"] == "running"
                           for row in startup_services):
                        startup_http_probes = json.loads(self.compose(
                            "exec", "-T", "api", "python", "-c", STARTUP_HTTP_PROBE, timeout=45,
                        ))
                except Exception:
                    pass
        finally:
            if self.root is not None:
                try:
                    self.phase = "final-owned-cleanup"
                    self.reset()
                    cleanup = True
                except Exception:
                    failure_phase = failure_phase or self.phase
            try:
                self.phase = "production-identity-health"
                preserved = self.before is not None and production_snapshot(self.command) == self.before
                require(preserved)
            except Exception:
                failure_phase = failure_phase or self.phase
            practice.command = original_command
        receipt = {"status": "passed" if passed and cleanup and preserved else "failed",
                   "failure_phase": failure_phase, "images": self.images, "project": practice.PROJECT,
                   "failure_command": failure_command, "startup_services": startup_services,
                   "failure_startup_step": failure_startup_step,
                   "failure_http": self.startup_http_failure, "startup_http_probes": startup_http_probes,
                   "production_before": self.before, "production_unchanged": preserved,
                   "cleanup_verified": cleanup, "checks": self.checks,
                   "migration_heads": data.get("migration_heads", []),
                   "migration_baseline": self.baseline,
                   "account_roles": "three disposable administrators; scoped role matrix not exercised",
                   "real_supplier_called": False, "browser_device_validated": False,
                   "production_mfa_validated": False}
        if self.root is not None:
            descriptor = os.open(self.root / "validation-receipt.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(receipt, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--api-image", required=True)
    parser.add_argument("--web-image", required=True)
    parser.add_argument("--db-image", required=True)
    parser.add_argument("--port", type=int, default=8098)
    arguments = parser.parse_args()
    try:
        receipt = Acceptance(arguments.directory, {"API": arguments.api_image, "WEB": arguments.web_image,
                                                   "DB": arguments.db_image}, arguments.port).run()
        print(json.dumps({"status": receipt["status"], "failure_phase": receipt["failure_phase"],
                          "cleanup_verified": receipt["cleanup_verified"],
                          "production_unchanged": receipt["production_unchanged"]}))
        return 0 if receipt["status"] == "passed" else 1
    except Exception:
        print(json.dumps({"status": "failed", "failure_phase": "preflight-or-receipt", "details_logged": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
