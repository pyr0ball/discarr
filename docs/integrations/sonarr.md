# Sonarr Integration

Discarr notifies Sonarr when an encode completes so it can trigger an import scan automatically.

## 1. Add the notification hook

In Sonarr, go to **Settings → Connect → Add Connection → Custom Script**.

| Field | Value |
|---|---|
| Name | `Discarr` |
| Path | `/opt/discarr/scripts/sonarr-notify.sh` |
| On Import | ✓ |
| On Episode File Delete | ✓ |

!!! note "Docker installs"
    If Sonarr runs in Docker, the script path must be accessible inside the Sonarr container. Mount the Discarr scripts directory as a volume, or copy the script into a shared config directory.

## 2. Configure the API key

In `~/.config/media-postprocessor/api-keys.conf`:

```bash
SONARR_URL=http://your-sonarr-host:8989/sonarr
SONARR_API_KEY=your-sonarr-api-key
```

Find your API key in Sonarr under **Settings → General → Security → API Key**.

## 3. How it works

When Discarr finishes an encode, it calls the Sonarr API to trigger a rescan on the target path. Sonarr picks up the new file and handles the rename and library update.

```
Encode completes
      │
      ▼
sonarr-notify.sh
      │  POST /api/v3/command
      │  {"name": "RescanSeries", "seriesId": <id>}
      ▼
Sonarr imports file
```

## 4. Test the connection

In Sonarr, click **Test** on the connection you just added. You should see a success notification.

To test end-to-end, queue a small encode in Discarr and watch **Activity → Queue** in Sonarr for the import.
