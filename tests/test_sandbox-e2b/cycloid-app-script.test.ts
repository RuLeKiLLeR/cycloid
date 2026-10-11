import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "apps/sandbox-e2b/scripts/cycloid-app");
const PYTHON_TIMEOUT_MS = 10_000;

vi.setConfig({ testTimeout: 15_000 });

function runPython(source: string): string {
  const result = spawnSync("python3", ["-c", source], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, SCRIPT_PATH },
    timeout: PYTHON_TIMEOUT_MS,
  });
  const diagnostics = [
    result.error ? `${result.error.name}: ${result.error.message}` : null,
    result.stderr,
    result.stdout,
  ]
    .filter(Boolean)
    .join("\n");
  expect(result.status, diagnostics).toBe(0);
  return result.stdout;
}

describe("cycloid-app script", () => {
  it("loads appRuntime from .cycloid.json when no injected contract is present", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

original_cwd = os.getcwd()
original_contract = os.environ.pop("ARCANIST_PREVIEW_CONTRACT_JSON", None)
try:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / ".cycloid.json").write_text(json.dumps({
            "appRuntime": {
                "kind": "web",
                "runner": "docker",
                "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
                "url": {"hostPort": 5173},
                "additionalPorts": [{"service": "api", "hostPort": 3000, "containerPort": 3000}],
            }
        }), encoding="utf-8")
        subdir = root / "apps" / "ui"
        subdir.mkdir(parents=True)
        os.chdir(subdir)

        contract = module.load_preview_contract()

        assert contract["cwd"] == str(root.resolve()), contract
        assert contract["entry"]["service"] == "web", contract
        assert contract["additionalPorts"] == [{"service": "api", "hostPort": 3000, "containerPort": 3000}], contract
finally:
    os.chdir(original_cwd)
    if original_contract is not None:
        os.environ["ARCANIST_PREVIEW_CONTRACT_JSON"] = original_contract
`);
  });

  it("generates compose env and reuses contracts by generation spec", () => {
    runPython(`
import os
import re
from importlib.machinery import SourceFileLoader
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

spec = {"DOGFOOD_SESSION_TOKEN": {"type": "hex", "bytes": 32}}
first = module.generated_compose_env(spec)["DOGFOOD_SESSION_TOKEN"]
second = module.generated_compose_env(spec)["DOGFOOD_SESSION_TOKEN"]

assert re.fullmatch(r"[0-9a-f]{64}", first), first
assert re.fullmatch(r"[0-9a-f]{64}", second), second
assert first != second

requested = {
    "cwd": "/workspace/repo",
    "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
    "env": {},
    "generatedComposeEnv": spec,
    "url": {"hostPort": 3000},
}
existing = {**requested, "composeEnv": {"DOGFOOD_SESSION_TOKEN": first}, "portMapping": {"containerPort": 3000}}
changed_spec = {**requested, "generatedComposeEnv": {"DOGFOOD_SESSION_TOKEN": {"type": "hex", "bytes": 16}}}

assert module.can_reuse_started_contract(existing, requested) is True
assert module.can_reuse_started_contract(existing, changed_spec) is False
`);
  });

  it("fails fast when docker info hangs", () => {
    runPython(`
import os
from importlib.machinery import SourceFileLoader
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

def fake_run(command, **kwargs):
    assert command == ["docker", "info"], command
    assert kwargs["timeout"] == module.DOCKER_INFO_TIMEOUT_SECONDS, kwargs
    raise module.subprocess.TimeoutExpired(command, kwargs["timeout"])

module.subprocess.run = fake_run

try:
    module.ensure_docker_ready({})
    raise AssertionError("ensure_docker_ready unexpectedly succeeded")
except RuntimeError as err:
    text = str(err)

assert "Timed out after" in text, text
assert "docker info" in text, text
assert "preview app cannot start" in text, text
`);
  });

  it("fails fast when start-dockerd hangs", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

class Completed:
    def __init__(self, returncode):
        self.returncode = returncode

with tempfile.TemporaryDirectory() as directory:
    start_script = Path(directory) / "start-dockerd.sh"
    start_script.write_text("#!/bin/sh\\n", encoding="utf-8")
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        if command == ["docker", "info"]:
            assert kwargs["timeout"] == module.DOCKER_INFO_TIMEOUT_SECONDS, kwargs
            return Completed(1)
        if command == [str(start_script)]:
            assert kwargs["timeout"] == module.DOCKERD_START_TIMEOUT_SECONDS, kwargs
            raise module.subprocess.TimeoutExpired(command, kwargs["timeout"])
        raise AssertionError(f"unexpected command: {command}")

    module.subprocess.run = fake_run

    try:
        module.ensure_docker_ready({}, start_script=start_script)
        raise AssertionError("ensure_docker_ready unexpectedly succeeded")
    except RuntimeError as err:
        text = str(err)

assert len(calls) == 2, calls
assert "start-dockerd.sh" in text, text
assert "preview app cannot start" in text, text
`);
  });

  it("does not reuse a healthy preview when runtime env changed", () => {
    runPython(`
import os
from importlib.machinery import SourceFileLoader
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

base = {
    "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
    "env": {},
    "composeEnv": {"ARCANIST_LOGIN_USERNAME": "old", "ARCANIST_LOGIN_PASSWORD": "old-pass"},
    "url": {"hostPort": 3000},
    "cwd": "/workspace/repo",
    "portMapping": {"containerPort": 3000},
}
same_runtime = {**base, "portMapping": {"containerPort": 8080}}
changed_cwd = {**base, "cwd": "/tmp/base-worktree"}
changed_env = {
    **base,
    "composeEnv": {"ARCANIST_LOGIN_USERNAME": "new", "ARCANIST_LOGIN_PASSWORD": "new-pass"},
}

assert module.can_reuse_started_contract(base, same_runtime) is True
assert module.can_reuse_started_contract(base, changed_cwd) is False
assert module.can_reuse_started_contract(base, changed_env) is False
`);
  });

  it("attaches to a bridge-booted stack instead of env-recycling it when the shell has no contract env", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    # Bridge-resolved started contract: carries platform-injected composeEnv.
    repo_resolved = str((Path(directory) / "repo").resolve())
    existing = {
        "cwd": repo_resolved,
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": [".cycloid/docker-compose.yml"], "service": "web"},
        "env": {},
        "composeEnv": {"MIA_ANTHROPIC_API_KEY": "real-secret-value"},
        "url": {"hostPort": 3300},
    }
    contract_path = Path(directory) / "contract.json"
    contract_path.write_text(json.dumps(existing), encoding="utf-8")

    # Agent shell: no contract env; committed .cycloid.json has no composeEnv.
    repo = Path(directory) / "repo"
    repo.mkdir()
    (repo / ".cycloid.json").write_text(json.dumps({
        "appRuntime": {
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": [".cycloid/docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3300},
        }
    }), encoding="utf-8")
    os.environ.pop("ARCANIST_PREVIEW_CONTRACT_JSON", None)
    os.chdir(repo)

    module.wait_for_runtime_readiness = lambda _verb: "ready"
    module.is_app_healthy = lambda _contract: True
    def no_request(**_kwargs):
        raise AssertionError("attachable ready stack must not trigger a boot request")
    module.request_managed_runtime_boot = no_request
    starts = []
    module.start_preview = lambda contract, _timeout, _contract_out: starts.append(contract) or contract

    import contextlib
    import io
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        code = module.cmd_start(SimpleNamespace(contract_out=str(contract_path), timeout=1))

    # Must ATTACH (reuse the credential-bearing stack), never recycle it.
    assert code == 0
    assert starts == [], starts
    # The resolved composeEnv (secret values) must not reach agent-visible stdout.
    printed = stdout.getvalue()
    assert "real-secret-value" not in printed, printed
    assert json.loads(printed).get("composeEnv") is None
