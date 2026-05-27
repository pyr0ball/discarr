# Discarr

**Scan disc rips. Map titles. Queue HEVC encodes. Notify Sonarr and Radarr when done.**

Discarr is a self-hosted web UI that bridges disc ripping (VIDEO_TS / BDMV / ISO) into Sonarr and Radarr. Point it at a disc directory, map each title to the right episode or movie, and it handles the encode queue and arr notification.

---

## How it works

```
Disc rip (MakeMKV / HandBrake)
        │
        ▼
  Discarr web UI
  ┌─────────────────────────────┐
  │  1. Scan disc structure     │
  │  2. Map titles → arr items  │
  │  3. Queue HEVC encode       │
  │  4. Notify Sonarr / Radarr  │
  └─────────────────────────────┘
        │
        ▼
  Sonarr / Radarr import
```

## Features

- **Disc scanning** — detects VIDEO_TS, BDMV, multi-disc, and ISO structures automatically
- **IFO chapter extraction** — reads DVD structure to split multi-episode discs correctly
- **Episode/movie mapping** — browser UI maps disc titles to Sonarr episodes or Radarr movies
- **HEVC encode queue** — dispatches ffmpeg or HandBrake jobs locally or over SSH
- **Arr notification** — custom script hooks notify on import, file delete, or completion
- **qBittorrent integration** — optional hook triggers a scan on torrent completion
- **Tdarr integration** — optional ping to Tdarr after encode completes
- **Persistent job queue** — survives restarts; jobs resume automatically
- **No npm dependencies** — pure Node.js built-ins only

## Requirements

| Dependency | Required | Notes |
|---|---|---|
| Node.js 18+ | Yes | Runtime |
| ffmpeg + ffprobe | Yes | Disc scanning, encode dispatch |
| HandBrake CLI | Recommended | HEVC encoding (falls back to ffmpeg) |
| libdvdcss | Recommended | CSS-encrypted DVD decryption |
| libdvdread + libdvdnav | Yes (DVD) | DVD structure reading |

## Quick links

- [Installation guide](install.md)
- [Quick start](quickstart.md)
- [Configuration reference](config.md)
- [Sonarr integration](integrations/sonarr.md)
- [SSH transcode workers](transcoders/ssh-workers.md)

## License

GPL-3.0. Source on [Forgejo](https://git.opensourcesolarpunk.com/Circuit-Forge/discarr) and [GitHub](https://github.com/pyr0ball/discarr).
