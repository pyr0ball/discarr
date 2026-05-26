#!/usr/bin/env bash
#
# qbittorrent-notify.sh — Discarr disc-rip notification hook for qBittorrent
# Relative Path: ./projects/discarr/scripts/qbittorrent-notify.sh
#
# Detects VIDEO_TS / BDMV / multi-disk structures in a completed download and
# POSTs a scan job to Discarr.  qBittorrent calls this on torrent completion.
#
# qBittorrent setup:
#   Options → Downloads → "Run external program on torrent completion"
#   Command: /path/to/qbittorrent-notify.sh "%F"
#   (or set DISCARR_URL in environment and call without args using %F as $1)
#
# Environment overrides:
#   DISCARR_URL   — default: http://127.0.0.1:8603
#   DISCARR_LOG   — log file, default: /tmp/discarr-qbit.log
#

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
DISCARR_URL="${DISCARR_URL:-http://127.0.0.1:8603}"
DISCARR_LOG="${DISCARR_LOG:-/tmp/discarr-qbit.log}"
TORRENT_PATH="${1:-${TORRENT_CONTENT_PATH:-}}"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[discarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }
ok()   { echo -e "${GREEN}[discarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }
warn() { echo -e "${YELLOW}[discarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }
err()  { echo -e "${RED}[discarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ -z "$TORRENT_PATH" ]]; then
    err "Usage: $0 <torrent-content-path>"
    exit 1
fi

if [[ ! -e "$TORRENT_PATH" ]]; then
    err "Path does not exist: $TORRENT_PATH"
    exit 1
fi

log "Checking download: $TORRENT_PATH"

# ── Disc structure detection ──────────────────────────────────────────────────
# Walk the path (and one level deep) looking for disc layouts
detect_disc_path() {
    local base="$1"

    # Direct VIDEO_TS or BDMV at root
    if [[ -d "$base/VIDEO_TS" ]] || [[ -d "$base/BDMV" ]]; then
        echo "$base"; return 0
    fi

    # Multi-disk: Disk1/, Disc1/, DISK_1/ … containing VIDEO_TS or BDMV
    local found_multi=0
    while IFS= read -r -d '' subdir; do
        local dname
        dname=$(basename "$subdir")
        if [[ "$dname" =~ ^[Dd]is[ck][[:space:]_-]?[0-9]+$ ]]; then
            if [[ -d "$subdir/VIDEO_TS" ]] || [[ -d "$subdir/BDMV" ]]; then
                found_multi=1
            fi
        fi
    done < <(find "$base" -maxdepth 1 -mindepth 1 -type d -print0 2>/dev/null)

    if [[ $found_multi -eq 1 ]]; then
        echo "$base"; return 0
    fi

    # ISO files at root
    local iso_count
    iso_count=$(find "$base" -maxdepth 1 -name '*.iso' -o -name '*.ISO' 2>/dev/null | wc -l)
    if [[ "$iso_count" -gt 0 ]]; then
        echo "$base"; return 0
    fi

    return 1
}

DISC_PATH=""
if [[ -d "$TORRENT_PATH" ]]; then
    DISC_PATH=$(detect_disc_path "$TORRENT_PATH") || true
elif [[ "$TORRENT_PATH" =~ \.[Ii][Ss][Oo]$ ]]; then
    DISC_PATH=$(dirname "$TORRENT_PATH")
fi

if [[ -z "$DISC_PATH" ]]; then
    log "No disc structure detected — skipping (not a disc rip)"
    exit 0
fi

ok "Disc structure found at: $DISC_PATH"

# ── Notify Discarr ────────────────────────────────────────────────────────────
log "POSTing scan job to $DISCARR_URL ..."

RESPONSE=$(curl -s --max-time 10 \
    -X POST "$DISCARR_URL/api/scan" \
    -H 'Content-Type: application/json' \
    -d "{\"path\": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$DISC_PATH")}" \
    2>&1) || {
    err "Failed to contact Discarr at $DISCARR_URL"
    exit 1
}

JOB_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || true)

if [[ -n "$JOB_ID" ]]; then
    ok "Scan queued — job ID: $JOB_ID"
    ok "Open Discarr to map episodes: $DISCARR_URL"
else
    err "Unexpected response from Discarr: $RESPONSE"
    exit 1
fi
