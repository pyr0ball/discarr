#!/usr/bin/env bash
#
# sonarr-notify.sh — Discarr integration hook for Sonarr custom scripts
# Relative Path: ./projects/discarr/scripts/sonarr-notify.sh
#
# Sonarr calls this script on various events. Two useful modes:
#
#   ON DOWNLOAD/IMPORT: Sonarr imported a file — tell Discarr the episode
#   is now on disk (useful if you encoded via Discarr and want confirmation).
#
#   ON EPISODE FILE DELETE: Sonarr removed a file — optionally log it so
#   you know the slot is open for a re-rip.
#
# Sonarr setup:
#   Settings → Connect → Custom Script
#   Path: /path/to/sonarr-notify.sh
#   Notification Triggers: On Import, On Episode File Delete (optional)
#
# Sonarr passes all event data as environment variables. Key ones used here:
#   sonarr_eventtype          — Download, EpisodeFileDelete, Test, etc.
#   sonarr_series_title       — Series name
#   sonarr_series_path        — Root folder path of the series
#   sonarr_episodefile_path   — Full path of the imported file
#   sonarr_episodefile_seasonnumber
#   sonarr_episodefile_episodenumbers
#
# Environment overrides:
#   DISCARR_URL   — default: http://127.0.0.1:8603
#   DISCARR_LOG   — log file, default: /tmp/discarr-sonarr.log
#

set -euo pipefail

DISCARR_URL="${DISCARR_URL:-http://127.0.0.1:8603}"
DISCARR_LOG="${DISCARR_LOG:-/tmp/discarr-sonarr.log}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[discarr/sonarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }
ok()   { echo -e "${GREEN}[discarr/sonarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }
warn() { echo -e "${YELLOW}[discarr/sonarr]${RESET} $*" | tee -a "$DISCARR_LOG"; }

EVENT="${sonarr_eventtype:-}"
SERIES="${sonarr_series_title:-unknown}"
SERIES_PATH="${sonarr_series_path:-}"
FILE_PATH="${sonarr_episodefile_path:-}"
SEASON="${sonarr_episodefile_seasonnumber:-}"
EPISODES="${sonarr_episodefile_episodenumbers:-}"

log "Event: ${EVENT} — ${SERIES} S${SEASON}E${EPISODES}"

case "$EVENT" in

  Test)
    ok "Test event received — Discarr hook is working."
    exit 0
    ;;

  Download|EpisodeFileImport)
    # Sonarr imported an episode. If we can match it back to a Discarr encode
    # job, mark it complete. For now, just log the confirmed import.
    ok "Episode imported: S${SEASON}E${EPISODES} → ${FILE_PATH}"

    # Optional: if the file came from the Discarr output directory, trigger
    # a Sonarr rescan of the series folder to make sure the library is fresh.
    if [[ -n "$SERIES_PATH" ]]; then
        log "Triggering Sonarr rescan of series path (via Discarr passthrough)..."
        curl -s --max-time 10 \
            -X POST "${DISCARR_URL}/api/notify/sonarr" \
            -H 'Content-Type: application/json' \
            -d "{\"event\":\"import\",\"seriesPath\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SERIES_PATH"),\"filePath\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "${FILE_PATH:-}")}" \
            2>/dev/null || warn "Could not reach Discarr (non-fatal)"
    fi
    ;;

  EpisodeFileDelete)
    warn "Episode deleted: S${SEASON}E${EPISODES} — ${FILE_PATH}"
    warn "Slot is now open — consider re-ripping from disc via Discarr: ${DISCARR_URL}"
    ;;

  SeriesDelete)
    warn "Series deleted from Sonarr: ${SERIES}"
    ;;

  *)
    log "Unhandled event type: ${EVENT} — no action taken"
    ;;
esac

exit 0
