#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/e2b-template-build.sh [options]

Options:
  --tag <name>       Build the exact E2B template name.
  --dev              Build cycloid-sandbox-dev-${USER}.
  --qa               Build the stable cycloid-sandbox-qa stem (default tier cycloid-sandbox-qa-mem4096-cpu2).
  --prod             Build arc-default-template (default tier arc-default-template-mem4096-cpu2).
  --memory-mb <mb>   Template memory in MiB. Defaults to 4096.
  --cpu-count <n>    Template CPU count. Defaults to 2.
  --include-repo-spec-templates
                    Also build templates required by hardcoded repo sandbox specs.
  --skip-bundles     Do not run npm run bundle:sandbox-core-apps.
  --skip-matching-registry
                    Skip Template.build when the current control-plane registry hash matches.
  --registry-url <url>
                    Control-plane API base URL for --skip-matching-registry.
  --force-rebuild    Build even when the registry hash matches.
  --print-template   Print E2B_SANDBOX_TEMPLATE=<name> and exit without building.
  --print-content-hashes
                    With --print-template, also print content hashes for every template.
  -h, --help         Show this help.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

set_template() {
  local value="$1"
  local source="$2"
  local mode="$3"
  if [ -n "${template:-}" ]; then
    die "multiple template selectors provided; already selected ${template}, got ${source}"
  fi
  template="$value"
  template_mode="$mode"
}

parse_positive_integer() {
  local value="$1"
  local flag="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    die "${flag} requires a positive integer"
  fi
}

resource_template_name() {
  local base="$1"
  local memory="$2"
  local cpu="$3"
  # Mirrors resolveRuntimeTemplateId in repo-sandbox-specs.ts: every resource
  # template, including the default 4096/2 tier, carries an explicit suffix so
  # the built name matches what the worker requests.
  echo "${base}-mem${memory}-cpu${cpu}"
}

add_template_build() {
  local name="$1"
  local memory="$2"
  local cpu="$3"
  local resource_profile_key="$4"
  local existing
  if [ "${#template_names[@]}" -gt 0 ]; then
    for existing in "${!template_names[@]}"; do
      if [ "${template_names[$existing]}" = "$name" ]; then
        return
      fi
    done
  fi
  template_names+=("$name")
  template_memory_mbs+=("$memory")
  template_cpu_counts+=("$cpu")
  template_resource_profile_keys+=("$resource_profile_key")
}

is_transient_e2b_build_error() {
  local output="$1"
  local normalized_output
  normalized_output="$(printf '%s' "$output" | tr '[:upper:]' '[:lower:]')"
  [[ "$normalized_output" == *"internal error occurred"* ]]
}

build_template_with_retries() {
  local name="$1"
  local memory="$2"
  local cpu="$3"
  local max_attempts=3
  local attempt=1
  local backoffs=(10 30)
  local output
  local output_file
  local status
  # Debug escape hatch: E2B_SKIP_CACHE=<truthy> forces a from-scratch rebuild
  # (--skip-cache bypasses E2B's layer cache). Distinct from --force-rebuild,
  # which only bypasses the content-hash registry skip; the E2B build it runs
  # still reuses cached layers. Use when a corrupted E2B layer cache makes a
  # cached resume crash with a bare "internal error".
  local skip_cache_args=()
  case "${E2B_SKIP_CACHE:-}" in
    1 | true | True | TRUE | yes | YES | on | ON)
      skip_cache_args+=(--skip-cache)
      ;;
  esac
  if [ "${#backoffs[@]}" -ne "$((max_attempts - 1))" ]; then
    echo "internal error: backoffs array length (${#backoffs[@]}) must equal max_attempts-1 ($((max_attempts - 1)))" >&2
    return 1
  fi

  while [ "$attempt" -le "$max_attempts" ]; do
    echo "building E2B template ${name} (${memory} MiB, ${cpu} CPU), attempt ${attempt}/${max_attempts}" >&2

    output_file="$(mktemp)"
    set +e
    npm run -w @cycloid/sandbox-e2b build-template -- \
      --name "$name" \
      --memory-mb "$memory" \
      --cpu-count "$cpu" \
      ${skip_cache_args[@]+"${skip_cache_args[@]}"} 2>&1 | tee "$output_file" >&2
    status=${PIPESTATUS[0]}
    set -e
    output="$(<"$output_file")"
    rm -f "$output_file"

    if [ "$status" -eq 0 ]; then
      return 0
    fi

    if ! is_transient_e2b_build_error "$output"; then
      echo "template ${name} failed with a non-retryable build error" >&2
      return "$status"
    fi

    if [ "$attempt" -eq "$max_attempts" ]; then
      echo "template ${name} exhausted ${max_attempts} attempts after transient E2B build errors" >&2
      return "$status"
    fi

    echo "template ${name} hit transient E2B build error; retrying in ${backoffs[$((attempt - 1))]}s" >&2
    sleep "${backoffs[$((attempt - 1))]}"
    attempt=$((attempt + 1))
  done
}

