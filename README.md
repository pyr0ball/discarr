# Discarr

> Disc scanning and HEVC encoding queue for Sonarr/Radarr.

Discarr is a lightweight web UI that scans DVD and Blu-ray directory structures (`VIDEO_TS` / `BDMV`), lets you map raw VOBs to Sonarr episodes or Radarr movies, queues HEVC encodes via ffmpeg (local or SSH to a remote host), and notifies Sonarr/Radarr on completion.

---

## What it does

| Stage | Details |
|---|---|
| **Scan** | Detect `VIDEO_TS` / `BDMV` structures and parse IFO chapters |
| **Map** | Web UI to match disc titles to Sonarr episodes or Radarr movies |
| **Encode** | Queue HEVC encodes via ffmpeg or HandBrake (local or SSH) |
| **Notify** | Call Sonarr/Radarr import on completion; optionally notify Tdarr |

---

## Requirements

- Node.js 18+
- ffmpeg and ffprobe (for metadata scanning)
- Docker (optional — image included)

---

## Install

```bash
git clone https://git.opensourcesolarpunk.com/Circuit-Forge/discarr
cd discarr
```

No npm dependencies — pure Node.js built-ins only.

### Config

```bash
mkdir -p ~/.config/media-postprocessor
cp api-keys.conf.example ~/.config/media-postprocessor/api-keys.conf
# Edit api-keys.conf with your Sonarr/Radarr URLs and API keys
```

All config values can be set as environment variables (env vars override the config file).

### Run

```bash
node server.js
# or: PORT=8603 node server.js
```

Open `http://localhost:8603` in your browser.

### Docker

```bash
docker build -t discarr .
docker run -d \
  -p 8603:8603 \
  -v ~/.config/media-postprocessor:/root/.config/media-postprocessor:ro \
  -v ~/.local/share/discarr:/root/.local/share/discarr \
  -v /path/to/media:/media \
  discarr
```

---

## Notification hooks

Drop the scripts from `scripts/` as custom script hooks in Sonarr/Radarr/qBittorrent:

| Script | Trigger |
|---|---|
| `scripts/sonarr-notify.sh` | Sonarr: Settings → Connect → Custom Script (On Import, On Episode File Delete) |
| `scripts/radarr-notify.sh` | Radarr: Settings → Connect → Custom Script (On Import, On Movie File Delete) |
| `scripts/qbittorrent-notify.sh` | qBittorrent: Options → Downloads → "Run external program on torrent completion" |

All scripts use `DISCARR_URL` env var (default: `http://127.0.0.1:8603`).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8603` | Web UI port |
| `DISCARR_CONFIG` | `~/.config/media-postprocessor/api-keys.conf` | Config file path |
| `DISCARR_LOG` | `~/.local/share/discarr/jobs.log` | Job log path |
| `DISCARR_QUEUE` | `~/.local/share/discarr/pending-queue.json` | Pending queue path |
| `DISCARR_SETTINGS` | Same dir as queue | Runtime settings overlay |

---

## License

MIT
