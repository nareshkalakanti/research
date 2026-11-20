#!/usr/bin/env bash
# Back up every data/*.db to Cloudflare R2.
#
#   npm run db:backup            one backup now
#   scripts/db-backup.sh --loop 3600   every hour (started by `npm run dev:bg`)
#
# Safe with the app running: each database is copied with SQLite's online
# backup (a short read, no checkpoint, no change to the live file), checked
# with quick_check, gzipped and uploaded. A copy that fails the check is never
# uploaded, so a good backup is never replaced by a broken one.
#
# R2 layout (bucket R2_BUCKET, default research-db-backup):
#   [<R2_MACHINE>/]latest/<name>.db.gz           newest copy of each database
#   [<R2_MACHINE>/]daily/YYYY-MM-DD/<name>.db.gz  one per day; older than KEEP_DAYS removed
# R2_MACHINE is unset on the main machine; give any other machine its own name
# so two machines never overwrite each other's backups.
#
# Free-tier guard rails (R2 free tier: 10 GB storage, 1M writes/month, free
# downloads). This script stays far below and refuses to go further:
#   - uploads only databases that changed since the last backup
#   - the daily copy is made once per day, not every run
#   - stops uploading for the month at MAX_WRITES_PER_MONTH (300k = 30% of free)
#   - refuses any file over 1 GB or a backup set over 3 GB compressed
#   - never runs more often than every 30 minutes
#
# Credentials come from .env.local (never printed):
#   LITESTREAM_ACCESS_KEY_ID, LITESTREAM_SECRET_ACCESS_KEY, R2_ENDPOINT, [R2_BUCKET]
set -uo pipefail
cd "$(dirname "$0")/.."

KEEP_DAYS="${KEEP_DAYS:-14}"
MAX_WRITES_PER_MONTH=300000
MAX_FILE_BYTES=$((1024 * 1024 * 1024))       # 1 GB compressed
MAX_SET_BYTES=$((3 * 1024 * 1024 * 1024))    # 3 GB compressed
MIN_LOOP_SECONDS=1800
STATE=logs/r2-state; mkdir -p "$STATE"
# Rebuildable caches / leftovers that are not worth the space.
SKIP_RE='^(rotation_bars)\.db$'

