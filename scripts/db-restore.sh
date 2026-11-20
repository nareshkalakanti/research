#!/usr/bin/env bash
# Restore databases from Cloudflare R2 (see scripts/db-backup.sh).
#
#   npm run db:restore                      all databases, newest copy
#   npm run db:restore -- governance.db     one database
#   DAY=2026-11-19 npm run db:restore       from a daily backup
#   FROM=laptop npm run db:restore          from another machine's backups
#   FROM=main npm run db:restore            from the main machine (no R2_MACHINE)
# Default source: this machine's own backups (R2_MACHINE), else the main ones.
#
# Stop the app first (npm run dev:stop). Each current file is moved to
# data/.pre-restore/<time>/ before it is replaced, and a download that fails
# quick_check is never put in place.
set -uo pipefail
cd "$(dirname "$0")/.."

# --to OUT NAME: download the newest backup of NAME into OUT (verified), used
# by the app's own corruption recovery. Does not touch data/.
TO_OUT=""; TO_NAME=""
if [[ "${1:-}" == "--to" ]]; then TO_OUT="${2:-}"; TO_NAME="${3:-}"; fi

if [[ -z "$TO_OUT" ]] && lsof -ti tcp:3000 >/dev/null 2>&1; then
  echo "db-restore: the app is running on :3000 — run 'npm run dev:stop' first." >&2
  exit 1
fi

# Environment first (e.g. R2_MACHINE=laptop npm run db:backup), then .env.local.
envval() { if [[ -n "${!1:-}" ]]; then printf %s "${!1}"; else grep -E "^$1=" .env.local 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' \r"; fi; }
KEY="$(envval LITESTREAM_ACCESS_KEY_ID)"
SECRET="$(envval LITESTREAM_SECRET_ACCESS_KEY)"
ENDPOINT="$(envval R2_ENDPOINT)"; ENDPOINT="${ENDPOINT%/}"
BUCKET="$(envval R2_BUCKET)"; BUCKET="${BUCKET:-research-db-backup}"
SRC="${FROM-$(envval R2_MACHINE)}"; SRC="$(printf %s "$SRC" | tr -cd 'A-Za-z0-9_-')"
[[ "$SRC" == "main" ]] && SRC=""
ROOT="${SRC:+$SRC/}"
[[ -z "$KEY" || -z "$SECRET" || -z "$ENDPOINT" ]] && { echo "db-restore: R2 settings missing in .env.local" >&2; exit 1; }
r2() { curl -sS --fail-with-body --retry 3 --aws-sigv4 "aws:amz:auto:s3" --user "$KEY:$SECRET" "$@"; }

PREFIX="${ROOT}latest"; [[ -n "${DAY:-}" ]] && PREFIX="${ROOT}daily/$DAY"
if [[ -n "$TO_OUT" ]]; then
  [[ -z "$TO_NAME" ]] && { echo "usage: db-restore.sh --to OUT NAME" >&2; exit 2; }
  r2 -o "$TO_OUT.gz" "$ENDPOINT/$BUCKET/$PREFIX/${TO_NAME%.gz}.gz" || { rm -f "$TO_OUT.gz"; exit 1; }
  gunzip -f "$TO_OUT.gz" || exit 1
  [[ "$(sqlite3 "$TO_OUT" 'pragma quick_check' 2>&1 | head -1)" == "ok" ]] || { rm -f "$TO_OUT"; exit 1; }
  exit 0
fi
if [[ $# -gt 0 ]]; then
  names=("$@")
else
  names=()
  while IFS= read -r n; do [[ -n "$n" ]] && names+=("$n"); done < <(r2 "$ENDPOINT/$BUCKET?list-type=2&prefix=$PREFIX/&max-keys=1000" | grep -oE '<Key>[^<]+</Key>' | sed -E "s#</?Key>##g; s#^$PREFIX/##; s#\.gz\$##")
fi
# A machine with no backups of its own yet starts from the main machine's.
if [[ ${#names[@]} -eq 0 && -z "${FROM+x}" && -n "$ROOT" && $# -eq 0 ]]; then
  echo "db-restore: no backups for '${ROOT%/}' yet — using the main machine's"
  ROOT=""; PREFIX="latest"; [[ -n "${DAY:-}" ]] && PREFIX="daily/$DAY"
  while IFS= read -r n; do [[ -n "$n" ]] && names+=("$n"); done < <(r2 "$ENDPOINT/$BUCKET?list-type=2&prefix=$PREFIX/&max-keys=1000" | grep -oE '<Key>[^<]+</Key>' | sed -E "s#</?Key>##g; s#^$PREFIX/##; s#\.gz\$##")
fi
[[ ${#names[@]} -eq 0 ]] && { echo "db-restore: nothing found under $PREFIX/"; exit 1; }

stamp="$(date +%Y%m%d-%H%M%S)"; keep="data/.pre-restore/$stamp"; tmp="$(mktemp -d)"
ok=0; bad=0
for name in "${names[@]}"; do
  name="${name%.gz}"
  if ! r2 -o "$tmp/$name.gz" "$ENDPOINT/$BUCKET/$PREFIX/$name.gz"; then echo "  ✗ $name: download failed"; bad=$((bad + 1)); continue; fi
  gunzip -f "$tmp/$name.gz"
  if [[ "$(sqlite3 "$tmp/$name" 'pragma quick_check' 2>&1 | head -1)" != "ok" ]]; then echo "  ✗ $name: failed quick_check — kept current file"; bad=$((bad + 1)); continue; fi
  mkdir -p "$keep"
  for f in "data/$name" "data/$name-wal" "data/$name-shm"; do [[ -e "$f" ]] && mv "$f" "$keep/"; done
  mv "$tmp/$name" "data/$name"
  echo "  ✓ $name"; ok=$((ok + 1))
done
rm -rf "$tmp"
msg="db-restore: $ok restored from $PREFIX/"; [[ $bad -gt 0 ]] && msg+=", $bad failed"; [[ $ok -gt 0 ]] && msg+=" · previous files in $keep"
echo "$msg"