template_content_hash() {
  local memory="$1"
  local cpu="$2"
  local output
  output="$(
    npm run -w @cycloid/sandbox-e2b build-template -- \
      --print-content-hash \
      --memory-mb "$memory" \
      --cpu-count "$cpu"
  )"
  printf '%s\n' "$output" | awk -F= '/^E2B_TEMPLATE_CONTENT_HASH=/{print $2; exit}'
}

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

registry_content_hash() {
  local resource_profile_key="$1"
  local encoded_profile
  local response_file
  local status
  local hash

  if [ -z "$registry_url" ] || [ -z "${CI_AUTOMATION_TOKEN:-}" ]; then
    echo "registry lookup unavailable for ${resource_profile_key}; registry URL or CI_AUTOMATION_TOKEN is missing" >&2
    return 1
  fi

  encoded_profile="$(urlencode "$resource_profile_key")"
  response_file="$(mktemp)"
  status="$(
    curl -sS \
      -o "$response_file" \
      -w "%{http_code}" \
      -H "Authorization: Bearer ${CI_AUTOMATION_TOKEN}" \
      "${registry_url%/}/api/admin/sandbox-base-templates/current?runtimeBackend=e2b_cloud&resourceProfileKey=${encoded_profile}" || true
  )"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "registry lookup for ${resource_profile_key} returned HTTP ${status}; building instead" >&2
    rm -f "$response_file"
    return 1
  fi
  if command -v jq &>/dev/null; then
    hash="$(jq -r '.current.contentHash // empty' "$response_file" 2>/dev/null || true)"
  else
    hash="$(node -e 'const fs=require("node:fs"); const obj=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(obj.current?.contentHash ?? "");' "$response_file" 2>/dev/null || true)"
  fi
  rm -f "$response_file"
  if [ -z "$hash" ]; then
    echo "registry lookup for ${resource_profile_key} has no content hash; building instead" >&2
    return 1
  fi
  printf '%s\n' "$hash"
}

template=""
template_mode="resource"
memory_mb=4096
cpu_count=2
include_repo_spec_templates=false
skip_bundles=false
skip_matching_registry=false
registry_url=""
force_rebuild=false
print_template=false
print_content_hashes=false
is_qa=false
qa_max_memory_mb=8192
template_names=()
template_memory_mbs=()
template_cpu_counts=()
template_resource_profile_keys=()
# Mirrors non-default resource specs in apps/control-plane-worker/src/sandbox/repo-sandbox-specs.ts.
# QA skips specs above qa_max_memory_mb; prod still builds the larger tiers.
repo_sandbox_resource_specs=("trycycloid/cycloid:8192:4" "openevidence/xyla:16384:4" "mialabs/mia:8192:4" "trycycloid/mia-copy-4:8192:4")
effective_repo_specs=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      [ "$#" -ge 2 ] || die "--tag requires a template name"
      set_template "$2" "--tag" "exact"
      shift 2
      ;;
    --dev)
      set_template "cycloid-sandbox-dev-${USER:-local}" "--dev" "resource"
      shift
      ;;
    --qa)
      # Stable stem (mirrors --prod): QA pins cycloid-sandbox-qa permanently in
      # wrangler.toml [env.qa.vars] and the worker appends the resource suffix, so
      # there is no per-commit SHA to inject and nothing for a bare control-plane
      # deploy to clobber.
      set_template "cycloid-sandbox-qa" "--qa" "resource"
      is_qa=true
      shift
      ;;
    --prod)
      set_template "arc-default-template" "--prod" "resource"
      shift
      ;;
    --memory-mb)
      [ "$#" -ge 2 ] || die "--memory-mb requires a value"
      parse_positive_integer "$2" "--memory-mb"
      memory_mb="$2"
      shift 2
      ;;
    --cpu-count)
      [ "$#" -ge 2 ] || die "--cpu-count requires a value"
      parse_positive_integer "$2" "--cpu-count"
      cpu_count="$2"
      shift 2
      ;;
    --include-repo-spec-templates)
      include_repo_spec_templates=true
      shift
      ;;
    --skip-bundles)
      skip_bundles=true
      shift
      ;;
    --skip-matching-registry)
      skip_matching_registry=true
      shift
      ;;
    --registry-url)
      [ "$#" -ge 2 ] || die "--registry-url requires a URL"
      registry_url="$2"
      shift 2
      ;;
    --force-rebuild)
      force_rebuild=true
      shift
      ;;
    --print-template)
      print_template=true
      shift
      ;;
    --print-content-hashes)
      print_content_hashes=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

