# Troubleshooting

## Discarr won't start

**Check Node.js version:**

```bash
node --version  # must be 18+
```

**Check for port conflict:**

```bash
ss -tlnp | grep 8603
# Change port with: PORT=8604 node server.js
```

**Check logs (if running as a service):**

```bash
journalctl -u discarr -f
```

---

## Scan returns no titles

**ffprobe not found:**

```bash
which ffprobe  # must be in PATH
ffprobe -version
```

**Disc structure not recognised:**

- Ensure the path points to the directory containing `VIDEO_TS` or `BDMV`, not inside it
- For ISOs, pass the full path including the `.iso` extension
- Check read permissions: `ls -la /path/to/disc`

**Encrypted DVD:**

```bash
dpkg -l libdvd-pkg 2>/dev/null || rpm -q libdvdcss 2>/dev/null
# Reinstall if missing — see Installation guide
```

---

## Encode fails immediately

**ffmpeg not found:**

```bash
which ffmpeg && ffmpeg -version
```

**HandBrake preset not found:**

```bash
HandBrakeCLI --preset-list | grep "H.265"
```

Check `HANDBRAKE_PRESET` matches exactly (case-sensitive).

**Disk space:**

```bash
df -h /tmp ~/.local/share/discarr
# Full HEVC encodes need 50–100 GB of temp space for large discs
```

---

## Sonarr/Radarr not importing after encode

**Check hook scripts are executable:**

```bash
ls -la /opt/discarr/scripts/
chmod +x /opt/discarr/scripts/*.sh
```

**Test the hook manually:**

```bash
DISCARR_URL=http://127.0.0.1:8603 /opt/discarr/scripts/sonarr-notify.sh
```

**Check API key:**

```bash
curl -s "http://your-sonarr-host:8989/sonarr/api/v3/system/status" \
  -H "X-Api-Key: your-api-key" | python3 -m json.tool | head -5
```

**Check Sonarr logs:**

Sonarr: **System → Logs** — look for connection errors from the Custom Script hook.

---

## SSH transcode not working

**Test SSH connection:**

```bash
ssh -i ~/.ssh/id_ed25519 user@remote-host echo "OK"
```

**Check ffmpeg on remote:**

```bash
ssh user@remote-host which ffmpeg
```

**Check disk space on remote:**

```bash
ssh user@remote-host df -h /media
```

---

## Jobs stuck in queue after restart

The queue file persists across restarts at `~/.local/share/discarr/pending-queue.json`.

To clear a stuck job:

```bash
# Edit the queue file and remove the stuck entry
$EDITOR ~/.local/share/discarr/pending-queue.json
systemctl restart discarr
```

Or clear the whole queue:

```bash
echo '[]' > ~/.local/share/discarr/pending-queue.json
systemctl restart discarr
```
