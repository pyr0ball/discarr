# ffmpeg

ffmpeg is the default transcoder in Discarr. It handles HEVC encoding and is required for disc metadata scanning regardless of which transcoder you use for encoding.

## Requirements

- `ffmpeg` — encoder
- `ffprobe` — disc metadata scanning (required even if using HandBrake for encoding)

Both are installed by `install.sh` or bundled in the Docker image.

## Encode arguments

Control encode quality and speed with `FFMPEG_ARGS`:

```bash
# Default (CRF 22, medium preset — good quality/size balance)
FFMPEG_ARGS=-c:v libx265 -crf 22 -preset medium -c:a aac -b:a 192k

# Faster encode, slightly larger file
FFMPEG_ARGS=-c:v libx265 -crf 22 -preset fast -c:a aac -b:a 192k

# Smaller file, slower encode
FFMPEG_ARGS=-c:v libx265 -crf 24 -preset slow -c:a aac -b:a 192k

# Hardware-accelerated (NVIDIA NVENC)
FFMPEG_ARGS=-c:v hevc_nvenc -preset p4 -cq 22 -c:a aac -b:a 192k

# Keep all audio tracks (useful for multi-language discs)
FFMPEG_ARGS=-c:v libx265 -crf 22 -preset medium -c:a copy -map 0
```

!!! tip "CRF values"
    Lower CRF = better quality, larger file. For HEVC (`libx265`):

    | CRF | Quality | Typical use |
    |---|---|---|
    | 18–20 | Near-lossless | Archival |
    | 22–24 | High quality | Standard library |
    | 26–28 | Good quality | Space-constrained |

## Hardware acceleration

Hardware encoding is significantly faster than software (`libx265`) but requires a supported GPU and the right ffmpeg build.

### NVIDIA NVENC

Most distro-packaged ffmpeg builds include NVENC support. Requires the NVIDIA driver (no CUDA toolkit needed at runtime).

```bash
# H.265 via NVENC
FFMPEG_ARGS=-c:v hevc_nvenc -preset p4 -cq 22 -c:a aac -b:a 192k

# Verify NVENC is available
ffmpeg -encoders | grep nvenc
```

### Intel QSV (Quick Sync Video)

!!! warning "Custom ffmpeg build required"
    Most distro-packaged ffmpeg builds **do not** include QSV support — it requires `--enable-libmfx` (legacy) or `--enable-libvpl` + `--enable-qsv` (oneVPL, Intel 11th gen+) at compile time.

    **Easiest option:** use `jellyfin-ffmpeg`, which ships QSV-enabled builds for Ubuntu/Debian:

    ```bash
    # Add Jellyfin repo and install jellyfin-ffmpeg
    curl -fsSL https://repo.jellyfin.org/install-debuntu.sh | sudo bash
    sudo apt install jellyfin-ffmpeg7

    # Then point Discarr at the jellyfin binary
    FFMPEG_BIN=/usr/lib/jellyfin-ffmpeg/ffmpeg
    FFPROBE_BIN=/usr/lib/jellyfin-ffmpeg/ffprobe
    ```

    Alternatively, build ffmpeg from source with `--enable-libvpl` (see [FFmpeg compilation guide](https://trac.ffmpeg.org/wiki/CompilationGuide)).

```bash
# H.265 via QSV (requires QSV-enabled ffmpeg)
FFMPEG_ARGS=-c:v hevc_qsv -global_quality 22 -c:a aac -b:a 192k

# Verify QSV is available
ffmpeg -encoders | grep qsv
ffmpeg -hwaccels | grep qsv
```

### VAAPI (AMD/Intel on Linux)

Standard distro ffmpeg builds usually include VAAPI. Works on AMD GPUs and Intel integrated graphics.

```bash
# H.265 via VAAPI
FFMPEG_ARGS=-vaapi_device /dev/dri/renderD128 -vf 'format=nv12,hwupload' -c:v hevc_vaapi -qp 22 -c:a aac -b:a 192k

# Verify VAAPI device
ls /dev/dri/renderD*
ffmpeg -hwaccels | grep vaapi
```

### Checking what your ffmpeg supports

```bash
ffmpeg -codecs | grep hevc
ffmpeg -hwaccels
ffmpeg -encoders | grep -E "nvenc|qsv|vaapi|hevc"
```