`);
  });

  it("still recycles on structural changes even without contract env", () => {
    runPython(`
import json
import os
from importlib.machinery import SourceFileLoader
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

resolved = {
    "cwd": "/workspace/repo",
    "entry": {"type": "compose", "files": [".cycloid/docker-compose.yml"], "service": "web"},
    "env": {},
    "composeEnv": {"SECRET": "value"},
    "url": {"hostPort": 3300},
}
# Committed .cycloid.json: no composeEnv, env absent entirely.
committed_same_shape = {k: v for k, v in resolved.items() if k not in ("composeEnv", "env")}
committed_other_worktree = {**committed_same_shape, "cwd": "/tmp/base-worktree"}
committed_other_entry = {**committed_same_shape, "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "api"}}
committed_changed_env = {**committed_same_shape, "env": {"FEATURE_FLAG": "on"}}

# composeEnv-only difference: attach (absent env == resolved empty env)
assert module.can_reuse_started_contract(resolved, committed_same_shape, ignore_env_inputs=True) is True
# Server sanitizer drops url.path "/" while the committed file keeps it (real
# incident: session e92c3000 recycled a credentialed stack over this). Only
# hostPort identifies the container.
server_url_no_path = {**resolved, "url": {"hostPort": 3300}}
committed_url_with_path = {**committed_same_shape, "url": {"hostPort": 3300, "path": "/"}}
assert module.can_reuse_started_contract(server_url_no_path, committed_url_with_path, ignore_env_inputs=True) is True
committed_other_port = {**committed_same_shape, "url": {"hostPort": 4400}}
assert module.can_reuse_started_contract(server_url_no_path, committed_other_port, ignore_env_inputs=True) is False
# structural differences still force a restart
assert module.can_reuse_started_contract(resolved, committed_other_worktree, ignore_env_inputs=True) is False
assert module.can_reuse_started_contract(resolved, committed_other_entry, ignore_env_inputs=True) is False
# committed-visible env changes still force a restart even without contract env
assert module.can_reuse_started_contract(resolved, committed_changed_env, ignore_env_inputs=True) is False
# default comparison unchanged: composeEnv difference still recycles for contract-bearing callers
assert module.can_reuse_started_contract(resolved, committed_same_shape) is False
`);
  });

  it("writes a key-name-only runtime env manifest", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    module.RUNTIME_ENV_MANIFEST_PATH = Path(directory) / "evidence" / "runtime-env-manifest.json"
    os.environ["ARCANIST_PREVIEW_CONTRACT_JSON"] = "{}"
    module._write_runtime_env_manifest({"MIA_ANTHROPIC_API_KEY": "secret-value", "PORT": "3300"})
    manifest = json.loads(module.RUNTIME_ENV_MANIFEST_PATH.read_text(encoding="utf-8"))
    assert manifest["source"] == "contract_env"
    assert manifest["composeEnvKeys"] == ["MIA_ANTHROPIC_API_KEY", "PORT"]
    assert "secret-value" not in module.RUNTIME_ENV_MANIFEST_PATH.read_text(encoding="utf-8")

    os.environ.pop("ARCANIST_PREVIEW_CONTRACT_JSON", None)
    module._write_runtime_env_manifest({})
    manifest = json.loads(module.RUNTIME_ENV_MANIFEST_PATH.read_text(encoding="utf-8"))
    assert manifest["source"] == "committed_fallback"
`);
  });

  it("request_managed_runtime_boot acknowledges when readiness appears and times out otherwise", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

assert str(module.RUNTIME_BOOT_REQUEST_PATH) == "/tmp/cycloid-runtime-boot-request.json"

with tempfile.TemporaryDirectory() as directory:
    request = Path(directory) / "boot-request.json"
    readiness = Path(directory) / "readiness.json"

    clock = {"t": 0.0}
    def fake_now():
        return clock["t"]
    def answering_sleep(seconds):
        clock["t"] += seconds
        readiness.write_text(json.dumps({"state": "starting", "startedAt": 0, "deadline": 10_000}), encoding="utf-8")

    ok = module.request_managed_runtime_boot(
        path=request, readiness_path=readiness, handshake_seconds=5.0, now=fake_now, sleep=answering_sleep,
    )
    assert ok is True
    # The trigger file carries no secrets -- a bare timestamp only.
    assert set(json.loads(request.read_text(encoding="utf-8")).keys()) == {"requestedAt"}

    readiness.unlink()
    request.unlink()
    clock["t"] = 0.0
    def silent_sleep(seconds):
        clock["t"] += seconds
    ok = module.request_managed_runtime_boot(
        path=request, readiness_path=readiness, handshake_seconds=1.0, now=fake_now, sleep=silent_sleep,
    )
    assert ok is False

    # A stale terminal record from the PREVIOUS boot is not an acknowledgment:
    # only a CHANGED record (bridge re-arming) counts, else a retry joins the
    # old failed state while the bridge boots concurrently.
    stale = {"state": "failed", "startedAt": 1, "deadline": 2, "error": "old"}
    readiness.write_text(json.dumps(stale), encoding="utf-8")
    clock["t"] = 0.0
    ok = module.request_managed_runtime_boot(
        path=request, readiness_path=readiness, handshake_seconds=1.0, now=fake_now, sleep=silent_sleep,
    )
    assert ok is False

    clock["t"] = 0.0
    def rearming_sleep(seconds):
        clock["t"] += seconds
        readiness.write_text(json.dumps({"state": "starting", "startedAt": 99, "deadline": 10_000}), encoding="utf-8")
    ok = module.request_managed_runtime_boot(
        path=request, readiness_path=readiness, handshake_seconds=5.0, now=fake_now, sleep=rearming_sleep,
    )
    assert ok is True
`);
  });

  it("cmd_start re-requests the managed boot when readiness says ready but the stack is gone", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop("ARCANIST_PREVIEW_CONTRACT_JSON", None)
os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    repo = (Path(directory) / "repo")
    repo.mkdir()
    repo = repo.resolve()
    (repo / ".cycloid.json").write_text(json.dumps({
        "appRuntime": {
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3300},
        }
    }), encoding="utf-8")
    os.chdir(repo)

    readiness = Path(directory) / "readiness.json"
    # Stale ready: previous managed boot succeeded, then the app was stopped or
    # crashed (contract file gone, app unhealthy) without clearing readiness.
    readiness.write_text(json.dumps({"state": "ready", "startedAt": 1, "deadline": 10_000}), encoding="utf-8")
    module.RUNTIME_READINESS_PATH = readiness
    contract_path = Path(directory) / "contract.json"

    state = {"healthy": False, "requests": 0}
    module.is_app_healthy = lambda _contract: state["healthy"]

    def fake_request(**_kwargs):
        state["requests"] += 1
        state["healthy"] = True
        readiness.write_text(json.dumps({"state": "ready", "startedAt": 99, "deadline": 10_000}), encoding="utf-8")
        contract_path.write_text(json.dumps({
            "cwd": str(repo),
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "composeEnv": {"SECRET": "value"},
            "url": {"hostPort": 3300},
        }), encoding="utf-8")
        return True

    module.request_managed_runtime_boot = fake_request
    def no_boot(*_args, **_kwargs):
        raise AssertionError("start_preview must not run when the bridge answered")
    module.start_preview = no_boot

    code = module.cmd_start(SimpleNamespace(contract_out=str(contract_path), timeout=1))
    assert code == 0
    assert state["requests"] == 1
`);
  });

  it("cmd_start in an agent shell requests the managed boot and attaches to the answered boot", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop("ARCANIST_PREVIEW_CONTRACT_JSON", None)
os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    repo = (Path(directory) / "repo")
    repo.mkdir()
    repo = repo.resolve()
    (repo / ".cycloid.json").write_text(json.dumps({
        "appRuntime": {
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3300},
        }
    }), encoding="utf-8")
    os.chdir(repo)

    readiness = Path(directory) / "readiness.json"
    module.RUNTIME_READINESS_PATH = readiness
    contract_path = Path(directory) / "contract.json"
    resolved = {
        "cwd": str(repo),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "composeEnv": {"DECLARED_SECRET": "real-value"},
        "url": {"hostPort": 3300},
    }

    requests = {"n": 0}
    def fake_request(**_kwargs):
        # Simulate the bridge answering: readiness goes ready, resolved contract lands.
        requests["n"] += 1
        readiness.write_text(json.dumps({"state": "ready", "startedAt": 0, "deadline": 10_000}), encoding="utf-8")
        contract_path.write_text(json.dumps(resolved), encoding="utf-8")
        return True

    module.request_managed_runtime_boot = fake_request
    module.is_app_healthy = lambda _contract: True
    def no_boot(*_args, **_kwargs):
        raise AssertionError("start_preview must not run when the bridge answered the request")
    module.start_preview = no_boot

    code = module.cmd_start(SimpleNamespace(contract_out=str(contract_path), timeout=1))
    assert code == 0
    assert requests["n"] == 1
