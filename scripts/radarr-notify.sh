#!/usr/bin/env bash
#
# radarr-notify.sh — Discarr integration hook for Radarr custom scripts
# Relative Path: ./projects/discarr/scripts/radarr-notify.sh
#
# Radarr calls this script on various events.
#
# Radarr setup:
#   Settings → Connect → Custom Script
#   Path: /path/to/radarr-notify.sh
#   Notification Triggers: On Import, On Movie File Delete (optional)
#
# Radarr passes event data as environment variables. Key ones used here:
#   radarr_eventtype          — Download, MovieFileDelete, Test, etc.
#   radarr_movie_title        — Movie title
#   radarr_movie_year         — Release year
#   radarr_movie_path         — Root folder path of the movie
#   radarr_moviefile_path     — Full path of the imported file
#   radarr_moviefile_quality  — Quality profile name
#
# Environment overrides:
#   DISCARR_URL   — default: http://127.0.0.1:8603
#   DISCARR_LOG   — log file, default: /tmp/discarr-radarr.log
#

set -euo pipefail

DISCARR_URL="${DISCARR_URL:-http://127.0.0.1:8603}"
DISCARR_LOG="${DISCARR_LOG:-/tmp/discarr-radarr.log}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[discarr/radarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }
ok()   { echo -e "${GREEN}[discarr/radarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }
warn() { echo -e "${YELLOW}[discarr/radarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }

EVENT="${radarr_eventtype:-}"
MOVIE="${radarr_movie_title:-unknown}"
YEAR="${radarr_movie_year:-}"
MOVIE_PATH="${radarr_movie_path:-}"
FILE_PATH="${radarr_moviefile_path:-}"
QUALITY="${radarr_moviefile_quality:-}"

log "Event: ${EVENT} — ${MOVIE} (${YEAR})"

case "$EVENT" in

  Test)
    ok "Test event received — Discarr hook is working."
    exit 0
    ;;

  Download|MovieFileImport)
    ok "Movie imported: ${MOVIE} (${YEAR}) — ${FILE_PATH} [${QUALITY}]"

    # Notify Discarr of the completed import (for job tracking)
    if [[ -n "$MOVIE_PATH" ]]; then
        log "Notifying Discarr of import..."
        curl -s --max-time 10 \
            -X POST "${DISCARR_URL}/api/notify/radarr" \
            -H 'Content-Type: application/json' \
            -d "{\"event\":\"import\",\"moviePath\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$MOVIE_PATH"),\"filePath\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "${FILE_PATH:-}")}" \
            2>/dev/null || warn "Could not reach Discarr (non-fatal)"
    fi
    ;;

  MovieFileDelete)
    warn "Movie file deleted: ${MOVIE} (${YEAR}) — ${FILE_PATH}"
    warn "Slot is now open — consider re-ripping from disc via Discarr: ${DISCARR_URL}"
    ;;

  MovieDelete)
    warn "Movie deleted from Radarr: ${MOVIE} (${YEAR})"
    ;;

  *)
    log "Unhandled event type: ${EVENT} — no action taken"
    ;;
esac

exit 0
