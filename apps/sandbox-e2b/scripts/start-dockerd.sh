#!/usr/bin/env bash
set -euo pipefail

export PATH="${PATH:-}:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin"

if docker info >/dev/null 2>&1; then
  exit 0
fi

if [[ "$(id -u)" != "0" && "${BASH_SOURCE[0]}" == "/app/scripts/start-dockerd.sh" ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -n -E /app/scripts/start-dockerd.sh "$@"
  fi
  echo "start-dockerd requires root privileges and sudo is not available" >&2
  exit 1
fi

LOG_PATH="/tmp/dockerd.log"
PID_PATH="/tmp/dockerd.pid"
DATA_ROOT="${DOCKER_DATA_ROOT:-/tmp/docker-data}"
SOCKET_PATH="${DOCKER_HOST_SOCKET:-/var/run/docker.sock}"
READY_TIMEOUT="${DOCKER_READY_TIMEOUT_SECONDS:-30}"
MAX_ATTEMPTS="${DOCKER_START_MAX_ATTEMPTS:-2}"
DOCKER_IPTABLES="${DOCKER_IPTABLES:-false}"
DOCKER_IP6TABLES="${DOCKER_IP6TABLES:-false}"
DOCKER_BRIDGE="${DOCKER_BRIDGE:-docker0}"
DOCKER_BRIDGE_CIDR="${DOCKER_BRIDGE_CIDR:-172.30.0.1/16}"
DOCKER_FIXED_CIDR="${DOCKER_FIXED_CIDR:-172.30.0.0/16}"
DOCKER_IP_FORWARD="${DOCKER_IP_FORWARD:-false}"
DOCKER_IP_MASQ="${DOCKER_IP_MASQ:-false}"
DOCKER_USERLAND_PROXY="${DOCKER_USERLAND_PROXY:-true}"
DOCKER_STORAGE_DRIVER="${DOCKER_STORAGE_DRIVER:-vfs}"
DOCKER_SOCKET_GROUP="${DOCKER_SOCKET_GROUP:-docker}"

if command -v update-alternatives >/dev/null 2>&1; then
  for tool in iptables ip6tables arptables ebtables; do
    legacy="/usr/sbin/${tool}-legacy"
    if [[ -x "${legacy}" ]]; then
      update-alternatives --set "${tool}" "${legacy}" >/dev/null 2>&1 || true
    fi
  done
fi

# Best-effort NAT setup for Docker bridge networking. Docker-managed iptables
# remains disabled because some sandbox kernels do not support Docker's addrtype
# iptables match. We provide only the forwarding/SNAT rules needed for
# bridge-mode builds and Compose port publishing.
if [[ "${DOCKER_BRIDGE}" != "none" ]]; then
  dev=$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')
  if [[ -n "${dev}" ]]; then
    addr=$(ip addr show dev "${dev}" 2>/dev/null | grep -w inet | awk '{print $2}' | cut -d/ -f1 | head -1)
    if [[ -n "${addr}" ]]; then
      echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true
      iptables-legacy -t nat -A POSTROUTING -s "${DOCKER_FIXED_CIDR}" -o "${dev}" -j SNAT --to-source "${addr}" -p tcp 2>/dev/null || true
      iptables-legacy -t nat -A POSTROUTING -s "${DOCKER_FIXED_CIDR}" -o "${dev}" -j SNAT --to-source "${addr}" -p udp 2>/dev/null || true
    fi
  fi
fi

mkdir -p "$(dirname "${SOCKET_PATH}")" "${DATA_ROOT}" /var/log

# Honor an already-live daemon from a prior invocation of the same container.
if [[ -f "${PID_PATH}" ]]; then
  old_pid="$(cat "${PID_PATH}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
    wait_deadline=$((SECONDS + READY_TIMEOUT))
    until docker info >/dev/null 2>&1; do
      if (( SECONDS >= wait_deadline )); then
        echo "Timed out waiting for existing dockerd at ${SOCKET_PATH}" >&2
        exit 1
      fi
      sleep 1
    done
    exit 0
  fi
fi

# Verify dockerd binary exists before attempting to start
if ! command -v dockerd >/dev/null 2>&1; then
  echo "dockerd binary not found in PATH" >&2
  echo "PATH=${PATH}" >&2
  exit 1
fi

# Start dockerd, tracking its PID directly so we can detect early death
# even if the pidfile is never written (common when dockerd crashes during
# cgroup/network init on cold gVisor containers). Retry once on early death
# because cold-boot init races are the dominant cause of flake.
attempt=0
while (( attempt < MAX_ATTEMPTS )); do
  attempt=$((attempt + 1))

  # Clean up any stale state from a prior failed attempt. Safe because the
  # previous attempt never reached readiness, so nothing useful lives here.
  if (( attempt > 1 )); then
    rm -f "${PID_PATH}" "${LOG_PATH}"
    rm -rf "${DATA_ROOT}"
    mkdir -p "${DATA_ROOT}"
    echo "start-dockerd: retry attempt ${attempt} after prior failure" >&2
  fi

  dockerd_args=(
    --host="unix://${SOCKET_PATH}"
    --data-root="${DATA_ROOT}"
    --pidfile="${PID_PATH}"
    --storage-driver="${DOCKER_STORAGE_DRIVER}"
    --iptables="${DOCKER_IPTABLES}"
    --ip6tables="${DOCKER_IP6TABLES}"
    --ip-forward="${DOCKER_IP_FORWARD}"
    --ip-masq="${DOCKER_IP_MASQ}"
    --userland-proxy="${DOCKER_USERLAND_PROXY}"
    --group="${DOCKER_SOCKET_GROUP}"
  )
  if [[ "${DOCKER_BRIDGE}" == "none" ]]; then
    dockerd_args+=(--bridge="none")
  else
    # Do not pass --bridge with --bip; dockerd treats them as mutually
    # exclusive. The default bridge name is docker0, which is what we want.
    dockerd_args+=(--bip="${DOCKER_BRIDGE_CIDR}" --fixed-cidr="${DOCKER_FIXED_CIDR}")
  fi

  nohup dockerd "${dockerd_args[@]}" >"${LOG_PATH}" 2>&1 &
  dockerd_pid=$!

  wait_deadline=$((SECONDS + READY_TIMEOUT))
  ready=false
  while true; do
    if docker info >/dev/null 2>&1; then
      ready=true
      break
    fi
    # Early death detection: works even if dockerd crashed before writing
    # the pidfile. This is the core fix for the ~2/3 cold-boot flake.
    if ! kill -0 "${dockerd_pid}" >/dev/null 2>&1; then
      echo "dockerd (pid ${dockerd_pid}) exited before becoming ready on attempt ${attempt}" >&2
      cat "${LOG_PATH}" >&2 || true
      break
    fi
    if (( SECONDS >= wait_deadline )); then
      echo "Timed out waiting for dockerd to become ready on attempt ${attempt}" >&2
      cat "${LOG_PATH}" >&2 || true
      # Kill the stuck daemon before a potential retry; avoids two dockerds
      # racing for the socket.
      kill "${dockerd_pid}" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
  done

  if [[ "${ready}" == "true" ]]; then
    exit 0
  fi
done

exit 1