if [ -z "$template" ]; then
  template="cycloid-sandbox-dev-${USER:-local}"
  template_mode="resource"
fi

template_base="$template"
if [ "$template_mode" = "resource" ]; then
  template="$(resource_template_name "$template_base" "$memory_mb" "$cpu_count")"
fi

case "$template" in
  prod)
    die "ambiguous production template tag 'prod'; use --prod for arc-default-template"
    ;;
  qa-*)
    die "ambiguous QA template tag '${template}'; Worker config expects cycloid-sandbox-qa"
    ;;
  cycloid-sandbox-dev-)
    die "dev template tag is missing the user suffix"
    ;;
esac

add_template_build "$template" "$memory_mb" "$cpu_count" "default"

if [ "$include_repo_spec_templates" = true ]; then
  for resource_spec in "${repo_sandbox_resource_specs[@]}"; do
    IFS=: read -r repo_key repo_memory_mb repo_cpu_count <<< "$resource_spec"
    if [ "$is_qa" = true ] && [ "$repo_memory_mb" -gt "$qa_max_memory_mb" ]; then
      echo "skipping repo-spec ${repo_key} (${repo_memory_mb} MiB > QA cap ${qa_max_memory_mb} MiB)" >&2
      continue
    fi
    effective_repo_specs+=("$resource_spec")
  done
fi

if [ "${#effective_repo_specs[@]}" -gt 0 ]; then
  for resource_spec in "${effective_repo_specs[@]}"; do
    IFS=: read -r repo_key repo_memory_mb repo_cpu_count <<< "$resource_spec"
    template_for_spec="$(resource_template_name "$template_base" "$repo_memory_mb" "$repo_cpu_count")"
    add_template_build "$template_for_spec" "$repo_memory_mb" "$repo_cpu_count" "$repo_key"
  done
fi

if [ "$print_template" = true ] && [ "$print_content_hashes" = true ] && [ "$skip_bundles" = false ]; then
  npm run bundle:sandbox-core-apps
  skip_bundles=true
fi

# Advertise the agent runtime backends this image installs so registration can record them and the
# control-plane spawn preflight can fail closed for opt-in backends (opencode) against old images.
# Mirrors IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS in shared/agent/agent-runtime-backend.ts; the two
# are locked byte-identical by a drift test in tests/test_sandbox-e2b/template-build-script.test.ts.
echo "E2B_SANDBOX_TEMPLATE_AGENT_BACKENDS=codex,claude_code,opencode"
echo "E2B_SANDBOX_TEMPLATE=${template_names[0]}"
if [ "$print_content_hashes" = true ]; then
  echo "E2B_SANDBOX_TEMPLATE_CONTENT_HASH=$(template_content_hash "${template_memory_mbs[0]}" "${template_cpu_counts[0]}")"
fi
# Emit one E2B_REPO_SANDBOX_TEMPLATE line per repo spec (not per built template):
# distinct repos can resolve to the same shared template (e.g. two repos at the
# same mem/cpu), and the build loop dedups by name, but each repo still needs its
# own evidence line so downstream verification can match `<owner>/<repo>:`.
if [ "${#effective_repo_specs[@]}" -gt 0 ]; then
  for resource_spec in "${effective_repo_specs[@]}"; do
    IFS=: read -r repo_key repo_memory_mb repo_cpu_count <<< "$resource_spec"
    template_for_spec="$(resource_template_name "$template_base" "$repo_memory_mb" "$repo_cpu_count")"
    echo "E2B_REPO_SANDBOX_TEMPLATE=${repo_key}:${template_for_spec}"
    if [ "$print_content_hashes" = true ]; then
      echo "E2B_REPO_SANDBOX_TEMPLATE_CONTENT_HASH=${repo_key}:$(template_content_hash "$repo_memory_mb" "$repo_cpu_count")"
    fi
  done
