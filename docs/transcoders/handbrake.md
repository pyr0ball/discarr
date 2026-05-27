# HandBrake

HandBrake is an optional transcoder. Use it instead of ffmpeg when you want to use HandBrake's preset system or its more aggressive subtitle/chapter handling.

## Enable HandBrake

```bash
DISCARR_TRANSCODER=handbrake
```

## Preset

Specify any preset available in your HandBrake installation:

```bash
HANDBRAKE_PRESET=H.265 MKV 1080p30
```

### Common presets

| Preset | Resolution | Notes |
|---|---|---|
| `H.265 MKV 1080p30` | 1080p | Default — good balance |
| `H.265 MKV 720p30` | 720p | Smaller files |
| `H.265 MKV 576p25` | 576p | PAL DVD native |
| `H.265 MKV 480p30` | 480p | NTSC DVD native |
| `Production Max` | Source | Near-lossless, large files |

List all available presets on your system:

```bash
HandBrakeCLI --preset-list
```

## Custom presets

Export a preset from HandBrake's GUI, save it to a JSON file, and reference it:

```bash
HANDBRAKE_PRESET_FILE=/home/mediauser/.config/handbrake/my-preset.json
HANDBRAKE_PRESET=My Custom Preset
```

## Subtitle handling

HandBrake handles subtitle tracks more gracefully than ffmpeg for DVD sources — it can burn in forced subtitles automatically. If you have discs with forced subtitle tracks (common for foreign-language scenes), HandBrake is the better choice.

!!! note "ffprobe still required"
    HandBrake handles encoding, but Discarr still uses ffprobe for disc metadata scanning. Keep ffmpeg/ffprobe installed even when using HandBrake as the transcoder.
