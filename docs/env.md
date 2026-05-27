# Environment Variables

All variables can be set in the config file (`api-keys.conf`) or as environment variables. Environment variables take precedence.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8603` | Web UI port |
| `DISCARR_CONFIG` | `~/.config/media-postprocessor/api-keys.conf` | Config file path |
| `DISCARR_LOG` | `~/.local/share/discarr/jobs.log` | Job log file |
| `DISCARR_QUEUE` | `~/.local/share/discarr/pending-queue.json` | Persistent queue file |
| `DISCARR_URL` | `http://127.0.0.1:8603` | Discarr's own URL (used by hook scripts) |
| `SONARR_URL` | — | Sonarr base URL |
| `SONARR_API_KEY` | — | Sonarr API key |
| `RADARR_URL` | — | Radarr base URL |
| `RADARR_API_KEY` | — | Radarr API key |
| `DISCARR_TRANSCODER` | `ffmpeg` | Transcoder: `ffmpeg` or `handbrake` |
| `FFMPEG_ARGS` | see config | ffmpeg encode arguments |
| `HANDBRAKE_PRESET` | `H.265 MKV 1080p30` | HandBrake preset name |
| `SSH_TRANSCODE_HOST` | — | Remote SSH encode host |
| `SSH_TRANSCODE_USER` | — | SSH user on remote host |
| `SSH_TRANSCODE_MEDIA_ROOT` | — | Media root path on remote host |
| `SSH_TRANSCODE_KEY` | `~/.ssh/id_rsa` | SSH private key path |
| `QBIT_URL` | — | qBittorrent Web UI URL |
| `QBIT_USER` | — | qBittorrent username |
| `QBIT_PASS` | — | qBittorrent password |
| `TDARR_URL` | — | Tdarr Web UI URL |
