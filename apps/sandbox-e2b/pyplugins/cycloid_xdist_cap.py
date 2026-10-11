"""Cycloid sandbox pytest-xdist worker cap.

A repo's test command is often tuned for a large CI runner (e.g. ``pytest -n 15``,
sized for a 16-vCPU machine). Run verbatim inside a small Cycloid sandbox
(4 vCPU / 16 GB) that spawns ~15 heavyweight workers that exhaust RAM and trip the
kernel OOM-killer — the OpenEvidence/xyla failure class. This plugin caps xdist
parallelism to the sandbox's real budget, deterministically and entirely on our
side: it is baked into the sandbox image and auto-loaded via
``PYTEST_ADDOPTS="-p cycloid_xdist_cap"``. No change to the customer repo.

Mechanism: it lowers xdist's own ``--maxprocesses`` option (which xdist applies as
``min(numprocesses, maxprocesses)`` when materialising workers), from inside a
``pytest_cmdline_main`` hookwrapper so the value is set BEFORE xdist reads it. It
only ever LOWERS the count — a repo already asking for fewer workers than the
budget is left untouched — and it is a no-op when pytest-xdist is not installed
(the ``--maxprocesses`` option is absent), so it can never break a non-xdist run.

Budget = ``ARCANIST_MAX_TEST_WORKERS`` when set (>0) — the injection point for a
per-repo ceiling such as xyla's 16-Redis-DB cap — else the CPU count visible to
this process, which is cgroup-accurate inside the sandbox.
"""

import os

try:
    import pytest
except ImportError:  # pragma: no cover - pytest is always present when this plugin loads
    pytest = None


def _cpu_budget():
    # Scheduling affinity respects the cgroup/cpuset the sandbox runs under; fall
    # back to cpu_count() on platforms without sched_getaffinity.
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        return max(1, os.cpu_count() or 1)


def _resolve_cap():
    raw = (os.environ.get("ARCANIST_MAX_TEST_WORKERS") or "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return _cpu_budget()


if pytest is not None:

    @pytest.hookimpl(hookwrapper=True)
    def pytest_cmdline_main(config):
        # Pre-yield code runs before every non-wrapper pytest_cmdline_main impl,
        # including xdist's — which is where xdist turns `-n <N>` into worker
        # processes. Setting maxprocesses here caps that. Never fail a run because
        # of the cap: on any error, leave the repo's requested -n intact.
        try:
            if hasattr(config.option, "maxprocesses"):
                cap = _resolve_cap()
                current = getattr(config.option, "maxprocesses", None)
                if current is None or current <= 0 or current > cap:
                    config.option.maxprocesses = cap
        except Exception:
            pass
        yield
