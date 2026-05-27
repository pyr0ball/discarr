# SSH Transcode Workers

Offload encoding to a remote machine over SSH. Useful when your NAS or media server is low-powered and you have a separate box with more CPU or a GPU encoder.

## How it works

When SSH transcode is configured, Discarr:

1. Copies the source disc files to the remote host over SCP
2. Runs ffmpeg or HandBrake on the remote machine
3. Copies the encoded output back
4. Triggers the arr notification from the local machine

```
Discarr (local)
      │
      │  scp source files →
      ▼
Remote encode host (SSH)
      │  ffmpeg / HandBrake
      │
      │  ← scp encoded output
      ▼
Discarr (local)
      │  notify Sonarr/Radarr
      ▼
Arr import
```

## Configuration

```bash
SSH_TRANSCODE_HOST=encode-box         # hostname or IP of the encode machine
SSH_TRANSCODE_USER=mediauser           # SSH user on that machine
SSH_TRANSCODE_MEDIA_ROOT=/media   # path where media is accessible on the remote
SSH_TRANSCODE_KEY=~/.ssh/id_ed25519  # optional: SSH key (defaults to ~/.ssh/id_rsa)
```

## Setting up SSH key auth

Generate a key pair if you don't have one:

```bash
ssh-keygen -t ed25519 -C "discarr-transcode"
```

Copy the public key to the remote host:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub mediauser@encode-box
```

Verify passwordless login:

```bash
ssh -i ~/.ssh/id_ed25519 mediauser@encode-box echo "OK"
```

## Shared media mount (recommended)

If both machines mount the same NFS share, Discarr can skip the SCP copy entirely — it passes the already-accessible path directly to the remote transcoder.

Set the same `SSH_TRANSCODE_MEDIA_ROOT` as the NFS mount point on the remote:

```bash
SSH_TRANSCODE_MEDIA_ROOT=/mnt/media  # must match the NFS mount on the remote
```

Discarr detects the shared mount and avoids copying.

## Requirements on the remote host

- `ffmpeg` + `ffprobe` (always)
- `HandBrakeCLI` (if using HandBrake as the transcoder)
- SSH server running and accessible from the Discarr host
- Write access to `SSH_TRANSCODE_MEDIA_ROOT`

## Tips

- Use a dedicated SSH key for Discarr rather than your personal key
- If encoding stalls, check disk space on the remote — HEVC encodes of full discs can use 50–100 GB of temp space
- For GPU-accelerated remote encoding (NVENC), make sure the ffmpeg on the remote is built with NVENC support: `ffmpeg -encoders | grep nvenc`
