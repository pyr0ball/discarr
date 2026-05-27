# Configuration Reference

All configuration lives in `~/.config/media-postprocessor/api-keys.conf`.

Every key can also be set as an environment variable — **env vars take precedence over the config file**.

---

## Sonarr

```bash
SONARR_URL=http://your-sonarr-host:8989/sonarr
SONARR_API_KEY=your-sonarr-api-key
```

Find your API key in Sonarr under **Settings → General → Security → API Key**.

---

## Radarr

```bash
RADARR_URL=http://your-radarr-host:7878/radarr
RADARR_API_KEY=your-radarr-api-key
```

Find your API key in Radarr under **Settings → General → Security → API Key**.

---

## Encode settings

```bash
# Transcoder to use: ffmpeg (default) or handbrake
DISCARR_TRANSCODER=ffmpeg

# ffmpeg encode preset (used when DISCARR_TRANSCODER=ffmpeg)
# Default produces a reasonable HEVC/H.265 encode at CRF 22
FFMPEG_ARGS=-c:v libx265 -crf 22 -preset medium -c:a aac -b:a 192k

# HandBrake preset name (used when DISCARR_TRANSCODER=handbrake)
HANDBRAKE_PRESET=H.265 MKV 1080p30
```

---

## SSH transcode worker

When set, Discarr sends encode jobs to a remote host over SSH instead of running them locally.

```bash
SSH_TRANSCODE_HOST=encode-box
SSH_TRANSCODE_USER=mediauser
SSH_TRANSCODE_MEDIA_ROOT=/media
# Optional: override SSH key path (defaults to ~/.ssh/id_rsa)
SSH_TRANSCODE_KEY=~/.ssh/id_ed25519
```

See [SSH Transcode Workers](transcoders/ssh-workers.md) for setup instructions.

---

## Discarr runtime

```bash
# Web UI port (default: 8603)
PORT=8603

# Config file path (default: ~/.config/media-postprocessor/api-keys.conf)
DISCARR_CONFIG=~/.config/media-postprocessor/api-keys.conf

# Job log path
DISCARR_LOG=~/.local/share/discarr/jobs.log

# Pending queue path
DISCARR_QUEUE=~/.local/share/discarr/pending-queue.json

# Discarr's own URL (used by notification hook scripts)
DISCARR_URL=http://127.0.0.1:8603
```

---

## qBittorrent integration

```bash
# qBittorrent Web UI URL
QBIT_URL=http://your-qbit-host:8080
QBIT_USER=admin
QBIT_PASS=your-password
```

See [qBittorrent integration](integrations/qbittorrent.md).

---

## Tdarr integration

```bash
TDARR_URL=http://your-tdarr-host:8265
```

See [Tdarr integration](integrations/tdarr.md).
