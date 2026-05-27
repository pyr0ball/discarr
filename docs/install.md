# Installation

## Native installer (recommended)

The installer handles Node.js, ffmpeg, HandBrake CLI, and DVD libraries automatically.

**Supported platforms:** Ubuntu/Debian (apt), Fedora/RHEL (dnf), Arch Linux (pacman), macOS (brew)

```bash
git clone https://git.opensourcesolarpunk.com/Circuit-Forge/discarr
cd discarr
sudo bash install.sh
```

The installer will ask whether to register a systemd service.

### Installer options

Override defaults with environment variables:

```bash
sudo DISCARR_INSTALL_DIR=/opt/discarr \
     DISCARR_PORT=8603 \
     REGISTER_SERVICE=yes \
     bash install.sh
```

| Variable | Default | Description |
|---|---|---|
| `DISCARR_INSTALL_DIR` | `/opt/discarr` | Where to install app files |
| `DISCARR_USER` | `discarr` | System user for the service |
| `DISCARR_PORT` | `8603` | Web UI port |
| `REGISTER_SERVICE` | `ask` | `ask`, `yes`, or `no` |
| `SKIP_DEPS` | `0` | Set to `1` to skip system dep installation |

### What gets installed

| Dependency | apt | dnf | pacman | brew |
|---|---|---|---|---|
| Node.js 20 LTS | NodeSource | NodeSource | nodejs | node@20 |
| ffmpeg + ffprobe | ffmpeg | ffmpeg (RPM Fusion) | ffmpeg | ffmpeg |
| HandBrake CLI | handbrake-cli | HandBrake-cli | handbrake-cli | handbrake |
| libdvdcss | libdvd-pkg | libdvdcss (RPM Fusion) | libdvdcss | libdvdcss |
| libdvdread | libdvdread8 | libdvdread | libdvdread | — |
| libdvdnav | libdvdnav4 | libdvdnav | libdvdnav | — |

!!! note "libdvdcss on Ubuntu"
    Ubuntu's `libdvd-pkg` builds libdvdcss from source using `dpkg-reconfigure`. The installer handles this automatically. Legal in most jurisdictions for personal use.

!!! note "HandBrake on Fedora"
    Requires RPM Fusion. The installer enables it automatically when installing ffmpeg — HandBrake installs from the same repo.

---

## Docker

Pre-built image — includes ffmpeg, ffprobe, HandBrake CLI, libdvd* libraries, and openssh-client:

```bash
docker run -d \
  --name discarr \
  -p 8603:8603 \
  -v ~/.config/media-postprocessor:/root/.config/media-postprocessor:ro \
  -v ~/.local/share/discarr:/root/.local/share/discarr \
  -v /path/to/media:/media \
  pyr0ball/discarr:latest
```

### Docker Compose

```yaml
services:
  discarr:
    image: pyr0ball/discarr:latest
    container_name: discarr
    ports:
      - "8603:8603"
    volumes:
      - ~/.config/media-postprocessor:/root/.config/media-postprocessor:ro
      - discarr-data:/root/.local/share/discarr
      - /path/to/media:/media
    restart: unless-stopped
    environment:
      - PORT=8603

volumes:
  discarr-data:
```

!!! warning "Media path"
    The `/media` mount must be the same path that Sonarr/Radarr can also see. If your arr apps run in Docker, make sure they share the same media volume or NFS mount.

---

## Manual (from source)

Install system dependencies yourself (see table above), then:

```bash
git clone https://git.opensourcesolarpunk.com/Circuit-Forge/discarr
cd discarr

# Configure
mkdir -p ~/.config/media-postprocessor
cp api-keys.conf.example ~/.config/media-postprocessor/api-keys.conf
$EDITOR ~/.config/media-postprocessor/api-keys.conf

# Run
node server.js
```