`);
  });

  it("cmd_start does not request the managed boot for boot owners or contract-bearing callers", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

def forbidden(**_kwargs):
    raise AssertionError("request_managed_runtime_boot must not be called")
module.request_managed_runtime_boot = forbidden
module.is_app_healthy = lambda _contract: True

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory).resolve()
    module.RUNTIME_READINESS_PATH = Path(directory) / "readiness.json"
    contract = {
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3300},
    }
    contract_path = Path(directory) / "contract.json"
    contract_path.write_text(json.dumps(contract), encoding="utf-8")

    # Contract-bearing caller (bridge boot path).
    os.environ["ARCANIST_PREVIEW_CONTRACT_JSON"] = json.dumps(contract)
    os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
    assert module.cmd_start(SimpleNamespace(contract_out=str(contract_path), timeout=1)) == 0

    # Boot owner without contract env.
    os.environ.pop("ARCANIST_PREVIEW_CONTRACT_JSON", None)
    os.environ[module.RUNTIME_BOOT_OWNER_ENV] = "1"
    (cwd / ".cycloid.json").write_text(json.dumps({"appRuntime": contract}), encoding="utf-8")
    os.chdir(cwd)
    assert module.cmd_start(SimpleNamespace(contract_out=str(contract_path), timeout=1)) == 0
    os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
`);
  });

  it("publishes additional service ports in the compose override", () => {
    runPython(`
import os
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

override_path = module.write_override_file(
    "web",
    3001,
    3001,
    {"FRONTEND_URL": "http://127.0.0.1:3001"},
    [{"service": "server", "hostPort": 3000, "containerPort": 3000}],
)
text = Path(override_path).read_text(encoding="utf-8")
expected = "\\n".join([
    "services:",
    "  web:",
    "    ports: !override",
    '      - "3001:3001"',
    "    environment:",
    '      FRONTEND_URL: "http://127.0.0.1:3001"',
    "  server:",
    "    ports: !override",
    '      - "3000:3000"',
    "",
])
assert text == expected, text
assert "network_mode: host" not in text
`);
  });

  it("clears unmanaged compose service host ports in the compose override", () => {
    runPython(`
import os
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

override_path = module.write_override_file(
    "web",
    3300,
    3000,
    {},
    None,
    ["api"],
)
text = Path(override_path).read_text(encoding="utf-8")
expected = "\\n".join([
    "services:",
    "  web:",
    "    ports: !override",
    '      - "3300:3000"',
    "  api:",
    "    ports: !override []",
    "",
])
assert text == expected, text
`);
  });

  it("does not reuse a healthy preview when the requested cwd changed", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    contract_path = Path(directory) / "contract.json"
    existing = {
        "cwd": "/tmp/base-worktree",
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "env": {},
        "composeEnv": {},
        "url": {"hostPort": 3308},
    }
    requested = {**existing, "cwd": "/repo"}
    contract_path.write_text(json.dumps(existing), encoding="utf-8")
    os.environ["ARCANIST_PREVIEW_CONTRACT_JSON"] = json.dumps(requested)
    starts = []

    module.is_app_healthy = lambda _contract: True
    module.start_preview = lambda contract, _timeout, _contract_out: starts.append(contract) or {**contract, "portMapping": {"containerPort": 3308}}

    code = module.cmd_start(SimpleNamespace(contract_out=str(contract_path), timeout=1))

    assert code == 0
    assert starts == [requested], starts
`);
  });

  it("starts additional port services and records resolved ports", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n  server:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    commands = []

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {
        "services": {
            "web": {"ports": [{"published": "3001", "target": 3001}]},
            "server": {"ports": [{"target": 3000}]},
        }
    }
    class Completed:
        returncode = 0

    module.preview_project_has_resources = lambda *_args, **_kwargs: False
    module.run_logged_result = lambda command, *_args, **_kwargs: commands.append(command) or Completed()
    module.wait_until_ready = lambda *_args, **_kwargs: None

    module.start_preview(
        {
            "cwd": str(cwd),
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3001},
            "additionalPorts": [{"service": "server", "hostPort": 3000}],
        },
        1,
        out_path,
    )

    assert commands[0][-5:] == ["up", "--build", "-d", "web", "server"], commands
    started = json.loads(out_path.read_text(encoding="utf-8"))
    assert started["additionalPorts"] == [{"service": "server", "hostPort": 3000, "containerPort": 3000}], started
`);
  });

  it("stops a partial startup by falling back to the input runtime contract", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    contract = {
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3002},
    }
    os.environ["ARCANIST_PREVIEW_CONTRACT_JSON"] = json.dumps(contract)
    commands = []

    class Completed:
        returncode = 0

    def fake_run(command, **kwargs):
        commands.append((command, kwargs))
        return Completed()

    module.subprocess.run = fake_run
    module.cleanup_preview_project = lambda *_args, **_kwargs: True

    code = module.cmd_stop(SimpleNamespace(contract_out=str(cwd / "missing-contract.json")))

    assert code == 0
    assert len(commands) == 1, commands
    command, kwargs = commands[0]
    assert command[-3:] == ["down", "--volumes", "--remove-orphans"], command
    assert "-f" in command and str((cwd / "docker-compose.yml").resolve()) in command, command
    assert kwargs["env"]["COMPOSE_PROJECT_NAME"] == "cycloid-preview-3002"
