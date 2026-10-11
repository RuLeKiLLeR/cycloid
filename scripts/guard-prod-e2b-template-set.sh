#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/guard-prod-e2b-template-set.sh --base <ref> --head <ref> [--allow-new-prod-template]

Fails when the resolved production E2B template set at head contains a template
ID that is absent at base. Use --allow-new-prod-template only after the new
production template IDs have been pre-built through the manual E2B deploy flow
and listed in .github/e2b-prebuilt-prod-templates.txt.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

base_ref=""
head_ref="HEAD"
allow_new_prod_template=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      [ "$#" -ge 2 ] || die "--base requires a ref"
      base_ref="$2"
      shift 2
      ;;
    --head)
      [ "$#" -ge 2 ] || die "--head requires a ref"
      head_ref="$2"
      shift 2
      ;;
    --allow-new-prod-template)
      allow_new_prod_template=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$base_ref" ] || die "--base is required"

prod_stem_for_ref() {
  local ref="$1"
  local stem
  stem="$(
    git show "${ref}:apps/control-plane-worker/wrangler.toml" |
      awk -F= '
        /^\[env\./ { exit }
        /^[[:space:]]*E2B_SANDBOX_TEMPLATE[[:space:]]*=/ {
          value = $2
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
          gsub(/^"|"$/, "", value)
          print value
          exit
        }
      '
  )"
  [ -n "$stem" ] || die "could not read production E2B_SANDBOX_TEMPLATE from ${ref}:apps/control-plane-worker/wrangler.toml"
  printf '%s\n' "$stem"
}

repo_sandbox_resource_specs_for_ref() {
  local ref="$1"
  git show "${ref}:scripts/e2b-template-build.sh" |
    awk '
      /^repo_sandbox_resource_specs=\(/ { in_array = 1 }
      in_array { print }
      in_array && /\)/ { exit }
    ' |
    grep -Eo '"[^"]+"' |
    tr -d '"'
}

resource_template_name() {
  local base="$1"
  local memory="$2"
  local cpu="$3"
  printf '%s-mem%s-cpu%s\n' "$base" "$memory" "$cpu"
}

template_ids_for_ref() {
  local ref="$1"
  local stem
  local repo_key
  local memory
  local cpu

  stem="$(prod_stem_for_ref "$ref")"
  resource_template_name "$stem" 4096 2
  while IFS=: read -r repo_key memory cpu; do
    [ -n "${repo_key:-}" ] || continue
    resource_template_name "$stem" "$memory" "$cpu"
  done < <(repo_sandbox_resource_specs_for_ref "$ref")
}

approved_template_ids_for_ref() {
  local ref="$1"
  if git show "${ref}:.github/e2b-prebuilt-prod-templates.txt" >/dev/null 2>&1; then
    git show "${ref}:.github/e2b-prebuilt-prod-templates.txt" |
      sed 's/#.*//' |
      awk 'NF { print $1 }' |
      sort -u
  fi
}

base_templates="$(template_ids_for_ref "$base_ref" | sort -u)"
head_templates="$(template_ids_for_ref "$head_ref" | sort -u)"

new_templates="$(comm -13 <(printf '%s\n' "$base_templates") <(printf '%s\n' "$head_templates"))"

if [ -z "$new_templates" ]; then
  echo "Resolved production E2B template set is unchanged."
  exit 0
fi

if [ "$allow_new_prod_template" = true ]; then
  approved_templates="$(approved_template_ids_for_ref "$head_ref")"
  unapproved_templates="$(comm -23 <(printf '%s\n' "$new_templates") <(printf '%s\n' "$approved_templates"))"
  if [ -n "$unapproved_templates" ]; then
    echo "::error::e2b-template-prebuilt label is present, but these new production E2B template IDs are not listed in .github/e2b-prebuilt-prod-templates.txt:"
    printf '%s\n' "$unapproved_templates"
    echo ""
    echo "Pre-build every new production template ID, then list each exact ID in .github/e2b-prebuilt-prod-templates.txt before applying the label."
    exit 1
  fi
  echo "::warning::Resolved production E2B template IDs changed under e2b-template-prebuilt label and matching annotation file:"
  printf '%s\n' "$new_templates"
  exit 0
fi

echo "::error::Resolved production E2B template IDs changed:"
printf '%s\n' "$new_templates"
echo ""
echo "Pre-build the new production template IDs with the manual Deploy E2B Sandbox workflow, list them in .github/e2b-prebuilt-prod-templates.txt, then add the e2b-template-prebuilt label to rerun this guard."
exit 1