fi

if [ "$print_template" = true ]; then
  exit 0
fi

if [ "$skip_bundles" = false ]; then
  npm run bundle:sandbox-core-apps
fi

successful_templates=()
failed_templates=()
retried_templates=()
skipped_templates=()

build_pids=()
build_names=()
build_output_paths=()
build_cleanup_done=false

kill_build_process_tree() {
  local pid="$1"
  local child_pid
  local child_pids=()
  child_pids=($(pgrep -P "$pid" 2>/dev/null || true))
  for child_pid in "${child_pids[@]}"; do
    kill_build_process_tree "$child_pid"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup_build_jobs() {
  if [ "$build_cleanup_done" = true ]; then
    return
  fi
  build_cleanup_done=true

  # Interrupting a local build must not leave E2B build processes running in the
  # background. Normal collection only removes output files; signal cleanup
  # also terminates and reaps outstanding jobs first.
  if [ "${build_collection_complete:-false}" != true ] && ((${#build_pids[@]} > 0)); then
    for pid in "${build_pids[@]}"; do
      kill_build_process_tree "$pid"
    done
    for pid in "${build_pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi
  if ((${#build_output_paths[@]} > 0)); then
    for output_path in "${build_output_paths[@]}"; do
      rm -f "$output_path"
    done
  fi
}

trap 'cleanup_build_jobs' EXIT
trap 'cleanup_build_jobs; exit 130' INT
trap 'cleanup_build_jobs; exit 143' TERM

collect_template_build() {
  local index="$1"
  local template_name="${build_names[$index]}"
  local output_path="${build_output_paths[$index]}"
  local build_status
  local build_output
  local attempts

  set +e
  wait "${build_pids[$index]}"
  build_status=$?
  set -e

  build_output="$(cat "$output_path")"
  printf '%s\n' "$build_output" >&2

  attempts="$(printf '%s\n' "$build_output" | grep -F -c "building E2B template ${template_name} " || true)"
  if [ "$attempts" -gt 1 ]; then
    retried_templates+=("${template_name}(${attempts} attempts)")
  fi

  if [ "$build_status" -eq 0 ]; then
    successful_templates+=("$template_name")
  else
    failed_templates+=("$template_name")
  fi
}

for i in "${!template_names[@]}"; do
  template_name="${template_names[$i]}"
  if [ "$skip_matching_registry" = true ] && [ "$force_rebuild" = false ]; then
    set +e
    content_hash="$(template_content_hash "${template_memory_mbs[$i]}" "${template_cpu_counts[$i]}")"
    hash_status=$?
    set -e
    if [ "$hash_status" -ne 0 ] || [ -z "$content_hash" ]; then
      echo "unable to compute content hash for ${template_name}" >&2
      failed_templates+=("$template_name")
      continue
    fi
    set +e
    current_hash="$(registry_content_hash "${template_resource_profile_keys[$i]}")"
    registry_status=$?
    set -e
    if [ "$registry_status" -eq 0 ] && [ "$current_hash" = "$content_hash" ]; then
      echo "skipping E2B template ${template_name}; content hash matches registry (${content_hash})" >&2
      skipped_templates+=("$template_name")
      successful_templates+=("$template_name")
      continue
    fi
  elif [ "$force_rebuild" = true ]; then
    echo "force rebuild enabled for E2B template ${template_name}; bypassing content-hash skip" >&2
  fi

  output_path="$(mktemp)"
  build_output_paths+=("$output_path")
  build_names+=("$template_name")
  (
    set -o pipefail
    build_template_with_retries "$template_name" "${template_memory_mbs[$i]}" "${template_cpu_counts[$i]}" \
      2>&1 | tee "$output_path" >&2
  ) &
  build_pids+=("$!")
done

for i in "${!build_pids[@]}"; do
  collect_template_build "$i"
done
build_collection_complete=true

success_summary="$(IFS=', '; echo "${successful_templates[*]:-none}")"
retry_summary="$(IFS=', '; echo "${retried_templates[*]:-none}")"
skip_summary="$(IFS=', '; echo "${skipped_templates[*]:-none}")"
failure_summary="$(IFS=', '; echo "${failed_templates[*]:-none}")"
echo "E2B template build summary: succeeded=${success_summary}; skipped=${skip_summary}; retried=${retry_summary}; failed=${failure_summary}" >&2

if [ "${#failed_templates[@]}" -gt 0 ]; then
  exit 1
fi