`);
  });

  it("keeps the contract file when stop cleanup fails", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    contract_path = cwd / "contract.json"
    contract_path.write_text(json.dumps({
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3300},
    }), encoding="utf-8")

    class Completed:
        returncode = 1

    module.run_logged_result = lambda *_args, **_kwargs: Completed()
    module.cleanup_preview_project = lambda *_args, **_kwargs: False

    code = module.cmd_stop(SimpleNamespace(contract_out=str(contract_path)))

    assert code == 1
    assert contract_path.exists(), "failed cleanup must preserve the contract for retry/diagnostics"
`);
  });

  it("removes the contract file when stop cleanup succeeds", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    contract_path = cwd / "contract.json"
    contract_path.write_text(json.dumps({
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3301},
    }), encoding="utf-8")

    class Completed:
        returncode = 1

    module.run_logged_result = lambda *_args, **_kwargs: Completed()
    module.cleanup_preview_project = lambda *_args, **_kwargs: True

    code = module.cmd_stop(SimpleNamespace(contract_out=str(contract_path)))

    assert code == 0
    assert not contract_path.exists(), "successful cleanup should remove the started contract"
`);
  });

  it("does not run targeted cleanup after compose down succeeds", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    contract_path = cwd / "contract.json"
    contract_path.write_text(json.dumps({
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3306},
    }), encoding="utf-8")
    cleanups = []

    class Completed:
        returncode = 0

    module.run_logged_result = lambda *_args, **_kwargs: Completed()
    module.cleanup_preview_project = lambda project, *_args, **_kwargs: cleanups.append(project) or False

    code = module.cmd_stop(SimpleNamespace(contract_out=str(contract_path)))

    assert code == 0
    assert cleanups == [], cleanups
    assert not contract_path.exists(), "successful compose down should remove the started contract"
`);
  });

  it("falls back to targeted cleanup when stop cannot resolve compose artifacts", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    missing_cwd = cwd / "deleted-worktree"
    contract_path = cwd / "contract.json"
    contract_path.write_text(json.dumps({
        "cwd": str(missing_cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3308},
    }), encoding="utf-8")
    cleanups = []

    module.cleanup_preview_project = lambda project, cleanup_cwd, env, _log_path: cleanups.append((project, cleanup_cwd, env["COMPOSE_PROJECT_NAME"])) or True
    module.resolve_compose_artifacts = lambda _started: (_ for _ in ()).throw(RuntimeError("compose files missing"))

    code = module.cmd_stop(SimpleNamespace(contract_out=str(contract_path)))

    assert code == 0
    assert cleanups == [("cycloid-preview-3308", Path(os.getcwd()).resolve(), "cycloid-preview-3308")], cleanups
    assert not contract_path.exists(), "successful fallback cleanup should remove the stuck contract"
`);
  });

  it("retries startup once after a container-name conflict", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    Path("/tmp/cycloid-preview-3302.log").unlink(missing_ok=True)
    attempts = []
    cleanups = []

    class Completed:
        def __init__(self, returncode):
            self.returncode = returncode

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {"services": {"web": {"ports": [{"published": "3302", "target": 8080}]}}}
    module.preview_project_has_resources = lambda *_args, **_kwargs: False
    module.cleanup_preview_project = lambda project, *_args, **_kwargs: cleanups.append(project) or True
    module.wait_until_ready = lambda *_args, **_kwargs: None

    def fake_run_logged_result(command, _cwd, _env, log_path):
        attempts.append(command)
        if len(attempts) == 1:
            with Path(log_path).open("a", encoding="utf-8") as log_file:
                log_file.write('container name "/cycloid-preview-3302-redis-1" is already in use')
            return Completed(1)
        return Completed(0)

    module.run_logged_result = fake_run_logged_result

    module.start_preview({
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3302},
    }, 1, out_path)

    assert len(attempts) == 2, attempts
    assert cleanups == ["cycloid-preview-3302"], cleanups
`);
  });

  it("retries startup once after an ambiguous network", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    Path("/tmp/cycloid-preview-3303.log").unlink(missing_ok=True)
    attempts = []
    cleanups = []

    class Completed:
        def __init__(self, returncode):
            self.returncode = returncode

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {"services": {"web": {"ports": [{"published": "3303", "target": 8080}]}}}
    module.preview_project_has_resources = lambda *_args, **_kwargs: False
    module.cleanup_preview_project = lambda project, *_args, **_kwargs: cleanups.append(project) or True
    module.wait_until_ready = lambda *_args, **_kwargs: None

    def fake_run_logged_result(command, _cwd, _env, log_path):
        attempts.append(command)
        if len(attempts) == 1:
            with Path(log_path).open("a", encoding="utf-8") as log_file:
                log_file.write("network cycloid-preview-3303_default is ambiguous (2 matches found on name)")
            return Completed(1)
        return Completed(0)

    module.run_logged_result = fake_run_logged_result

    module.start_preview({
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3303},
    }, 1, out_path)

    assert len(attempts) == 2, attempts
    assert cleanups == ["cycloid-preview-3303"], cleanups
