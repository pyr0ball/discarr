# qBittorrent Integration

Configure qBittorrent to notify Discarr when a torrent finishes downloading, so disc rips downloaded as torrents are scanned automatically.

## 1. Add the run-on-completion script

In qBittorrent, go to **Tools → Options → Downloads**.

Under **Run external program on torrent completion**, enter:

```
/opt/discarr/scripts/qbittorrent-notify.sh "%D"
```

`%D` passes the save path of the completed torrent to the script.

## 2. Configure qBittorrent credentials

In `~/.config/media-postprocessor/api-keys.conf`:

```bash
QBIT_URL=http://your-qbit-host:8080
QBIT_USER=admin
QBIT_PASS=your-password
```

## 3. How it works

When a torrent completes, qBittorrent runs the script with the download directory. The script checks if the directory contains a disc structure (VIDEO_TS, BDMV, or ISO) and, if so, submits it to Discarr's scan queue automatically.

```
Torrent completes
      │
      ▼
qbittorrent-notify.sh "%D"
      │  checks for disc structure
      │  POST /api/scan {"path": "/media/downloads/..."}
      ▼
Discarr scan queue
```

## 4. DISCARR_URL

The script uses `DISCARR_URL` to find the Discarr instance. If qBittorrent and Discarr are not on the same host, set this in the config file:

```bash
DISCARR_URL=http://discarr-host:8603
```
