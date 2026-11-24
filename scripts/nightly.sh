#!/usr/bin/env bash
# Ours (governedwork fork), not upstream GBrain: the fork's whole suite, once a night.
#
# .github/workflows/nightly.yml runs this on governedwork/lander's shared nightly recipe, on the wardrobe's Linux
# runner: an alarm after the merge, never a check a pull request waits for (the lander's gate is the typecheck). A red
# night opens or rewrites the one `nightly-red` issue, which the lander routes to the landings since the last green
# night. It replaces fork-suite.yml, which ran the same lanes on GitHub-hosted runners after every merge.
#
# Lanes, each upstream's own runner, every lane run even after a red one; the night is red when any lane is:
#   unit       scripts/run-unit-parallel.sh: the unit files in parallel, memory-adapted, then the *.serial files
#   slow       scripts/run-slow-tests.sh: the *.slow files
#   e2e        scripts/run-e2e.sh: upstream's E2E corpus against PostgreSQL + pgvector, minus the fork's reasoned
#              exclusions (scripts/fork-e2e-exclusions.txt), in four shards, one database each
#   pg-arms    scripts/postgres-unit-arms.ts: the unit suites' PostgreSQL arms, one worker per database
# PostgreSQL is upstream's own compose services (docker-compose.ci.yml), started empty for each database lane, under a
# project name of this run and on ports Docker picks, so the night shares the runner VM with other jobs.
#
# The whole suite assumes Linux (flock(1), case-sensitive paths, ps); on macOS it is red on bare upstream too.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
unset DATABASE_URL SHARD

project="gbrain-nightly-${GITHUB_RUN_ID:-$$}"
databases=(postgres-1 postgres-2 postgres-3 postgres-4)
export GBRAIN_CI_PG_PORT=0 GBRAIN_CI_PG_PORT_2=0 GBRAIN_CI_PG_PORT_3=0 GBRAIN_CI_PG_PORT_4=0
logs=$(mktemp -d)
compose() { docker compose -f docker-compose.ci.yml -p "$project" "$@"; }
trap 'compose down -v --remove-orphans >/dev/null 2>&1; rm -rf "$logs"' EXIT

# Empty databases, healthy; prints one URL per database.
fresh_databases() {
  compose down -v --remove-orphans >/dev/null 2>&1
  compose up -d --wait "${databases[@]}" >&2 || return 1
  local db
  for db in "${databases[@]}"; do
    echo "postgres://postgres:postgres@$(compose port "$db" 5432)/gbrain_test"
  done
}

e2e() {
  local urls files
  urls=$(fresh_databases) || return 1
  mapfile -t files < <(bash scripts/run-e2e.sh --dry-run-list | grep -vxF -f <(grep -v '^#' scripts/fork-e2e-exclusions.txt | cut -f1))
  local total i=0 url pids=() rc=0 pid
  total=$(wc -l <<<"$urls")
  for url in $urls; do
    i=$((i + 1))
    DATABASE_URL=$url SHARD="$i/$total" bash scripts/run-e2e.sh "${files[@]}" >"$logs/e2e-$i.log" 2>&1 &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid" || rc=1; done
  for i in $(seq 1 "$total"); do echo "--- e2e shard $i/$total"; cat "$logs/e2e-$i.log"; done
  return "$rc"
}

pg_arms() {
  local urls
  urls=$(fresh_databases) || return 1
  GBRAIN_ARM_DATABASE_URLS=$(tr '\n' ' ' <<<"$urls") GBRAIN_TEST_ALLOW_DATABASE_URL=1 bun scripts/postgres-unit-arms.ts run 1 1
}

red=()
lane() {
  local name=$1 start=$SECONDS rc
  shift
  echo "::group::$name"
  "$@"
  rc=$?
  echo "::endgroup::"
  if [ "$rc" = 0 ]; then
    echo "$name: green in $((SECONDS - start)) s"
  else
    echo "::error title=nightly lane red: $name::exit $rc after $((SECONDS - start)) s"
    red+=("$name")
  fi
}

lane unit bash scripts/run-unit-parallel.sh
lane slow bash scripts/run-slow-tests.sh
lane e2e e2e
lane pg-arms pg_arms

if [ "${#red[@]}" -gt 0 ]; then
  echo "nightly red on ${NIGHTLY_SHA:-$(git rev-parse HEAD)}: ${red[*]}"
  exit 1
fi
echo "nightly green on ${NIGHTLY_SHA:-$(git rev-parse HEAD)}"