`);
  });

  it("cleans existing preview resources before docker compose up", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    events = []
    previous_project_name = os.environ.get("COMPOSE_PROJECT_NAME")
    os.environ["COMPOSE_PROJECT_NAME"] = "custom-preview-project"

    class Completed:
        returncode = 0

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {"services": {"web": {"ports": [{"published": "3305", "target": 8080}]}}}
    module.preview_project_has_resources = lambda *_args, **_kwargs: True
    module.cleanup_preview_project = lambda project, *_args, **_kwargs: events.append(f"cleanup:{project}") or True
    module.run_logged_result = lambda command, *_args, **_kwargs: events.append("up") or Completed()
    module.wait_until_ready = lambda *_args, **_kwargs: None

    try:
        module.start_preview({
            "cwd": str(cwd),
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3305},
        }, 1, out_path)
    finally:
        if previous_project_name is None:
            os.environ.pop("COMPOSE_PROJECT_NAME", None)
        else:
            os.environ["COMPOSE_PROJECT_NAME"] = previous_project_name

    assert events == ["cleanup:custom-preview-project", "up"], events
`);
  });

  it("cleanup targets only the current preview project", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    log_path = cwd / "cleanup.log"
    remove_commands = []
    containers = {"container-label", "container-prefix", "container-underscore", "container-other", "container-unrelated"}
    networks = {"network-label", "network-a", "network-b", "network-other"}
    volumes = {"volume-label", "cycloid-preview-3300_db-data", "cycloid-preview-3300-cache", "cycloid-preview-3301_db-data"}

    class Completed:
        def __init__(self, stdout="", returncode=0):
            self.returncode = returncode
            self.stdout = stdout

    def json_lines(entries):
        return "\\n".join(json.dumps(entry) for entry in entries) + "\\n"

    def fake_run(command, **_kwargs):
        if command[:4] == ["docker", "container", "ls", "-a"] and "-q" in command:
            return Completed("container-label\\n" if "container-label" in containers else "")
        if command[:4] == ["docker", "container", "ls", "-a"] and "--format" in command:
            entries = []
            if "container-prefix" in containers:
                entries.append({"ID": "container-prefix", "Names": "cycloid-preview-3300-web-1"})
            if "container-underscore" in containers:
                entries.append({"ID": "container-underscore", "Names": "cycloid-preview-3300_redis_1"})
            if "container-other" in containers:
                entries.append({"ID": "container-other", "Names": "cycloid-preview-3301-web-1"})
            if "container-unrelated" in containers:
                entries.append({"ID": "container-unrelated", "Names": "customer-app-web-1"})
            return Completed(json_lines(entries))
        if command[:3] == ["docker", "network", "ls"] and "-q" in command:
            return Completed("network-label\\n" if "network-label" in networks else "")
        if command[:3] == ["docker", "network", "ls"] and "--format" in command:
            entries = []
            if "network-a" in networks:
                entries.append({"ID": "network-a", "Name": "cycloid-preview-3300_default"})
            if "network-b" in networks:
                entries.append({"ID": "network-b", "Name": "cycloid-preview-3300-default"})
            if "network-other" in networks:
                entries.append({"ID": "network-other", "Name": "cycloid-preview-3301_default"})
            return Completed(json_lines(entries))
        if command[:3] == ["docker", "volume", "ls"] and "-q" in command:
            return Completed("volume-label\\n" if "volume-label" in volumes else "")
        if command[:3] == ["docker", "volume", "ls"] and "--format" in command:
            entries = []
            if "cycloid-preview-3300_db-data" in volumes:
                entries.append({"Name": "cycloid-preview-3300_db-data"})
            if "cycloid-preview-3300-cache" in volumes:
                entries.append({"Name": "cycloid-preview-3300-cache"})
            if "cycloid-preview-3301_db-data" in volumes:
                entries.append({"Name": "cycloid-preview-3301_db-data"})
            return Completed(json_lines(entries))
        if command[:3] == ["docker", "container", "rm"]:
            remove_commands.append(command)
            containers.difference_update(command[4:])
            return Completed("")
        if command[:3] == ["docker", "network", "rm"]:
            remove_commands.append(command)
            networks.difference_update(command[3:])
            return Completed("")
        if command[:3] == ["docker", "volume", "rm"]:
            remove_commands.append(command)
            volumes.difference_update(command[3:])
            return Completed("")
        raise AssertionError(f"unexpected command: {command}")

    module.subprocess.run = fake_run

    assert module.cleanup_preview_project("cycloid-preview-3300", cwd, {}, log_path) is True

    flat = " ".join(" ".join(command) for command in remove_commands)
    assert "container-label" in flat and "container-prefix" in flat and "container-underscore" in flat, flat
    assert "network-label" in flat and "network-a" in flat and "network-b" in flat, flat
    assert "cycloid-preview-3300_db-data" in flat and "cycloid-preview-3300-cache" in flat, flat
    assert "container-other" not in flat and "network-other" not in flat and "cycloid-preview-3301_db-data" not in flat, flat
    assert "customer-app" not in flat, flat
    assert remove_commands[0][:3] == ["docker", "container", "rm"], remove_commands
`);
  });

  it("treats already removed cleanup resources as success when final discovery is empty", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    log_path = cwd / "cleanup.log"
    discovery_count = [0]

    class Completed:
        def __init__(self, stdout="", returncode=0):
            self.returncode = returncode
            self.stdout = stdout

    def fake_resource_ids(project, _cwd, _env, _log_path):
        discovery_count[0] += 1
        if discovery_count[0] <= 2:
            return {"container": set(), "network": {"network-stale"}, "volume": set()}
        return {"container": set(), "network": set(), "volume": set()}

    def fake_run(command, **_kwargs):
        if command[:3] == ["docker", "network", "rm"]:
            return Completed("Error response from daemon: No such network: network-stale", 1)
        raise AssertionError(f"unexpected command: {command}")

    module.preview_project_resource_ids = fake_resource_ids
    module.subprocess.run = fake_run

    assert module.cleanup_preview_project("cycloid-preview-3300", cwd, {}, log_path) is True
`);
  });

  it("retries network cleanup when Docker reports active endpoints", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    log_path = cwd / "cleanup.log"
    discovery_count = [0]
    network_rm_count = [0]
    sleeps = []

    class Completed:
        def __init__(self, stdout="", returncode=0):
            self.returncode = returncode
            self.stdout = stdout

    def fake_resource_ids(project, _cwd, _env, _log_path):
        discovery_count[0] += 1
        if discovery_count[0] <= 2:
            return {"container": {"container-a"} if discovery_count[0] == 1 else set(), "network": {"network-a"}, "volume": set()}
        return {"container": set(), "network": set(), "volume": set()}

    def fake_run(command, **_kwargs):
        if command[:3] == ["docker", "container", "rm"]:
            return Completed("")
        if command[:3] == ["docker", "network", "rm"]:
            network_rm_count[0] += 1
            if network_rm_count[0] == 1:
                return Completed("Error response from daemon: network has active endpoints", 1)
            return Completed("")
        raise AssertionError(f"unexpected command: {command}")

    module.preview_project_resource_ids = fake_resource_ids
    module.subprocess.run = fake_run
    module.time.sleep = lambda seconds: sleeps.append(seconds)

    assert module.cleanup_preview_project("cycloid-preview-3300", cwd, {}, log_path) is True
    assert network_rm_count[0] == 2, network_rm_count
    assert sleeps == [0.5], sleeps
`);
  });

  it("fails cleanup when final rediscovery still finds matching resources", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    log_path = cwd / "cleanup.log"

    class Completed:
        def __init__(self, stdout="", returncode=0):
            self.returncode = returncode
            self.stdout = stdout

    module.preview_project_resource_ids = lambda *_args, **_kwargs: {"container": set(), "network": {"network-a"}, "volume": set()}
    module.subprocess.run = lambda *_args, **_kwargs: Completed("")

    assert module.cleanup_preview_project("cycloid-preview-3300", cwd, {}, log_path) is False
`);
  });

  it("withholds targeted cleanup output in start failures", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    Path("/tmp/cycloid-preview-3310.log").unlink(missing_ok=True)

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {"services": {"web": {"ports": [{"published": "3310", "target": 8080}]}}}
    module.preview_project_has_resources = lambda *_args, **_kwargs: True
    module.wait_until_ready = lambda *_args, **_kwargs: None

    def fail_cleanup(_project, _cwd, _env, log_path):
        with Path(log_path).open("a", encoding="utf-8") as log_file:
            log_file.write("docker network rm network-a\\nError response from daemon: network has active endpoints\\n")
        return False

    module.cleanup_preview_project = fail_cleanup

    try:
        module.start_preview({
            "cwd": str(cwd),
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3310},
        }, 1, out_path)
        raise AssertionError("start_preview unexpectedly succeeded")
    except RuntimeError as err:
        text = str(err)

    assert "Cleanup output was withheld" in text, text
    assert "active endpoints" not in text, text