# Environment first (e.g. R2_MACHINE=laptop npm run db:backup), then .env.local.
envval() { if [[ -n "${!1:-}" ]]; then printf %s "${!1}"; else grep -E "^$1=" .env.local 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' \r"; fi; }
KEY="$(envval LITESTREAM_ACCESS_KEY_ID)"
SECRET="$(envval LITESTREAM_SECRET_ACCESS_KEY)"
ENDPOINT="$(envval R2_ENDPOINT)"; ENDPOINT="${ENDPOINT%/}"
BUCKET="$(envval R2_BUCKET)"; BUCKET="${BUCKET:-research-db-backup}"
MACHINE="$(envval R2_MACHINE | tr -cd 'A-Za-z0-9_-')"
ROOT="${MACHINE:+$MACHINE/}"
if [[ -z "$KEY" || -z "$SECRET" || -z "$ENDPOINT" ]]; then
  echo "db-backup: R2 settings missing in .env.local" >&2
  exit 1
fi

r2() { curl -sS --fail-with-body --retry 3 --aws-sigv4 "aws:amz:auto:s3" --user "$KEY:$SECRET" "$@"; }

# Count every write-type request (PUT / LIST / DELETE) per calendar month.
ops_file() { echo "$STATE/writes-$(date -u +%Y-%m)"; }
writes_used() { cat "$(ops_file)" 2>/dev/null || echo 0; }
count_write() { echo $(( $(writes_used) + ${1:-1} )) > "$(ops_file)"; }
budget_ok() { [[ $(( $(writes_used) + ${1:-1} )) -le $MAX_WRITES_PER_MONTH ]]; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

backup_once() {
  local day tmp ok=0 same=0 bad=0 total=0 set_bytes=0
  day="$(date -u +%F)"
  tmp="$(mktemp -d)"
  if ! budget_ok 100; then
    echo "$(date '+%F %T') db-backup: monthly write budget reached ($(writes_used)/$MAX_WRITES_PER_MONTH) — skipped, nothing uploaded"
    rm -rf "$tmp"; return 1
  fi
  for db in data/*.db; do
    local name; name="$(basename "$db")"
    [[ "$name" =~ $SKIP_RE ]] && continue
    [[ -s "$db" ]] || continue
    total=$((total + 1))
    if ! sqlite3 "$db" ".timeout 15000" ".backup '$tmp/$name'" 2>/dev/null; then
      echo "  ✗ $name: backup copy failed"; bad=$((bad + 1)); continue
    fi
    if [[ "$(sqlite3 "$tmp/$name" 'pragma quick_check' 2>&1 | head -1)" != "ok" ]]; then
      echo "  ✗ $name: copy failed quick_check — not uploaded"; bad=$((bad + 1)); rm -f "$tmp/$name"; continue
    fi
    # Content hash of the database itself (gzip output varies with time stamps).
    local h; h="$(sha "$tmp/$name")"
    gzip -9 -n -c "$tmp/$name" > "$tmp/$name.gz"; rm -f "$tmp/$name"
    local bytes; bytes=$(stat -f%z "$tmp/$name.gz" 2>/dev/null || stat -c%s "$tmp/$name.gz")
    set_bytes=$((set_bytes + bytes))
    if [[ $bytes -gt $MAX_FILE_BYTES || $set_bytes -gt $MAX_SET_BYTES ]]; then
      echo "  ✗ $name: over the size guard ($bytes bytes, set $set_bytes) — not uploaded"; bad=$((bad + 1)); rm -f "$tmp/$name.gz"; continue
    fi
    local need_latest=1 need_daily=1
    [[ "$(cat "$STATE/$name.sha" 2>/dev/null)" == "$h" ]] && need_latest=0
    [[ -f "$STATE/daily-$day-$name" ]] && need_daily=0
    if [[ $need_latest -eq 0 && $need_daily -eq 0 ]]; then
      same=$((same + 1)); rm -f "$tmp/$name.gz"; continue
    fi
    if ! budget_ok 2; then
      echo "  ✗ $name: monthly write budget reached — not uploaded"; bad=$((bad + 1)); rm -f "$tmp/$name.gz"; continue
    fi
    local up_ok=1
    if [[ $need_latest -eq 1 ]]; then
      count_write
      r2 -o /dev/null -T "$tmp/$name.gz" "$ENDPOINT/$BUCKET/${ROOT}latest/$name.gz" && echo "$h" > "$STATE/$name.sha" || up_ok=0
    fi
    if [[ $up_ok -eq 1 && $need_daily -eq 1 ]]; then
      count_write
      r2 -o /dev/null -T "$tmp/$name.gz" "$ENDPOINT/$BUCKET/${ROOT}daily/$day/$name.gz" && touch "$STATE/daily-$day-$name" || up_ok=0
    fi
    if [[ $up_ok -eq 1 ]]; then ok=$((ok + 1)); else echo "  ✗ $name: upload failed"; bad=$((bad + 1)); fi
    rm -f "$tmp/$name.gz"
  done
  rm -rf "$tmp"
  # Prune at most once a day (it lists + deletes).
  if [[ ! -f "$STATE/pruned-$day" ]]; then prune_daily && touch "$STATE/pruned-$day"; fi
  find "$STATE" -name 'daily-*' -mtime +3 -delete 2>/dev/null; find "$STATE" -name 'pruned-*' -mtime +3 -delete 2>/dev/null
  local failed=""; [[ $bad -gt 0 ]] && failed=", $bad failed"
  echo "$(date '+%F %T') db-backup: $ok uploaded, $same unchanged of $total$failed · writes this month $(writes_used)/$MAX_WRITES_PER_MONTH · r2://$BUCKET/${ROOT}latest/"
  [[ $bad -eq 0 ]]
}

# Drop daily/<date>/ folders older than KEEP_DAYS.
prune_daily() {
  local cutoff keys
  cutoff="$(date -u -v-"${KEEP_DAYS}"d +%F 2>/dev/null || date -u -d "-${KEEP_DAYS} days" +%F)"
  budget_ok 1 || return 0
  count_write
  keys="$(r2 "$ENDPOINT/$BUCKET?list-type=2&prefix=${ROOT}daily/&max-keys=1000" 2>/dev/null | grep -oE '<Key>[^<]+</Key>' | sed -E 's#</?Key>##g')"
  while IFS= read -r k; do
    [[ -z "$k" ]] && continue
    local d="${k#"${ROOT}"daily/}"; d="${d%%/*}"
    if [[ "$d" < "$cutoff" ]]; then count_write; r2 -o /dev/null -X DELETE "$ENDPOINT/$BUCKET/$k" || true; fi
  done <<< "$keys"
}

if [[ "${1:-}" == "--loop" ]]; then
  every="${2:-3600}"
  [[ "$every" =~ ^[0-9]+$ && $every -ge $MIN_LOOP_SECONDS ]] || every=$MIN_LOOP_SECONDS
  while true; do
    backup_once || true
    sleep "$every"
  done
else
  backup_once
fi
