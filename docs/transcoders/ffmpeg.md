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

## Checking ffmpeg capabilities

```bash
ffmpeg -codecs | grep hevc
ffmpeg -hwaccels
```

If hardware acceleration is available (NVENC, VAAPI, QSV), you can set it in `FFMPEG_ARGS` for significantly faster encodes.