`);
  });

  it("does not cleanup or retry unrelated startup failures", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    Path("/tmp/cycloid-preview-3304.log").unlink(missing_ok=True)
    attempts = []
    cleanups = []

    class Completed:
        returncode = 1

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {"services": {"web": {"ports": [{"published": "3304", "target": 8080}]}}}
    module.preview_project_has_resources = lambda *_args, **_kwargs: False
    module.cleanup_preview_project = lambda project, *_args, **_kwargs: cleanups.append(project) or True
    module.wait_until_ready = lambda *_args, **_kwargs: None

    def fake_run_logged_result(command, _cwd, _env, log_path):
        attempts.append(command)
        with Path(log_path).open("a", encoding="utf-8") as log_file:
            log_file.write("failed to solve: npm install exited with code 1")
        return Completed()

    module.run_logged_result = fake_run_logged_result

    try:
        module.start_preview({
            "cwd": str(cwd),
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3304},
        }, 1, out_path)
        raise AssertionError("start_preview unexpectedly succeeded")
    except RuntimeError as err:
        text = str(err)

    assert len(attempts) == 1, attempts
    assert cleanups == [], cleanups
    assert "Startup log tail was withheld" in text, text
    assert "npm install exited" not in text, text
`);
  });

  it("does not retry unrelated startup failures because of stale log content", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    stale_log_path = Path("/tmp/cycloid-preview-3307.log")
    stale_log_path.write_text("network cycloid-preview-3307_default is ambiguous (2 matches found on name)\\n", encoding="utf-8")
    attempts = []
    cleanups = []

    class Completed:
        returncode = 1

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {"services": {"web": {"ports": [{"published": "3307", "target": 8080}]}}}
    module.preview_project_has_resources = lambda *_args, **_kwargs: False
    module.cleanup_preview_project = lambda project, *_args, **_kwargs: cleanups.append(project) or True
    module.wait_until_ready = lambda *_args, **_kwargs: None

    def fake_run_logged_result(command, _cwd, _env, log_path):
        attempts.append(command)
        with Path(log_path).open("a", encoding="utf-8") as log_file:
            log_file.write("failed to solve: npm install exited with code 1\\n")
        return Completed()

    module.run_logged_result = fake_run_logged_result

    try:
        module.start_preview({
            "cwd": str(cwd),
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3307},
        }, 1, out_path)
        raise AssertionError("start_preview unexpectedly succeeded")
    except RuntimeError as err:
        text = str(err)
    finally:
        stale_log_path.unlink(missing_ok=True)

    assert len(attempts) == 1, attempts
    assert cleanups == [], cleanups
    assert "Startup log tail was withheld" in text, text
    assert "npm install exited" not in text, text
    assert "ambiguous" not in text, text
