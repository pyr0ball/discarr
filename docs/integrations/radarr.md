# Radarr Integration

Discarr notifies Radarr when a movie encode completes so it can trigger an import scan automatically.

## 1. Add the notification hook

In Radarr, go to **Settings → Connect → Add Connection → Custom Script**.

| Field | Value |
|---|---|
| Name | `Discarr` |
| Path | `/opt/discarr/scripts/radarr-notify.sh` |
| On Import | ✓ |
| On Movie File Delete | ✓ |

## 2. Configure the API key

In `~/.config/media-postprocessor/api-keys.conf`:

```bash
RADARR_URL=http://your-radarr-host:7878/radarr
RADARR_API_KEY=your-radarr-api-key
```

Find your API key in Radarr under **Settings → General → Security → API Key**.

## 3. How it works

```
Encode completes
      │
      ▼
radarr-notify.sh
      │  POST /api/v3/command
      │  {"name": "RescanMovie", "movieId": <id>}
      ▼
Radarr imports file
```

## 4. Test the connection

Click **Test** on the connection in Radarr. To test end-to-end, queue a movie encode in Discarr and watch **Activity → Queue** in Radarr for the import.