`);
  });

  it("records a cleanup contract and withholds compose logs when readiness fails", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    (cwd / "docker-compose.yml").write_text("services:\\n  web:\\n    image: busybox\\n", encoding="utf-8")
    out_path = cwd / "contract.json"
    commands = []

    module.ensure_docker_ready = lambda _env: None
    module.compose_config = lambda *_args, **_kwargs: {"services": {"web": {"ports": [{"published": "3003", "target": 8080}]}}}
    module.preview_project_has_resources = lambda *_args, **_kwargs: False

    def fail_ready(*_args, **_kwargs):
        raise TimeoutError("health timed out")

    module.wait_until_ready = fail_ready

    class Completed:
        def __init__(self, stdout):
            self.returncode = 0
            self.stdout = stdout
            self.stderr = ""

    module.run_logged_result = lambda command, *_args, **_kwargs: commands.append(command) or Completed("")

    def fake_run(command, **_kwargs):
        commands.append(command)
        if command[-1] == "ps":
            return Completed("NAME STATUS\\nweb exited\\n")
        if "logs" in command:
            return Completed("web-1 | missing artifact transit-java\\n")
        return Completed("")

    module.subprocess.run = fake_run

    try:
        module.start_preview(
            {
                "cwd": str(cwd),
                "kind": "web",
                "runner": "docker",
                "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
                "url": {"hostPort": 3003},
                "ready": {"path": "/", "timeoutSeconds": 1},
            },
            1,
            out_path,
        )
        raise AssertionError("start_preview unexpectedly succeeded")
    except Exception as err:
        text = str(err)

    assert out_path.exists(), "expected a cleanup contract before readiness wait"
    started = json.loads(out_path.read_text(encoding="utf-8"))
    assert started["portMapping"] == {"containerPort": 8080}, started
    assert "Startup diagnostics were withheld" in text, text
    assert "docker compose ps" not in text, text
    assert "docker compose logs" not in text, text
    assert "missing artifact transit-java" not in text, text
`);
  });

  it("runs appRuntime.auth.command and validates storage state", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    contract_path = cwd / "contract.json"
    contract = {
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3199, "path": "/"},
        "auth": {
            "command": "npm run cycloid:auth",
            "validatePath": "/account",
            "credentials": [{"name": "user", "envVar": "E2E_USER"}],
        },
        "composeEnv": {"E2E_USER": "operator@example.test"},
    }
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    module.is_app_healthy = lambda _contract: True
    commands = []

    class Completed:
        returncode = 0

    def fake_run(command, **kwargs):
        commands.append((command, kwargs))
        state_path = Path(kwargs["env"]["ARCANIST_AUTH_STATE_PATH"])
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")
        assert kwargs["env"]["ARCANIST_BASE_URL"] == "http://127.0.0.1:3199"
        assert kwargs["env"]["ARCANIST_AUTH_VALIDATE_URL"] == "http://127.0.0.1:3199/account"
        assert kwargs["env"]["E2E_USER"] == "operator@example.test"
        return Completed()

    module.subprocess.run = fake_run

    code = module.cmd_auth(SimpleNamespace(contract_out=str(contract_path)))

    assert code == 0
    assert commands[0][0] == ["sh", "-c", "npm run cycloid:auth"], commands
`);
  });

  it("fails appRuntime.auth when declared credentials are missing", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    contract_path = cwd / "contract.json"
    contract = {
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3200},
        "auth": {
            "command": "npm run cycloid:auth",
            "credentials": [{"name": "user", "envVar": "E2E_USER"}],
        },
    }
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    module.is_app_healthy = lambda _contract: True

    code = module.cmd_auth(SimpleNamespace(contract_out=str(contract_path)))

    assert code == 2
`);
  });

  it("rejects appRuntime.auth validatePath that is not a pure pathname", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    for validate_path in [
        "/dashboard?redirect=https://example.com",
        "/dashboard?next=/foo",
        "/dashboard#done",
        "/dashboard\\x00",
    ]:
        contract = {
            "cwd": str(cwd),
            "kind": "web",
            "runner": "docker",
            "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
            "url": {"hostPort": 3201},
            "auth": {
                "command": "npm run cycloid:auth",
                "validatePath": validate_path,
            },
        }

        try:
            module._auth_validate_path(contract, contract["auth"])
            raise AssertionError(f"validatePath unexpectedly succeeded: {validate_path!r}")
        except RuntimeError as err:
            assert "app-relative path" in str(err), str(err)
`);
  });

  it("reports auth command stderr on failure without leaking secrets", () => {
    runPython(`
import io
import json
import os
import sys
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    contract_path = cwd / "contract.json"
    contract = {
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3202},
        "auth": {"command": "npm run cycloid:auth"},
        "composeEnv": {"OPENAI_API_KEY": "sk-test-secret-value-1234567890"},
    }
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    module.is_app_healthy = lambda _contract: True

    class Completed:
        returncode = 1
        stdout = "minting token sk-test-secret-value-1234567890"
        stderr = "runtime-auth-token returned 401 for sk-test-secret-value-1234567890"

    module.subprocess.run = lambda *_args, **_kwargs: Completed()
    stderr = io.StringIO()
    old_stderr = sys.stderr
    sys.stderr = stderr
    try:
        code = module.cmd_auth(SimpleNamespace(contract_out=str(contract_path)))
    finally:
        sys.stderr = old_stderr

    output = stderr.getvalue()
    assert code == 1
    assert "auth command stderr" in output
    assert "runtime-auth-token returned 401" in output
    assert "sk-test-secret-value" not in output
    assert "[redacted]" in output
`);
  });

  it("fails appRuntime.auth when storage state is missing or invalid", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    contract_path = cwd / "contract.json"
    contract = {
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3201},
        "auth": {"command": "npm run cycloid:auth"},
    }
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    module.is_app_healthy = lambda _contract: True

    class Completed:
        returncode = 0

    module.subprocess.run = lambda *_args, **_kwargs: Completed()
    assert module.cmd_auth(SimpleNamespace(contract_out=str(contract_path))) == 3
`);
  });

  it("treats an absent readiness file as no background boot in flight", () => {
    runPython(`
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "readiness.json"
    assert module.wait_for_runtime_readiness("run", path=path) == "absent"
    assert module.gate_on_runtime_readiness("run") in (None,)
`);
  });

  it("returns each terminal readiness state without polling", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "readiness.json"
    for state in ("ready", "failed", "timed_out", "aborted"):
        path.write_text(json.dumps({"state": state, "startedAt": 0, "deadline": 0}), encoding="utf-8")
        assert module.wait_for_runtime_readiness("run", path=path) == state, state
`);
  });

  it("waits while starting and returns ready once the boot resolves", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "readiness.json"
    path.write_text(json.dumps({"state": "starting", "startedAt": 0, "deadline": 10_000_000_000_000}), encoding="utf-8")

    polls = {"n": 0}

    def fake_sleep(_seconds):
        polls["n"] += 1
        # Flip to ready after the first poll so the wait loop unblocks.
        path.write_text(json.dumps({"state": "ready", "startedAt": 0, "deadline": 10_000_000_000_000}), encoding="utf-8")

    outcome = module.wait_for_runtime_readiness("run", path=path, now=lambda: 0.0, sleep=fake_sleep)
    assert outcome == "ready", outcome
    assert polls["n"] == 1, polls
`);
  });

  it("times out when the boot blows past the absolute deadline", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "readiness.json"
    # deadline is epoch ms; now() returns seconds, so now()*1000 = 5000 >= 1000.
    path.write_text(json.dumps({"state": "starting", "startedAt": 0, "deadline": 1000}), encoding="utf-8")
    outcome = module.wait_for_runtime_readiness("run", path=path, now=lambda: 5.0, sleep=lambda _s: None)
    assert outcome == "timed_out", outcome
`);
  });

  it("returns aborted when the readiness file is cleared mid-wait", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "readiness.json"
    path.write_text(json.dumps({"state": "starting", "startedAt": 0, "deadline": 10_000_000_000_000}), encoding="utf-8")

    def fake_sleep(_seconds):
        path.unlink()

    outcome = module.wait_for_runtime_readiness("run", path=path, now=lambda: 0.0, sleep=fake_sleep)
    assert outcome == "aborted", outcome
`);
  });

  it("the boot owner never waits on its own readiness state", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "readiness.json"
    path.write_text(json.dumps({"state": "starting", "startedAt": 0, "deadline": 10_000_000_000_000}), encoding="utf-8")
    os.environ[module.RUNTIME_BOOT_OWNER_ENV] = "1"
    try:
        # No sleep is provided; if the owner waited it would hang/raise on poll.
        assert module.wait_for_runtime_readiness("start", path=path) == "absent"
    finally:
        os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
`);
  });

  it("cmd_run surfaces INCONCLUSIVE (exit 5) when the background boot failed", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    readiness = cwd / "readiness.json"
    readiness.write_text(json.dumps({"state": "failed", "startedAt": 0, "deadline": 0, "error": "boom"}), encoding="utf-8")
    module.RUNTIME_READINESS_PATH = readiness

    # Health check must never run when the gate already failed.
    def boom(_contract):
        raise AssertionError("is_app_healthy should not be called after a failed boot")

    module.is_app_healthy = boom
    code = module.cmd_run(SimpleNamespace(contract_out=str(cwd / "contract.json"), command=["npm", "test"]))
    assert code == 5, code
`);
  });

  it("cmd_run proceeds to the health check once the boot is ready", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    readiness = cwd / "readiness.json"
    readiness.write_text(json.dumps({"state": "ready", "startedAt": 0, "deadline": 0}), encoding="utf-8")
    module.RUNTIME_READINESS_PATH = readiness

    contract_path = cwd / "contract.json"
    contract_path.write_text(json.dumps({
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3199, "path": "/"},
    }), encoding="utf-8")

    checked = {"n": 0}

    def healthy(_contract):
        checked["n"] += 1
        return True

    class Completed:
        returncode = 0

    module.is_app_healthy = healthy
    module.subprocess.run = lambda *_a, **_k: Completed()
    code = module.cmd_run(SimpleNamespace(contract_out=str(contract_path), command=["true"]))
    assert checked["n"] == 1, checked
    assert code == 0, code
`);
  });

  it("clears a stale failed readiness state after a successful start so later verbs are not gated", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    readiness = cwd / "readiness.json"
    readiness.write_text(json.dumps({"state": "failed", "startedAt": 0, "deadline": 0, "error": "boot died"}), encoding="utf-8")
    module.RUNTIME_READINESS_PATH = readiness

    contract = {
        "cwd": str(cwd),
        "kind": "web",
        "runner": "docker",
        "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
        "url": {"hostPort": 3199, "path": "/"},
    }
    contract_out = cwd / "contract.json"
    contract_out.write_text(json.dumps(contract), encoding="utf-8")

    module.load_preview_contract = lambda: contract
    module.is_app_healthy = lambda _c: True
    module.can_reuse_started_contract = lambda _a, _b, **_kwargs: True
    module.request_managed_runtime_boot = lambda **_kwargs: False

    code = module.cmd_start(SimpleNamespace(contract_out=str(contract_out), timeout=5))
    assert code == 0, code
    # The stale failure must be gone, so a follow-up run/auth/reset/seed proceeds.
    assert not readiness.exists(), "stale failed readiness should be cleared after a successful start"
    assert module.wait_for_runtime_readiness("run", path=readiness) == "absent"
`);
  });

  it("does not clear readiness on start when invoked as the bridge boot owner", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType, SimpleNamespace

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    cwd = Path(directory)
    readiness = cwd / "readiness.json"
    readiness.write_text(json.dumps({"state": "failed", "startedAt": 0, "deadline": 0}), encoding="utf-8")
    module.RUNTIME_READINESS_PATH = readiness
    contract = {"cwd": str(cwd), "kind": "web", "runner": "docker",
                "entry": {"type": "compose", "files": ["docker-compose.yml"], "service": "web"},
                "url": {"hostPort": 3199, "path": "/"}}
    contract_out = cwd / "contract.json"
    contract_out.write_text(json.dumps(contract), encoding="utf-8")
    module.load_preview_contract = lambda: contract
    module.is_app_healthy = lambda _c: True
    module.can_reuse_started_contract = lambda _a, _b, **_kwargs: True

    os.environ[module.RUNTIME_BOOT_OWNER_ENV] = "1"
    try:
        assert module.cmd_start(SimpleNamespace(contract_out=str(contract_out), timeout=5)) == 0
        # The bridge owns its own lifecycle; the owner start must not delete the file.
        assert readiness.exists(), "boot owner must not clear bridge-managed readiness state"
    finally:
        os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
`);
  });

  it("falls back to a bounded wait when a starting record has no usable deadline", () => {
    runPython(`
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType

module = ModuleType("cycloid_app")
SourceFileLoader(module.__name__, os.environ["SCRIPT_PATH"]).exec_module(module)

os.environ.pop(module.RUNTIME_BOOT_OWNER_ENV, None)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "readiness.json"
    # Malformed record: 'starting' with no usable deadline, startedAt present.
    path.write_text(json.dumps({"state": "starting", "startedAt": 0}), encoding="utf-8")
    # now() far past startedAt + fallback window -> times out instead of hanging.
    elapsed = module.RUNTIME_READINESS_FALLBACK_TIMEOUT_MS / 1000 + 1
    outcome = module.wait_for_runtime_readiness("run", path=path, now=lambda: elapsed, sleep=lambda _s: None)
    assert outcome == "timed_out", outcome

    # No startedAt and no deadline -> cannot bound -> timed_out immediately.
    path.write_text(json.dumps({"state": "starting"}), encoding="utf-8")
    outcome2 = module.wait_for_runtime_readiness("run", path=path, now=lambda: 0.0, sleep=lambda _s: None)
    assert outcome2 == "timed_out", outcome2
`);
  });
});
